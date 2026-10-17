
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
    var isMaintenancePending: Bool {
        lock.lock(); defer { lock.unlock() }
        return maintenanceOwner != nil
    }
    func canStart(excluding owner: AnyObject? = nil) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return (maintenanceOwner == nil || maintenanceOwner === owner) && !busyLocked(excluding: owner, ignorePersistent: true)
    }
    @discardableResult func beginMaintenance(owner: AnyObject) -> Bool {
        lock.lock()
        guard maintenanceOwner == nil || maintenanceOwner === owner,
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

@MainActor final class GDUpdateCoordinator:ObservableObject {
    static let shared=GDUpdateCoordinator()
    @Published private(set) var status="Automatic updates enabled · checking at launch and every 20 minutes."
    @Published private(set) var phase="idle"
    @Published private(set) var percentage:Double=0
    @Published private(set) var remainingSeconds:Int?
    @Published private(set) var bytesDownloaded:Int64=0
    @Published private(set) var bytesTotal:Int64=0
    @Published private(set) var isBusy=false { didSet { GDUpdateActivity.shared.set(self, key: "updater", active: isBusy) } }
    private var launched=false
    private var timer:Timer?
    private var process:Process?
    private var output:Pipe?
    private var lineBuffer=""
    private var lastErrorDate:Date?
    private var relaunchAfterUpdate=false
    private var restartTimer: Timer?
    private var idleSince: Date?
    private var restartRequested=false
    var hasProgress:Bool {isBusy || ["ready","downloading","verifying","extracting","signature","postponed","error"].contains(phase)}
    private var updaterScript:URL? {
        Bundle.main.resourceURL?.appendingPathComponent("gendragoon_auto_update.py")
    }
    private init(){
        let statusURL=FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/GenDragoon Cloud SSD/AutoUpdates/status.json")
        if let data=try? Data(contentsOf:statusURL),
           let result=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
           result["state"] as? String == "installed",
           let version=result["version"] as? String {
            percentage=100;phase="installed";status="Updated successfully to \(version)."
        }
    }
    func start(){
        guard !launched else {return}
        launched=true
        scheduleCheck()
        restartTimer=Timer.scheduledTimer(withTimeInterval:5,repeats:true){[weak self] _ in
            Task {@MainActor in self?.restartWhenIdle()}
        }
        timer=Timer.scheduledTimer(withTimeInterval:20*60,repeats:true){[weak self] _ in
            Task {@MainActor in self?.scheduleCheck()}
        }
    }
    func scheduleCheck(){
        guard !isBusy, !restartRequested, let script=updaterScript else{return}
        guard GDUpdateActivity.shared.beginMaintenance(owner: self) else {
            if phase != "ready" { phase="postponed" }
            status="Update check queued. Finish current work and unmount the cloud drive first."
            return
        }
        guard let python=GDRuntime.pythonURL else {
            GDUpdateActivity.shared.endMaintenance(owner: self)
            phase="error";status="A supported Python runtime is unavailable. Run the installer.";return
        }
        isBusy=true;phase="checking";status="Checking for trusted app updates…"
        percentage=0;remainingSeconds=nil;bytesDownloaded=0;bytesTotal=0;lineBuffer=""
        let runner=Process(),pipe=Pipe()
        runner.executableURL=python
        GDRuntime.configurePython(runner, arguments: [script.path,"prepare"])
        runner.standardOutput=pipe
        runner.standardError=FileHandle.nullDevice
        runner.terminationHandler={[weak self] done in
            Task {@MainActor in
                guard let self else{return}
                self.output?.fileHandleForReading.readabilityHandler=nil
                self.output=nil
                self.process=nil
                self.isBusy=false
                GDUpdateActivity.shared.endMaintenance(owner: self)
                if !self.lineBuffer.isEmpty { self.consume("\n") }
                if done.terminationStatus != 0 && self.phase != "error" {
                    self.phase="error";self.status="Update check failed. Retrying automatically in 20 minutes."
                    self.remainingSeconds=nil
                }
            }
        }
        pipe.fileHandleForReading.readabilityHandler={[weak self] handle in
            let bytes=handle.availableData
            guard !bytes.isEmpty,let text=String(data:bytes,encoding:.utf8) else{return}
            Task {@MainActor in self?.consume(text)}
        }
        do{try runner.run();process=runner;output=pipe}
        catch {
            isBusy=false;phase="error";status="Could not launch secure updater."
            GDUpdateActivity.shared.endMaintenance(owner: self)
        }
    }
    private func consume(_ incoming:String){
        guard lineBuffer.utf8.count + incoming.utf8.count <= 1_048_576 else {
            lineBuffer="";phase="error";status="Updater returned an invalid progress response.";return
        }
        lineBuffer+=incoming
        while let cut=lineBuffer.range(of:"\n"){
            let raw=String(lineBuffer[..<cut.lowerBound])
            lineBuffer.removeSubrange(..<cut.upperBound)
            guard let data=raw.data(using:.utf8),
                  let json=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
                  let event=json["event"] as? String else{continue}
            phase=event
            if let message=json["message"] as? String{status=GDNativeMessage.safe(message)}
            if let value=json["progress"] as? Double{percentage=min(100,max(0,value))}
            if let eta=json["etaSeconds"] as? Int {remainingSeconds=max(0,eta)}
            else {remainingSeconds=nil}
            bytesDownloaded=(json["downloadedBytes"] as? NSNumber)?.int64Value ?? bytesDownloaded
            bytesTotal=(json["totalBytes"] as? NSNumber)?.int64Value ?? bytesTotal
        }
    }
    private func restartWhenIdle(){
        if phase == "postponed", !isBusy, !GDUpdateActivity.shared.isBusy { scheduleCheck(); return }
        guard phase=="ready", !isBusy, !restartRequested else {idleSince=nil;return}
        guard !GDUpdateActivity.shared.isBusy else {
            idleSince=nil;status="Update ready. Waiting for transfers and mounted drives before restarting."
            return
        }
        if idleSince==nil {idleSince=Date()}
        guard Date().timeIntervalSince(idleSince!) >= 15 else {
            status="Verified update ready. Restarting automatically once the app is idle."
            return
        }
        restartToUpdate()
    }
    func restartToUpdate(){
        guard phase=="ready",!isBusy,!restartRequested else{return}
        guard GDUpdateActivity.shared.beginMaintenance(owner: self) else {
            status="Finish current operations and unmount your cloud drive to restart safely.";return
        }
        restartRequested=true;relaunchAfterUpdate=true
        NSApplication.shared.terminate(nil)
        // A cancelled AppKit termination must not permanently freeze the app.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            self.restartRequested=false;self.relaunchAfterUpdate=false
            GDUpdateActivity.shared.endMaintenance(owner: self)
        }
    }
    func forceUpdateAndRestart() {
        if phase == "ready" { restartToUpdate() } else { scheduleCheck() }
    }
    var requestsTermination: Bool { restartRequested }
    func prepareForTermination(){
        // A detached child checks once more and installs only a trusted, notarized,
        // newer build, and only once this app has actually exited.
        guard !GDUpdateActivity.shared.isBusy(excluding: self),
              let script=updaterScript, let python=GDRuntime.pythonURL else{return}
        let worker=Process()
        worker.executableURL=python
        GDRuntime.configurePython(worker, arguments: [script.path,"auto-on-exit","--pid",String(ProcessInfo.processInfo.processIdentifier),"--relaunch"])
        worker.standardInput=FileHandle.nullDevice
        worker.standardOutput=FileHandle.nullDevice
        worker.standardError=FileHandle.nullDevice
        try? worker.run()
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
    var body:some View {
        VStack(alignment:.leading,spacing:10){
            Label("Automatic app updates",systemImage:"arrow.triangle.2.circlepath.circle.fill")
                .font(.system(size:16,weight:.bold))
            Text("Checks at startup and every 20 minutes. Verified updates restart the app automatically when transfers finish and drives are unmounted.")
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
            HStack(spacing:12){
                Button("Update and restart"){update.forceUpdateAndRestart()}.disabled(update.isBusy)
                if update.phase=="ready"{Button("Restart to update"){update.restartToUpdate()}.buttonStyle(.borderedProminent).tint(.purple)}
            }
            if update.phase == "error" {
                Text("The installed version remains unchanged. Only trusted, newer Apple-signed releases can install.")
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
