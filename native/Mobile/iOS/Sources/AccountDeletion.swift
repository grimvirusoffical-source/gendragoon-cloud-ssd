import Foundation
import Security

/// Account-deletion state machine. Freshness is the Firebase ID token `auth_time` claim.
/// `DELETE /v2/account` sends `{"confirm":"DELETE"}` and returns `202` with `jobId` and `statusToken`.
/// A repeat delete returns `410 {"error":"account_deleted","jobId","statusToken"}`.
/// Status is only `deletionStatusPath`, authorized with the status token.
/// The JSON field is `status` (`queued | running | done | failed`) plus `retryable`.
/// Local keys are wiped only after `done`.
struct AccountDeletion:Equatable {
    enum Step:Equatable,Hashable { case explain, confirm, reauth, deleting, polling, done, failed, wiped, signedOut }
    static let confirmPhrase="DELETE"
    static let freshSeconds:TimeInterval=300
    static let pollLimit=90
    static let confirmJSON="{\"confirm\":\"DELETE\"}"
    static let confirmContentType="application/json"
    static let confirmBody=Data("{\"confirm\":\"DELETE\"}".utf8)
    /// The only deletion status route. It is plural: `GET /v2/account/deletions/:jobId`.
    static let deletionStatusPath="/v2/account/deletions/"

    var step:Step = .explain
    var message:String?
    var jobId:String?
    var statusToken:String?
    var statusPath:String?
    var deleteAttempts=0
    var polls=0
    var wipe=false
    var wiped=false
    /// Retry must send DELETE again, even when a job and status token are already saved.
    var repeatDelete=false
    /// Non-retryable failure. The screen shows `SupportContact.address` next to Dismiss.
    var showSupport=false
    /// Dismiss clears the saved job and wipes nothing.
    var dismissible=false
    /// Dismiss already cleared the job. Retry must not send DELETE after that.
    var closed=false
    /// Clear the saved job and token without erasing the rest of the device.
    var dropReceipt=false
    /// An owner-token `invalid_token` cleared the Firebase session. Polling may continue.
    var clearSession=false
    /// A DELETE 404 with no saved job. Show the error without Retry.
    var plainError=false
    var lastHttp:AccountHttp?

