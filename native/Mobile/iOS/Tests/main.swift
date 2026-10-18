import XCTest
@testable import GenDragoonMobile

final class AccountLogicTests: XCTestCase {
    private let token="status-token-1"

    func testPhraseFreshnessAndConfirmBody() {
        var gated=AccountDeletion()
        XCTAssertFalse(gated.confirmPhrase("DELETE"))
        gated.continueFromExplain()
        XCTAssertFalse(gated.confirmPhrase("delete"))
        XCTAssertTrue(gated.confirmPhrase("DELETE"))
        let now=Date(timeIntervalSince1970:10_000)
        XCTAssertFalse(gated.acceptFreshSignIn(authTime:now.addingTimeInterval(-301),now:now))
        XCTAssertEqual(gated.step,.reauth)
        XCTAssertTrue((gated.message ?? "").contains("5 minutes"))
        XCTAssertEqual(AccountDeletion.confirmBody,Data("{\"confirm\":\"DELETE\"}".utf8))
        XCTAssertEqual(AccountDeletion.confirmContentType,"application/json")
    }

    func testParsesRealStatusJson() throws {
        XCTAssertEqual(BackendFixtures.accountDeletionSHA,"84f6fff")
        let created=AccountHttp.parse(status:202,data:Data(BackendFixtures.body("delete202").utf8))
        XCTAssertEqual(created.jobStatus,"deleting")
        XCTAssertFalse((created.jobId ?? "").isEmpty)
        XCTAssertFalse((created.statusToken ?? "").isEmpty)
        let running=AccountHttp.parse(status:200,data:Data(BackendFixtures.body("pollRunning").utf8))
        XCTAssertEqual(running.jobId,created.jobId)
        XCTAssertEqual(running.jobStatus,"running")
        XCTAssertEqual(running.retryable,true)
        let done=AccountHttp.parse(status:200,data:Data(BackendFixtures.body("pollDone").utf8))
        XCTAssertEqual(done.jobStatus,"done")
        XCTAssertEqual(done.retryable,false)
        let failed=AccountHttp.parse(status:200,data:Data(BackendFixtures.body("pollFailed").utf8))
        XCTAssertEqual(failed.jobStatus,"failed")
        XCTAssertEqual(failed.retryable,true)
        let queued=AccountHttp.parse(status:200,data:Data(BackendFixtures.body("pollQueued").utf8))
        XCTAssertEqual(queued.jobStatus,"queued")
        XCTAssertEqual(queued.retryable,true)
        let unknown=AccountHttp.parse(status:200,data:Data("{\"status\":\"completed\"}".utf8))
        XCTAssertEqual(unknown.jobStatus,"completed")
        let malformed=AccountHttp.parse(status:200,data:Data("{not json".utf8))
        XCTAssertNil(malformed.jobId)
        XCTAssertNil(malformed.jobStatus)
        XCTAssertNil(malformed.retryable)
        XCTAssertNil(malformed.statusToken)
    }

    func testQueuedRunningThenDoneWipes() {
        var flow=ready()
        flow.onDeleteHttp(status:202,jobId:"job_1",errorCode:nil,statusToken:token)
        XCTAssertEqual(flow.step,.polling)
        XCTAssertEqual(flow.statusPath,AccountDeletion.deletionStatusPath+"job_1")
        flow.onPollHttp(status:200,jobStatus:"queued",errorCode:nil,retryable:true)
        XCTAssertEqual(flow.step,.polling)
        XCTAssertFalse(flow.requestsWipe())
        flow.onPollHttp(status:200,jobStatus:"running",errorCode:nil,retryable:true)
        flow.onPollHttp(status:200,jobStatus:"done",errorCode:nil,retryable:false)
        XCTAssertTrue(flow.requestsWipe())
        XCTAssertFalse(LocalWipePlan.keychainServicesRemoved(wipe:false).contains(DeletionReceiptVault.service))
        XCTAssertTrue(LocalWipePlan.keychainServicesRemoved(wipe:true).contains(DeletionReceiptVault.service))
    }

