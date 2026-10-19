import Foundation

enum AboutCopy {
    static let ownership = "Gendragoon is developed and maintained by Red-XAI LLC. Red-XAI LLC is wholly owned by GRIM-VIRUS, an independent recording artist who leads development under the alias MainDirectory. © Red-XAI LLC. All rights reserved."
    static let copyright = "© Red-XAI LLC"
}

/// Mirrors `packages/core` `SUPPORT_CONTACT` in gendragoon-apps: Josh's shared support address.
/// `isPlaceholder` must stay false; `testReleaseBuildRejectsPlaceholderSupportContact` fails
/// if a placeholder is reinstalled.
enum SupportContact {
    static let address="support@infected-nation.com"
    static let isPlaceholder=false
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

/// Contact support for a deletion that cannot be retried. Off until the Discord webhook is
/// configured in production. The only path is `POST /v2/account/deletions/:jobId/support-request`.
/// There is no request body: no `jobId` field, no uid, and no user data. `Authorization` is
/// `Bearer statusToken`, so this still works while signed out. the `d33970c` fixtures in
/// `fixtures/account-deletion/` describe the responses.
enum DeletionSupport {
    static let enabled=false
    /// Pinned. `POST /v2/account/deletions/:jobId/support-request`.
    static let pathFormat="/v2/account/deletions/%@/support-request"
    static let sent="Request sent."
    static let already="Request already sent."
    enum Kind:Equatable { case sent, already, refresh, mailto }
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
        var opensMailto:Bool { kind == .mailto }
    }
    /// Reads the saved job from the Keychain-backed vault. Any thrown error returns nil, which falls back to mailto.
    static func savedJob(_ read:() throws -> String?)->String? { (try? read()) ?? nil }
    static func call(jobId:String?,statusToken:String?)->Call { call(jobId:jobId,savedJobId:jobId,statusToken:statusToken,enabled:enabled) }
    static func call(jobId:String?,statusToken:String?,enabled:Bool)->Call { call(jobId:jobId,savedJobId:jobId,statusToken:statusToken,enabled:enabled) }
    /// Sends nothing unless `jobId` is the job saved on this device. A mismatch opens mailto.
    static func call(jobId:String?,savedJobId:String?,statusToken:String?,enabled:Bool)->Call {
        guard enabled,let jobId,jobId==savedJobId,AccountDeletion.validJob(jobId),let statusToken,AccountDeletion.validToken(statusToken) else {return .mailto}
        guard let encoded=AccountDeletion.encodeJob(jobId),!encoded.contains("/"),!encoded.contains("\\"),!encoded.contains("..") else {return .mailto}
        return Call(send:true,path:String(format:pathFormat,encoded),statusToken:statusToken)
    }
    /// 202 `received` (including a repeat with the same `requestId`) shows "Request sent."
    /// 409 `support_not_needed` refreshes deletion status. 429 shows "Request already sent."
    /// and does not open mailto. Everything else opens mailto and never asks for sign-in: any 401,
    /// a 404, any other 4xx (400, 403, 413, 422, ...), HTTP 5xx, a transport failure, or a malformed
    /// success. The account may already be deleted.
    static func interpret(status:Int,body:String,transportFailed:Bool)->Result {
        if transportFailed || status>=500 || status==404 || status==401 {
            return Result(kind:.mailto,requestId:nil,message:nil)
        }
        let requestId=CloudSignals.jsonString(body,"requestId")
        if status==202,CloudSignals.jsonString(body,"status")=="received",let requestId,!requestId.isEmpty {
            return Result(kind:.sent,requestId:requestId,message:sent)
        }
        if status==409,CloudSignals.jsonString(body,"error")=="support_not_needed" {
            return Result(kind:.refresh,requestId:nil,message:nil)
        }
        // No countdown: Retry-After is ignored, whatever it says.
        if status==429 {return Result(kind:.already,requestId:nil,message:already)}
        return Result(kind:.mailto,requestId:nil,message:nil)
    }
}