    mutating func continueFromExplain(){if step == .explain {step = .confirm}}
    mutating func confirmPhrase(_ phrase:String)->Bool {
        guard step == .confirm,phrase == Self.confirmPhrase else {return false}
        step = .reauth;message=nil;return true
    }
    mutating func acceptFreshSignIn(authTime:Date,now:Date)->Bool {
        guard step == .reauth else {return false}
        let age=now.timeIntervalSince(authTime)
        if age<0 || age>Self.freshSeconds {
            step = .reauth
            message="Sign in again. The server only accepts a sign-in from the last 5 minutes."
            return false
        }
        if repeatDelete {step = .deleting;message=nil;return true}
        if beginPolling(jobId:jobId,statusToken:statusToken) {return true}
        if jobId != nil || statusToken != nil {
            fail("A saved deletion is already in progress. DELETE was not sent again.")
            return false
        }
        step = .deleting;message=nil;return true
    }
    /// DELETE when nothing is saved, or when Retry asked to send it again for a saved job.
    func allowsDelete()->Bool { step == .deleting && (repeatDelete || (jobId==nil && statusToken==nil)) }
    mutating func noteDeleteSent(){deleteAttempts+=1}
    func requestsWipe()->Bool { wipe && step == .done }
    func receipt()->DeletionReceipt? { DeletionReceipt.of(jobId:jobId,statusToken:statusToken) }
    static func resume(_ receipt:DeletionReceipt?)->AccountDeletion {
        var flow=AccountDeletion()
        if receipt==nil || !flow.beginPolling(jobId:receipt?.jobId,statusToken:receipt?.statusToken) {
            flow.dropReceipt=true
            flow.fail("Saved deletion could not be resumed. Nothing on this device was erased.")
        }
        return flow
    }
    mutating func askForSignIn(_ text:String){
        wipe=false
        step = .reauth
        message=text
    }
    mutating func onDeleteHttp(status:Int,jobId:String?,errorCode:String?,statusToken:String?){
        guard step == .deleting else {return}
        if status==423 && errorCode==CloudSignals.lockCode {wipe=false;return}
        if status==401 {onUnauthorized(errorCode);return}
        if status==410 {
            // A repeat DELETE after done is 410 account_deleted, never 401.
            // Up to 5 status tokens for the job stay valid, so this token is polled and not discarded.
            wipe=false
            if errorCode=="account_deleted" && beginPolling(jobId:jobId,statusToken:statusToken) {return}
            fail("Account deletion did not include a usable job. Nothing on this device was erased.")
            return
        }
        if status==409 && errorCode=="deletion_not_retryable" {noteNotRetryable(jobId);return}
        if status==202 && beginPolling(jobId:jobId,statusToken:statusToken) {return}
        if status==404 && self.jobId==nil && self.statusToken==nil {
            plainError=true
            fail("Account deletion did not start. Nothing on this device was erased.")
            return
        }
        plainError=false
        showSupport=false
        fail("Account deletion did not start. You can retry.")
    }
    /// Polling continues after an owner-token sign-out that kept a status token. A status-token `invalid_token` stops it.
    func keepsPolling()->Bool { step == .polling || (step == .signedOut && jobId != nil && !(statusToken ?? "").isEmpty) }
    mutating func onPollHttp(status:Int,jobStatus:String?,errorCode:String?,retryable:Bool?,reportedJobId:String?=nil){
        guard keepsPolling() else {return}
        plainError=false
        showSupport=false
        if status==423 && errorCode==CloudSignals.lockCode {wipe=false;return}
        if status==401 {onUnauthorized(errorCode);return}
        if status==404 {
            // Keep the saved job and token. Retry sends DELETE again. Dismiss clears the job.
            wipe=false;dismissible=true;dropReceipt=false
            fail("This deletion could not be confirmed. Nothing on this device was erased.")
            return
        }
        if status==409 && errorCode=="deletion_not_retryable" {noteNotRetryable(reportedJobId);return}
        if (200..<300).contains(status) {
            if jobStatus=="queued" || jobStatus=="running" {if step != .signedOut {step = .polling};wipe=false;return}
            if jobStatus=="done" {step = .done;wipe=true;message=nil;return}
            if jobStatus=="failed" {
                if retryable==false {
                    showSupport=true;dismissible=true;dropReceipt=false
                    fail("Account deletion failed and cannot be resumed. Nothing on this device was erased.")
                } else {fail("Account deletion failed. You can retry.")}
                return
            }
            // Anything else, including "completed", stops now. Do not poll until the timeout.
            fail("Account deletion reported an unknown status. Nothing on this device was erased.")
            return
        }
        wipe=false
        dismissible=false
        fail("Could not read deletion status. You can retry.")
    }
    private mutating func beginPolling(jobId:String?,statusToken:String?)->Bool {
        guard let jobId,let statusToken,let path=Self.statusPath(jobId:jobId),Self.validToken(statusToken),Self.safeAccountPath(path) else {return false}
        self.jobId=jobId;self.statusToken=statusToken;self.statusPath=path
        step = .polling;wipe=false;dropReceipt=false;repeatDelete=false;showSupport=false;dismissible=false;message=nil
        return true
    }
    /// A non-retryable failure keeps the job until Dismiss. Dismiss wipes nothing.
    private mutating func noteNotRetryable(_ reportedJobId:String?){
        if let reportedJobId,Self.validJob(reportedJobId) {jobId=reportedJobId}
        showSupport=true;dismissible=true;dropReceipt=false;repeatDelete=false;wipe=false
        fail("This deletion cannot be retried. Nothing on this device was erased.")
    }
    private mutating func onUnauthorized(_ errorCode:String?){
        wipe=false
        plainError=false
        let polling=step == .polling || (step == .signedOut && keepsPolling())
        if polling && (errorCode==nil || errorCode?.isEmpty==true || errorCode=="unauthorized" || errorCode=="invalid_token") {
            // Status GET 401 unauthorized, a 401 with no code, or a rejected status token:
            // stop polling, keep the job, and show re-sign-in on the deletion screen.
            // Only a Firebase/owner-token invalid_token signs out and keeps polling.
            showResignIn()
            return
        }
        if errorCode=="invalid_token" {
            clearSession=true
            repeatDelete=false
            if let jobId,let statusToken,Self.validJob(jobId),Self.validToken(statusToken) {
                dropReceipt=false
                step = .signedOut
                message="Deleting your account…"
                return
            }
            step = .signedOut;message="Sign in again to continue.";return
        }
        if errorCode==nil || errorCode?.isEmpty==true {
            step = .reauth;message="Sign in again to continue.";return
        }
        step = .reauth
        message="Sign in again. The server only accepts a sign-in from the last 5 minutes."
    }
    /// Re-sign-in stays on the deletion screen. The next fresh sign-in sends DELETE again.
    private mutating func showResignIn(){
        clearSession=false
        dropReceipt=false
        repeatDelete=true
        showSupport=false
        dismissible=false
        wipe=false
        step = .reauth
        message="Sign in again to continue."
    }
    func exhausted()->Bool { polls>=Self.pollLimit }
    mutating func nextPollDelayMillis()->Int { let delay=1000<<min(polls,3);polls+=1;return delay }
    mutating func fail(_ text:String){step = .failed;wipe=false;message=text}
    /// Re-authenticate when needed, then send DELETE again and poll the job from 202 or 410.
    mutating func retry(){
        guard offersRetry() else {return}
        wipe=false;message=nil;polls=0;dismissible=false;repeatDelete=true;step = .reauth
    }
    /// Failed responses offer Retry, except a non-retryable failure and a DELETE 404 that never saved a job.
    func offersRetry()->Bool { step == .failed && !plainError && !showSupport && !closed }
    /// True when Dismiss should clear the saved job without wiping the device.
    func canDismiss()->Bool { step == .failed && dismissible && !closed }
    /// The user dismissed the 404 error. Clears the saved pair and wipes nothing.
    mutating func dismissError()->Bool {
        guard canDismiss() else {return false}
        wipe=false;dropReceipt=true;closed=true;jobId=nil;statusToken=nil;statusPath=nil
        message="Nothing on this device was erased."
        return true
    }
    static let differentAccount="Sign in with the same Google account. Nothing was deleted."
    /// A `reauth_required` sign-in for a different uid is rejected. Nothing is deleted or wiped.
    mutating func rejectDifferentAccount(expectedUid:String,actualUid:String,expectedEmail:String,actualEmail:String?)->Bool {
        guard step == .reauth else {return false}
        if AccountMatch.same(expectedUid:expectedUid,expectedEmail:expectedEmail,actualUid:actualUid,actualEmail:actualEmail) {return false}
        fail(Self.differentAccount)
        return true
    }
    mutating func noteWiped(){if step == .done && wipe {wiped=true;step = .wiped}}
    mutating func noteWipeFailed(_ text:String){if step == .done {message=text}}