    func testErrorFieldBodies() {
        let reauth=AccountHttp.parse(status:401,data:Data(BackendFixtures.body("reauth401").utf8))
        XCTAssertEqual(reauth.error,"reauth_required")
        var again=ready()
        again.onDeleteHttp(status:reauth.status,jobId:reauth.jobId,errorCode:reauth.error,statusToken:reauth.statusToken)
        XCTAssertEqual(again.step,.reauth)
        XCTAssertFalse(again.requestsWipe())

        let invalid=AccountHttp.parse(status:401,data:Data(BackendFixtures.body("invalidToken401").utf8))
        XCTAssertEqual(invalid.error,"invalid_token")
        var signedOut=ready()
        signedOut.onDeleteHttp(status:invalid.status,jobId:invalid.jobId,errorCode:invalid.error,statusToken:invalid.statusToken)
        XCTAssertEqual(signedOut.step,.signedOut)
        XCTAssertTrue(LocalWipePlan.keychainServicesRemoved(wipe:signedOut.requestsWipe()).isEmpty)

        let fromCode=AccountHttp.parse(status:401,data:Data("{\"code\":\"reauth_required\"}".utf8))
        XCTAssertEqual(fromCode.error,"reauth_required")
        let errorWins=AccountHttp.parse(status:401,data:Data("{\"error\":\"invalid_token\",\"code\":\"reauth_required\"}".utf8))
        XCTAssertEqual(errorWins.error,"invalid_token")

        let gone=AccountHttp.parse(status:410,data:Data(BackendFixtures.body("accountDeleted410").utf8))
        XCTAssertEqual(gone.status,410)
        XCTAssertNotEqual(gone.status,401)
        XCTAssertEqual(gone.error,"account_deleted")
        XCTAssertFalse((gone.jobId ?? "").isEmpty)
        XCTAssertFalse((gone.statusToken ?? "").isEmpty)
        var deleted=ready()
        XCTAssertTrue(deleted.allowsDelete())
        deleted.onDeleteHttp(status:gone.status,jobId:gone.jobId,errorCode:gone.error,statusToken:gone.statusToken)
        XCTAssertEqual(deleted.step,.polling)
        XCTAssertNotEqual(deleted.step,.signedOut)
        XCTAssertEqual(deleted.statusPath,"/v2/account/deletions/"+(gone.jobId ?? ""))
        XCTAssertFalse(deleted.allowsDelete())
        XCTAssertFalse(deleted.requestsWipe())
        XCTAssertTrue(LocalWipePlan.keychainServicesRemoved(wipe:deleted.requestsWipe()).isEmpty)
        let saved=deleted.statusToken
        deleted.onDeleteHttp(status:gone.status,jobId:gone.jobId,errorCode:gone.error,statusToken:gone.statusToken)
        XCTAssertEqual(deleted.step,.polling)
        XCTAssertEqual(deleted.statusToken,saved)
        let kept=AccountDeletion.resume(DeletionReceipt.of(jobId:gone.jobId,statusToken:gone.statusToken))
        XCTAssertEqual(kept.step,.polling)
        XCTAssertFalse(kept.allowsDelete())
    }

    func testGoneAccountWithoutJobDoesNotWipe() {
        var missing=ready()
        let body=AccountHttp.parse(status:410,data:Data("{\"error\":\"account_deleted\"}".utf8))
        missing.onDeleteHttp(status:body.status,jobId:body.jobId,errorCode:body.error,statusToken:body.statusToken)
        XCTAssertEqual(missing.step,.failed)
        XCTAssertFalse(missing.requestsWipe())
        var invalid=ready()
        invalid.onDeleteHttp(status:410,jobId:"../secret",errorCode:"account_deleted",statusToken:token)
        XCTAssertEqual(invalid.step,.failed)
        var noToken=ready()
        noToken.onDeleteHttp(status:410,jobId:"job_410",errorCode:"account_deleted",statusToken:nil)
        XCTAssertEqual(noToken.step,.failed)
        XCTAssertFalse(noToken.requestsWipe())
    }

