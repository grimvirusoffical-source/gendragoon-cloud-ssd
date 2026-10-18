import Foundation

/// Account-deletion state machine. Freshness is the Firebase ID token `auth_time` claim.
/// `DELETE /v2/account` returns `202 {"jobId"}`. Status is only `deletionStatusPath`.
/// States are `queued | running | done | failed`. A 401 never wipes local keys. Only `done` does.
struct AccountDeletion:Equatable {
    enum Step:Equatable,Hashable { case explain, confirm, reauth, deleting, polling, done, failed, wiped, signedOut }
    static let confirmPhrase="DELETE"
    static let freshSeconds:TimeInterval=300
    static let pollLimit=90
    /// The only deletion status route. It is plural: `GET /v2/account/deletions/:jobId`.
    static let deletionStatusPath="/v2/account/deletions/"

    var step:Step = .explain
    var message:String?
    var jobId:String?
    var statusPath:String?
    var deleteAttempts=0
    var polls=0
    var wipe=false
    var wiped=false

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
        step = self.jobId==nil ? .deleting : .polling;message=nil;return true
    }
    mutating func noteDeleteSent(){deleteAttempts+=1}
    /// True only after the deletion job reports `done`. A 401 never sets this.
    func requestsWipe()->Bool { wipe && step == .done }
    mutating func onDeleteHttp(status:Int,jobId:String?,errorCode:String?){
        guard step == .deleting else {return}
        if status==401 {onUnauthorized(errorCode);return}
        if status==202,let jobId,Self.validJob(jobId){
            self.jobId=jobId;statusPath=Self.statusPath(jobId:jobId);step = .polling;wipe=false;message=nil;return
        }
        fail("Account deletion did not start. You can retry.")
    }
    mutating func onPollHttp(status:Int,state:String?,errorCode:String?){
        guard step == .polling else {return}
        if status==401 {onUnauthorized(errorCode);return}
        if (200..<300).contains(status){
            if state=="queued" || state=="running" {step = .polling;wipe=false;return}
            if state=="done" {step = .done;wipe=true;message=nil;return}
            if state=="failed" {fail("Account deletion failed. You can retry.");return}
        }
        fail("Could not read deletion status. You can retry.")
    }
    private mutating func onUnauthorized(_ errorCode:String?){
        wipe=false
        if errorCode=="invalid_token" {step = .signedOut;message="Sign in again to continue.";return}
        step = .reauth
        message="Sign in again. The server only accepts a sign-in from the last 5 minutes."
    }
    func exhausted()->Bool { polls>=Self.pollLimit }
    mutating func nextPollDelayMillis()->Int { let delay=1000<<min(polls,3);polls+=1;return delay }
    mutating func fail(_ text:String){step = .failed;wipe=false;message=text}
    mutating func retry(){
        guard step == .failed else {return}
        step = .explain;message=nil;jobId=nil;statusPath=nil;deleteAttempts=0;polls=0;wipe=false;wiped=false
    }
    mutating func noteWiped(){if step == .done && wipe {wiped=true;step = .wiped}}
    mutating func noteWipeFailed(_ text:String){if step == .done {message=text}}

    static func validJob(_ jobId:String)->Bool { jobId.range(of:"^[A-Za-z0-9_-]{1,80}$",options:.regularExpression) != nil }
    static func statusPath(jobId:String)->String { deletionStatusPath+jobId }
    static func safeAccountPath(_ path:String)->Bool {
        guard path.hasPrefix(deletionStatusPath) else {return false}
        return validJob(String(path.dropFirst(deletionStatusPath.count)))
    }
    /// Merge is not final and performs no request.
    /// Expected later call: POST v2/workspaces/{targetId}/merge {"sourceId": sourceId}.
    /// Duplicate files are kept as name (from <source>).
    static func mergeUnavailable(_ sourceName:String)->String {
        let source=sourceName.isEmpty ? "workspace" : sourceName
        return "Merge isn't available yet. Duplicates are kept as name (from "+source+")."
    }
}

struct AccountHttp:Equatable,Sendable {
    var status:Int
    var raw:String
    var error:String?
    var jobId:String?
    var state:String?
    static func parse(status:Int,data:Data)->AccountHttp {
        let raw=String(data:data,encoding:.utf8) ?? ""
        let json=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any]
        return AccountHttp(status:status,raw:raw,error:json?["error"] as? String,jobId:json?["jobId"] as? String,state:json?["state"] as? String)
    }
}