    mutating func deleteThrough(_ transport:any DeletionTransport,authorization:String) async {
        let exchange=await Self.exchange(transport,method:"DELETE",path:"v2/account",body:Self.confirmBody,authorization:authorization)
        completeDelete(exchange)
    }
    mutating func completeDelete(_ exchange:DeletionExchange) {
        guard allowsDelete() else {return}
        noteDeleteSent()
        guard !exchange.failed,let body=exchange.body else {
            plainError=false
            lastHttp=nil
            fail("Account deletion did not start. You can retry.")
            return
        }
        lastHttp=body
        onDeleteHttp(status:body.status,jobId:body.jobId,errorCode:body.error,statusToken:body.statusToken)
    }
    mutating func pollThrough(_ transport:any DeletionTransport) async {
        guard keepsPolling() else {return}
        guard let path=statusPath,let statusToken,let call=Self.pollCall(path:path,statusToken:statusToken) else {
            plainError=false
            fail("Could not read deletion status. You can retry.")
            return
        }
        let exchange=await Self.exchange(transport,method:"GET",path:call.path,body:nil,authorization:call.authorization)
        completePoll(exchange)
    }
    mutating func completePoll(_ exchange:DeletionExchange) {
        guard keepsPolling() else {return}
        guard !exchange.failed,let body=exchange.body else {
            plainError=false
            lastHttp=nil
            wipe=false
            fail("Could not read deletion status. You can retry.")
            return
        }
        lastHttp=body
        onPollHttp(status:body.status,jobStatus:body.jobStatus,errorCode:body.error,retryable:body.retryable,reportedJobId:body.jobId)
    }
    static func exchange(_ transport:any DeletionTransport,method:String,path:String,body:Data?,authorization:String) async -> DeletionExchange {
        do { return DeletionExchange(body:try await transport.execute(method:method,path:path,body:body,authorization:authorization),failed:false) }
        catch { return DeletionExchange(body:nil,failed:true) }
    }

