
import SwiftUI
import AppKit
import Foundation

// One process-wide gate covers native transfers and maintenance. Persistent
// mounts/app sessions prevent replacement/reset, while normal independent work
// may continue until an exclusive maintenance lease is taken.
final class GDUpdateActivity: ObservableObject {
    static let shared = GDUpdateActivity()
    @Published private(set) var revision: UInt64 = 0
    private struct Entry { weak var owner: AnyObject?; var flags: Set<String> }
    private let lock = NSLock()
    private var entries: [ObjectIdentifier: Entry] = [:]
    private weak var maintenanceOwner: AnyObject?
    private var backgroundInspections: Set<UUID> = []
    private let persistentFlags: Set<String> = ["mounted", "runningApps"]

    private func changed() {
        DispatchQueue.main.async { [weak self] in self?.revision &+= 1 }
    }
    func set(_ owner: AnyObject, key: String, active: Bool) {
        lock.lock()
        let id = ObjectIdentifier(owner)
        var entry = entries[id] ?? Entry(owner: owner, flags: [])
        let previous = entry.flags
        if active { entry.flags.insert(key) } else { entry.flags.remove(key) }
        entries[id] = entry
        lock.unlock()
        if previous != entry.flags { changed() }
    }
    private func busyLocked(excluding owner: AnyObject?, ignorePersistent: Bool) -> Bool {
        entries = entries.filter { $0.value.owner != nil }
        return entries.contains { id, entry in
            if let owner, id == ObjectIdentifier(owner) { return false }
            return !(ignorePersistent ? entry.flags.subtracting(persistentFlags) : entry.flags).isEmpty
        }
    }
    var hasActiveOperations: Bool {
        lock.lock(); defer { lock.unlock() }
        return busyLocked(excluding: nil, ignorePersistent: false)
    }
    var isBusy: Bool { isBusy(excluding: nil) }
    func isBusy(excluding owner: AnyObject?) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return (maintenanceOwner != nil && maintenanceOwner !== owner) || busyLocked(excluding: owner, ignorePersistent: false)
    }
    // Only the primary mount may be quiesced by the verified update worker.
    // Running managed apps and every transient operation remain blockers.
    private func updateBusyLocked(excluding owner: AnyObject?) -> Bool {
        entries = entries.filter { $0.value.owner != nil }
        return entries.contains { id, entry in
            if let owner, id == ObjectIdentifier(owner) { return false }
            return !entry.flags.subtracting(["mounted"]).isEmpty
        }
    }
    func isBusyForUpdate(excluding owner: AnyObject? = nil) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return (maintenanceOwner != nil && maintenanceOwner !== owner) || updateBusyLocked(excluding: owner)
    }
    @discardableResult func beginUpdateMaintenance(owner: AnyObject) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard (maintenanceOwner == nil || maintenanceOwner === owner), !updateBusyLocked(excluding: owner) else { return false }
        maintenanceOwner = owner
        changed()
        return true
    }
    var isMaintenancePending: Bool {
        lock.lock(); defer { lock.unlock() }
        return maintenanceOwner != nil
    }
    // Background status readers may finish normally after maintenance starts,
    // but no new reader may race the verified restart worker's quiet checks.
    func beginBackgroundInspection() -> UUID? {
        lock.lock(); defer { lock.unlock() }
        guard maintenanceOwner == nil else { return nil }
        let token = UUID()
        backgroundInspections.insert(token)
        return token
    }
    func endBackgroundInspection(_ token: UUID) {
        lock.lock(); defer { lock.unlock() }
        backgroundInspections.remove(token)
    }
    var hasBackgroundInspections: Bool {
        lock.lock(); defer { lock.unlock() }
        return !backgroundInspections.isEmpty
    }
    func canStart(excluding owner: AnyObject? = nil) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return (maintenanceOwner == nil || maintenanceOwner === owner) && !busyLocked(excluding: owner, ignorePersistent: true)
    }
    @discardableResult func beginMaintenance(owner: AnyObject) -> Bool {
        lock.lock()
        guard maintenanceOwner == nil || maintenanceOwner === owner,
              backgroundInspections.isEmpty,
              !busyLocked(excluding: owner, ignorePersistent: false) else { lock.unlock(); return false }
        maintenanceOwner = owner
        lock.unlock(); changed(); return true
    }
    func endMaintenance(owner: AnyObject) {
        lock.lock()
        let released = maintenanceOwner === owner
        if released { maintenanceOwner = nil }
        lock.unlock()
        if released { changed() }
    }
}