    func testRetryKeepsJobAndGoneAccountRecovers() {
        var kept=ready()
        kept.onDeleteHttp(status:202,jobId:"job_keep",errorCode:nil,statusToken:token)
        kept.onPollHttp(status:500,jobStatus:"done",errorCode:nil,retryable:nil)
        XCTAssertEqual(kept.step,.failed)
        XCTAssertEqual(kept.jobId,"job_keep")
        kept.retry()
        XCTAssertEqual(kept.step,.polling)
        XCTAssertEqual(kept.statusToken,token)
        var again=ready()
        again.onDeleteHttp(status:500,jobId:nil,errorCode:"bad",statusToken:nil)
        again.retry()
        XCTAssertEqual(again.step,.reauth)
        XCTAssertTrue(again.acceptFreshSignIn(authTime:Date(timeIntervalSince1970:2),now:Date(timeIntervalSince1970:2)))
        let gone=AccountHttp.parse(status:410,data:Data("{\"error\":\"account_deleted\",\"jobId\":\"job_again\",\"statusToken\":\"status-token-again\"}".utf8))
        again.onDeleteHttp(status:gone.status,jobId:gone.jobId,errorCode:gone.error,statusToken:gone.statusToken)
        XCTAssertEqual(again.step,.polling)
        XCTAssertEqual(again.statusPath,"/v2/account/deletions/job_again")
        XCTAssertFalse(again.requestsWipe())
    }

    func testUnknownStatusFailsImmediately() {
        for status in ["completed","deleting","succeeded",nil] as [String?] {
            var flow=ready()
            flow.onDeleteHttp(status:202,jobId:"job_c",errorCode:nil,statusToken:token)
            flow.onPollHttp(status:200,jobStatus:status,errorCode:nil,retryable:false)
            XCTAssertEqual(flow.step,.failed)
            XCTAssertNotEqual(flow.step,.polling)
            XCTAssertEqual(flow.polls,0)
            XCTAssertFalse(flow.requestsWipe())
            flow.onPollHttp(status:200,jobStatus:"done",errorCode:nil,retryable:false)
            XCTAssertEqual(flow.step,.failed)
            XCTAssertFalse(flow.requestsWipe())
            XCTAssertLessThan(flow.polls,AccountDeletion.pollLimit)
        }
    }

    func testNonSuccessPollNeverWipes() {
        var flow=ready()
        flow.onDeleteHttp(status:202,jobId:"job_http",errorCode:nil,statusToken:token)
        flow.onPollHttp(status:500,jobStatus:"done",errorCode:nil,retryable:nil)
        XCTAssertEqual(flow.step,.failed)
        XCTAssertFalse(flow.requestsWipe())
    }

    func testFailedRetryableFalseClearsReceiptOnly() {
        var flow=ready()
        flow.onDeleteHttp(status:202,jobId:"job_dead",errorCode:nil,statusToken:token)
        flow.onPollHttp(status:200,jobStatus:"failed",errorCode:nil,retryable:false)
        XCTAssertEqual(flow.step,.failed)
        XCTAssertTrue(flow.dropReceipt)
        XCTAssertNil(flow.jobId)
        XCTAssertFalse(flow.requestsWipe())
        var retryable=ready()
        retryable.onDeleteHttp(status:202,jobId:"job_live",errorCode:nil,statusToken:token)
        retryable.onPollHttp(status:200,jobStatus:"failed",errorCode:nil,retryable:true)
        XCTAssertFalse(retryable.dropReceipt)
        retryable.retry()
        XCTAssertEqual(retryable.step,.polling)
    }

    func testStoresTokenAndResumesWithBearer() {
        let receipt=DeletionReceipt.of(jobId:"job_saved",statusToken:token)
        XCTAssertEqual(receipt?.description,"DeletionReceipt(job_saved)")
        XCTAssertFalse((receipt?.description ?? "").contains(token))
        var memory=DeletionReceiptMemory()
        memory.save(receipt)
        XCTAssertTrue(memory.containsToken(token))
        var resumed=AccountDeletion.resume(memory.read())
        XCTAssertEqual(resumed.step,.polling)
        XCTAssertTrue(AccountDeletion.resumesBeforeSignOut(memory.read()))
        let call=AccountDeletion.pollCall(path:resumed.statusPath ?? "",statusToken:resumed.statusToken ?? "")
        XCTAssertEqual(call?.method,"GET")
        XCTAssertEqual(call?.path,"/v2/account/deletions/job_saved")
        XCTAssertEqual(call?.authorization,"Bearer "+token)
        XCTAssertFalse(AccountDeletion.describePoll(path:call?.path ?? "").contains(token))
        XCTAssertTrue(DeletionReceiptVault.backedByKeychain)
        XCTAssertFalse(DeletionReceiptVault.usesUserDefaults)
        DeletionReceiptVault.clear()
        DeletionReceiptVault.save(jobId:"job_saved",token:token)
        let loaded=DeletionReceiptVault.load()
        XCTAssertEqual(loaded?.jobId,"job_saved")
        XCTAssertEqual(loaded?.statusToken,token)
        XCTAssertFalse((loaded?.description ?? "").contains(token))
        DeletionReceiptVault.clear()
        XCTAssertNil(DeletionReceiptVault.load())
        resumed.onPollHttp(status:200,jobStatus:"done",errorCode:nil,retryable:false)
        XCTAssertTrue(resumed.requestsWipe())
    }