    /// Non-empty only. No length or character-set check.
    static func validJob(_ jobId:String)->Bool { !jobId.isEmpty }
    /// Non-empty only. No length or character-set check. Redacted fixture tokens such as `<redacted>` stay valid.
    static func validToken(_ token:String)->Bool { !token.isEmpty }
    static func statusPath(jobId:String)->String? {
        guard validJob(jobId) else {return nil}
        var allowed=CharacterSet.alphanumerics
        allowed.insert(charactersIn:"-_.~")
        guard let encoded=jobId.addingPercentEncoding(withAllowedCharacters:allowed) else {return nil}
        return deletionStatusPath+encoded
    }
    static func safeAccountPath(_ path:String)->Bool {
        guard path.hasPrefix(deletionStatusPath), !path.contains("/v2/account/deletion/") else {return false}
        let rest=String(path.dropFirst(deletionStatusPath.count))
        return !rest.isEmpty && !rest.contains("/") && !rest.contains("\\")
    }
    static func pollCall(path:String,statusToken:String)->(method:String,path:String,authorization:String)? {
        guard safeAccountPath(path),validToken(statusToken) else {return nil}
        return ("GET",path,"Bearer "+statusToken)
    }
    /// Safe to log. The status token is never included.
    static func describePoll(path:String)->String { "GET "+path+" Authorization: Bearer [redacted]" }
    /// A saved pair is resumed before any sign-out. An unusable pair is not.
    static func resumesBeforeSignOut(_ receipt:DeletionReceipt?)->Bool {
        guard let receipt else {return false}
        return validJob(receipt.jobId) && validToken(receipt.statusToken)
    }
    static func byoVerifyPath(workspaceID:String)->String? {
        guard workspaceID=="free" || UUID(uuidString:workspaceID) != nil else {return nil}
        return "v2/workspaces/"+workspaceID.lowercased()+"/byo/verify"
    }
    /// `POST /byo/verify` body is `{"presignedUrl"}`. Never `readBack` or `proofUrl`.
    static func byoVerifyBody(presignedUrl:String)->Data? {
        guard !presignedUrl.isEmpty,!presignedUrl.contains("\""),!presignedUrl.contains("\\") else {return nil}
        return try? JSONSerialization.data(withJSONObject:["presignedUrl":presignedUrl])
    }
    static func mergePath(sourceID:String)->String? {
        guard sourceID=="free" || UUID(uuidString:sourceID) != nil else {return nil}
        return "v2/workspaces/"+sourceID.lowercased()+"/merge"
    }
    static func mergeBody(targetID:String,confirmName:String)->Data? {
        guard !confirmName.isEmpty,targetID=="free" || UUID(uuidString:targetID) != nil else {return nil}
        return try? JSONSerialization.data(withJSONObject:["targetId":targetID,"confirmName":confirmName])
    }
    static func mergeNote(_ sourceName:String)->String {
        let source=sourceName.isEmpty ? "workspace" : sourceName
        return "Duplicates are kept as name (from "+source+")."
    }
}

protocol DeletionTransport {
    func execute(method:String,path:String,body:Data?,authorization:String) async throws -> AccountHttp
}

