import SwiftUI
import AppKit

private struct GDStatus:Decodable {let freeWorkspace:GDSpace?}
private struct GDSpace:Decodable {let name:String;let quotaBytes:Int64;let usedBytes:Int64;let workers:Int}
private struct GDList:Decodable {let files:[GDItem]}
private struct GDItem:Decodable,Identifiable {let id:String;let name:String;let sizeBytes:Int64}
private struct GDJob:Decodable {let uploadId:String;let chunkBytes:Int;let totalChunks:Int}
private struct GDError:Decodable {let error:String}

@MainActor final class GDFreeClient:ObservableObject {
 @Published var space:GDSpace?
 @Published var items:[GDItem]=[]
 @Published var status="Connecting to your free cloud…"
 @Published var busy=false
 @Published var fraction=0.0
 var session:GDLoginSession?
 private let host="https://gendragoon-free-10068843866.us-central1.run.app"
 private func call(_ path:String,method:String="GET",body:Data?=nil) async throws -> Data {
  guard let token=session?.verifiedBearerToken(),let url=URL(string:host+path) else {
   throw NSError(domain:"GenDragoon",code:1,userInfo:[NSLocalizedDescriptionKey:"Google sign-in and Terms required"])
  }
  var req=URLRequest(url:url);req.httpMethod=method;req.timeoutInterval=300
  req.setValue("Bearer "+token,forHTTPHeaderField:"Authorization")
  if body != nil {req.setValue("application/json",forHTTPHeaderField:"Content-Type")}
  let (data,res): (Data,URLResponse)
  if let body {(data,res)=try await URLSession.shared.upload(for:req,from:body)}
  else {(data,res)=try await URLSession.shared.data(for:req)}
  let code=(res as? HTTPURLResponse)?.statusCode ?? 0
  guard (200..<300).contains(code) else{
   let error=(try? JSONDecoder().decode(GDError.self,from:data).error) ?? "Cloud unavailable (HTTP \(code))"
   throw NSError(domain:"GenDragoon",code:code,userInfo:[NSLocalizedDescriptionKey:error])
  }
  return data
 }
 func refresh() async {
  guard !busy else{return};busy=true;defer{busy=false}
  do {
   let state=try JSONDecoder().decode(GDStatus.self,from:call("/v1/me"))
   space=state.freeWorkspace
   if space != nil {
    items=try JSONDecoder().decode(GDList.self,from:call("/v1/files")).files
    status="Connected · Private storage · One concurrent transfer"
   }else{items=[];status="Create a free 2 GB private cloud workspace."}
  }catch{status=error.localizedDescription}
 }
 func create() async {
  guard !busy else{return};busy=true;defer{busy=false}
  do{
   let body=try JSONSerialization.data(withJSONObject:["name":"My Free Cloud"])
   _=try await call("/v1/free",method:"POST",body:body)
   busy=false;await refresh()
  }catch{status=error.localizedDescription}
 }
 func upload() async {
  guard !busy,space != nil else{return}
  let panel=NSOpenPanel();panel.canChooseDirectories=false;panel.allowsMultipleSelection=false
  guard panel.runModal()==.OK,let url=panel.url else{return}
  busy=true;fraction=0;defer{busy=false}
  var handle:FileHandle?
  do {
   let attrs=try FileManager.default.attributesOfItem(atPath:url.path)
   let size=(attrs[.size] as? NSNumber)?.int64Value ?? 0
   guard size>0,size<=2_000_000_000 else {throw NSError(domain:"GenDragoon",code:2,userInfo:[NSLocalizedDescriptionKey:"File must be between 1 byte and 2 GB."])}
   let payload=try JSONSerialization.data(withJSONObject:["name":url.lastPathComponent,"sizeBytes":size])
   let job=try JSONDecoder().decode(GDJob.self,from:call("/v1/uploads",method:"POST",body:payload))
   guard job.chunkBytes>0 && job.chunkBytes<=8_388_608 else {throw NSError(domain:"GenDragoon",code:3)}
   handle=try FileHandle(forReadingFrom:url)
   guard let token=session?.verifiedBearerToken() else {throw NSError(domain:"GenDragoon",code:4)}
   for idx in 0..<job.totalChunks {
    let length=Int(min(Int64(job.chunkBytes),size-Int64(idx*job.chunkBytes)))
    guard let data=try handle?.read(upToCount:length),data.count==length else{throw NSError(domain:"GenDragoon",code:5,userInfo:[NSLocalizedDescriptionKey:"File changed during upload"])}
    var req=URLRequest(url:URL(string:host+"/v1/uploads/\(job.uploadId)/chunks/\(idx)")!)
    req.httpMethod="PUT";req.timeoutInterval=300
    req.setValue("Bearer "+token,forHTTPHeaderField:"Authorization")
    let (response,meta)=try await URLSession.shared.upload(for:req,from:data)
    guard (meta as? HTTPURLResponse)?.statusCode==200 else{
     throw NSError(domain:"GenDragoon",code:6,userInfo:[NSLocalizedDescriptionKey:(try? JSONDecoder().decode(GDError.self,from:response).error) ?? "Chunk failed"])
    }
    fraction=Double(idx+1)/Double(job.totalChunks)
    status="Uploading \(url.lastPathComponent) · \(Int(fraction*100))%"
   }
   _=try await call("/v1/uploads/\(job.uploadId)/finalize",method:"POST",body:Data())
   try handle?.close();handle=nil
   busy=false;await refresh();status="File uploaded and verified."
  }catch{try? handle?.close();status=error.localizedDescription}
 }
 func restore(_ file:GDItem) async {
  guard !busy,let token=session?.verifiedBearerToken() else{return}
  let panel=NSSavePanel();panel.nameFieldStringValue=file.name
  guard panel.runModal()==.OK,let dest=panel.url else{return}
  busy=true;defer{busy=false}
  do{
   var req=URLRequest(url:URL(string:host+"/v1/files/\(file.id)/download")!)
   req.setValue("Bearer "+token,forHTTPHeaderField:"Authorization")
   let (tmp,res)=try await URLSession.shared.download(for:req)
   guard (res as? HTTPURLResponse)?.statusCode==200 else {throw NSError(domain:"GenDragoon",code:7,userInfo:[NSLocalizedDescriptionKey:"Download rejected"])}
   let attrs=try FileManager.default.attributesOfItem(atPath:tmp.path)
   guard (attrs[.size] as? NSNumber)?.int64Value==file.sizeBytes else{throw NSError(domain:"GenDragoon",code:8,userInfo:[NSLocalizedDescriptionKey:"Download size mismatch"])}
   if FileManager.default.fileExists(atPath:dest.path){try FileManager.default.removeItem(at:dest)}
   try FileManager.default.moveItem(at:tmp,to:dest)
   status="Restored \(file.name)."
  }catch{status=error.localizedDescription}
 }
 func delete(_ file:GDItem) async{
  guard !busy else{return};busy=true;defer{busy=false}
  do{_ = try await call("/v1/files/\(file.id)",method:"DELETE")
   items.removeAll{$0.id==file.id};status="Deleted \(file.name)."
   busy=false;await refresh()
  }catch{status=error.localizedDescription}
 }
}
struct GenDragoonFreeCloudView:View {
 @EnvironmentObject private var session:GDLoginSession
 @StateObject private var client=GDFreeClient()
 var body:some View{
  VStack(alignment:.leading,spacing:13){
   HStack{
    Label("Private Free Cloud",systemImage:"icloud.fill").font(.system(size:18,weight:.bold))
    Spacer()
    Text("2 GB · 1 WORKER").font(.system(size:11,weight:.heavy)).foregroundStyle(.green)
   }
   Text(client.status).font(.system(size:12)).foregroundStyle(.secondary)
   if let space=client.space{
    ProgressView(value:min(1,Double(space.usedBytes)/Double(max(1,space.quotaBytes)))).tint(.purple)
    Text("\(ByteCountFormatter.string(fromByteCount:space.usedBytes,countStyle:.file)) of 2 GB")
     .font(.system(size:11)).foregroundStyle(.secondary)
    HStack{
     Button("Upload File"){Task{await client.upload()}}.buttonStyle(.borderedProminent).tint(.purple).disabled(client.busy)
     Button("Refresh"){Task{await client.refresh()}}.disabled(client.busy)
    }
    if client.busy{ProgressView(value:client.fraction)}
    ForEach(client.items){file in
     HStack{
      Image(systemName:"doc.fill").foregroundStyle(.purple)
      VStack(alignment:.leading,spacing:3){
       Text(file.name).font(.system(size:12,weight:.semibold))
       Text(ByteCountFormatter.string(fromByteCount:file.sizeBytes,countStyle:.file))
        .font(.system(size:10)).foregroundStyle(.secondary)
      }
      Spacer()
      Button("Restore"){Task{await client.restore(file)}}.disabled(client.busy)
      Button("Delete",role:.destructive){Task{await client.delete(file)}}.disabled(client.busy)
     }.padding(9).background(.white.opacity(0.05),in:RoundedRectangle(cornerRadius:10))
    }
   }else{
    Button("Create My Free Cloud"){Task{await client.create()}}
     .buttonStyle(.borderedProminent).tint(.purple).disabled(client.busy)
   }
  }.padding(22).background(.white.opacity(0.055),in:RoundedRectangle(cornerRadius:17))
   .task{client.session=session;await client.refresh()}
 }
}