    func testPollNotFoundDoesNotWipe() {
        var flow=AccountDeletion.resume(DeletionReceipt.of(jobId:"job_404",statusToken:token))
        let missing=AccountHttp.parse(status:404,data:Data(BackendFixtures.body("pollNotFound").utf8))
        flow.onPollHttp(status:missing.status,jobStatus:missing.jobStatus,errorCode:missing.error,retryable:missing.retryable)
        XCTAssertEqual(flow.step,.failed)
        XCTAssertTrue(flow.refuseDelete)
        flow.retry()
        XCTAssertEqual(flow.step,.failed)
        XCTAssertFalse(flow.allowsDelete())
        XCTAssertTrue(flow.dropReceipt)
        XCTAssertFalse(flow.requestsWipe())
        XCTAssertFalse((flow.message ?? "").contains(token))
        XCTAssertTrue(LocalWipePlan.keychainServicesRemoved(wipe:flow.requestsWipe()).isEmpty)
    }

    func testLockAndUnauthorizedDoNotWipe() {
        let body=BackendFixtures.responseBodyData(area:"workspace-lock",name:"over-cap")
        XCTAssertEqual(BackendFixtures.responseStatus(area:"workspace-lock",name:"over-cap"),423)
        let route=CloudSignals.route(status:423,body:body,method:"DELETE")
        XCTAssertEqual(route.destination,.lockScreen)
        XCTAssertNil(route.toast)
        var flow=ready()
        flow.onDeleteHttp(status:423,jobId:nil,errorCode:"workspace_lock",statusToken:nil)
        XCTAssertEqual(flow.step,.deleting)
        flow.onDeleteHttp(status:202,jobId:"job_lock",errorCode:nil,statusToken:token)
        let poll=CloudSignals.route(status:423,body:body,method:"GET")
        XCTAssertEqual(poll.destination,.lockScreen)
        XCTAssertNil(poll.toast)
        flow.onPollHttp(status:423,jobStatus:"done",errorCode:"workspace_lock",retryable:nil)
        XCTAssertEqual(flow.step,.polling)
        XCTAssertFalse(flow.requestsWipe())
        var unsigned=ready()
        let empty=AccountHttp.parse(status:401,data:Data("{}".utf8))
        unsigned.onDeleteHttp(status:empty.status,jobId:empty.jobId,errorCode:empty.error,statusToken:empty.statusToken)
        XCTAssertEqual(unsigned.step,.signedOut)
        XCTAssertFalse(unsigned.requestsWipe())
    }

    func testUnsafeJobAndAuthTime() {
        XCTAssertNil(AccountDeletion.statusPath(jobId:"a/b"))
        XCTAssertNil(AccountDeletion.statusPath(jobId:".."))
        XCTAssertEqual(AccountDeletion.statusPath(jobId:"job_1"),"/v2/account/deletions/job_1")
        XCTAssertFalse(AccountDeletion.safeAccountPath("/v2/account/deletion/job_1"))
        XCTAssertFalse(AccountDeletion.safeAccountPath("/v2/account/deletions/a/b"))
        XCTAssertTrue(AccountDeletion.safeAccountPath("/v2/account/deletions/job_1"))
        XCTAssertNil(AccountDeletion.pollCall(path:"/v2/account/deletion/job_1",statusToken:token))
        let missing=jwt("{\"iat\":1700003600}")
        XCTAssertNil(CloudSignals.authTime(missing))
        XCTAssertFalse(CloudSignals.freshSignIn(missing,now:Date(timeIntervalSince1970:1_700_003_600)))
        let future=jwt("{\"auth_time\":1700007200}")
        XCTAssertFalse(CloudSignals.freshSignIn(future,now:Date(timeIntervalSince1970:1_700_003_600)))
        let fresh=jwt("{\"auth_time\":1700000000}")
        XCTAssertTrue(CloudSignals.freshSignIn(fresh,now:Date(timeIntervalSince1970:1_700_000_300)))
        XCTAssertFalse(CloudSignals.freshSignIn(fresh,now:Date(timeIntervalSince1970:1_700_000_300.001)))
    }