struct DeletionExchange: Equatable {
    var body:AccountHttp?
    var failed:Bool
}

/// Replaces a file only in this order: upload the new chunks, PUT the manifest with ifGeneration
/// (on 412, refetch and retry), delete the old chunks, then trash the local original.
/// Mobile uploads are raw bytes with `X-Chunk-SHA256`. Chunks are not sealed.
enum FileReplacement {
    struct Conflict:Error { let generation:Int64 }
    struct Manifest {
        var objectId:String
        var generation:Int64
        var oldReadable=true
        var localTrashed=false
    }
    static func replace(_ store:any ReplacementStore,manifest:inout Manifest,newObjectId:String) throws {
        let oldId=manifest.objectId
        try store.uploadChunks(objectId:newObjectId)
        var generation=manifest.generation
        var committed=false
        var attempt=0
        while attempt<2 && !committed {
            attempt+=1
            do {
                let next=try store.putManifest(ifGeneration:generation,objectId:newObjectId)
                manifest.objectId=newObjectId
                manifest.generation=next
                committed=true
            } catch is Conflict {
                generation=try store.refetchGeneration()
            }
        }
        if !committed {return}
        do {
            try store.deleteOldChunks(objectId:oldId)
            manifest.oldReadable=false
        } catch {
            manifest.objectId=oldId
            manifest.oldReadable=true
            return
        }
        try store.trashLocalOriginal()
        manifest.localTrashed=true
    }
}

protocol ReplacementStore: AnyObject {
    func uploadChunks(objectId:String) throws
    func putManifest(ifGeneration:Int64,objectId:String) throws -> Int64
    func refetchGeneration() throws -> Int64
    func deleteOldChunks(objectId:String) throws
    func trashLocalOriginal() throws
}

struct AccountHttp:Equatable,Sendable {
    var status:Int
    var raw:String
    var error:String?
    var jobId:String?
    var jobStatus:String?
    var retryable:Bool?
    var statusToken:String?
    static func parse(status:Int,data:Data)->AccountHttp {
        let raw=String(data:data,encoding:.utf8) ?? ""
        guard let json=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else {
            return AccountHttp(status:status,raw:raw,error:nil,jobId:nil,jobStatus:nil,retryable:nil,statusToken:nil)
        }
        let retryable:Bool?
        if let value=json["retryable"] as? Bool {retryable=value}
        else if let number=json["retryable"] as? NSNumber, CFGetTypeID(number) != CFStringGetTypeID() {retryable=number.boolValue}
        else {retryable=nil}
        return AccountHttp(status:status,raw:raw,error:errorCode(in:json),jobId:json["jobId"] as? String,jobStatus:json["status"] as? String,retryable:retryable,statusToken:json["statusToken"] as? String)
    }
    /// A non-empty `error` string wins. Otherwise `code`. No pattern check on either.
    static func errorCode(in json:[String:Any])->String? {
        if let error=json["error"] as? String, !error.isEmpty {return error}
        if let code=json["code"] as? String, !code.isEmpty {return code}
        return nil
    }
}

struct DeletionReceipt:Equatable {
    let jobId:String
    let statusToken:String
    static func of(jobId:String?,statusToken:String?)->DeletionReceipt? {
        guard let jobId,let statusToken,AccountDeletion.validJob(jobId),AccountDeletion.validToken(statusToken) else {return nil}
        return DeletionReceipt(jobId:jobId,statusToken:statusToken)
    }
    var description:String { "DeletionReceipt("+jobId+")" }
}

struct DeletionReceiptMemory {
    private var values:[String:String]=[:]
    mutating func save(_ receipt:DeletionReceipt?){
        guard let receipt else {return}
        values["jobId"]=receipt.jobId
        values["statusToken"]=receipt.statusToken
    }
    func read()->DeletionReceipt? { DeletionReceipt.of(jobId:values["jobId"],statusToken:values["statusToken"]) }
    mutating func clear(){values.removeAll()}
    func containsToken(_ token:String)->Bool { values["statusToken"]==token }
}

