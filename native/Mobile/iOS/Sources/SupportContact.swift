import Foundation

/// Mirrors `packages/core` `SUPPORT_CONTACT` in gendragoon-apps.
/// RELEASE BLOCKER until grim supplies the real contact. `isPlaceholder` must be false
/// before a release ships. Release CI runs
/// `xcodebuild test -configuration Release`; `testReleaseBuildRejectsPlaceholderSupportContact`
/// fails while this flag is true. Debug test runs only check that the placeholder is still
/// the shared value.
enum SupportContact {
    /// Shared-core placeholder. Not a deliverable address.
    static let address="SUPPORT_CONTACT_PLACEHOLDER@invalid"
    static let isPlaceholder=true
    /// Mailto for the Contact support button. The job id is the subject.
    static func mailto(jobId:String?)->URL? {
        let id=jobId ?? ""
        let subject=id.isEmpty ? "Account deletion" : "Account deletion "+id
        var allowed=CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn:"+&=")
        guard let encoded=subject.addingPercentEncoding(withAllowedCharacters:allowed) else {return nil}
        return URL(string:"mailto:"+address+"?subject="+encoded)
    }
}

/// Contact support for a deletion that cannot be retried. Off until the endpoint is turned on.
/// The only path is `POST /v2/account/deletions/:jobId/support-request`. There is no request body:
/// no `jobId` field, no uid, and no user data. `Authorization` is `Bearer statusToken`, so this
/// still works while signed out. Riley's `d9888be` fixtures describe the responses.
enum DeletionSupport {
    static let enabled=false
    /// Pinned. `POST /v2/account/deletions/:jobId/support-request`.
    static let pathFormat="/v2/account/deletions/%@/support-request"
    static let sent="Request sent."
    static let already="Request already sent."
    enum Kind:Equatable { case sent, already, refresh, mailto, hold }
    struct Call:Equatable {
        var send:Bool
        var path:String?
        var statusToken:String?
        var authorization:String? { statusToken.map {"Bearer "+$0} }
        static let mailto=Call(send:false,path:nil,statusToken:nil)
    }
    struct Result:Equatable {
        var kind:Kind
        var requestId:String?
        var message:String?
        var opensMailto:Bool { kind==.mailto }
    }
    static func call(jobId:String?,statusToken:String?)->Call { call(jobId:jobId,statusToken:statusToken,enabled:enabled) }
    static func call(jobId:String?,statusToken:String?,enabled:Bool)->Call {
        guard enabled,let jobId,AccountDeletion.validJob(jobId),let statusToken,AccountDeletion.validToken(statusToken) else {return .mailto}
        guard let encoded=AccountDeletion.encodeJob(jobId),!encoded.contains("/"),!encoded.contains("\\"),!encoded.contains("..") else {return .mailto}
        return Call(send:true,path:String(format:pathFormat,encoded),statusToken:statusToken)
    }
    /// 202 `received` (including a repeat with the same `requestId`) shows "Request sent."
    /// 409 `support_not_needed` refreshes deletion status. 429 shows "Request already sent."
    /// and does not open mailto. A 404, a transport failure, or HTTP 5xx opens mailto and does not
    /// ask for sign-in. The account may already be deleted.
    static func interpret(status:Int,body:String,transportFailed:Bool)->Result {
        if transportFailed || status>=500 || status==404 {return Result(kind:.mailto,requestId:nil,message:nil)}
        let requestId=CloudSignals.jsonString(body,"requestId")
        if status==202,CloudSignals.jsonString(body,"status")=="received",let requestId,!requestId.isEmpty {
            return Result(kind:.sent,requestId:requestId,message:sent)
        }
        if status==409,CloudSignals.jsonString(body,"error")=="support_not_needed" {
            return Result(kind:.refresh,requestId:nil,message:nil)
        }
        if status==429 {return Result(kind:.already,requestId:nil,message:already)}
        return Result(kind:.hold,requestId:nil,message:nil)
    }
}
