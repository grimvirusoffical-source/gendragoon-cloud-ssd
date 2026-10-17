import SwiftUI
import AppKit
import Foundation
import CryptoKit

struct GDWorkspaceChoice:Decodable,Identifiable {
    let id:String
    let name:String
    let kind:String
    let storageActive:Bool
    let provisioned:Bool
}
@MainActor final class GDFreeCustomerModel:ObservableObject {
    @Published var choices:[GDWorkspaceChoice]=[]
    @Published var selectedWorkspace="free" { didSet {
        guard !connectedID.isEmpty else { return }
        UserDefaults.standard.set(selectedWorkspace, forKey: workspacePreference)
    } }
    @Published private(set) var workspaceName:String?
    @Published private(set) var usedBytes:Int64=0
    @Published private(set) var reservedBytes:Int64=0
    @Published private(set) var quotaBytes:Int64=2_000_000_000
    @Published private(set) var workerCount=1
    @Published private(set) var files:[GDCloudItem]=[]
    @Published var status="Checking your private cloud…"
    @Published var busy=false { didSet { GDUpdateActivity.shared.set(self, key: "busy", active: busy) } }
    @Published var uploadProgress=0.0
    @Published var transferDetail=""
    @Published var dataSaver=false
    private var client:GDTransferClient?
    private var connectedID=""
    private var workspacePreference:String {
        let account=SHA256.hash(data:Data(connectedID.utf8)).map{String(format:"%02x",$0)}.joined()
        return "gd.customer.workspace."+account
    }
    private var operation:Task<Void,Never>?
    func connect(_ login:GDLoginSession) {
        guard !busy,!GDUpdateActivity.shared.isMaintenancePending else{return}
        if connectedID != login.userID {
            files=[];workspaceName=nil;choices=[];connectedID="";selectedWorkspace="free";client=nil
        }
        guard !login.userID.isEmpty else {status="Sign in with Google first.";return}
        do {
            if client==nil {
                guard let file=Bundle.main.url(forResource:"gendragoon_free_api",withExtension:"json"),
                    let cfg=(try JSONSerialization.jsonObject(with:Data(contentsOf:file))) as? [String:Any],
                    let endpointText=cfg["endpoint"] as? String,let endpoint=URL(string:endpointText),
                    endpoint.host?.hasSuffix(".run.app")==true else {throw GDTransferError(message:"Cloud service configuration missing.",status:0)}
                let expectedID=login.userID
                client=try GDTransferClient(endpoint:endpoint,accountID:expectedID){[weak login] force in
                    guard let login,await login.userID==expectedID else {throw GDTransferError(message:"Your account changed. Sign in again.",status:401)}
                    return try await login.tokenForTransfer(forceRefresh:force)
                }
                connectedID=expectedID
                selectedWorkspace=UserDefaults.standard.string(forKey:workspacePreference) ?? "free"
            }
            refresh()
        }catch{status=error.localizedDescription}
    }
    private func load() async throws {
        guard let client else{throw GDTransferError(message:"Sign in first.",status:401)}
        let data=try await client.json("v2/workspaces")
        struct Response:Decodable{let workspaces:[GDWorkspaceChoice]}
        choices=try JSONDecoder().decode(Response.self,from:data).workspaces.filter{$0.kind=="paid" && $0.storageActive && $0.provisioned}
        if selectedWorkspace != "free" && !choices.contains(where:{$0.id==selectedWorkspace}){selectedWorkspace="free"}
        do {
            let c=try await client.configuration(workspace:selectedWorkspace)
            workspaceName=c.name;usedBytes=c.usedBytes;reservedBytes=c.reservedBytes;quotaBytes=c.quotaBytes;workerCount=c.transfer.workers
            files=try await client.list(workspace:selectedWorkspace)
            status="Cloud ready · \(workerCount) verified transfer worker\(workerCount==1 ? "":"s")."
        }catch let failure as GDTransferError where failure.status==404 && selectedWorkspace=="free" {
            workspaceName=nil;files=[];status="Create your free private 2 GB cloud workspace."
        }
    }
    func refresh(){
        guard !busy,!GDUpdateActivity.shared.isMaintenancePending,client != nil else{return};busy=true
        operation=Task {defer{busy=false};do{try await load()}catch{status=error.localizedDescription}}
    }
    func create(){
        guard !busy,GDUpdateActivity.shared.canStart(excluding:self),let client else{return};busy=true
        operation=Task {defer{busy=false};do{
            do{_=try await client.json("v1/free",method:"POST",payload:["name":"My Free Cloud"])}
            catch let e as GDTransferError where e.status==409 {}
            try await load()
        }catch{status=error.localizedDescription}}
    }
    private func update(_ p:GDTransferProgress){
        uploadProgress=p.fraction
        let rate=String(format:"%.1f MB/s",p.bytesPerSecond/1_000_000)
        let eta=p.secondsRemaining.map{String(format:" · about %.0fs remaining",$0)} ?? ""
        transferDetail=p.phase+" · "+rate+eta
    }
    func upload(){
        guard !busy,GDUpdateActivity.shared.canStart(excluding:self),workspaceName != nil,client != nil else{return}
        let panel=NSOpenPanel();panel.canChooseFiles=true;panel.canChooseDirectories=false;panel.allowsMultipleSelection=true
        panel.message="Select files for this workspace. Interrupted uploads resume when the same unchanged files are selected again. Originals are retained."
        guard panel.runModal() == .OK else{return}
        uploadFiles(panel.urls)
    }
    func uploadFiles(_ urls:[URL]) {
        guard !busy,GDUpdateActivity.shared.canStart(excluding:self),workspaceName != nil,let client,!urls.isEmpty else{return}
        guard urls.allSatisfy({$0.isFileURL && (try? $0.resourceValues(forKeys:[.isRegularFileKey]).isRegularFile)==true}) else {
            status="Choose regular files, or archive folders and app bundles first. Nothing was uploaded.";return
        }
        let workspace=selectedWorkspace,constrained=dataSaver
        busy=true;uploadProgress=0
        operation=Task {defer{busy=false};do{
            for url in urls {
                try Task.checkCancellation()
                let scoped=url.startAccessingSecurityScopedResource();defer{if scoped{url.stopAccessingSecurityScopedResource()}}
                status="Uploading \(url.lastPathComponent)…"
                try await client.upload(source:url,workspace:workspace,constrained:constrained){[weak model=self] p in await model?.update(p)}
            }
            try await load();status="Files verified and saved. Your originals were retained."
        }catch is CancellationError{status="Paused. Select the same files to resume without restarting completed chunks."}
         catch{status="Upload stopped: "+error.localizedDescription}}
    }
    func download(file:GDCloudItem){
        guard !busy,GDUpdateActivity.shared.canStart(excluding:self),let client else{return}
        let panel=NSSavePanel();panel.nameFieldStringValue=file.name;panel.message="Restore this file. Interrupted downloads resume from verified byte ranges."
        guard panel.runModal() == .OK,let destination=panel.url else{return}
        let workspace=selectedWorkspace,constrained=dataSaver
        busy=true;uploadProgress=0
        operation=Task {defer{busy=false};do{
            let scoped=destination.startAccessingSecurityScopedResource();defer{if scoped{destination.stopAccessingSecurityScopedResource()}}
            let source=try await client.download(file:file,workspace:workspace,constrained:constrained){[weak model=self] p in await model?.update(p)}
            let staged=destination.deletingLastPathComponent().appendingPathComponent(".gendragoon-"+UUID().uuidString)
            defer{try? FileManager.default.removeItem(at:staged)}
            try FileManager.default.copyItem(at:source,to:staged)
            if FileManager.default.fileExists(atPath:destination.path){_=try FileManager.default.replaceItemAt(destination,withItemAt:staged)}
            else{try FileManager.default.moveItem(at:staged,to:destination)}
            try? FileManager.default.removeItem(at:source)
            status="Restored \(file.name) to your chosen location."
        }catch is CancellationError{status="Paused. Restore this file again to resume the download."}
         catch{status=error.localizedDescription}}
    }
    func delete(file:GDCloudItem){
        guard !busy,GDUpdateActivity.shared.canStart(excluding:self),let client else{return}
        let alert=NSAlert();alert.messageText="Delete \(file.name) from cloud?"
        alert.informativeText="This removes the cloud copy. Local copies are not affected."
        alert.addButton(withTitle:"Delete Cloud Copy");alert.addButton(withTitle:"Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else{return}
        let workspace=selectedWorkspace;busy=true
        operation=Task {defer{busy=false};do{try await client.delete(fileID:file.id,workspace:workspace);try await load()}catch{status=error.localizedDescription}}
    }
    func pause(){operation?.cancel()}
}
struct GenDragoonFreeCloudPanel:View {
    @EnvironmentObject var login:GDLoginSession
    @StateObject private var customer=GDFreeCustomerModel()
    @State private var search=""
    @State private var order="name"
    @State private var kind="all"
    @State private var dropTarget=false
    @AppStorage("gd.library.grid") private var grid=false
    private let accent=Color(red:0.72,green:0.55,blue:0.96)
    private func size(_ n:Int64)->String{ByteCountFormatter.string(fromByteCount:n,countStyle:.file)}
    private func category(_ file:GDCloudItem)->String{
        let ext=(file.name as NSString).pathExtension.lowercased()
        if ["wav","mp3","aiff","aac","m4a","flac","ogg"].contains(ext){return "audio"}
        if ["png","jpg","jpeg","webp","gif","heic","svg"].contains(ext){return "images"}
        if ["zip","dmg","7z","tar","gz","ipa","apk","aab"].contains(ext){return "archives"}
        return "documents"
    }
    private func icon(_ file:GDCloudItem)->String{
        switch category(file){case "audio":return "waveform";case "images":return "photo";case "archives":return "archivebox";default:return "doc.text"}
    }
    private var visible:[GDCloudItem]{
        customer.files.filter{(search.isEmpty || $0.name.localizedCaseInsensitiveContains(search))&&(kind=="all" || category($0)==kind)}.sorted{
            if order=="largest"{return $0.sizeBytes>$1.sizeBytes}
            if order=="smallest"{return $0.sizeBytes<$1.sizeBytes}
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }
    private func metric(_ title:String,_ value:String,_ symbol:String)->some View{
        VStack(alignment:.leading,spacing:12){
            Label(title,systemImage:symbol).font(.system(size:11,weight:.medium)).foregroundStyle(.white.opacity(0.60))
            Text(value).font(.system(size:24,weight:.bold,design:.rounded)).tracking(-0.5).lineLimit(1).minimumScaleFactor(0.6)
        }.frame(maxWidth:.infinity,alignment:.leading).padding(19)
         .background(accent.opacity(0.075),in:RoundedRectangle(cornerRadius:15))
         .overlay(RoundedRectangle(cornerRadius:15).stroke(accent.opacity(0.18)))
    }
    private func fileIcon(_ file:GDCloudItem)->some View{
        Image(systemName:icon(file)).font(.system(size:21,weight:.medium)).foregroundStyle(accent)
            .frame(width:44,height:50).background(accent.opacity(0.11),in:RoundedRectangle(cornerRadius:12))
    }
    private func actions(_ file:GDCloudItem)->some View{
        HStack(spacing:9){
            Button{customer.download(file:file)}label:{Label("Restore",systemImage:"arrow.down.to.line")}
                .buttonStyle(.bordered).tint(accent).help("Restore a local copy; the cloud copy remains.")
            Button(role:.destructive){customer.delete(file:file)}label:{Image(systemName:"trash")}
                .buttonStyle(.borderless).help("Delete the cloud copy").accessibilityLabel("Delete "+file.name)
        }.disabled(customer.busy).font(.system(size:11,weight:.medium))
    }
    private func row(_ file:GDCloudItem)->some View{
        HStack(spacing:14){fileIcon(file)
            VStack(alignment:.leading,spacing:6){Text(file.name).font(.system(size:13,weight:.semibold)).lineLimit(2);Text(size(file.sizeBytes)).font(.system(size:11)).foregroundStyle(.secondary)}
            Spacer(minLength:12);actions(file)
        }.padding(.vertical,13).padding(.horizontal,8)
         .contextMenu{Button("Restore a local copy"){customer.download(file:file)};Button("Delete cloud copy",role:.destructive){customer.delete(file:file)}}
    }
    private func tile(_ file:GDCloudItem)->some View{
        VStack(alignment:.leading,spacing:14){
            HStack{fileIcon(file);Spacer();Text(size(file.sizeBytes)).font(.system(size:10)).foregroundStyle(.secondary)}
            Text(file.name).font(.system(size:13,weight:.semibold)).lineLimit(2).frame(height:36,alignment:.topLeading)
            HStack{Spacer();actions(file)}
        }.padding(17).background(.white.opacity(0.035),in:RoundedRectangle(cornerRadius:16))
         .overlay(RoundedRectangle(cornerRadius:16).stroke(.white.opacity(0.09)))
    }
    var body:some View{
        VStack(alignment:.leading,spacing:20){
            HStack(alignment:.center){
                VStack(alignment:.leading,spacing:6){Text("PRIVATE WORKSPACE").font(.system(size:9,weight:.bold,design:.monospaced)).tracking(2).foregroundStyle(accent);Text(customer.workspaceName ?? "Your private storage").font(.system(size:23,weight:.bold,design:.rounded))}
                Spacer();Button{customer.refresh();login.checkAdEntitlement()}label:{Label("Refresh",systemImage:"arrow.clockwise")}.disabled(customer.busy)
            }
            HStack(spacing:14){
                Picker("Workspace",selection:$customer.selectedWorkspace){Text("Free · 2 GB").tag("free");ForEach(customer.choices){Text($0.name).tag($0.id)}}
                    .labelsHidden().controlSize(.large).disabled(customer.busy)
                Spacer();Label(login.email,systemImage:"checkmark.shield").font(.system(size:11)).foregroundStyle(.secondary).lineLimit(1)
            }.onChange(of:customer.selectedWorkspace){_,_ in customer.refresh()}
            if customer.workspaceName != nil {
                HStack(spacing:12){metric("Storage used",size(customer.usedBytes),"externaldrive");metric("Available",size(max(0,customer.quotaBytes-customer.usedBytes-customer.reservedBytes)),"cloud");metric("Parallel transfers",String(customer.workerCount),"bolt")}
                ProgressView(value:min(1,Double(customer.usedBytes+customer.reservedBytes)/Double(max(1,customer.quotaBytes)))).tint(accent)
                HStack(spacing:12){
                    Button{customer.upload()}label:{Label("Upload files",systemImage:"plus")}.buttonStyle(.borderedProminent).tint(accent).controlSize(.large).disabled(customer.busy)
                    Text("or drop files here").font(.system(size:11)).foregroundStyle(.secondary)
                    Spacer();Toggle("Data saver",isOn:$customer.dataSaver).toggleStyle(.switch).font(.system(size:11)).disabled(customer.busy)
                }
                if customer.busy{
                    VStack(alignment:.leading,spacing:11){HStack{Label("Transfer in progress",systemImage:"arrow.up.arrow.down").font(.system(size:12,weight:.semibold));Spacer();Button("Pause"){customer.pause()}};ProgressView(value:customer.uploadProgress).tint(accent);Text(customer.transferDetail).font(.system(size:11,design:.monospaced)).foregroundStyle(.secondary)}
                        .padding(16).background(accent.opacity(0.12),in:RoundedRectangle(cornerRadius:14))
                }
                HStack(spacing:11){
                    HStack{Image(systemName:"magnifyingglass").foregroundStyle(.secondary);TextField("Find a file…",text:$search).textFieldStyle(.plain)}.padding(11).background(.black.opacity(0.18),in:RoundedRectangle(cornerRadius:10))
                    Picker("Sort",selection:$order){Text("Name A–Z").tag("name");Text("Largest first").tag("largest");Text("Smallest first").tag("smallest")}.labelsHidden().frame(width:135)
                    Button{grid.toggle()}label:{Image(systemName:grid ? "list.bullet":"square.grid.2x2")}.help(grid ? "List view":"Grid view").accessibilityLabel(grid ? "List view":"Grid view")
                }.padding(.top,8)
                HStack{
                    Picker("File type",selection:$kind){Text("All files").tag("all");Text("Audio").tag("audio");Text("Images").tag("images");Text("Documents").tag("documents");Text("Archives").tag("archives")}.pickerStyle(.segmented).labelsHidden().frame(maxWidth:475)
                    Spacer();Text("\(visible.count) files").font(.system(size:10)).foregroundStyle(.secondary)
                }
                if visible.isEmpty{
                    VStack(spacing:12){Image(systemName:customer.files.isEmpty ? "tray.and.arrow.up":"magnifyingglass").font(.system(size:33,weight:.light)).foregroundStyle(accent);Text(customer.files.isEmpty ? "Make room for what matters.":"No matching files.").font(.system(size:16,weight:.semibold));Text(customer.files.isEmpty ? "Upload your first file. The original stays on your Mac.":"Try another search or file type.").font(.system(size:12)).foregroundStyle(.secondary)}.frame(maxWidth:.infinity).padding(.vertical,38)
                }else if grid{LazyVGrid(columns:[GridItem(.adaptive(minimum:245),spacing:13)],spacing:13){ForEach(visible){tile($0)}}}
                else{LazyVStack(spacing:0){ForEach(visible){file in row(file);Divider().opacity(0.22)}}}
            }else{
                VStack(spacing:14){Image(systemName:"cloud.badge.plus").font(.system(size:40,weight:.light)).foregroundStyle(accent);Text("Start with 2 GB, on us.").font(.system(size:22,weight:.bold,design:.rounded));Text("Private storage with resumable uploads and integrity checks. No payment required.").font(.system(size:12)).foregroundStyle(.secondary);Button("Create my free workspace"){customer.create()}.buttonStyle(.borderedProminent).tint(accent).controlSize(.large).disabled(customer.busy)}.frame(maxWidth:.infinity).padding(.vertical,30)
            }
            Label(customer.status,systemImage:"info.circle").font(.system(size:11)).foregroundStyle(.white.opacity(0.66)).textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading).padding(13).background(.white.opacity(0.035),in:RoundedRectangle(cornerRadius:10))
            DisclosureGroup("Transfer details"){
                Text("All plans include resume, integrity checks and partial downloads. Paid performance increases parallel transfers, not your internet connection speed. Data saver uses one transfer at a time. Archive folders and app bundles before uploading here; the owner library below supports compatible Mac app streaming.").font(.system(size:11)).foregroundStyle(.secondary).padding(.top,7)
            }.font(.system(size:11)).tint(accent)
        }.padding(24).background(.white.opacity(0.035),in:RoundedRectangle(cornerRadius:21))
         .overlay(RoundedRectangle(cornerRadius:21).stroke(dropTarget ? accent:.white.opacity(0.08),lineWidth:dropTarget ? 2:1))
         .dropDestination(for:URL.self){urls,_ in guard !customer.busy,customer.workspaceName != nil else{return false};customer.uploadFiles(urls);return true}isTargeted:{dropTarget=$0}
         .onAppear{customer.connect(login)}.onChange(of:login.userID){_,_ in customer.connect(login)}
    }
}
