import Foundation
import CryptoKit
import Darwin
import Security

struct GDTransferProfile:Decodable,Sendable {
    let workers:Int
    let chunkBytes:Int
    let recommendedMobileWorkers:Int
}
struct GDTransferConfig:Decodable,Sendable {
    let workspaceId:String
    let name:String
    let quotaBytes:Int64
    let usedBytes:Int64
    let reservedBytes:Int64
    let maxFileBytes:Int64
    let transfer:GDTransferProfile
}
struct GDCloudItem:Decodable,Identifiable,Sendable {
    let id:String
    let name:String
    let sizeBytes:Int64
    let generation:String?
    let crc32c:String?
    let kind:String?
    let originalName:String?
    let archiveFormat:String?
    let manifestSHA256:String?
    let logicalBytes:Int64?
    var displayName:String { originalName ?? name }
    var displaySize:Int64 { logicalBytes ?? sizeBytes }
    var isPackage:Bool { archiveFormat == "gendragoon-package-v1" }
    var itemKind:String { kind ?? "file" }
}
struct GDCloudUploadMetadata:Sendable {
    let kind:String
    let originalName:String
    let archiveFormat:String
    let manifestSHA256:String
    let logicalBytes:Int64
}
struct GDTransferListing:Decodable,Sendable {
    let files:[GDCloudItem]
    let nextCursor:String?
    let workers:Int
}
struct GDTransferProgress:Sendable {
    let completed:Int64
    let total:Int64
    let bytesPerSecond:Double
    let phase:String
    var fraction:Double {total>0 ? min(1,Double(completed)/Double(total)):1}
    var secondsRemaining:Double? {bytesPerSecond>0 ? Double(max(0,total-completed))/bytesPerSecond:nil}
}
struct GDTransferError:LocalizedError,Sendable {
    let message:String
    let status:Int
    var errorDescription:String? {message}
}
private struct GDTransferJob:Decodable,Sendable {
    let uploadId:String
    let status:String
    let chunkBytes:Int
    let totalChunks:Int
    let sizeBytes:Int64
    let receivedRanges:[[Int]]
    let uploadedBytes:Int64
}
private struct GDDownloadCheckpoint:Codable {
    var etag:String
    var size:Int64
    var ranges:[[Int]]
    var chunkBytes:Int?
}