/// How this copy of the app was distributed. Decides whether it may update itself.
/// direct = GitHub download (self-updates); rotten-apple = the Rotten Apple launcher updates it;
/// mas = Mac App Store (Apple forbids self-update, so no update code runs and the UI is hidden).
/// Mirrors `distribution()` in Resources/gendragoon_auto_update.py. Unknown or unreadable values fail safe to "mas" (no self-update).
enum GDDistribution:String {
    case direct,rottenApple="rotten-apple",mas
    static let current:GDDistribution={
        // A Mac App Store receipt always wins.
        if let receipt=Bundle.main.appStoreReceiptURL,FileManager.default.fileExists(atPath:receipt.path){return .mas}
        var value="direct"
        if let url=Bundle.main.url(forResource:"gendragoon_distribution",withExtension:"json"){
            if let data=try? Data(contentsOf:url),
               let object=try? JSONSerialization.jsonObject(with:data) as? [String:Any],
               let text=object["distribution"] as? String{value=text}
            else{value="invalid"}
        }
        if value=="direct",ProcessInfo.processInfo.environment["ROTTEN_APPLE_LAUNCHER"]=="1"{value="rotten-apple"}
        return GDDistribution(rawValue:value) ?? .mas
    }()
    var selfUpdates:Bool{self == .direct}
}

