import Foundation
import SwiftUI
import Network

struct MobileWorkspace:Decodable,Identifiable,Sendable {let id:String;let name:String;let kind:String;let storageActive:Bool;let provisioned:Bool}
struct MobileExport:Identifiable {let id=UUID();let url:URL}
@MainActor final class MobileCloudModel:ObservableObject {
    @Published var selected="free"
    @Published var removeOriginals=false
    private var selectionKey:String { "GenDragoon.workspace."+GDTransferClient.digest(Data(owner.utf8)) }
    @Published var choices:[MobileWorkspace]=[]
    @Published var config:GDTransferConfig?
    @Published var files:[GDCloudItem]=[]
    @Published var status="Opening your workspace…"
    @Published var busy=false
    @Published var transferring=false
    @Published var ownerBenefits=false
    private var didChooseOwnerWorkspace=false
    @Published var dataSaver=false
    @Published var constrainedNetwork=false
    @Published var fraction=0.0
    @Published var detail=""
    @Published var export:MobileExport?
    private var task:Task<Void,Never>?
    private var client:GDTransferClient?
    private var owner=""
    private let monitor=NWPathMonitor()
    init(){monitor.pathUpdateHandler={[weak self] path in Task{@MainActor in self?.constrainedNetwork=path.isExpensive||path.isConstrained}};monitor.start(queue:DispatchQueue(label:"GenDragoon.Network"))}
    deinit{monitor.cancel()}
    func connect(_ session:MobileSession) async {
        guard !session.uid.isEmpty,session.stage == .ready else{return}
        let expected=session.uid
        do {
            if owner != expected {
                task?.cancel();config=nil;files=[];choices=[];export=nil;selected="free"
                client=try GDTransferClient(endpoint:URL(string:"https://gendragoon-free-10068843866.us-central1.run.app")!,accountID:expected){[weak session] force in
                    guard let session,await session.uid==expected else{throw GDTransferError(message:"Your account changed. Please sign in again.",status:401)}
                    return try await session.token(force:force)
                };owner=expected
                let savedWorkspace=UserDefaults.standard.string(forKey:selectionKey)
                selected=savedWorkspace ?? "free"
                didChooseOwnerWorkspace = savedWorkspace != nil
            }
            try await load()
        }catch{status=error.localizedDescription}
    }
    private func load() async throws {
        guard let client else{return}
        struct Response:Decodable{let workspaces:[MobileWorkspace];let ownerBenefits:Bool?}
        let response=try JSONDecoder().decode(Response.self,from:await client.json("v2/workspaces"))
        ownerBenefits=response.ownerBenefits == true
        choices=response.workspaces.filter{$0.kind=="paid"&&$0.storageActive&&$0.provisioned}
        if ownerBenefits && !didChooseOwnerWorkspace {if let ownerSpace=choices.first(where:{$0.name=="Owner • All features"}){selected=ownerSpace.id};didChooseOwnerWorkspace=true}
        if selected != "free" && !choices.contains(where:{$0.id==selected}){selected="free"}
        UserDefaults.standard.set(selected,forKey:selectionKey)
        do{let nextConfig=try await client.configuration(workspace:selected);let nextFiles=try await client.list(workspace:selected);config=nextConfig;files=nextFiles;status="Your files are ready."}
        catch let e as GDTransferError where e.status==404 && selected=="free"{config=nil;files=[];status="Create your free 2 GB workspace to begin."}
        catch{config=nil;files=[];throw error}
    }
    func refresh(){guard !busy else{return};busy=true;task=Task{defer{busy=false};do{try await load()}catch{status=error.localizedDescription}}}
    func refreshAndWait() async {refresh();await task?.value}
    func create(){guard !busy,let client else{return};busy=true;task=Task{defer{busy=false};do{
        do{_=try await client.json("v1/free",method:"POST",payload:["name":"My Free Cloud"])}catch let e as GDTransferError where e.status==409{}
        try await load()
    }catch{status=error.localizedDescription}}}
    private func progress(_ p:GDTransferProgress){fraction=p.fraction;detail=p.phase+(p.bytesPerSecond>0 ? String(format:" · %.1f MB/s",p.bytesPerSecond/1e6):"");if let eta=p.secondsRemaining{detail+=String(format:" · ~%.0fs",eta)}}
    func upload(_ urls:[URL]){
        guard !busy,let client,let config,!urls.isEmpty else{return};busy=true;transferring=true;fraction=0
        let workspace=selected,constrained=dataSaver||constrainedNetwork,remove=removeOriginals,limit=config.maxFileBytes
        task=Task{defer{busy=false;transferring=false;removeOriginals=false};do{
            for url in urls {
                try Task.checkCancellation();let access=url.startAccessingSecurityScopedResource();defer{if access{url.stopAccessingSecurityScopedResource()}}
                status="Preparing "+url.lastPathComponent
                let preparation=Task.detached(priority:.utility){try MobileArchive.prepare(url,maximumBytes:limit)}
                let prepared=try await withTaskCancellationHandler(operation:{try await preparation.value},onCancel:{preparation.cancel()})
                defer{if let temporary=prepared.temporaryDirectory{try? FileManager.default.removeItem(at:temporary)}}
                status="Uploading "+url.lastPathComponent
                let item=try await client.upload(source:prepared.uploadURL,workspace:workspace,constrained:constrained){[weak model=self] value in await model?.progress(value)}
                // A full cloud read-back and every archive entry are checked before originals can be removed.
                if remove {
                    status="Checking restored copy of "+url.lastPathComponent
                    let restored=try await client.download(file:item,workspace:workspace,constrained:constrained){[weak model=self] value in await model?.progress(value)}
                    defer{try? FileManager.default.removeItem(at:restored)}
                    let verification=Task.detached(priority:.utility){try MobileArchive.verifyReadback(restored,prepared:prepared)}
                    try await withTaskCancellationHandler(operation:{try await verification.value},onCancel:{verification.cancel()})
                    try Task.checkCancellation()
                    try MobileArchive.removeOriginal(prepared)
                }
            }
            try await load();status=remove ? "Upload and restore check passed. Selected originals removed." : "Upload verified. Your originals are unchanged."
        }catch is CancellationError{status="Paused. Select the same files to resume. Unverified originals were retained."}
        catch{status=error.localizedDescription}}
    }
    func resetLocalState() {
        guard !busy else{return}
        task?.cancel();export=nil;files=[];config=nil;removeOriginals=false;dataSaver=false
        UserDefaults.standard.removeObject(forKey:selectionKey);selected="free";didChooseOwnerWorkspace=true
        let cache=FileManager.default.urls(for:.cachesDirectory,in:.userDomainMask)[0].appendingPathComponent("GenDragoonTransfers/"+GDTransferClient.digest(Data(owner.utf8)))
        do {if FileManager.default.fileExists(atPath:cache.path){try FileManager.default.removeItem(at:cache)};try FileManager.default.createDirectory(at:cache,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]);status="Local settings and transfer cache reset. Cloud and exported files retained.";refresh()}
        catch{status=error.localizedDescription}
    }
    func restore(_ file:GDCloudItem){
        guard !busy,let client else{return};busy=true;transferring=true;fraction=0
        let workspace=selected,constrained=dataSaver||constrainedNetwork
        task=Task{defer{busy=false;transferring=false};do{
            let temporary=try await client.download(file:file,workspace:workspace,constrained:constrained){[weak model=self] value in await model?.progress(value)}
            guard !file.name.contains("/"),!file.name.contains("\\"),file.name != ".",file.name != ".." else{throw GDTransferError(message:"Unsafe file name.",status:0)}
            let directory=FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent("Exports/"+file.id,isDirectory:true)
            try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.protectionKey:FileProtectionType.completeUntilFirstUserAuthentication])
            let destination=directory.appendingPathComponent(file.name)
            if FileManager.default.fileExists(atPath:destination.path){_=try FileManager.default.replaceItemAt(destination,withItemAt:temporary)}else{try FileManager.default.moveItem(at:temporary,to:destination)}
            export=MobileExport(url:destination);status=MobileArchive.isApplication(file.name) ? "Application package restored for storage or transfer to its compatible device. iOS cannot run desktop or Android applications." : "Restored. Save or open this file in another app."
        }catch is CancellationError{status="Paused. Restore this file again to resume."}
        catch{status=error.localizedDescription}}
    }
    func delete(_ file:GDCloudItem){guard !busy,let client else{return};busy=true;let workspace=selected
        task=Task{defer{busy=false};do{try await client.delete(fileID:file.id,workspace:workspace);try await load()}catch{status=error.localizedDescription}}
    }
    func pause(){task?.cancel()}
}