    func testSameAccountLockNamesMergeAndByo() throws {
        XCTAssertEqual(BackendFixtures.sharedFixtureSHA,"4dfde4b")
        XCTAssertTrue(AccountMatch.same(expectedUid:"uid-1",expectedEmail:"owner@example.com",actualUid:"uid-1",actualEmail:"owner@example.com"))
        XCTAssertFalse(AccountMatch.same(expectedUid:"uid-1",expectedEmail:"owner@example.com",actualUid:"uid-2",actualEmail:"owner@example.com"))
        XCTAssertFalse(AccountMatch.same(expectedUid:"uid-1",expectedEmail:"owner@example.com",actualUid:"uid-1",actualEmail:"other@example.com"))
        let cache=BackendFixtures.listedWorkspaces()
        XCTAssertEqual(cache.first?.name,"Fixture Project")
        let over=WorkspaceLock.fromLockBody(BackendFixtures.responseBodyString(area:"workspace-lock",name:"over-cap")).named(cache)
        XCTAssertEqual(over.chooseMessage,"Choose 1 workspaces to remove.")
        XCTAssertEqual(over.workspaces.first?.name,"Fixture Project")
        let lapsed=WorkspaceLock.fromLockBody(BackendFixtures.responseBodyString(area:"workspace-lock",name:"lapsed")).named(cache)
        XCTAssertEqual(lapsed.workspaces.first?.name,"Fixture Project")
        XCTAssertEqual(lapsed.workspaces.first?.issue,"unpaid")
        let mixed=WorkspaceLock.fromLockBody(BackendFixtures.responseBodyString(area:"workspace-lock",name:"over-cap-and-lapsed")).named(cache)
        XCTAssertEqual(mixed.chooseMessage,"Choose 1 workspaces to remove.")
        XCTAssertEqual(mixed.workspaces.first?.name,"Fixture Project")
        for name in ["over-cap","lapsed","over-cap-and-lapsed","scope-unavailable","merge-in-progress"] {
            let raw=BackendFixtures.responseBodyData(area:"workspace-lock",name:name)
            let route=CloudSignals.route(status:BackendFixtures.responseStatus(area:"workspace-lock",name:name),body:raw,method:"POST")
            XCTAssertEqual(route.destination,.lockScreen)
            XCTAssertNil(route.toast)
            XCTAssertEqual(CloudSignals.jsonString(BackendFixtures.responseBodyString(area:"workspace-lock",name:name),"error"),"workspace_lock")
        }
        let mergePath=BackendFixtures.requestPath(area:"merge",name:"completed")
        let prefix="/v2/workspaces/"
        let suffix="/merge"
        XCTAssertTrue(mergePath.hasPrefix(prefix))
        XCTAssertTrue(mergePath.hasSuffix(suffix))
        let source=String(mergePath.dropFirst(prefix.count).dropLast(suffix.count))
        XCTAssertEqual("/"+(AccountDeletion.mergePath(sourceID:source) ?? ""),mergePath)
        let request=BackendFixtures.requestBody(area:"merge",name:"completed")
        let target=request["targetId"] as? String ?? ""
        let confirm=request["confirmName"] as? String ?? ""
        let sent=try XCTUnwrap(AccountDeletion.mergeBody(targetID:target,confirmName:confirm))
        let json=try XCTUnwrap(JSONSerialization.jsonObject(with:sent) as? [String:String])
        XCTAssertEqual(json["targetId"],target)
        XCTAssertEqual(json["confirmName"],confirm)
        XCTAssertTrue(BackendFixtures.responseBodyString(area:"merge",name:"renamed-file").contains("notes.txt (from Alpha)"))
        XCTAssertTrue(AccountDeletion.mergeNote("Alpha").contains("name (from Alpha)"))
        XCTAssertEqual(BackendFixtures.responseStatus(area:"merge",name:"confirm-name"),400)
        XCTAssertEqual(CloudSignals.jsonString(BackendFixtures.responseBodyString(area:"merge",name:"confirm-name"),"error"),"CONFIRM_NAME_REQUIRED")
        let cap=CloudSignals.route(status:BackendFixtures.responseStatus(area:"workspaces",name:"cap-reached"),body:BackendFixtures.responseBodyData(area:"workspaces",name:"cap-reached"),method:"POST")
        XCTAssertEqual(cap.destination,.genericError)
        XCTAssertEqual(BackendFixtures.responseStatus(area:"workspaces",name:"create"),201)
        let foreign=BackendFixtures.responseBodyString(area:"ownership",name:"foreign-workspace")
        let missing=CloudSignals.route(status:BackendFixtures.responseStatus(area:"ownership",name:"foreign-workspace"),body:BackendFixtures.responseBodyData(area:"ownership",name:"foreign-workspace"),method:"GET")
        XCTAssertEqual(missing.destination,.genericError)
        XCTAssertEqual(CloudSignals.jsonString(foreign,"error"),"PROJECT_NOT_FOUND")
        var flow=ready()
        flow.onDeleteHttp(status:404,jobId:nil,errorCode:CloudSignals.jsonString(foreign,"error"),statusToken:nil)
        XCTAssertFalse(flow.requestsWipe())
        let unsupported=BackendFixtures.responseBodyString(area:"byo",name:"provider-unsupported")
        XCTAssertEqual(BackendFixtures.responseStatus(area:"byo",name:"provider-unsupported"),422)
        XCTAssertEqual(CloudSignals.jsonString(unsupported,"provider"),"sftp")
        let friendly=ByoMessages.friendly(status:422,error:CloudSignals.jsonString(unsupported,"error"))
        XCTAssertEqual(friendly,ByoMessages.unsupported)
        XCTAssertFalse((friendly ?? "").contains("byo_provider_unsupported"))
        let routed=CloudSignals.route(status:422,body:BackendFixtures.responseBodyData(area:"byo",name:"provider-unsupported"),method:"POST")
        XCTAssertEqual(routed.toast,ByoMessages.unsupported)
        XCTAssertFalse((routed.toast ?? "").contains("byo_provider_unsupported"))
        let register=BackendFixtures.requestBodyString(area:"byo",name:"register")
        XCTAssertEqual(CloudSignals.jsonString(register,"provider"),"s3")
        XCTAssertFalse(register.lowercased().contains("secret"))
        XCTAssertTrue(ByoMessages.comingSoonProvider("SFTP"))
        XCTAssertTrue(ByoMessages.comingSoonProvider("Azure"))
        XCTAssertTrue(ByoMessages.comingSoonProvider("WebDAV"))
        XCTAssertFalse(ByoMessages.comingSoonProvider("s3"))
    }