@MainActor final class GDUpdateCoordinator:ObservableObject {
    static let shared=GDUpdateCoordinator()
    @Published private(set) var status="Automatic updates enabled · checking at launch and every 20 minutes."
    @Published private(set) var phase="idle"
    @Published private(set) var percentage:Double=0
    @Published private(set) var remainingSeconds:Int?
    @Published private(set) var bytesDownloaded:Int64=0
    @Published private(set) var bytesTotal:Int64=0
    @Published private(set) var isBusy=false { didSet { GDUpdateActivity.shared.set(self, key: "updater", active: isBusy) } }
    @Published private(set) var previewUpdates:Bool
    private var launched=false
    private var timer:Timer?
    private var restartTimer:Timer?
    private var process:Process?
    private var idleSince:Date?
    private var retryNotBefore=Date.distantPast
    private var restartRequested=false
    private var acknowledgedRequest:String?
    var hasProgress:Bool {isBusy || ["ready","downloading","verifying","extracting","signature","postponed","error"].contains(phase)}
    var requestsTermination:Bool {restartRequested && acknowledgedRequest != nil && !isBusy}
    private var channel:String {previewUpdates ? "preview" : "stable"}
    private var appPath:String {Bundle.main.bundleURL.path}
    private var statusURL:URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/GenDragoon Cloud SSD/AutoUpdates/status.json")
    }
    private init(){
        previewUpdates=UserDefaults.standard.string(forKey:"gd.updates.channel") == "preview"
        refreshObservedOutcome()
    }
    private func refreshObservedOutcome(){
        guard let data=try? Data(contentsOf:statusURL), data.count<=131_072,
              let result=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
              let state=result["state"] as? String else{return}
        let version=Bundle.main.object(forInfoDictionaryKey:"CFBundleShortVersionString") as? String ?? ""
        let build=Bundle.main.object(forInfoDictionaryKey:"CFBundleVersion") as? String ?? ""
        if ["installed","rolled_back"].contains(state), result["version"] as? String == "v"+version,
           String(describing:result["build"] ?? "") == build,
           result["launchStatus"] as? String == "exact_executable_observed",
           let records=result["launchedProcesses"] as? [[String:Any]],
           records.contains(where:{ ($0["pid"] as? NSNumber)?.int32Value == ProcessInfo.processInfo.processIdentifier &&
               $0["executable"] as? String == Bundle.main.executableURL?.path }) {
            percentage=100;phase=state
            status=state == "installed" ? "Updated to \(version) (\(build)) and reopened automatically." :
                "The update could not finish. Your previous verified app reopened automatically."
        }
        if let request=acknowledgedRequest, result["request_id"] as? String == request,
           ["postponed","attention","rolled_back"].contains(state) {
            acknowledgedRequest=nil;restartRequested=false
            GDUpdateActivity.shared.endMaintenance(owner:self)
            phase="postponed";retryNotBefore=Date().addingTimeInterval(60)
            status="The app stayed open. Automatic update will retry after current work finishes."
        }
    }
    func setPreviewUpdates(_ enabled:Bool){
        guard !isBusy,!restartRequested else{return}
        previewUpdates=enabled
        UserDefaults.standard.set(enabled ? "preview" : "stable",forKey:"gd.updates.channel")
        phase="idle";retryNotBefore = .distantPast;idleSince=nil
        scheduleCheck()
    }
    func start(){
        guard GDDistribution.current.selfUpdates else{
            status=GDDistribution.current == .rottenApple ? "Updates are handled by the Rotten Apple launcher." : ""
            return
        }
        guard !launched else{return}
        launched=true
        scheduleCheck()
        restartTimer=Timer.scheduledTimer(withTimeInterval:5,repeats:true){[weak self] _ in
            Task {@MainActor in self?.restartWhenIdle()}
        }
        timer=Timer.scheduledTimer(withTimeInterval:20*60,repeats:true){[weak self] _ in
            Task {@MainActor in self?.scheduleCheck()}
        }
    }
    // One reader drains stdout to EOF before completion. A final ready/ACK line
    // cannot be lost through competing readability and termination callbacks.
    private func runHelper(_ arguments:[String],finished:@escaping(Int32,[String:Any]?)->Void){
        guard let python=GDRuntime.pythonURL,let resources=Bundle.main.resourceURL else{
            finished(-1,nil);return
        }
        let runner=Process(),pipe=Pipe()
        runner.executableURL=python
        GDRuntime.configurePython(runner,arguments:[resources.appendingPathComponent("gendragoon_auto_update.py").path]+arguments)
        runner.standardInput=FileHandle.nullDevice;runner.standardOutput=pipe;runner.standardError=FileHandle.nullDevice
        do{try runner.run();process=runner}
        catch{finished(-1,nil);return}
        DispatchQueue.global(qos:.utility).async {[weak self] in
            var pending=Data()
            var last:[String:Any]?
            while true {
                let bytes=pipe.fileHandleForReading.availableData
                if bytes.isEmpty{break}
                pending.append(bytes)
                if pending.count>1_048_576{pending.removeAll();continue}
                while let newline=pending.firstIndex(of:10){
                    let line=Data(pending[..<newline]);pending.removeSubrange(...newline)
                    if let record=(try? JSONSerialization.jsonObject(with:line)) as? [String:Any]{
                        last=record
                        DispatchQueue.main.async {self?.consume(record)}
                    }
                }
            }
            runner.waitUntilExit()
            let code=runner.terminationStatus,record=last
            DispatchQueue.main.async {
                self?.process=nil
                finished(code,record)
            }
        }
    }
    private func consume(_ json:[String:Any]){
        guard let event=json["event"] as? String else{return}
        phase=event
        if let message=json["message"] as? String{status=GDNativeMessage.safe(message)}
        if let value=json["progress"] as? Double{percentage=min(100,max(0,value))}
        remainingSeconds=(json["etaSeconds"] as? Int).map{max(0,$0)}
        bytesDownloaded=(json["downloadedBytes"] as? NSNumber)?.int64Value ?? bytesDownloaded
        bytesTotal=(json["totalBytes"] as? NSNumber)?.int64Value ?? bytesTotal
    }
    func scheduleCheck(){
        guard GDDistribution.current.selfUpdates else{return}
        guard !isBusy,!restartRequested,Date()>=retryNotBefore else{return}
        guard GDUpdateActivity.shared.beginUpdateMaintenance(owner:self) else{
            if phase != "ready"{phase="postponed"}
            status="Update check queued until current transfers and managed applications finish."
            return
        }
        isBusy=true;phase="checking";status="Checking for trusted app updates…"
        percentage=0;remainingSeconds=nil;bytesDownloaded=0;bytesTotal=0
        runHelper(["prepare","--app",appPath,"--channel",channel]) {[weak self] code,_ in
            guard let self else{return}
            self.isBusy=false
            GDUpdateActivity.shared.endMaintenance(owner:self)
            if code != 0 {
                self.phase="error";self.remainingSeconds=nil
                self.retryNotBefore=Date().addingTimeInterval(60)
                if !self.status.contains("10 GiB"){self.status="Automatic update check could not finish. It will retry; your app stays available."}
            }
        }
    }
    private func restartWhenIdle(){
        if restartRequested{refreshObservedOutcome();return}
        if phase=="postponed",!isBusy,!GDUpdateActivity.shared.isBusyForUpdate(),Date()>=retryNotBefore{scheduleCheck();return}
        guard phase=="ready",!isBusy else{idleSince=nil;return}
        guard !GDUpdateActivity.shared.isBusyForUpdate() else{
            idleSince=nil;status="Update ready. Waiting for transfers and managed applications to finish.";return
        }
        if idleSince==nil{idleSince=Date()}
        guard Date().timeIntervalSince(idleSince!)>=15 else{
            status="Verified update ready. The app will reopen automatically when it is idle.";return
        }
        scheduleRestart()
    }
    private func scheduleRestart(){
        guard phase=="ready",!isBusy,!restartRequested,
              GDUpdateActivity.shared.beginUpdateMaintenance(owner:self) else{return}
        restartRequested=true;isBusy=true;phase="handoff"
        status="Preparing the verified restart helper and checking that cloud storage is idle…"
        beginRestartAfterBackgroundChecks(deadline:Date().addingTimeInterval(125))
    }
    private func postponeRestart(_ detail:String="Finish current cloud work; the app will retry."){
        isBusy=false;restartRequested=false;phase="postponed";idleSince=nil
        retryNotBefore=Date().addingTimeInterval(60)
        status="Automatic restart postponed. "+GDNativeMessage.safe(detail)
        GDUpdateActivity.shared.endMaintenance(owner:self)
    }
    private func beginRestartAfterBackgroundChecks(deadline:Date){
        guard restartRequested,isBusy,acknowledgedRequest==nil else{return}
        if GDUpdateActivity.shared.hasBackgroundInspections {
            guard Date()<deadline else{
                postponeRestart("A background cloud check has not finished. The app will retry safely.");return
            }
            status="Finishing the current cloud status check before the automatic restart…"
            DispatchQueue.main.asyncAfter(deadline:.now()+0.1){[weak self] in
                self?.beginRestartAfterBackgroundChecks(deadline:deadline)
            }
            return
        }
        guard !GDUpdateActivity.shared.isBusyForUpdate(excluding:self) else{postponeRestart();return}
        runHelper(["schedule-restart","--app",appPath,"--pid",String(ProcessInfo.processInfo.processIdentifier),
                   "--ui-busy","false","--channel",channel]) {[weak self] code,record in
            guard let self else{return}
            self.isBusy=false
            guard code==0,record?["state"] as? String == "scheduled",let request=record?["request_id"] as? String else{
                self.postponeRestart(record?["message"] as? String ?? "Finish current cloud work; the app will retry.")
                return
            }
            self.acknowledgedRequest=request;self.phase="restarting"
            self.status="Installing the verified update and reopening GenDragoon automatically…"
            NSApplication.shared.terminate(nil)
            // If AppKit/user cancellation keeps this exact app alive, cancel
            // the acknowledged worker before releasing our maintenance lease.
            DispatchQueue.main.asyncAfter(deadline:.now()+2){[weak self] in self?.cancelUnfinishedQuit(request)}
        }
    }
    private func cancelUnfinishedQuit(_ request:String){
        guard acknowledgedRequest==request,restartRequested else{return}
        isBusy=true
        runHelper(["cancel-restart","--app",appPath,"--pid",String(ProcessInfo.processInfo.processIdentifier),
                   "--request-id",request,"--channel",channel]) {[weak self] code,record in
            guard let self else{return}
            self.isBusy=false
            if code==0,record?["state"] as? String == "cancelled"{
                self.acknowledgedRequest=nil;self.restartRequested=false;self.phase="postponed";self.idleSince=nil
                self.retryNotBefore=Date().addingTimeInterval(60)
                self.status="The app stayed open. Its automatic update will retry when idle."
                GDUpdateActivity.shared.endMaintenance(owner:self)
            }else{
                self.phase="postponed"
                self.status="Waiting for the restart helper to release its maintenance lock."
            }
        }
    }
    func prepareForTermination(){
        // Ordinary Quit stays closed. An update worker exists only after the
        // explicit pre-quit handoff has acknowledged its lock and verified stage.
        timer?.invalidate();restartTimer?.invalidate()
    }
}
struct GenDragoonAutomaticUpdateStatus:View {
    @ObservedObject private var update=GDUpdateCoordinator.shared
    private var etaLabel:String {
        guard let secs=update.remainingSeconds else{return "Calculating ETA…"}
        return secs>=3600 ? "\(secs/3600)h \((secs%3600)/60)m" :
            secs>=60 ? "\(secs/60)m \(secs%60)s" : "\(secs)s"
    }
    private var showETA:Bool {update.phase == "downloading"}
    @ViewBuilder var body:some View {
        switch GDDistribution.current {
        case .mas:
            EmptyView()
        case .rottenApple:
            VStack(alignment:.leading,spacing:10){
                Label("App updates",systemImage:"arrow.triangle.2.circlepath.circle.fill")
                    .font(.system(size:16,weight:.bold))
                Text("Updates are handled by the Rotten Apple launcher.")
                    .font(.system(size:12)).foregroundStyle(.gray)
            }
            .padding(16)
            .background(Color.white.opacity(0.045),in:RoundedRectangle(cornerRadius:15))
        case .direct:
            directBody
        }
    }
    private var directBody:some View {
        VStack(alignment:.leading,spacing:10){
            Label("Automatic app updates",systemImage:"arrow.triangle.2.circlepath.circle.fill")
                .font(.system(size:16,weight:.bold))
            Text("Checks at startup and every 20 minutes. Verified updates install and reopen the app automatically after cloud work finishes. An idle cloud drive is stopped safely first.")
                .font(.system(size:12)).foregroundStyle(.gray)
            if update.hasProgress {
                ProgressView(value:update.percentage,total:100).tint(.cyan)
                    .animation(.easeOut(duration:0.2),value:update.percentage)
                HStack {
                    Text(String(format:"%.0f/100",update.percentage))
                        .font(.system(size:12,weight:.bold,design:.monospaced))
                    Spacer()
                    if showETA {Text(etaLabel).font(.system(size:11,weight:.medium,design:.monospaced))}
                    else if update.phase == "ready" {Text("Restarts when idle").font(.system(size:11))}
                }
                .foregroundStyle(.cyan)
                if update.bytesTotal>0 && update.phase == "downloading" {
                    Text(String(format:"%.1f / %.1f MiB",Double(update.bytesDownloaded)/1048576,
                                Double(update.bytesTotal)/1048576))
                        .font(.system(size:10,design:.monospaced)).foregroundStyle(.gray)
                }
            }
            Text(update.status).font(.system(size:12)).foregroundStyle(.gray)
            Toggle("Receive preview releases",isOn:Binding(get:{update.previewUpdates},set:{update.setPreviewUpdates($0)}))
                .font(.system(size:12)).disabled(update.isBusy || update.requestsTermination)
            Text(update.previewUpdates ? "Preview releases are enabled for testing. Every update still requires Apple trust verification." : "Stable releases are selected. Preview test releases are excluded.")
                .font(.system(size:11)).foregroundStyle(.gray)
            if update.phase == "error" {
                Text("Only newer releases with the required Developer ID signature, Apple acceptance and a stapled ticket can install.")
                    .font(.system(size:11)).foregroundStyle(.orange)
            }
        }
        .padding(16)
        .background(Color.white.opacity(0.045),in:RoundedRectangle(cornerRadius:15))
    }
}

struct GenDragoonCompactUpdateStatus:View {
    @ObservedObject private var update=GDUpdateCoordinator.shared
    var body:some View {
        if update.isBusy || update.phase == "ready" {
            VStack(alignment:.leading,spacing:7){
                HStack {
                    Label("Updating GenDragoon",systemImage:"arrow.triangle.2.circlepath")
                        .font(.system(size:11,weight:.semibold)).foregroundStyle(.cyan)
                    Spacer()
                    Text(String(format:"%.0f/100",update.percentage))
                        .font(.system(size:11,weight:.bold,design:.monospaced))
                    if let eta=update.remainingSeconds,update.phase == "downloading" {
                        Text("· ~\(eta/60)m \(eta%60)s remaining")
                            .font(.system(size:10,design:.monospaced)).foregroundStyle(.gray)
                    }
                }
                ProgressView(value:update.percentage,total:100).tint(.cyan)
                Text(update.status).font(.system(size:11)).foregroundStyle(.gray).lineLimit(2)
            }
            .padding(12).background(Color.cyan.opacity(0.08),in:RoundedRectangle(cornerRadius:12))
        }
    }
}