enum DeletionReceiptVault {
    static let service="app.gendragoon.cloudssd.mobile.deletion"
    static let account="status-receipt"
    static let backedByKeychain=true
    static let usesUserDefaults=false
    /// Last `SecItem` status. The simulator often returns -34018 once before the keychain is ready.
    static var lastStatus:OSStatus=errSecSuccess
    private static let missingEntitlement:OSStatus = -34018
    static func save(jobId:String,token:String){
        guard let receipt=DeletionReceipt.of(jobId:jobId,statusToken:token),
              let data=try? JSONSerialization.data(withJSONObject:["jobId":receipt.jobId,"statusToken":receipt.statusToken]) else {lastStatus=errSecParam;return}
        let query:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:account]
        SecItemDelete(query as CFDictionary)
        var add=query
        add[kSecValueData as String]=data
        add[kSecAttrAccessible as String]=kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        lastStatus=addItem(add)
    }
    /// Retries the simulator's one-shot missing-entitlement error. Stays in the keychain.
    private static func addItem(_ add:[String:Any])->OSStatus {
        var status:OSStatus=errSecSuccess
        for attempt in 0..<5 {
            status=SecItemAdd(add as CFDictionary,nil)
            if status != missingEntitlement {return status}
            if attempt<4 {Thread.sleep(forTimeInterval:0.2)}
        }
        return status
    }
    static func load()->DeletionReceipt? {
        var query:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:account,kSecReturnData as String:true,kSecMatchLimit as String:kSecMatchLimitOne]
        var result:CFTypeRef?
        var status=SecItemCopyMatching(query as CFDictionary,&result)
        if status==missingEntitlement {
            Thread.sleep(forTimeInterval:0.2)
            status=SecItemCopyMatching(query as CFDictionary,&result)
        }
        lastStatus=status
        guard status==errSecSuccess,let data=result as? Data,
              let json=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else {return nil}
        return DeletionReceipt.of(jobId:json["jobId"] as? String,statusToken:json["statusToken"] as? String)
    }
    static func clear(){
        let query:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:account]
        SecItemDelete(query as CFDictionary)
    }
}

enum AccountMatch {
    static func same(expectedUid:String,expectedEmail:String,actualUid:String,actualEmail:String?)->Bool {
        guard !expectedUid.isEmpty,expectedUid==actualUid else {return false}
        if expectedEmail.isEmpty {return true}
        return expectedEmail.compare(actualEmail ?? "",options:.caseInsensitive) == .orderedSame
    }
}

/// Bring-your-own storage ships only as the server register, challenge, and verify flow.
/// The on-device SigV4 proof is not green, so the settings entry stays hidden.
/// There is no key-only fallback.
enum ByoFeature {
    static let serverFlowEnabled=false
    static var showInSettings:Bool { serverFlowEnabled }
}

enum ByoMessages {
    static let comingSoon="Coming soon"
    static let unsupported="That storage provider isn't available yet. S3-compatible storage is supported."
    static let presignedUrlRequired="A presigned URL is required to verify this storage."
    static let challengeExpired="This storage check expired. Start the check again."
    static let hostMismatch="The presigned URL does not match the storage you registered."
    static let challengeMismatch="The storage check did not match. Start the check again."
    static let challengeUsed="This storage check was already used. Start a new check."
    static func friendly(status:Int,error:String?)->String? {
        if status==422 && error=="byo_provider_unsupported" {return unsupported}
        if status==400 && error=="presigned_url_required" {return presignedUrlRequired}
        if status==400 && error=="BYO_CHALLENGE_EXPIRED" {return challengeExpired}
        if status==400 && error=="BYO_ENDPOINT_HOST_MISMATCH" {return hostMismatch}
        if status==400 && error=="BYO_CHALLENGE_MISMATCH" {return challengeMismatch}
        if status==400 && error=="BYO_CHALLENGE_USED" {return challengeUsed}
        return nil
    }
    static func comingSoonProvider(_ provider:String)->Bool {
        let name=provider.lowercased()
        return name=="sftp" || name=="azure" || name=="webdav"
    }
}