    func testChunkLockHasNoToast() {
        let body=BackendFixtures.responseBodyData(area:"workspace-lock",name:"over-cap")
        let route=CloudSignals.route(status:BackendFixtures.responseStatus(area:"workspace-lock",name:"over-cap"),body:body,method:"PUT")
        XCTAssertEqual(route.destination,.lockScreen)
        XCTAssertNil(route.toast)
        XCTAssertEqual(route.lock?.overBy,1)
        let named=route.lock?.named(BackendFixtures.listedWorkspaces())
        XCTAssertEqual(named?.workspaces.first?.name,"Fixture Project")
        XCTAssertEqual(named?.chooseMessage,"Choose 1 workspaces to remove.")
        XCTAssertFalse(CloudSignals.allowsTransfer(method:"PUT",locked:true))
        XCTAssertTrue(CloudSignals.allowsTransfer(method:"GET",locked:true))
        let ok=CloudSignals.route(status:200,body:Data("{\"ok\":true}".utf8),method:"GET")
        XCTAssertEqual(ok.destination,.cont)
        XCTAssertNil(ok.toast)
        var delays=AccountDeletion()
        XCTAssertEqual(delays.nextPollDelayMillis(),1000)
        XCTAssertEqual(delays.nextPollDelayMillis(),2000)
        XCTAssertEqual(delays.nextPollDelayMillis(),4000)
        XCTAssertEqual(delays.nextPollDelayMillis(),8000)
        XCTAssertEqual(delays.nextPollDelayMillis(),8000)
        XCTAssertTrue(LocalWipePlan.accountWipeIncludesCheckpoints())
        XCTAssertTrue(LocalWipePlan.lockPauseDeletes().isEmpty)
    }

    private func ready()->AccountDeletion {
        var flow=AccountDeletion()
        flow.continueFromExplain()
        XCTAssertTrue(flow.confirmPhrase("DELETE"))
        XCTAssertTrue(flow.acceptFreshSignIn(authTime:Date(timeIntervalSince1970:1),now:Date(timeIntervalSince1970:1)))
        flow.noteDeleteSent()
        return flow
    }

