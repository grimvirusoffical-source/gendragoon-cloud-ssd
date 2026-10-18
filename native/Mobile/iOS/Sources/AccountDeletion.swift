import Foundation

/// Account-deletion state machine. Server contract, adjustable when the route is merged:
/// re-authenticate within five minutes, `DELETE /v2/account` returns `202 {"jobId"}`,
/// then poll `GET /v2/account/deletions/{jobId}` for `queued | running | done | failed`.
struct AccountDeletion:Equatable {
    enum Step:Equatable,Hashable { case explain, confirm, reauth, deleting, polling, done, failed, wiped }
    static let confirmPhrase="DELETE"
    static let freshSeconds:TimeInterval=300
    static let pollLimit=90
    static let origin="https://gendragoon-free-10068843866.us-central1.run.app"

    var step:Step = .explain
    var message:String?
    var jobId:String?
    var statusPath:String?
    var deleteAttempts=0
    var staleRetries=0
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
        step = .deleting;message=nil;return true
    }
    mutating func noteDeleteSent(){deleteAttempts+=1}
    mutating func onDeleteHttp(status:Int,jobId:String?,statusUrl:String?,errorCode:String?){
        guard step == .deleting else {return}
        if status==202,let jobId,Self.validJob(jobId){
            self.jobId=jobId;statusPath=Self.statusPath(jobId:jobId,statusUrl:statusUrl);step = .polling;message=nil;return
        }
        if status==404 || status==410 {succeed();return}
        if status==401 {
            if Self.staleSession(errorCode) && deleteAttempts<=1 && staleRetries==0 {
                staleRetries=1;step = .reauth
                message="Sign in again. The server only accepts a sign-in from the last 5 minutes."
                return
            }
            succeed();return
        }
        fail("Account deletion did not start. You can retry.")
    }
    mutating func onPollHttp(status:Int,state:String?){
        guard step == .polling else {return}
        if status==401 {succeed();return}
        if (200..<300).contains(status){
            if state=="queued" || state=="running" {step = .polling;return}
            if state=="done" {succeed();return}
            if state=="failed" {fail("Account deletion failed. You can retry.");return}
        }
        fail("Could not read deletion status. You can retry.")
    }
    func exhausted()->Bool { polls>=Self.pollLimit }
    mutating func nextPollDelayMillis()->Int { let delay=1000<<min(polls,3);polls+=1;return delay }
    mutating func fail(_ text:String){step = .failed;wipe=false;message=text}
    mutating func retry(){
        guard step == .failed else {return}
        step = .explain;message=nil;jobId=nil;statusPath=nil;deleteAttempts=0;staleRetries=0;polls=0;wipe=false;wiped=false
    }
    mutating func noteWiped(){if step == .done {wiped=true;step = .wiped}}
    mutating func noteWipeFailed(_ text:String){if step == .done {message=text}}
    private mutating func succeed(){step = .done;wipe=true;message=nil}

    static func validJob(_ jobId:String)->Bool { jobId.range(of:"^[A-Za-z0-9_-]{1,80}$",options:.regularExpression) != nil }
    static func staleSession(_ errorCode:String?)->Bool { errorCode=="session_stale" || errorCode=="auth_too_old" || errorCode=="signin_too_old" }
    static func safeAccountPath(_ path:String)->Bool {
        path.hasPrefix("v2/account/") && !path.contains("..") && !path.contains("\\") && !path.contains(" ") && !path.contains("@") && !path.contains("?")
    }
    static func statusPath(jobId:String,statusUrl:String?)->String {
        let fallback="v2/account/deletions/"+jobId
        guard let statusUrl,!statusUrl.isEmpty else {return fallback}
        var path=statusUrl
        let prefixed=origin+"/"
        if path.hasPrefix(prefixed){path=String(path.dropFirst(prefixed.count))}
        if path.hasPrefix("/"){path=String(path.dropFirst())}
        return safeAccountPath(path) ? path : fallback
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
    var statusUrl:String?
    var state:String?
    static func parse(status:Int,data:Data)->AccountHttp {
        let raw=String(data:data,encoding:.utf8) ?? ""
        let json=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any]
        return AccountHttp(status:status,raw:raw,error:json?["error"] as? String,jobId:json?["jobId"] as? String,statusUrl:json?["statusUrl"] as? String,state:json?["state"] as? String)
    }
}