/// Foundation-only transport shared by macOS and iOS. No shell, rclone, UI or embedded secrets.
actor GDTransferClient {
    typealias TokenProvider = @Sendable (Bool) async throws -> String
    typealias Progress = @Sendable (GDTransferProgress) async -> Void
    private let endpoint:URL
    private let accountID:String
    private let tokens:TokenProvider
    private let session:URLSession
    private let root:URL
    private let decoder=JSONDecoder()
    private var budget=GDTransferBudget()
    private var uploadedStates:[String:URL]=[:]
    init(endpoint:URL,accountID:String,tokenProvider:@escaping TokenProvider) throws {
        guard endpoint.scheme=="https",endpoint.host != nil,endpoint.user==nil,endpoint.password==nil,
              endpoint.query==nil,endpoint.fragment==nil else {
            throw GDTransferError(message:"A secure cloud endpoint is required.",status:0)
        }
        self.endpoint=endpoint;self.accountID=accountID;self.tokens=tokenProvider
        let config=URLSessionConfiguration.ephemeral
        config.httpMaximumConnectionsPerHost=24
        config.timeoutIntervalForRequest=120
        config.timeoutIntervalForResource=300
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session=URLSession(configuration:config)
        let cache=FileManager.default.urls(for:.cachesDirectory,in:.userDomainMask)[0]
        self.root=cache.appendingPathComponent("GenDragoonTransfers/"+Self.digest(Data(accountID.utf8)),isDirectory:true)
        for directory in [root.deletingLastPathComponent(),root] {
            if FileManager.default.fileExists(atPath:directory.path) {
                let attributes=try FileManager.default.attributesOfItem(atPath:directory.path)
                guard attributes[.type] as? FileAttributeType == .typeDirectory,
                      (attributes[.ownerAccountID] as? NSNumber)?.uint32Value==getuid(),
                      ((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0)&0o022==0 else {
                    throw GDTransferError(message:"The local transfer cache has unsafe permissions. Sign out and back in before starting a transfer.",status:0)
                }
            }
        }
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
    }
    static func digest(_ data:Data)->String {SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined()}
    private func safeWorkspace(_ id:String)throws->String {
        guard id=="free" || UUID(uuidString:id) != nil else {throw GDTransferError(message:"Invalid workspace.",status:400)}
        return "v3/cloud/"+id.lowercased()
    }
    private func send(_ path:String,method:String="GET",data:Data?=nil,headers:[String:String]=[:],query:[URLQueryItem]=[]) async throws -> (Data,HTTPURLResponse) {
        var last:Error=GDTransferError(message:"Transfer failed.",status:0)
        for attempt in 0..<5 {
            try Task.checkCancellation()
            do {
                guard var parts=URLComponents(url:endpoint.appendingPathComponent(path),resolvingAgainstBaseURL:false) else {
                    throw GDTransferError(message:"Invalid cloud request.",status:400)
                }
                parts.queryItems=query.isEmpty ? nil:query
                guard let url=parts.url else {throw GDTransferError(message:"Invalid cloud request.",status:400)}
                var request=URLRequest(url:url)
                request.httpMethod=method;request.httpBody=data
                request.setValue("Bearer "+(try await tokens(attempt>0)),forHTTPHeaderField:"Authorization")
                request.setValue("identity",forHTTPHeaderField:"Accept-Encoding")
                request.setValue("application/json",forHTTPHeaderField:"Accept")
                if data != nil {request.setValue("application/json",forHTTPHeaderField:"Content-Type")}
                for(key,value) in headers {request.setValue(value,forHTTPHeaderField:key)}
                let(body,response)=try await session.data(for:request)
                guard let http=response as? HTTPURLResponse else {throw GDTransferError(message:"No cloud response.",status:0)}
                let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
                let reason = GDServerCode.read(object)
                if http.statusCode == 423, reason == "workspace_lock" {
                    Task { @MainActor in GDWorkspaceLock.shared.present(json: object) }
                    let message = GDStorageContract.downloadStaysAvailable(method: method)
                        ? "Downloads stay available. Delete or merge the extra workspaces before uploading."
                        : "This account is over its workspace limit. Delete or merge the extra workspaces. Downloads stay available."
                    throw GDTransferError(message: message, status: 423)
                }
                if (200...299).contains(http.statusCode){return(body,http)}
                if let explained = GDStorageContract.byoMessage(code: reason, status: http.statusCode) {
                    throw GDTransferError(message: explained, status: http.statusCode)
                }
                if let explained = GDStorageContract.explainProjectWrite(status: http.statusCode, json: object) {
                    throw GDTransferError(message: explained, status: http.statusCode)
                }
                if http.statusCode == 400, reason == "manifest_generation_required" {
                    throw GDTransferError(message: "The manifest upload was missing its generation. This is a client bug, and the file was not replaced.", status: 400)
                }
                let failure=GDTransferError(message:reason.isEmpty ? "Cloud request failed (HTTP \(http.statusCode))." : reason,status:http.statusCode)
                if ![401,408,429,500,502,503,504].contains(http.statusCode){throw failure}
                last=failure
            } catch let error as GDTransferError {
                if error.status != 0 && ![401,408,429,500,502,503,504].contains(error.status){throw error}
                last=error
            } catch {
                if Task.isCancelled {throw CancellationError()}
                last=error
            }
            if attempt<4 {try await Task.sleep(nanoseconds:UInt64(250_000_000*(1<<attempt))+UInt64.random(in:0...100_000_000))}
        }
        throw last
    }
    func json(_ path:String,method:String="GET",payload:[String:String]?=nil) async throws -> Data {
        let body=try payload.map{try JSONSerialization.data(withJSONObject:$0)}
        return try await send(path,method:method,data:body).0
    }
    func jsonData(_ path:String,method:String="GET",payload:Data?=nil,query:[URLQueryItem]=[]) async throws -> Data {
        try await send(path,method:method,data:payload,query:query).0
    }
    func configuration(workspace:String) async throws -> GDTransferConfig {
        let path=try safeWorkspace(workspace)
        let c=try decoder.decode(GDTransferConfig.self,from:await send(path+"/config").0)
        guard c.workspaceId.lowercased()==workspace.lowercased(),c.quotaBytes>=0,c.usedBytes>=0,c.reservedBytes>=0,c.maxFileBytes>0,
              (1...24).contains(c.transfer.workers),c.transfer.chunkBytes>0,c.transfer.chunkBytes<=8*1024*1024 else {
            throw GDTransferError(message:"Invalid server transfer profile.",status:0)
        }
        return c
    }
    func list(workspace:String) async throws -> [GDCloudItem] {
        let path=try safeWorkspace(workspace);var files:[GDCloudItem]=[],cursor:String?,seen=Set<String>()
        repeat {
            let query=cursor.map{[URLQueryItem(name:"cursor",value:$0)]} ?? []
            let page=try decoder.decode(GDTransferListing.self,from:await send(path+"/files",query:query).0)
            files+=page.files;cursor=page.nextCursor
            if let cursor {
                guard UUID(uuidString:cursor) != nil,seen.insert(cursor).inserted,files.count<=500_000 else {
                    throw GDTransferError(message:"Invalid or repeated file-list page. Refresh this project.",status:0)
                }
            }
        } while cursor != nil
        return files
    }
    private func workers(_ c:GDTransferConfig,constrained:Bool)->Int {
        if constrained {return 1}
        #if os(iOS)
        if ProcessInfo.processInfo.isLowPowerModeEnabled {return 1}
        return min(c.transfer.workers,max(1,min(4,c.transfer.recommendedMobileWorkers)))
        #else
        return c.transfer.workers
        #endif
    }
    private static func contains(_ ranges:[[Int]],_ index:Int)->Bool {ranges.contains{$0.count==2 && index >= $0[0] && index <= $0[1]}}
    private static func adding(_ ranges:[[Int]],_ index:Int)->[[Int]] {
        let sorted=(ranges+[[index,index]]).sorted{$0[0]<$1[0]};var out:[[Int]]=[]
        for pair in sorted {if let last=out.last,pair[0]<=last[1]+1 {out[out.count-1][1]=max(last[1],pair[1])}else{out.append(pair)}}
        return out
    }
    private func persist(_ data:Data,to url:URL)throws {
        try data.write(to:url,options:.atomic)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:url.path)
    }
    private func openDownload(_ url:URL)throws->FileHandle {
        let descriptor=Darwin.open(url.path,O_RDWR|O_CREAT|O_NOFOLLOW,0o600)
        guard descriptor>=0 else {throw GDTransferError(message:"Could not open a private download cache. The destination was not changed.",status:0)}
        var info=stat()
        guard fstat(descriptor,&info)==0,(info.st_mode&S_IFMT)==S_IFREG,info.st_nlink==1,
              info.st_uid==getuid(),info.st_mode&0o077==0 else {
            Darwin.close(descriptor)
            throw GDTransferError(message:"The download cache is shared or linked. The destination was not changed.",status:0)
        }
        return FileHandle(fileDescriptor:descriptor,closeOnDealloc:true)
    }
    private static func attributes(_ file:URL)throws->(Int64,Date) {
        let a=try FileManager.default.attributesOfItem(atPath:file.path)
        guard a[.type] as? FileAttributeType == .typeRegular,let n=a[.size] as? NSNumber,let date=a[.modificationDate] as? Date else {
            throw GDTransferError(message:"Choose a regular file. Archive folders or app bundles first.",status:0)
        }
        return(n.int64Value,date)
    }
    private func uploadPart(path:String,id:String,index:Int,source:URL,size:Int64,date:Date,chunkBytes:Int) async throws -> Int64 {
        let now=try Self.attributes(source)
        guard now.0==size,now.1==date else {throw GDTransferError(message:"The source file changed. Upload stopped without deleting it.",status:0)}
        let handle=try FileHandle(forReadingFrom:source);defer{try? handle.close()}
        let offset=Int64(index)*Int64(chunkBytes),length=Int(min(Int64(chunkBytes),size-offset))
        try handle.seek(toOffset:UInt64(offset))
        guard let data=try handle.read(upToCount:length),data.count==length else {throw GDTransferError(message:"Source read interrupted.",status:0)}
        _=try await send(path+"/uploads/"+id+"/chunks/\(index)",method:"PUT",data:data,
            headers:["Content-Type":"application/octet-stream","Content-Length":String(data.count),"X-Chunk-SHA256":Self.digest(data)])
        return Int64(data.count)
    }
    @discardableResult func upload(source:URL,workspace:String,constrained:Bool=false,metadata:GDCloudUploadMetadata?=nil,maximumWorkers:Int?=nil,progress:@escaping Progress) async throws -> GDCloudItem {
        let c=try await configuration(workspace:workspace),path=try safeWorkspace(workspace)
        let(size,date)=try Self.attributes(source)
        guard size>=0,size<=c.maxFileBytes else {throw GDTransferError(message:"File exceeds this workspace's file limit.",status:0)}
        let name=metadata?.originalName ?? source.lastPathComponent
        let metadataKey=metadata?.manifestSHA256 ?? "raw"
        let key=Self.digest(Data((workspace+"|"+source.path+"|\(size)|\(date.timeIntervalSince1970)|"+metadataKey).utf8))
        let lease="upload-"+key
        let limit=try budget.reserve(key:lease,verifiedLimit:workers(c,constrained:constrained),requestedWorkers:maximumWorkers)
        defer{budget.release(key:lease)}
        let state=root.appendingPathComponent("upload-"+key+".json")
        var id=(try? String(contentsOf:state,encoding:.utf8)) ?? UUID().uuidString.lowercased()
        if UUID(uuidString:id)==nil{id=UUID().uuidString.lowercased()}
        try persist(Data(id.utf8),to:state)
        var request:[String:Any]=["requestId":id,"name":name,"sizeBytes":size]
        if let metadata {
            request["kind"]=metadata.kind;request["originalName"]=metadata.originalName
            request["archiveFormat"]=metadata.archiveFormat;request["manifestSHA256"]=metadata.manifestSHA256
            request["logicalBytes"]=metadata.logicalBytes
        }
        let payload=try JSONSerialization.data(withJSONObject:request)
        let job=try decoder.decode(GDTransferJob.self,from:await send(path+"/uploads",method:"POST",data:payload).0)
        guard job.uploadId==id,job.sizeBytes==size,job.chunkBytes==c.transfer.chunkBytes,
              job.totalChunks==Int((size+Int64(job.chunkBytes)-1)/Int64(job.chunkBytes)) else {throw GDTransferError(message:"Invalid upload session.",status:0)}
        guard ["active","assembling","completed"].contains(job.status) else {try? FileManager.default.removeItem(at:state);throw GDTransferError(message:"Old upload expired. Select the file again to start a fresh upload.",status:409)}
        let count=job.totalChunks,start=ProcessInfo.processInfo.systemUptime
        var done=job.uploadedBytes,next=0
        if job.status=="active" {
            try await withThrowingTaskGroup(of:Int64.self){group in
                func addNext()->Bool {
                    while next<count && Self.contains(job.receivedRanges,next){next+=1}
                    guard next<count else{return false}
                    let index=next;next+=1
                    group.addTask {try await self.uploadPart(path:path,id:id,index:index,source:source,size:size,date:date,chunkBytes:job.chunkBytes)}
                    return true
                }
                for _ in 0..<limit{if !addNext(){break}}
                while let bytes=try await group.next(){
                    done+=bytes
                    let speed=Double(done-job.uploadedBytes)/max(0.001,ProcessInfo.processInfo.systemUptime-start)
                    await progress(GDTransferProgress(completed:done,total:size,bytesPerSecond:speed,phase:"Uploading"))
                    _=addNext()
                }
            }
        }
        let finalAttrs=try Self.attributes(source)
        guard finalAttrs.0==size,finalAttrs.1==date else {throw GDTransferError(message:"Source changed before completion. Original retained.",status:0)}
        while job.status != "completed" {
            try Task.checkCancellation()
            let(_,http)=try await send(path+"/uploads/"+id+"/finalize",method:"POST",data:Data("{}".utf8))
            if http.statusCode==200{break}
            guard http.statusCode==202 else{throw GDTransferError(message:"Invalid finalize response.",status:http.statusCode)}
            await progress(GDTransferProgress(completed:size,total:size,bytesPerSecond:0,phase:"Verifying cloud file"))
            try await Task.sleep(nanoseconds:1_000_000_000)
        }
        guard let saved=try await list(workspace:workspace).first(where:{$0.id==id}),saved.sizeBytes==size,
              saved.displayName==name, saved.crc32c?.isEmpty==false else {
            throw GDTransferError(message:"Upload finished, but its verified cloud record is not available yet. Refresh this project before retrying; originals remain on your Mac.",status:0)
        }
        if let metadata {
            guard saved.archiveFormat==metadata.archiveFormat,saved.manifestSHA256==metadata.manifestSHA256,
                  saved.itemKind==metadata.kind,saved.logicalBytes==metadata.logicalBytes else {
                throw GDTransferError(message:"Cloud package metadata did not match the prepared source. Original retained.",status:0)
            }
        }
        if metadata == nil {try? FileManager.default.removeItem(at:state)}
        else {uploadedStates[saved.id]=state}
        await progress(GDTransferProgress(completed:size,total:size,bytesPerSecond:0,phase:"Saved and verified"))
        return saved
    }
    /// Each encrypted chunk is its own object. The file-name list is the `manifest`
    /// object, uploaded with the generation from the download. The local file stays
    /// until that manifest put succeeds and the chunks open again.
    func hostedRoundTrip(source:URL,workspace:String,metadata:GDCloudUploadMetadata,progress:@escaping Progress) async throws -> (item:GDCloudItem,file:URL) {
        let (size, _) = try Self.attributes(source)
        guard size >= 0, size <= 5 * 1024 * 1024 * 1024 else { throw GDTransferError(message:"File exceeds this workspace's file limit.",status:0) }
        let key = try GDHostedVault.key()
        let chunkBytes = 1024 * 1024
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        var crc: UInt32 = 0xffffffff
        var previous: Data?
        var index: UInt32 = 0
        var total = 0
        var chunkIDs: [String] = []
        var batch: [(id: String, sealed: Data)] = []
        func flush() async throws {
            guard !batch.isEmpty else { return }
            let session = try await storageSession(workspace: workspace, body: GDStorageContract.uploadBody(objectIDs: batch.map(\.id)))
            for item in batch {
                guard let signed = session.urls.first(where: { $0.object == item.id }) else {
                    throw GDTransferError(message:"Storage did not return a URL for every chunk.",status:0)
                }
                _ = try await Self.signedTransfer(url: signed.url, method: signed.method, body: item.sealed)
            }
            batch.removeAll(keepingCapacity: true)
        }
        func enqueue(_ plain: Data, final: Bool) async throws {
            let identifier = try Self.opaqueObjectID()
            let sealed = try GDSealedManifest.sealChunk(plaintext: plain, key: key, index: index, isFinal: final)
            chunkIDs.append(identifier)
            batch.append((identifier, sealed))
            index += 1
            if batch.count == 32 { try await flush() }
        }
        await progress(GDTransferProgress(completed: 0, total: size, bytesPerSecond: 0, phase: "Uploading sealed file"))
        while true {
            try Task.checkCancellation()
            let chunk = try input.read(upToCount: chunkBytes) ?? Data()
            if chunk.isEmpty { break }
            if let previous {
                try await enqueue(previous, final: false)
            }
            crc = GDCRC32C.value(chunk, seed: crc)
            total += chunk.count
            previous = chunk
            await progress(GDTransferProgress(completed: Int64(total), total: size, bytesPerSecond: 0, phase: "Uploading sealed file"))
        }
        if let previous {
            try await enqueue(previous, final: true)
        } else {
            try await enqueue(Data(), final: true)
        }
        try await flush()
        guard total == Int(size), chunkIDs.count > 0 else {
            throw GDTransferError(message:"The source file changed. Upload stopped without deleting it.",status:0)
        }
        let fileEntry = GDManifestFile(name: metadata.originalName, chunkCount: chunkIDs.count, totalSize: total, chunks: chunkIDs)
        let lastSeen = UserDefaults.standard.integer(forKey: GDSealedManifest.versionKey(workspace: workspace))
        try await commitManifest(workspace: workspace, file: fileEntry, key: key, lastSeen: lastSeen)
        await progress(GDTransferProgress(completed: size, total: size, bytesPerSecond: 0, phase: "Downloading sealed file"))
        let restored = try await restoreChunks(ids: chunkIDs, workspace: workspace, key: key, totalSize: total)
        var final = (crc ^ 0xffffffff).bigEndian
        let checksum = withUnsafeBytes(of: &final) { Data($0).base64EncodedString() }
        let item = GDCloudItem(id: UUID().uuidString.lowercased(), name: GDSealedManifest.objectID, sizeBytes: size, generation: nil,
            crc32c: checksum, kind: metadata.kind, originalName: metadata.originalName,
            archiveFormat: metadata.archiveFormat, manifestSHA256: metadata.manifestSHA256, logicalBytes: metadata.logicalBytes)
        await progress(GDTransferProgress(completed: size, total: size, bytesPerSecond: 0, phase: "Saved and verified"))
        return (item, restored)
    }
    private func storageSession(workspace: String, body: [String: Any]) async throws -> GDStorageSession {
        let payload = try JSONSerialization.data(withJSONObject: body)
        let data = try await send("v2/workspaces/\(workspace)/storage-urls", method: "POST", data: payload).0
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw GDTransferError(message:"Storage session was empty.",status:0)
        }
        do {
            return try GDStorageContract.parseSession(workspace: workspace, json: json)
        } catch let error as GDStorageContractError {
            throw GDTransferError(message: error.text, status: 0)
        }
    }
    private func commitManifest(workspace: String, file: GDManifestFile, key: SymmetricKey, lastSeen: Int) async throws {
        let local = GDSealedManifestDocument(version: lastSeen, files: [file])
        for _ in 0..<4 {
            let download = try await storageSession(workspace: workspace, body: GDStorageContract.downloadBody(objectIDs: [GDSealedManifest.objectID]))
            guard let source = download.urls.first(where: { $0.object == GDSealedManifest.objectID }) else {
                throw GDTransferError(message:"Storage did not return a manifest URL.",status:0)
            }
            let fetched = try await Self.signedExchange(url: source.url, method: source.method, body: nil)
            let generation = GDSealedManifest.generation(objectStatus: fetched.status, headers: fetched.headers)
            guard let generationValue = GDSealedManifest.generationValue(generation) else {
                throw GDTransferError(message:"The manifest download did not include a generation. This Mac will not upload without it.",status:0)
            }
            let remote: GDSealedManifestDocument
            switch generation {
            case .absentObject:
                remote = GDSealedManifestDocument(version: 0, files: [])
            case .value:
                do { remote = try GDSealedManifest.open(sealed: fetched.data, key: key) }
                catch { throw GDTransferError(message:"The stored file list could not be opened.",status:0) }
            case .missing:
                throw GDTransferError(message:"The manifest download did not include a generation. This Mac will not upload without it.",status:0)
            }
            let merged: GDSealedManifestDocument
            do { merged = try GDSealedManifest.merge(local: local, remote: remote, lastSeen: lastSeen) }
            catch let error as GDStorageContractError { throw GDTransferError(message: error.text, status: 0) }
            let sealed = try GDSealedManifest.seal(document: merged, key: key)
            let payload = try JSONSerialization.data(withJSONObject: GDSealedManifest.uploadBody(generation: generationValue))
            let uploadData: Data
            do {
                uploadData = try await send("v2/workspaces/\(workspace)/storage-urls", method: "POST", data: payload).0
            } catch let error as GDTransferError {
                switch GDSealedManifest.interpretUpload(status: error.status, json: ["error": error.message]) {
                case .retryMerge: continue
                case .clientBug:
                    throw GDTransferError(message:"The manifest upload was missing its generation. This is a client bug, and the file was not replaced.",status:400)
                case .committed, .failed: throw error
                }
            }
            guard let uploadJSON = try JSONSerialization.jsonObject(with: uploadData) as? [String: Any] else {
                throw GDTransferError(message:"Storage session was empty.",status:0)
            }
            let session: GDStorageSession
            do { session = try GDStorageContract.parseSession(workspace: workspace, json: uploadJSON) }
            catch let error as GDStorageContractError { throw GDTransferError(message: error.text, status: 0) }
            guard let target = session.urls.first(where: { $0.object == GDSealedManifest.objectID }) else {
                throw GDTransferError(message:"Storage did not return a manifest upload URL.",status:0)
            }
            let put = try await Self.signedExchange(url: target.url, method: target.method, body: sealed)
            switch GDSealedManifest.interpretUpload(status: put.status, json: [:]) {
            case .committed:
                UserDefaults.standard.set(merged.version, forKey: GDSealedManifest.versionKey(workspace: workspace))
                return
            case .retryMerge:
                continue
            case .clientBug:
                throw GDTransferError(message:"The manifest upload was missing its generation. This is a client bug, and the file was not replaced.",status:400)
            case .failed:
                throw GDTransferError(message:"The sealed manifest was not stored.",status:put.status)
            }
        }
        throw GDTransferError(message:"The manifest changed while it was being saved. The original file is still on this Mac.",status:412)
    }
    private func restoreChunks(ids: [String], workspace: String, key: SymmetricKey, totalSize: Int) async throws -> URL {
        let restored = root.appendingPathComponent("hosted-"+UUID().uuidString.lowercased()+".part")
        FileManager.default.createFile(atPath: restored.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let output = try FileHandle(forWritingTo: restored)
        defer { try? output.close() }
        var written = 0
        var offset = 0
        while offset < ids.count {
            let end = min(offset + 32, ids.count)
            let slice = Array(ids[offset..<end])
            let session = try await storageSession(workspace: workspace, body: GDStorageContract.downloadBody(objectIDs: slice))
            for (delta, identifier) in slice.enumerated() {
                guard let signed = session.urls.first(where: { $0.object == identifier }) else {
                    throw GDTransferError(message:"Storage did not return a URL for every chunk.",status:0)
                }
                let sealed = try await Self.signedTransfer(url: signed.url, method: signed.method, body: nil)
                let position = offset + delta
                let plain: Data
                do {
                    plain = try GDSealedManifest.openChunk(sealed: sealed, key: key, index: UInt32(position), isFinal: position == ids.count - 1)
                } catch {
                    throw GDTransferError(message:"The downloaded file failed its integrity check.",status:0)
                }
                try output.write(contentsOf: plain)
                written += plain.count
            }
            offset = end
        }
        guard written == totalSize else {
            throw GDTransferError(message:"The downloaded file failed its integrity check.",status:0)
        }
        return restored
    }
    private static func opaqueObjectID() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw GDTransferError(message:"The file could not be sealed on this Mac.",status:0)
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
    private static func signedExchange(url: URL, method: String, body: Data?) async throws -> (status: Int, data: Data, headers: [String: String]) {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 300
        if body != nil {
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as? HTTPURLResponse
        var headers: [String: String] = [:]
        for (key, value) in http?.allHeaderFields ?? [:] {
            if let key = key as? String, let value = value as? String { headers[key.lowercased()] = value }
        }
        return (http?.statusCode ?? 0, data, headers)
    }
    private static func signedTransfer(url: URL, method: String, body: Data?) async throws -> Data {
        let exchanged = try await signedExchange(url: url, method: method, body: body)
        guard (200...299).contains(exchanged.status) else {
            throw GDTransferError(message:"The signed storage URL was refused (HTTP \(exchanged.status)).",status:exchanged.status)
        }
        return exchanged.data
    }
    func acknowledgeUpload(fileID:String) {
        if let state=uploadedStates.removeValue(forKey:fileID) {try? FileManager.default.removeItem(at:state)}
    }
    private func downloadPart(path:String,index:Int,chunk:Int,size:Int64,etag:String) async throws -> (Int,Data) {
        let start=Int64(index)*Int64(chunk),end=min(size-1,start+Int64(chunk)-1)
        let(data,http)=try await send(path,headers:["Range":"bytes=\(start)-\(end)","If-Match":etag])
        guard http.statusCode==206,http.value(forHTTPHeaderField:"Content-Range")=="bytes \(start)-\(end)/\(size)",
              http.value(forHTTPHeaderField:"ETag")==etag,Int64(data.count)==end-start+1 else {
            throw GDTransferError(message:"Cloud file changed or returned an invalid byte range.",status:0)
        }
        return(index,data)
    }
    func download(file:GDCloudItem,workspace:String,constrained:Bool=false,maximumWorkers:Int?=nil,progress:@escaping Progress) async throws -> URL {
        guard UUID(uuidString:file.id) != nil,file.sizeBytes>=0 else {throw GDTransferError(message:"Invalid file.",status:0)}
        let c=try await configuration(workspace:workspace),path=try safeWorkspace(workspace)+"/files/"+file.id+"/download"
        let lease="download-"+workspace.lowercased()+"-"+file.id.lowercased()
        let limit=try budget.reserve(key:lease,verifiedLimit:workers(c,constrained:constrained),requestedWorkers:maximumWorkers,downloadBytes:file.sizeBytes)
        defer{budget.release(key:lease)}
        let(_,head)=try await send(path,method:"HEAD")
        guard let etag=head.value(forHTTPHeaderField:"ETag"),head.value(forHTTPHeaderField:"Content-Length")==String(file.sizeBytes) else{throw GDTransferError(message:"File metadata changed. Refresh the file list.",status:0)}
        let key=Self.digest(Data((workspace+"|"+file.id).utf8)),state=root.appendingPathComponent("download-"+key+".json"),target=root.appendingPathComponent("download-"+key+".part")
        let chunk=c.transfer.chunkBytes,count=Int((file.sizeBytes+Int64(chunk)-1)/Int64(chunk))
        var checkpoint=(try? decoder.decode(GDDownloadCheckpoint.self,from:Data(contentsOf:state))) ?? GDDownloadCheckpoint(etag:etag,size:file.sizeBytes,ranges:[],chunkBytes:chunk)
        let validRanges=checkpoint.ranges.count<=count && checkpoint.ranges.allSatisfy{$0.count==2 && $0[0]>=0 && $0[1]>=$0[0] && $0[1]<count}
        let orderedRanges=zip(checkpoint.ranges,checkpoint.ranges.dropFirst()).allSatisfy{pair in pair.0.count==2 && pair.1.count==2 && pair.0[1]<pair.1[0]}
        if checkpoint.etag != etag || checkpoint.size != file.sizeBytes || checkpoint.chunkBytes != chunk || !validRanges || !orderedRanges || !FileManager.default.fileExists(atPath:target.path){
            checkpoint=GDDownloadCheckpoint(etag:etag,size:file.sizeBytes,ranges:[],chunkBytes:chunk)
            try? FileManager.default.removeItem(at:target)
        }
        var done:Int64=0
        for r in checkpoint.ranges{for i in r[0]...r[1]{done+=min(Int64(chunk),file.sizeBytes-Int64(i)*Int64(chunk))}}
        let fs=try FileManager.default.attributesOfFileSystem(forPath:root.path)
        let free=(fs[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
        #if os(iOS)
        let reserve:Int64=512*1024*1024
        #else
        let reserve:Int64=10*1024*1024*1024
        #endif
        guard free>=budget.reservedDownloadBytes-done+reserve else {throw GDTransferError(message:"Not enough local cache space to restore the active files safely.",status:0)}
        let handle=try openDownload(target);defer{try? handle.close()}
        let originalRanges=checkpoint.ranges,initial=done,start=ProcessInfo.processInfo.systemUptime
        var next=0
        try await withThrowingTaskGroup(of:(Int,Data).self){group in
            func addNext()->Bool {
                while next<count && Self.contains(originalRanges,next){next+=1}
                guard next<count else{return false};let index=next;next+=1
                group.addTask{try await self.downloadPart(path:path,index:index,chunk:chunk,size:file.sizeBytes,etag:etag)}
                return true
            }
            for _ in 0..<limit{if !addNext(){break}}
            while let(index,part)=try await group.next(){
                try handle.seek(toOffset:UInt64(index)*UInt64(chunk));try handle.write(contentsOf:part);try handle.synchronize()
                checkpoint.ranges=Self.adding(checkpoint.ranges,index)
                try persist(JSONEncoder().encode(checkpoint),to:state)
                done+=Int64(part.count)
                await progress(GDTransferProgress(completed:done,total:file.sizeBytes,bytesPerSecond:Double(done-initial)/max(0.001,ProcessInfo.processInfo.systemUptime-start),phase:"Restoring"))
                _=addNext()
            }
        }
        try handle.truncate(atOffset:UInt64(file.sizeBytes));try handle.synchronize()
        let checksum=file.crc32c ?? head.value(forHTTPHeaderField:"X-Goog-Hash")?.split(separator:",").first(where:{$0.trimmingCharacters(in:.whitespaces).hasPrefix("crc32c=")}).map{String($0.trimmingCharacters(in:.whitespaces).dropFirst(7))}
        if let crc=checksum,!crc.isEmpty {
            await progress(GDTransferProgress(completed:done,total:file.sizeBytes,bytesPerSecond:0,phase:"Checking restored file"))
            if try GDCRC32C.file(target) != crc {
                try? FileManager.default.removeItem(at:state);try? FileManager.default.removeItem(at:target)
                throw GDTransferError(message:"Restored checksum mismatch. The destination was not changed.",status:0)
            }
        }else {throw GDTransferError(message:"The cloud copy has no integrity checksum. Refresh the project before restoring it.",status:0)}
        try? FileManager.default.removeItem(at:state)
        return target
    }
    func delete(fileID:String,workspace:String) async throws {
        guard UUID(uuidString:fileID) != nil else{throw GDTransferError(message:"Invalid file.",status:0)}
        _=try await send(safeWorkspace(workspace)+"/files/"+fileID,method:"DELETE")
    }
}
enum GDHostedVault {
    private static let service = "app.gendragoon.cloudssd"
    private static let account = "hosted-aes-256"
    static func key() throws -> SymmetricKey {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data, data.count == 32 {
            return SymmetricKey(data: data)
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw GDTransferError(message: "Could not create the device encryption key.", status: 0)
        }
        let data = Data(bytes)
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else {
            throw GDTransferError(message: "Could not save the device encryption key in the Keychain.", status: 0)
        }
        return SymmetricKey(data: data)
    }
}
enum GDCRC32C {
    static let table:[UInt32]=(0..<256).map{n in var c=UInt32(n);for _ in 0..<8{c=(c&1)==1 ? 0x82f63b78^(c>>1):c>>1};return c}
    static func value(_ data:Data,seed:UInt32=0xffffffff)->UInt32 {var crc=seed;for byte in data{crc=table[Int((crc^UInt32(byte))&0xff)]^(crc>>8)};return crc}
    static func file(_ url:URL)throws->String {
        let h=try FileHandle(forReadingFrom:url);defer{try? h.close()};var crc:UInt32=0xffffffff
        while let data=try h.read(upToCount:1024*1024),!data.isEmpty{crc=value(data,seed:crc)}
        var final=(crc^0xffffffff).bigEndian
        return withUnsafeBytes(of:&final){Data($0).base64EncodedString()}
    }
}