    private func jwt(_ payload:String)->String {
        let encoded=Data(payload.utf8).base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"")
        return "eyJhbGciOiJub25lIn0."+encoded+"."
    }
}

/// Deletion bodies stay in `native/Mobile/fixtures/backend-http.json` (84f6fff).
/// Lock, merge, BYO, workspace, and ownership cases are `fixtures/<area>/<case>.json` at 4dfde4b.
/// The repo-root `fixtures/` directory wins when this branch has it.
private enum BackendFixtures {
    static let accountDeletionSHA="84f6fff"
    static let sharedFixtureSHA="4dfde4b"

    static func body(_ name:String)->String {
        guard let value=deletionObject()[name] as? String, !value.isEmpty else {
            preconditionFailure("Missing deletion fixture \(name)")
        }
        return value
    }

    static func responseStatus(area:String,name:String)->Int {
        let response=shared(area:area,name:name)["response"] as? [String:Any]
        if let number=response?["status"] as? Int {return number}
        if let number=response?["status"] as? NSNumber {return number.intValue}
        preconditionFailure("Missing status \(area)/\(name)")
        return 0
    }

    static func responseBodyData(area:String,name:String)->Data {
        let body=(shared(area:area,name:name)["response"] as? [String:Any])?["body"] ?? [:]
        return (try? JSONSerialization.data(withJSONObject:body)) ?? Data()
    }

    static func responseBodyString(area:String,name:String)->String {
        String(data:responseBodyData(area:area,name:name),encoding:.utf8) ?? ""
    }

    static func requestPath(area:String,name:String)->String {
        (shared(area:area,name:name)["request"] as? [String:Any])?["path"] as? String ?? ""
    }

    static func requestBody(area:String,name:String)->[String:Any] {
        (shared(area:area,name:name)["request"] as? [String:Any])?["body"] as? [String:Any] ?? [:]
    }

    static func requestBodyString(area:String,name:String)->String {
        let body=(shared(area:area,name:name)["request"] as? [String:Any])?["body"] ?? [:]
        guard let data=try? JSONSerialization.data(withJSONObject:body) else {return ""}
        return String(data:data,encoding:.utf8) ?? ""
    }

    static func listedWorkspaces()->[WorkspaceLock.Item] {
        let body=(shared(area:"workspaces",name:"list")["response"] as? [String:Any])?["body"] as? [String:Any]
        let rows=body?["workspaces"] as? [[String:Any]] ?? []
        return rows.map { WorkspaceLock.Item(workspaceID:$0["id"] as? String,name:$0["name"] as? String,issue:nil) }
    }

    private static func deletionObject()->[String:Any] {
        let text=stripComments(read(deletionURL()))
        return (try? JSONSerialization.jsonObject(with:Data(text.utf8)) as? [String:Any]) ?? [:]
    }

    private static func shared(area:String,name:String)->[String:Any] {
        let data=(try? Data(contentsOf:sharedURL(area:area,name:name))) ?? Data()
        return (try? JSONSerialization.jsonObject(with:data) as? [String:Any]) ?? [:]
    }

    private static func deletionURL()->URL {
        let root=repoFixtures().appendingPathComponent("backend-http.json")
        if FileManager.default.fileExists(atPath:root.path) {return root}
        return mobileFixtures().appendingPathComponent("backend-http.json")
    }

    private static func sharedURL(area:String,name:String)->URL {
        let relative=area+"/"+name+".json"
        let root=repoFixtures().appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath:root.path) {return root}
        return mobileFixtures().appendingPathComponent("shared").appendingPathComponent(relative)
    }

    private static func mobileFixtures()->URL {
        URL(fileURLWithPath:#filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("fixtures")
    }

    private static func repoFixtures()->URL {
        URL(fileURLWithPath:#filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("fixtures")
    }

    private static func read(_ url:URL)->String {
        (try? String(contentsOf:url,encoding:.utf8)) ?? ""
    }

    private static func stripComments(_ raw:String)->String {
        raw.split(separator:"\n",omittingEmptySubsequences:false)
            .filter { !$0.trimmingCharacters(in:.whitespaces).hasPrefix("//") }
            .joined(separator:"\n")
    }
}
