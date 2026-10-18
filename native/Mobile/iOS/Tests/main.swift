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
        XCTAssertEqual(BackendFixtures.accountDeletionSHA,"fff0a84")
        let created=AccountHttp.parse(status:202,data:Data(BackendFixtures.body("delete202").utf8))
        XCTAssertEqual(created.jobStatus,"deleting")
        XCTAssertTrue(AccountDeletion.validJob(created.jobId ?? ""))
        XCTAssertTrue(AccountDeletion.validToken(created.statusToken ?? ""))
        let running=AccountHttp.parse(status:200,data:Data(BackendFixtures.body("pollRunning").utf8))
        XCTAssertTrue(AccountDeletion.validJob(running.jobId ?? ""))
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
        XCTAssertEqual(invalid.step,.polling)
        XCTAssertEqual(invalid.statusPath,"/v2/account/deletions/..%2Fsecret")
        XCTAssertFalse(invalid.requestsWipe())
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
        XCTAssertEqual(kept.step,.reauth)
        XCTAssertEqual(kept.jobId,"job_keep")
        XCTAssertEqual(kept.statusToken,token)
        XCTAssertTrue(kept.acceptFreshSignIn(authTime:Date(timeIntervalSince1970:2),now:Date(timeIntervalSince1970:2)))
        XCTAssertTrue(kept.allowsDelete())
        kept.onDeleteHttp(status:202,jobId:"job_keep",errorCode:nil,statusToken:"status-token-new")
        XCTAssertEqual(kept.step,.polling)
        XCTAssertEqual(kept.statusToken,"status-token-new")
        XCTAssertFalse(kept.requestsWipe())
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

    func testFailedRetryableFalseClearsReceiptOnly() async {
        let dead=fixture("status-failed-not-retryable")
        XCTAssertEqual(dead.status,200)
        XCTAssertEqual(dead.jobStatus,"failed")
        XCTAssertEqual(dead.retryable,false)
        XCTAssertEqual(BackendFixtures.requestPath(area:"account-deletion",name:"status-failed-not-retryable"),"/v2/account/deletions/00000000-0000-4000-8000-000000000009")
        var flow=AccountDeletion.resume(DeletionReceipt.of(jobId:dead.jobId ?? "",statusToken:token))
        let script=ScriptedDeletionTransport()
        script.respond(dead)
        await flow.pollThrough(script)
        XCTAssertEqual(flow.step,.failed)
        XCTAssertFalse(flow.dropReceipt)
        XCTAssertTrue(flow.showSupport)
        XCTAssertFalse(flow.offersRetry())
        XCTAssertTrue(flow.canDismiss())
        XCTAssertEqual(flow.jobId,"00000000-0000-4000-8000-000000000009")
        XCTAssertEqual(flow.statusToken,token)
        XCTAssertFalse(flow.requestsWipe())
        XCTAssertTrue(SupportContact.mailto(jobId:flow.jobId)?.absoluteString.contains("Account%20deletion%20"+(dead.jobId ?? "")) ?? false)
        XCTAssertTrue(flow.dismissError())
        XCTAssertTrue(flow.dropReceipt)
        XCTAssertNil(flow.jobId)
        XCTAssertFalse(flow.requestsWipe())
        let live=fixture("status-failed")
        var retryable=AccountDeletion.resume(DeletionReceipt.of(jobId:live.jobId ?? "",statusToken:token))
        let liveScript=ScriptedDeletionTransport()
        liveScript.respond(live)
        await retryable.pollThrough(liveScript)
        XCTAssertEqual(live.retryable,true)
        XCTAssertFalse(retryable.dropReceipt)
        XCTAssertFalse(retryable.showSupport)
        XCTAssertEqual(retryable.jobId,live.jobId)
        retryable.retry()
        XCTAssertEqual(retryable.step,.reauth)
        XCTAssertTrue(retryable.acceptFreshSignIn(authTime:Date(timeIntervalSince1970:2),now:Date(timeIntervalSince1970:2)))
        XCTAssertTrue(retryable.allowsDelete())
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
        XCTAssertEqual(DeletionReceiptVault.lastStatus,errSecSuccess,"keychain save status \(DeletionReceiptVault.lastStatus)")
        let loaded=DeletionReceiptVault.load()
        XCTAssertEqual(DeletionReceiptVault.lastStatus,errSecSuccess,"keychain load status \(DeletionReceiptVault.lastStatus)")
        XCTAssertEqual(loaded?.jobId,"job_saved")
        XCTAssertEqual(loaded?.statusToken,token)
        XCTAssertFalse((loaded?.description ?? "").contains(token))
        DeletionReceiptVault.clear()
        XCTAssertNil(DeletionReceiptVault.load())
        resumed.onPollHttp(status:200,jobStatus:"done",errorCode:nil,retryable:false)
        XCTAssertTrue(resumed.requestsWipe())
    }

    func testPollNotFoundKeepsPairUntilDismissed() {
        var flow=AccountDeletion.resume(DeletionReceipt.of(jobId:"job_404",statusToken:token))
        let missing=AccountHttp.parse(status:404,data:Data(BackendFixtures.body("pollNotFound").utf8))
        flow.onPollHttp(status:missing.status,jobStatus:missing.jobStatus,errorCode:missing.error,retryable:missing.retryable)
        XCTAssertEqual(flow.step,.failed)
        XCTAssertTrue(flow.canDismiss())
        XCTAssertEqual(flow.jobId,"job_404")
        XCTAssertEqual(flow.statusToken,token)
        XCTAssertFalse(flow.dropReceipt)
        XCTAssertFalse(flow.requestsWipe())
        XCTAssertFalse((flow.message ?? "").contains(token))
        XCTAssertTrue(flow.offersRetry())
        XCTAssertTrue(LocalWipePlan.keychainServicesRemoved(wipe:flow.requestsWipe()).isEmpty)
        XCTAssertTrue(flow.dismissError())
        XCTAssertTrue(flow.dropReceipt)
        XCTAssertNil(flow.jobId)
        XCTAssertNil(flow.statusToken)
        XCTAssertFalse(flow.requestsWipe())
        XCTAssertTrue(LocalWipePlan.keychainServicesRemoved(wipe:flow.requestsWipe()).isEmpty)
        let attempts=flow.deleteAttempts
        flow.retry()
        XCTAssertEqual(flow.step,.failed)
        XCTAssertEqual(flow.deleteAttempts,attempts)
        XCTAssertFalse(flow.allowsDelete())
        var again=AccountDeletion.resume(DeletionReceipt.of(jobId:"job_404",statusToken:token))
        again.onPollHttp(status:404,jobStatus:nil,errorCode:"not_found",retryable:nil)
        again.retry()
        XCTAssertEqual(again.step,.reauth)
        XCTAssertEqual(again.jobId,"job_404")
        XCTAssertEqual(again.statusToken,token)
        XCTAssertTrue(again.acceptFreshSignIn(authTime:Date(timeIntervalSince1970:2),now:Date(timeIntervalSince1970:2)))
        XCTAssertTrue(again.allowsDelete())
        XCTAssertEqual(again.step,.deleting)
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
        unsigned.onDeleteHttp(status:202,jobId:"job_auth",errorCode:nil,statusToken:token)
        unsigned.onPollHttp(status:401,jobStatus:nil,errorCode:nil,retryable:nil)
        XCTAssertEqual(unsigned.step,.reauth)
        XCTAssertNotEqual(unsigned.step,.signedOut)
        XCTAssertEqual(unsigned.message,"Sign in again. The server only accepts a sign-in from the last 5 minutes.")
        XCTAssertFalse(unsigned.keepsPolling())
        XCTAssertFalse(unsigned.clearSession)
        XCTAssertFalse(unsigned.repeatDelete)
        XCTAssertEqual(unsigned.jobId,"job_auth")
        XCTAssertEqual(unsigned.statusToken,token)
        XCTAssertFalse(unsigned.requestsWipe())
        XCTAssertFalse(unsigned.allowsDelete())
        unsigned.onPollHttp(status:200,jobStatus:"done",errorCode:nil,retryable:false)
        XCTAssertEqual(unsigned.step,.reauth)
        XCTAssertFalse(unsigned.requestsWipe())
    }

    func testReauthRequiredRejectsADifferentAccount() {
        var flow=ready()
        let reauth=AccountHttp.parse(status:401,data:Data(BackendFixtures.body("reauth401").utf8))
        flow.onDeleteHttp(status:reauth.status,jobId:reauth.jobId,errorCode:reauth.error,statusToken:reauth.statusToken)
        XCTAssertEqual(flow.step,.reauth)
        let attempts=flow.deleteAttempts
        XCTAssertFalse(flow.rejectDifferentAccount(expectedUid:"uid-1",actualUid:"uid-1",expectedEmail:"owner@example.com",actualEmail:"owner@example.com"))
        XCTAssertEqual(flow.step,.reauth)
        XCTAssertTrue(flow.rejectDifferentAccount(expectedUid:"uid-1",actualUid:"uid-2",expectedEmail:"owner@example.com",actualEmail:"owner@example.com"))
        XCTAssertEqual(flow.step,.failed)
        XCTAssertEqual(flow.message,AccountDeletion.differentAccount)
        XCTAssertEqual(flow.deleteAttempts,attempts)
        XCTAssertFalse(flow.allowsDelete())
        XCTAssertFalse(flow.requestsWipe())
        XCTAssertTrue(LocalWipePlan.keychainServicesRemoved(wipe:flow.requestsWipe()).isEmpty)
    }

    func testUnsafeJobAndAuthTime() {
        XCTAssertTrue(AccountDeletion.validJob("a/b"))
        XCTAssertTrue(AccountDeletion.validJob(String(repeating:"x",count:200)))
        XCTAssertFalse(AccountDeletion.validJob(""))
        XCTAssertTrue(AccountDeletion.validToken("<redacted>"))
        XCTAssertTrue(AccountDeletion.validToken(String(repeating:"t",count:600)))
        XCTAssertFalse(AccountDeletion.validToken(""))
        XCTAssertEqual(AccountDeletion.statusPath(jobId:"a/b"),"/v2/account/deletions/a%2Fb")
        XCTAssertEqual(AccountDeletion.statusPath(jobId:".."),"/v2/account/deletions/..")
        XCTAssertNil(AccountDeletion.statusPath(jobId:""))
        XCTAssertEqual(AccountDeletion.statusPath(jobId:"job_1"),"/v2/account/deletions/job_1")
        XCTAssertFalse(AccountDeletion.safeAccountPath("/v2/account/deletion/job_1"))
        XCTAssertFalse(AccountDeletion.safeAccountPath("/v2/account/deletions/a/b"))
        XCTAssertTrue(AccountDeletion.safeAccountPath("/v2/account/deletions/.."))
        XCTAssertTrue(AccountDeletion.safeAccountPath("/v2/account/deletions/a%2Fb"))
        XCTAssertTrue(AccountDeletion.safeAccountPath("/v2/account/deletions/job_1"))
        XCTAssertNil(AccountDeletion.pollCall(path:"/v2/account/deletion/job_1",statusToken:token))
        XCTAssertNotNil(AccountDeletion.pollCall(path:AccountDeletion.statusPath(jobId:"a/b") ?? "",statusToken:token))
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
        XCTAssertEqual(BackendFixtures.sharedFixtureSHA,"da39276")
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
            let shown=WorkspaceLock.fromLockBody(BackendFixtures.responseBodyString(area:"workspace-lock",name:name)).named(cache)
            XCTAssertEqual(shown.reasonText,CloudSignals.jsonString(BackendFixtures.responseBodyString(area:"workspace-lock",name:name),"reason"))
            XCTAssertFalse(shown.reasonText.isEmpty)
            XCTAssertEqual(shown.overByText,"Over by \(shown.overBy)")
            if shown.reasonText=="merge_in_progress" {
                XCTAssertEqual(shown.detailText,WorkspaceLock.detailMerge)
                XCTAssertFalse(shown.detailText.contains("did not include a workspace list"))
                XCTAssertTrue(shown.workspaces.isEmpty)
                XCTAssertFalse(shown.requiresPayment)
            } else if shown.reasonText=="scope_unavailable" {
                XCTAssertEqual(shown.detailText,WorkspaceLock.detailScope)
                XCTAssertFalse(shown.detailText.contains("did not include a workspace list"))
                XCTAssertTrue(shown.workspaces.isEmpty)
                XCTAssertFalse(shown.requiresPayment)
            } else if shown.requiresPayment {
                XCTAssertEqual(shown.detailText,WorkspaceLock.detailPay)
                XCTAssertFalse(shown.detailText.contains("did not include a workspace list"))
            } else {
                XCTAssertTrue(shown.detailText.isEmpty)
                XCTAssertFalse(shown.workspaces.isEmpty)
            }
            XCTAssertEqual(WorkspaceLock.actionDelete,"Delete")
            XCTAssertEqual(WorkspaceLock.actionMerge,"Merge")
            XCTAssertEqual(WorkspaceLock.actionDownload,"Download files")
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
        XCTAssertFalse(ByoFeature.showInSettings)
        for name in ["verify-expired","verify-host-mismatch","verify-mismatch","verify-used","verify-missing-url","verify-success"] {
            let request=BackendFixtures.requestBodyString(area:"byo",name:name)
            XCTAssertFalse(request.contains("readBack"))
            XCTAssertFalse(request.contains("proofUrl"))
            let response=BackendFixtures.responseBodyString(area:"byo",name:name)
            let status=BackendFixtures.responseStatus(area:"byo",name:name)
            let code=CloudSignals.jsonString(response,"error")
            if name=="verify-missing-url" {
                XCTAssertFalse(request.contains("presignedUrl"))
                XCTAssertEqual(status,400)
                XCTAssertEqual(code,"presigned_url_required")
            } else {
                XCTAssertTrue(request.contains("presignedUrl"))
            }
            if let code {
                let friendly=ByoMessages.friendly(status:status,error:code)
                XCTAssertNotNil(friendly)
                XCTAssertFalse(friendly?.contains(code) ?? true)
                let mapped=CloudSignals.route(status:status,body:BackendFixtures.responseBodyData(area:"byo",name:name),method:"POST")
                XCTAssertEqual(mapped.toast,friendly)
            }
        }
        let verifySent=try XCTUnwrap(AccountDeletion.byoVerifyBody(presignedUrl:"https://bucket.example/object"))
        let sentJson=try XCTUnwrap(JSONSerialization.jsonObject(with:verifySent) as? [String:String])
        XCTAssertEqual(sentJson["presignedUrl"],"https://bucket.example/object")
        XCTAssertEqual(sentJson.count,1)
        let sentText=String(data:verifySent,encoding:.utf8) ?? ""
        XCTAssertFalse(sentText.contains("readBack"))
        XCTAssertFalse(sentText.contains("proofUrl"))
        XCTAssertEqual(AccountDeletion.byoVerifyPath(workspaceID:"11111111-1111-4111-8111-000000000001"),"v2/workspaces/11111111-1111-4111-8111-000000000001/byo/verify")
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

    func testTransportRunsFixtureFlowWithoutWipingEarly() async {
        var flow=ready()
        let accepted=AccountHttp.parse(status:BackendFixtures.responseStatus(area:"account-deletion",name:"accepted"),data:BackendFixtures.responseBodyData(area:"account-deletion",name:"accepted"))
        let running=AccountHttp.parse(status:BackendFixtures.responseStatus(area:"account-deletion",name:"status-running"),data:BackendFixtures.responseBodyData(area:"account-deletion",name:"status-running"))
        let done=AccountHttp.parse(status:BackendFixtures.responseStatus(area:"account-deletion",name:"status-done"),data:BackendFixtures.responseBodyData(area:"account-deletion",name:"status-done"))
        let script=ScriptedDeletionTransport()
        script.respond(accepted);script.respond(running);script.respond(done)
        let attempts=flow.deleteAttempts
        await flow.deleteThrough(script,authorization:"Bearer firebase-token")
        XCTAssertEqual(flow.step,.polling)
        XCTAssertEqual(script.calls.first?.0,"DELETE")
        XCTAssertEqual(script.calls.first?.1,"v2/account")
        XCTAssertTrue(script.authorizations.first?.hasPrefix("Bearer ") ?? false)
        XCTAssertFalse(flow.requestsWipe())
        await flow.pollThrough(script)
        XCTAssertEqual(flow.step,.polling)
        XCTAssertTrue(script.calls[1].1.hasPrefix("/v2/account/deletions/"))
        XCTAssertEqual(script.authorizations[1],"Bearer "+(flow.statusToken ?? ""))
        await flow.pollThrough(script)
        XCTAssertEqual(flow.step,.done)
        XCTAssertTrue(flow.requestsWipe())
        XCTAssertEqual(flow.deleteAttempts,attempts+1)

        var gone=ready()
        let deleted=AccountHttp.parse(status:BackendFixtures.responseStatus(area:"account-deletion",name:"account-deleted"),data:BackendFixtures.responseBodyData(area:"account-deletion",name:"account-deleted"))
        let again=ScriptedDeletionTransport()
        again.respond(deleted)
        await gone.deleteThrough(again,authorization:"Bearer firebase-token")
        XCTAssertEqual(gone.step,.polling)
        XCTAssertFalse(gone.requestsWipe())
        XCTAssertFalse(gone.allowsDelete())
    }

    func testSingularPathIsJson404AndSyntheticNonJsonDoesNotThrow() async {
        XCTAssertTrue(BackendFixtures.requestPath(area:"account-deletion",name:"singular-path").contains("/v2/account/deletion/"))
        let missingPath=fixture("singular-path")
        XCTAssertEqual(missingPath.status,404)
        XCTAssertEqual(missingPath.error,"not_found")
        XCTAssertNil(missingPath.jobId)
        var polling=AccountDeletion.resume(DeletionReceipt.of(jobId:"job_html",statusToken:token))
        let script=ScriptedDeletionTransport()
        script.respond(missingPath)
        await polling.pollThrough(script)
        XCTAssertEqual(polling.step,.failed)
        XCTAssertTrue(polling.offersRetry())
        XCTAssertTrue(polling.canDismiss())
        XCTAssertEqual(polling.jobId,"job_html")
        XCTAssertEqual(polling.statusToken,token)
        XCTAssertFalse(polling.dropReceipt)
        XCTAssertFalse(polling.requestsWipe())

        // SYNTHETIC non-JSON body. singular-path.json is JSON 404 and is not this case.
        var generic=AccountDeletion.resume(DeletionReceipt.of(jobId:"job_html",statusToken:token))
        let other=AccountHttp.parse(status:503,data:Data("<html>unavailable</html>".utf8))
        XCTAssertTrue(other.raw.contains("<html>unavailable</html>"))
        XCTAssertNil(other.error)
        let genericScript=ScriptedDeletionTransport()
        genericScript.respond(other)
        await generic.pollThrough(genericScript)
        XCTAssertTrue(generic.offersRetry())
        XCTAssertFalse(generic.plainError)
        XCTAssertEqual(generic.jobId,"job_html")
        XCTAssertEqual(generic.statusToken,token)
        XCTAssertFalse(generic.requestsWipe())

        var missing=ready()
        let plain=ScriptedDeletionTransport()
        plain.respond(missingPath)
        await missing.deleteThrough(plain,authorization:"Bearer firebase-token")
        XCTAssertTrue(missing.plainError)
        XCTAssertFalse(missing.offersRetry())
        XCTAssertFalse(missing.requestsWipe())
        XCTAssertNil(missing.jobId)

        let expired=fixture("expired-token")
        XCTAssertEqual(expired.status,404)
        XCTAssertEqual(expired.error,"not_found")
        XCTAssertTrue(BackendFixtures.requestPath(area:"account-deletion",name:"expired-token").hasSuffix("000000000005"))
        let otherJob=fixture("other-job-token")
        XCTAssertEqual(otherJob.status,404)
        XCTAssertEqual(otherJob.error,"not_found")
        XCTAssertTrue(BackendFixtures.requestPath(area:"account-deletion",name:"other-job-token").hasSuffix("000000000006"))
        XCTAssertEqual(fixture("accepted").statusToken,"<redacted>")
        XCTAssertEqual(fixture("retry-after-failed").statusToken,"<redacted>")
        XCTAssertTrue(AccountDeletion.validToken("<redacted>"))
    }

    func testStatusTokenPollStopsOnInvalidTokenAndUnauthorized() async {
        let invalid=AccountHttp.parse(status:BackendFixtures.responseStatus(area:"account-deletion",name:"status-invalid-token"),data:BackendFixtures.responseBodyData(area:"account-deletion",name:"status-invalid-token"))
        XCTAssertTrue(BackendFixtures.requestPath(area:"account-deletion",name:"status-invalid-token").hasPrefix("/v2/account/deletions/"))
        XCTAssertEqual(invalid.status,401)
        XCTAssertEqual(invalid.error,"invalid_token")
        var stopped=AccountDeletion.resume(DeletionReceipt.of(jobId:"job_poll",statusToken:token))
        let denied=ScriptedDeletionTransport()
        denied.respond(invalid)
        await stopped.pollThrough(denied)
        XCTAssertEqual(stopped.step,.reauth)
        XCTAssertFalse(stopped.keepsPolling())
        XCTAssertFalse(stopped.clearSession)
        XCTAssertTrue(stopped.repeatDelete)
        XCTAssertEqual(stopped.jobId,"job_poll")
        XCTAssertEqual(stopped.statusToken,token)
        XCTAssertFalse(stopped.dropReceipt)
        XCTAssertFalse(stopped.requestsWipe())
        let donePoll=ScriptedDeletionTransport()
        donePoll.respond(AccountHttp.parse(status:200,data:Data("{\"jobId\":\"job_poll\",\"status\":\"done\",\"retryable\":false}".utf8)))
        await stopped.pollThrough(donePoll)
        XCTAssertEqual(stopped.step,.reauth)
        XCTAssertFalse(stopped.requestsWipe())
        XCTAssertTrue(stopped.acceptFreshSignIn(authTime:Date(timeIntervalSince1970:2),now:Date(timeIntervalSince1970:2)))
        XCTAssertTrue(stopped.allowsDelete())

        let unauthorized=AccountHttp.parse(status:BackendFixtures.responseStatus(area:"account-deletion",name:"status-unauthorized"),data:BackendFixtures.responseBodyData(area:"account-deletion",name:"status-unauthorized"))
        XCTAssertEqual(unauthorized.status,401)
        XCTAssertEqual(unauthorized.error,"unauthorized")
        var signIn=AccountDeletion.resume(DeletionReceipt.of(jobId:"job_poll",statusToken:token))
        let blank=ScriptedDeletionTransport()
        blank.respond(unauthorized)
        await signIn.pollThrough(blank)
        XCTAssertEqual(signIn.step,.reauth)
        XCTAssertEqual(signIn.message,"Sign in again. The server only accepts a sign-in from the last 5 minutes.")
        XCTAssertFalse(signIn.keepsPolling())
        XCTAssertFalse(signIn.clearSession)
        XCTAssertFalse(signIn.repeatDelete)
        XCTAssertEqual(signIn.jobId,"job_poll")
        XCTAssertEqual(signIn.statusToken,token)
        XCTAssertFalse(signIn.dropReceipt)
        XCTAssertFalse(signIn.requestsWipe())
        let ignored=ScriptedDeletionTransport()
        ignored.respond(AccountHttp.parse(status:200,data:Data("{\"jobId\":\"job_poll\",\"status\":\"done\",\"retryable\":false}".utf8)))
        await signIn.pollThrough(ignored)
        XCTAssertEqual(signIn.step,.reauth)
        XCTAssertFalse(signIn.requestsWipe())
        XCTAssertTrue(signIn.acceptFreshSignIn(authTime:Date(timeIntervalSince1970:2),now:Date(timeIntervalSince1970:2)))
        XCTAssertEqual(signIn.step,.polling)
        XCTAssertFalse(signIn.allowsDelete())

        var bare=AccountDeletion.resume(DeletionReceipt.of(jobId:"job_poll",statusToken:token))
        let empty=ScriptedDeletionTransport()
        empty.respond(AccountHttp.parse(status:401,data:Data()))
        await bare.pollThrough(empty)
        XCTAssertNil(AccountHttp.parse(status:401,data:Data()).error)
        XCTAssertEqual(bare.step,.reauth)
        XCTAssertEqual(bare.message,"Sign in again. The server only accepts a sign-in from the last 5 minutes.")
        XCTAssertFalse(bare.keepsPolling())
        XCTAssertFalse(bare.clearSession)
        XCTAssertFalse(bare.repeatDelete)
        XCTAssertEqual(bare.jobId,"job_poll")
        XCTAssertEqual(bare.statusToken,token)
        XCTAssertFalse(bare.requestsWipe())
    }

    func testRetryAfterFailureSendsDeleteAndSavesTheNewToken() async {
        let failed=AccountHttp.parse(status:BackendFixtures.responseStatus(area:"account-deletion",name:"status-failed"),data:BackendFixtures.responseBodyData(area:"account-deletion",name:"status-failed"))
        XCTAssertEqual(failed.retryable,true)
        var flow=AccountDeletion.resume(DeletionReceipt.of(jobId:failed.jobId ?? "",statusToken:token))
        let script=ScriptedDeletionTransport()
        script.respond(failed)
        await flow.pollThrough(script)
        XCTAssertEqual(flow.step,.failed)
        XCTAssertTrue(flow.offersRetry())
        XCTAssertFalse(flow.showSupport)
        XCTAssertEqual(flow.jobId,failed.jobId)
        flow.retry()
        XCTAssertEqual(flow.step,.reauth)
        XCTAssertTrue(flow.acceptFreshSignIn(authTime:Date(timeIntervalSince1970:2),now:Date(timeIntervalSince1970:2)))
        XCTAssertTrue(flow.allowsDelete())
        let again=fixture("retry-after-failed")
        XCTAssertEqual(again.status,202)
        XCTAssertEqual(again.jobStatus,"queued")
        XCTAssertEqual(again.statusToken,"<redacted>")
        XCTAssertEqual(BackendFixtures.requestPath(area:"account-deletion",name:"retry-after-failed"),"/v2/account")
        let retried=ScriptedDeletionTransport()
        retried.respond(again)
        await flow.deleteThrough(retried,authorization:"Bearer firebase-token")
        XCTAssertEqual(retried.calls.first?.0,"DELETE")
        XCTAssertEqual(retried.calls.first?.1,"v2/account")
        XCTAssertEqual(flow.step,.polling)
        XCTAssertEqual(flow.jobId,again.jobId)
        XCTAssertEqual(flow.statusToken,"<redacted>")
        XCTAssertFalse(flow.requestsWipe())

        var gone=AccountDeletion.resume(DeletionReceipt.of(jobId:failed.jobId ?? "",statusToken:token))
        let failedAgain=ScriptedDeletionTransport()
        failedAgain.respond(failed)
        await gone.pollThrough(failedAgain)
        gone.retry()
        XCTAssertTrue(gone.acceptFreshSignIn(authTime:Date(timeIntervalSince1970:2),now:Date(timeIntervalSince1970:2)))
        let deleted=fixture("account-deleted")
        let finished=ScriptedDeletionTransport()
        finished.respond(deleted)
        await gone.deleteThrough(finished,authorization:"Bearer firebase-token")
        XCTAssertEqual(finished.calls.first?.0,"DELETE")
        XCTAssertEqual(finished.calls.first?.1,"v2/account")
        XCTAssertEqual(gone.step,.polling)
        XCTAssertEqual(gone.jobId,deleted.jobId)
        XCTAssertEqual(gone.statusToken,"<redacted>")
        XCTAssertFalse(gone.requestsWipe())
    }

    func testNotRetryableFailureShowsSupportAndDismissWipesNothing() async {
        XCTAssertTrue(SupportContact.isPlaceholder)
        XCTAssertEqual(SupportContact.address,"SUPPORT_CONTACT_PLACEHOLDER@invalid")
        let dead=fixture("status-failed-not-retryable")
        var failed=AccountDeletion.resume(DeletionReceipt.of(jobId:dead.jobId ?? "",statusToken:token))
        let deadScript=ScriptedDeletionTransport()
        deadScript.respond(dead)
        await failed.pollThrough(deadScript)
        XCTAssertTrue(failed.showSupport)
        XCTAssertTrue(failed.canDismiss())
        XCTAssertFalse(failed.offersRetry())
        XCTAssertEqual(failed.jobId,dead.jobId)
        XCTAssertTrue(failed.dismissError())
        XCTAssertNil(failed.jobId)
        XCTAssertFalse(failed.requestsWipe())

        let failedBody=fixture("status-failed")
        var blocked=AccountDeletion.resume(DeletionReceipt.of(jobId:failedBody.jobId ?? "",statusToken:token))
        let failedScript=ScriptedDeletionTransport()
        failedScript.respond(failedBody)
        await blocked.pollThrough(failedScript)
        blocked.retry()
        XCTAssertTrue(blocked.acceptFreshSignIn(authTime:Date(timeIntervalSince1970:2),now:Date(timeIntervalSince1970:2)))
        let conflict=fixture("retry-not-retryable")
        XCTAssertEqual(conflict.status,409)
        XCTAssertEqual(conflict.error,"deletion_not_retryable")
        XCTAssertEqual(BackendFixtures.requestPath(area:"account-deletion",name:"retry-not-retryable"),"/v2/account")
        let script=ScriptedDeletionTransport()
        script.respond(conflict)
        await blocked.deleteThrough(script,authorization:"Bearer firebase-token")
        XCTAssertEqual(script.calls.first?.0,"DELETE")
        XCTAssertEqual(script.calls.first?.1,"v2/account")
        XCTAssertEqual(blocked.step,.failed)
        XCTAssertTrue(blocked.showSupport)
        XCTAssertFalse(blocked.offersRetry())
        XCTAssertTrue(blocked.canDismiss())
        XCTAssertEqual(blocked.jobId,"00000000-0000-4000-8000-000000000009")
        XCTAssertEqual(blocked.statusToken,token)
        XCTAssertTrue(SupportContact.mailto(jobId:blocked.jobId)?.absoluteString.contains("Account%20deletion%20"+(conflict.jobId ?? "")) ?? false)
        XCTAssertFalse(blocked.requestsWipe())
        XCTAssertTrue(blocked.dismissError())
        XCTAssertNil(blocked.jobId)
        XCTAssertFalse(blocked.requestsWipe())
        XCTAssertTrue(LocalWipePlan.keychainServicesRemoved(wipe:blocked.requestsWipe()).isEmpty)
    }

    func testVendoredKeyEnvelopeAndPayloadTooLargeAreLoaded() throws {
        XCTAssertEqual(BackendFixtures.accountDeletionSHA,"fff0a84")
        XCTAssertEqual(BackendFixtures.keyEnvelopeSHA,"ee4f76f")
        let tooLarge=AccountHttp.parse(status:BackendFixtures.responseStatus(area:"errors",name:"payload-too-large"),data:BackendFixtures.responseBodyData(area:"errors",name:"payload-too-large"))
        XCTAssertEqual(tooLarge.status,413)
        XCTAssertEqual(tooLarge.error,"payload_too_large")
        XCTAssertEqual(BackendFixtures.requestPath(area:"errors",name:"payload-too-large"),"/v2/account")
        var huge=ready()
        huge.onDeleteHttp(status:tooLarge.status,jobId:tooLarge.jobId,errorCode:tooLarge.error,statusToken:tooLarge.statusToken)
        XCTAssertEqual(huge.step,.failed)
        XCTAssertFalse(huge.requestsWipe())
        XCTAssertEqual(BackendFixtures.responseStatus(area:"key-envelope",name:"create"),201)
        XCTAssertTrue(BackendFixtures.requestPath(area:"key-envelope",name:"create").hasSuffix("/key-envelope"))
        let envelopeRequest=BackendFixtures.requestBody(area:"key-envelope",name:"create")
        XCTAssertTrue((envelopeRequest["wrappedKey"] as? String)?.contains("+/v7") ?? false)
        XCTAssertTrue((envelopeRequest["iv"] as? String)?.contains("+/v7") ?? false)
        let envelopeResponse=try XCTUnwrap(JSONSerialization.jsonObject(with:BackendFixtures.responseBodyData(area:"key-envelope",name:"create")) as? [String:Any])
        XCTAssertTrue((envelopeResponse["wrappedKey"] as? String)?.contains("-_v7") ?? false)
        let conflict=AccountHttp.parse(status:BackendFixtures.responseStatus(area:"key-envelope",name:"conflict"),data:BackendFixtures.responseBodyData(area:"key-envelope",name:"conflict"))
        XCTAssertEqual(conflict.status,409)
        XCTAssertEqual(conflict.error,"envelope_exists")
        let mismatch=AccountHttp.parse(status:BackendFixtures.responseStatus(area:"key-envelope",name:"version-mismatch"),data:BackendFixtures.responseBodyData(area:"key-envelope",name:"version-mismatch"))
        XCTAssertEqual(mismatch.status,412)
        XCTAssertEqual(mismatch.error,"version_mismatch")
        let envelopeSize=AccountHttp.parse(status:BackendFixtures.responseStatus(area:"key-envelope",name:"payload-too-large"),data:BackendFixtures.responseBodyData(area:"key-envelope",name:"payload-too-large"))
        XCTAssertEqual(envelopeSize.status,413)
        XCTAssertEqual(envelopeSize.error,"payload_too_large")
    }

    func testReleaseBuildRejectsPlaceholderSupportContact() {
        #if DEBUG
        XCTAssertTrue(SupportContact.isPlaceholder)
        XCTAssertEqual(SupportContact.address,"SUPPORT_CONTACT_PLACEHOLDER@invalid")
        #else
        XCTAssertFalse(SupportContact.isPlaceholder,"RELEASE BLOCKER: replace SupportContact.address with packages/core SUPPORT_CONTACT before shipping")
        #endif
    }

    func testRetryAfterNetworkErrorSendsDeleteAgain() async {
        var flow=ready()
        flow.onDeleteHttp(status:202,jobId:"job_net",errorCode:nil,statusToken:token)
        let attempts=flow.deleteAttempts
        let offline=ScriptedDeletionTransport()
        offline.fail(ReplacementFailure.offline)
        await flow.pollThrough(offline)
        XCTAssertEqual(flow.step,.failed)
        XCTAssertTrue(flow.offersRetry())
        XCTAssertEqual(flow.jobId,"job_net")
        XCTAssertEqual(flow.statusToken,token)
        XCTAssertFalse(flow.requestsWipe())
        flow.retry()
        XCTAssertEqual(flow.step,.reauth)
        XCTAssertEqual(flow.deleteAttempts,attempts)
        XCTAssertTrue(flow.acceptFreshSignIn(authTime:Date(timeIntervalSince1970:2),now:Date(timeIntervalSince1970:2)))
        XCTAssertTrue(flow.allowsDelete())
        flow.onDeleteHttp(status:202,jobId:"job_net",errorCode:nil,statusToken:"status-token-net")
        XCTAssertEqual(flow.statusToken,"status-token-net")
        let again=ScriptedDeletionTransport()
        again.respond(AccountHttp.parse(status:200,data:Data("{\"jobId\":\"job_net\",\"status\":\"running\",\"retryable\":true}".utf8)))
        await flow.pollThrough(again)
        XCTAssertEqual(again.calls.first?.0,"GET")
        XCTAssertEqual(again.calls.first?.1,"/v2/account/deletions/job_net")
        XCTAssertEqual(again.authorizations.first,"Bearer status-token-net")
        XCTAssertEqual(flow.step,.polling)
    }

    func testErrorCodeIgnoresMessageText() {
        let disguised=AccountHttp.parse(status:400,data:Data("{\"error\":\"other\",\"message\":\"manifest_generation_required\"}".utf8))
        XCTAssertEqual(disguised.error,"other")
        let fallback=AccountHttp.parse(status:400,data:Data("{\"message\":\"try manifest_generation_required\",\"code\":\"manifest_generation_required\"}".utf8))
        XCTAssertEqual(fallback.error,"manifest_generation_required")
        let empty=AccountHttp.parse(status:401,data:Data("{\"error\":\"\",\"code\":\"reauth_required\"}".utf8))
        XCTAssertEqual(empty.error,"reauth_required")
        let weird=AccountHttp.parse(status:401,data:Data("{\"error\":\"not a code!!\",\"code\":\"reauth_required\"}".utf8))
        XCTAssertEqual(weird.error,"not a code!!")
    }

    func testFileReplacementFailureLeavesTheOldCopyReadable() throws {
        var upload=FileReplacement.Manifest(objectId:"old-object",generation:3)
        let uploadStore=MemoryReplacement()
        uploadStore.failUpload=true
        XCTAssertThrowsError(try FileReplacement.replace(uploadStore,manifest:&upload,newObjectId:"new-object",enabled:true))
        XCTAssertEqual(upload.objectId,"old-object")
        XCTAssertTrue(upload.oldReadable)
        XCTAssertFalse(upload.localTrashed)

        var put=FileReplacement.Manifest(objectId:"old-object",generation:3)
        let putStore=MemoryReplacement()
        putStore.failPut=true
        XCTAssertThrowsError(try FileReplacement.replace(putStore,manifest:&put,newObjectId:"new-object",enabled:true))
        XCTAssertEqual(put.objectId,"old-object")
        XCTAssertTrue(put.oldReadable)
        XCTAssertFalse(put.localTrashed)

        var deleted=FileReplacement.Manifest(objectId:"old-object",generation:3)
        let deleteStore=MemoryReplacement()
        deleteStore.failDelete=true
        try FileReplacement.replace(deleteStore,manifest:&deleted,newObjectId:"new-object",enabled:true)
        XCTAssertEqual(deleted.objectId,"old-object")
        XCTAssertTrue(deleted.oldReadable)
        XCTAssertFalse(deleted.localTrashed)
        XCTAssertFalse(deleteStore.events.contains("trash"))
    }

    func testConflict412NeverPutsAgainAndKeepsTheOldCopy() {
        XCTAssertFalse(EncryptedWorkspace.ENCRYPTED_WORKSPACE_ENABLED)
        var blocked=FileReplacement.Manifest(objectId:"old-object",generation:3)
        let blockedStore=MemoryReplacement()
        XCTAssertThrowsError(try FileReplacement.replace(blockedStore,manifest:&blocked,newObjectId:"new-object")) { error in
            XCTAssertTrue(error is FileReplacement.Disabled)
        }
        XCTAssertEqual(blockedStore.events,[])
        XCTAssertEqual(blocked.objectId,"old-object")
        XCTAssertFalse(blocked.localTrashed)

        var conflicted=FileReplacement.Manifest(objectId:"old-object",generation:3)
        let conflictStore=MemoryReplacement()
        conflictStore.conflict=true
        XCTAssertThrowsError(try FileReplacement.replace(conflictStore,manifest:&conflicted,newObjectId:"new-object",enabled:true)) { error in
            XCTAssertEqual((error as? LocalizedError)?.errorDescription,"changed on another device, retry")
        }
        XCTAssertEqual(conflictStore.events,["upload","put"])
        XCTAssertEqual(conflictStore.puts,1)
        XCTAssertEqual(conflictStore.uploaded,["new-object"])
        XCTAssertTrue(conflictStore.deleted.isEmpty)
        XCTAssertFalse(conflictStore.events.contains("trash"))
        XCTAssertFalse(conflictStore.events.contains("refetch"))
        XCTAssertEqual(conflicted.objectId,"old-object")
        XCTAssertEqual(conflicted.generation,Int64(3))
        XCTAssertTrue(conflicted.oldReadable)
        XCTAssertFalse(conflicted.localTrashed)
    }

    func testSupportRequestUsesRileyFixturesAndSendsNoBody() {
        XCTAssertEqual(BackendFixtures.supportFixtureSHA,"d33970c")
        XCTAssertFalse(DeletionSupport.enabled)
        let job="00000000-0000-4000-8000-00000000000a"
        XCTAssertFalse(DeletionSupport.call(jobId:job,statusToken:token).send)
        let call=DeletionSupport.call(jobId:job,statusToken:token,enabled:true)
        XCTAssertEqual(call.path,"/v2/account/deletions/"+job+"/support-request")
        XCTAssertEqual(call.authorization,"Bearer "+token)
        XCTAssertEqual(call.path,BackendFixtures.requestPath(area:"account-deletion",name:"support-received"))
        XCTAssertEqual(BackendFixtures.requestBodyString(area:"account-deletion",name:"support-received"),"")
        XCTAssertEqual(call.path,BackendFixtures.requestPath(area:"account-deletion",name:"support-repeat"))
        XCTAssertEqual(BackendFixtures.requestBodyString(area:"account-deletion",name:"support-repeat"),"")
        XCTAssertEqual(call.path,BackendFixtures.requestPath(area:"account-deletion",name:"support-bad-token"))
        XCTAssertEqual(call.path,BackendFixtures.requestPath(area:"account-deletion",name:"support-rate-limited"))
        XCTAssertEqual(BackendFixtures.requestPath(area:"account-deletion",name:"support-not-needed"),"/v2/account/deletions/00000000-0000-4000-8000-00000000000b/support-request")
        XCTAssertEqual(BackendFixtures.requestBodyString(area:"account-deletion",name:"support-not-needed"),"")
        XCTAssertEqual(BackendFixtures.responseStatus(area:"account-deletion",name:"support-received"),202)
        XCTAssertEqual(BackendFixtures.responseStatus(area:"account-deletion",name:"support-repeat"),202)
        let received=BackendFixtures.responseBodyString(area:"account-deletion",name:"support-received")
        let repeated=BackendFixtures.responseBodyString(area:"account-deletion",name:"support-repeat")
        let first=DeletionSupport.interpret(status:202,body:received,transportFailed:false)
        let again=DeletionSupport.interpret(status:202,body:repeated,transportFailed:false)
        XCTAssertEqual(first.kind,.sent)
        XCTAssertEqual(again.kind,.sent)
        XCTAssertEqual(first.message,"Request sent.")
        XCTAssertEqual(first.requestId,again.requestId)
        XCTAssertFalse(first.requestId?.isEmpty ?? true)
        XCTAssertEqual(BackendFixtures.responseStatus(area:"account-deletion",name:"support-not-needed"),409)
        let refresh=DeletionSupport.interpret(status:409,body:BackendFixtures.responseBodyString(area:"account-deletion",name:"support-not-needed"),transportFailed:false)
        XCTAssertEqual(refresh.kind,.refresh)
        XCTAssertFalse(refresh.opensMailto)
        var flow=AccountDeletion.resume(DeletionReceipt.of(jobId:job,statusToken:token))
        XCTAssertTrue(flow.refreshAfterSupport())
        XCTAssertEqual(flow.step,.polling)
        XCTAssertFalse(flow.requestsWipe())
        XCTAssertEqual(BackendFixtures.responseStatus(area:"account-deletion",name:"support-rate-limited"),429)
        let limited=DeletionSupport.interpret(status:429,body:BackendFixtures.responseBodyString(area:"account-deletion",name:"support-rate-limited"),transportFailed:false)
        XCTAssertEqual(limited.kind,.already)
        XCTAssertEqual(limited.message,"Request already sent.")
        XCTAssertFalse(limited.opensMailto)
        XCTAssertTrue(DeletionSupport.interpret(status:503,body:"",transportFailed:false).opensMailto)
        XCTAssertTrue(DeletionSupport.interpret(status:0,body:"",transportFailed:true).opensMailto)
        XCTAssertTrue(SupportContact.mailto(jobId:job)?.absoluteString.hasPrefix("mailto:SUPPORT_CONTACT_PLACEHOLDER@invalid") ?? false)
    }

    func testSupport404ShowsMailtoAndNeverSignIn() async {
        XCTAssertEqual(BackendFixtures.responseStatus(area:"account-deletion",name:"support-bad-token"),404)
        let body=BackendFixtures.responseBodyString(area:"account-deletion",name:"support-bad-token")
        XCTAssertEqual(CloudSignals.jsonString(body,"error"),"not_found")
        let missing=DeletionSupport.interpret(status:404,body:body,transportFailed:false)
        let unavailable=DeletionSupport.interpret(status:503,body:"<html>unavailable</html>",transportFailed:false)
        let offline=DeletionSupport.interpret(status:0,body:"",transportFailed:true)
        XCTAssertEqual(missing.kind,.mailto)
        XCTAssertEqual(unavailable.kind,missing.kind)
        XCTAssertEqual(offline.kind,missing.kind)
        XCTAssertTrue(missing.opensMailto)
        let dead=fixture("status-failed-not-retryable")
        var flow=AccountDeletion.resume(DeletionReceipt.of(jobId:dead.jobId ?? "",statusToken:token))
        let script=ScriptedDeletionTransport()
        script.respond(dead)
        await flow.pollThrough(script)
        XCTAssertEqual(flow.step,.failed)
        XCTAssertTrue(flow.showSupport)
        let kept=flow.message
        XCTAssertTrue(flow.applySupport(missing))
        XCTAssertEqual(flow.step,.failed)
        XCTAssertNotEqual(flow.step,.reauth)
        XCTAssertNotEqual(flow.step,.signedOut)
        XCTAssertFalse(flow.repeatDelete)
        XCTAssertFalse(flow.clearSession)
        XCTAssertEqual(flow.message,kept)
        XCTAssertFalse(flow.message?.contains("Sign in") ?? true)
        XCTAssertTrue(flow.showSupport)
        XCTAssertFalse(flow.requestsWipe())
        XCTAssertTrue(SupportContact.mailto(jobId:flow.jobId)?.absoluteString.hasPrefix("mailto:SUPPORT_CONTACT_PLACEHOLDER@invalid") ?? false)
    }

    /// Riley PR #6 at `0486412`: `support-unauthorized.json`. Required, no auth header at all.
    func testSupportUnauthorizedFixtureOpensMailtoAndNeverSignIn() async {
        XCTAssertFalse(DeletionSupport.enabled)
        XCTAssertEqual(BackendFixtures.responseStatus(area:"account-deletion",name:"support-unauthorized"),401)
        let unauthorized=BackendFixtures.responseBodyString(area:"account-deletion",name:"support-unauthorized")
        XCTAssertEqual(CloudSignals.jsonString(unauthorized,"error"),"unauthorized")
        XCTAssertEqual(BackendFixtures.requestBodyString(area:"account-deletion",name:"support-unauthorized"),"")
        XCTAssertTrue(BackendFixtures.requestPath(area:"account-deletion",name:"support-unauthorized").hasSuffix("/support-request"))
        let coded=DeletionSupport.interpret(status:401,body:unauthorized,transportFailed:false)
        XCTAssertEqual(coded.kind,.mailto)
        XCTAssertEqual(DeletionSupport.interpret(status:401,body:"",transportFailed:false).kind,.mailto)
        XCTAssertEqual(DeletionSupport.interpret(status:401,body:"{}",transportFailed:false).kind,.mailto)
        XCTAssertEqual(DeletionSupport.interpret(status:401,body:"{\"error\":\"invalid_token\"}",transportFailed:false).kind,.mailto)
        let dead=fixture("status-failed-not-retryable")
        var flow=AccountDeletion.resume(DeletionReceipt.of(jobId:dead.jobId ?? "",statusToken:token))
        let script=ScriptedDeletionTransport()
        script.respond(dead)
        await flow.pollThrough(script)
        let kept=flow.message
        XCTAssertTrue(flow.applySupport(coded))
        XCTAssertEqual(flow.step,.failed)
        XCTAssertFalse(flow.repeatDelete)
        XCTAssertFalse(flow.clearSession)
        XCTAssertEqual(flow.message,kept)
        XCTAssertFalse(flow.message?.contains("Sign in") ?? true)
    }

    func testSupportOtherClientErrorsAndServerErrorsOpenMailto() async {
        for status in [400,403,404,405,409,410,413,422,500,502,503] {
            XCTAssertEqual(DeletionSupport.interpret(status:status,body:"{\"error\":\"x\"}",transportFailed:false).kind,.mailto,"status \(status)")
        }
        XCTAssertEqual(DeletionSupport.interpret(status:0,body:"",transportFailed:true).kind,.mailto)
        XCTAssertEqual(DeletionSupport.interpret(status:202,body:"{}",transportFailed:false).kind,.mailto)
        let dead=fixture("status-failed-not-retryable")
        for status in [400,403,413,422] {
            var flow=AccountDeletion.resume(DeletionReceipt.of(jobId:dead.jobId ?? "",statusToken:token))
            let script=ScriptedDeletionTransport()
            script.respond(dead)
            await flow.pollThrough(script)
            XCTAssertTrue(flow.applySupport(DeletionSupport.interpret(status:status,body:"",transportFailed:false)))
            XCTAssertEqual(flow.step,.failed)
            XCTAssertTrue(flow.showSupport)
        }
    }

    func testSupportJobMismatchSendsNothing() {
        let job=fixture("status-failed-not-retryable").jobId ?? ""
        XCTAssertTrue(DeletionSupport.call(jobId:job,savedJobId:job,statusToken:token,enabled:true).send)
        let other=DeletionSupport.call(jobId:job,savedJobId:"00000000-0000-4000-8000-0000000000ff",statusToken:token,enabled:true)
        XCTAssertFalse(other.send)
        XCTAssertNil(other.path)
        XCTAssertNil(other.authorization)
        XCTAssertFalse(DeletionSupport.call(jobId:job,savedJobId:nil,statusToken:token,enabled:true).send)
        XCTAssertFalse(DeletionSupport.call(jobId:job,savedJobId:job,statusToken:token,enabled:false).send)
    }

    func testSupportRefreshFailureAfter409OpensMailtoAndNeverSignIn() async {
        let dead=fixture("status-failed-not-retryable")
        let refresh=DeletionSupport.interpret(status:409,body:BackendFixtures.responseBodyString(area:"account-deletion",name:"support-not-needed"),transportFailed:false)
        XCTAssertEqual(refresh.kind,.refresh)
        let failures:[Result<AccountHttp,Error>]=[
            .failure(ReplacementFailure.offline),
            .success(AccountHttp.parse(status:503,data:Data())),
            .success(AccountHttp.parse(status:401,data:Data("{\"error\":\"invalid_token\"}".utf8))),
        ]
        for failure in failures {
            var flow=AccountDeletion.resume(DeletionReceipt.of(jobId:dead.jobId ?? "",statusToken:token))
            let first=ScriptedDeletionTransport()
            first.respond(dead)
            await flow.pollThrough(first)
            XCTAssertFalse(flow.applySupport(refresh))
            XCTAssertTrue(flow.keepsPolling())
            let script=ScriptedDeletionTransport()
            switch failure {
            case .success(let body): script.respond(body)
            case .failure(let error): script.fail(error)
            }
            await flow.pollThrough(script)
            XCTAssertTrue(flow.openSupportMailto)
            XCTAssertEqual(flow.step,.failed)
            XCTAssertNotEqual(flow.step,.reauth)
            XCTAssertFalse(flow.clearSession)
            XCTAssertTrue(flow.showSupport)
            XCTAssertFalse(flow.message?.contains("Sign in") ?? true)
        }
        var ok=AccountDeletion.resume(DeletionReceipt.of(jobId:dead.jobId ?? "",statusToken:token))
        let a=ScriptedDeletionTransport();a.respond(dead);await ok.pollThrough(a)
        _=ok.applySupport(refresh)
        let b=ScriptedDeletionTransport();b.respond(AccountHttp.parse(status:200,data:Data("{\"jobId\":\"\(dead.jobId ?? "")\",\"status\":\"running\"}".utf8)));await ok.pollThrough(b)
        XCTAssertFalse(ok.openSupportMailto)
        XCTAssertFalse(ok.supportRefresh)
    }

    private func refreshing(_ dead:AccountHttp) async -> AccountDeletion {
        var flow=AccountDeletion.resume(DeletionReceipt.of(jobId:dead.jobId ?? "",statusToken:token))
        let first=ScriptedDeletionTransport();first.respond(dead);await flow.pollThrough(first)
        let refresh=DeletionSupport.interpret(status:409,body:BackendFixtures.responseBodyString(area:"account-deletion",name:"support-not-needed"),transportFailed:false)
        XCTAssertFalse(flow.applySupport(refresh))
        return flow
    }
    private func status(_ job:String?,_ value:String)->AccountHttp {
        AccountHttp.parse(status:200,data:Data("{\"jobId\":\"\(job ?? "")\",\"status\":\"\(value)\",\"retryable\":true}".utf8))
    }

    func testSupportRefreshFailedOpensMailto() async {
        let dead=fixture("status-failed-not-retryable")
        var flow=await refreshing(dead)
        let s=ScriptedDeletionTransport();s.respond(status(dead.jobId,"failed"));await flow.pollThrough(s)
        XCTAssertTrue(flow.openSupportMailto)
        XCTAssertEqual(flow.step,.failed)
        XCTAssertTrue(flow.showSupport)
    }

    func testSupportRefreshRunningOrQueuedShowsStillInProgress() async {
        let dead=fixture("status-failed-not-retryable")
        for value in ["running","queued"] {
            var flow=await refreshing(dead)
            let s=ScriptedDeletionTransport();s.respond(status(dead.jobId,value));await flow.pollThrough(s)
            XCTAssertFalse(flow.openSupportMailto,value)
            XCTAssertEqual(flow.message,"Your deletion is still in progress.")
            XCTAssertNotEqual(flow.step,.failed)
            XCTAssertFalse(flow.showSupport)
        }
    }

    func testSupportRefreshInvalidBodyFallsBack() async {
        let dead=fixture("status-failed-not-retryable")
        for body in ["","not json","{}","{\"status\":\"completed\"}","{\"status\":42}"] {
            var flow=await refreshing(dead)
            let s=ScriptedDeletionTransport();s.respond(AccountHttp.parse(status:200,data:Data(body.utf8)));await flow.pollThrough(s)
            XCTAssertTrue(flow.openSupportMailto,body)
            XCTAssertEqual(flow.step,.failed)
        }
    }

    func testSupportRefreshForAnotherJobFallsBack() async {
        let dead=fixture("status-failed-not-retryable")
        for value in ["running","queued","done"] {
            var flow=await refreshing(dead)
            let s=ScriptedDeletionTransport();s.respond(status("00000000-0000-4000-8000-0000000000ff",value));await flow.pollThrough(s)
            XCTAssertTrue(flow.openSupportMailto,value)
            XCTAssertEqual(flow.step,.failed)
            XCTAssertFalse(flow.requestsWipe())
        }
        var missing=await refreshing(dead)
        let m=ScriptedDeletionTransport();m.respond(AccountHttp.parse(status:200,data:Data("{\"status\":\"running\"}".utf8)));await missing.pollThrough(m)
        XCTAssertTrue(missing.openSupportMailto)
    }

    func testSupportBlankStatusTokenSendsNothingAndOpensMailto() async {
        let dead=fixture("status-failed-not-retryable")
        let job=dead.jobId ?? ""
        for blank in ["","   ","\t\n "] {
            let call=DeletionSupport.call(jobId:job,savedJobId:job,statusToken:blank,enabled:true)
            XCTAssertFalse(call.send)
            XCTAssertNil(call.path)
            XCTAssertNil(call.authorization)
            let script=ScriptedDeletionTransport()
            var flow=AccountDeletion.resume(DeletionReceipt.of(jobId:job,statusToken:blank))
            await flow.pollThrough(script)
            XCTAssertEqual(script.calls.count,0)
            XCTAssertNotEqual(flow.step,.reauth)
            XCTAssertNotEqual(flow.step,.signedOut)
            XCTAssertFalse(flow.clearSession)
            XCTAssertTrue(SupportContact.mailto(jobId:job)?.absoluteString.hasPrefix("mailto:SUPPORT_CONTACT_PLACEHOLDER@invalid") ?? false)
        }
        XCTAssertFalse(DeletionSupport.call(jobId:job,savedJobId:job,statusToken:nil,enabled:true).send)
    }

    func testSupportSavedJobReadFailureFallsBackToMailto() {
        let job=fixture("status-failed-not-retryable").jobId ?? ""
        XCTAssertNil(DeletionSupport.savedJob{throw ReplacementFailure.offline})
        XCTAssertEqual(DeletionSupport.savedJob{job},job)
        XCTAssertFalse(DeletionSupport.call(jobId:job,savedJobId:DeletionSupport.savedJob{throw ReplacementFailure.delete},statusToken:token,enabled:true).send)
    }

    func testSupport429ShowsAlreadySentWithoutCountdown() {
        let body=BackendFixtures.responseBodyString(area:"account-deletion",name:"support-rate-limited")
        for extra in [body,"{\"error\":\"rate_limited\",\"retryAfter\":-5}","{\"error\":\"rate_limited\",\"retryAfter\":\"soon\"}",""] {
            let result=DeletionSupport.interpret(status:429,body:extra,transportFailed:false)
            XCTAssertEqual(result.kind,.already)
            XCTAssertEqual(result.message,"Request already sent.")
            XCTAssertFalse(result.opensMailto)
        }
    }

    // MARK: QA (Morgan) support contract rows vs core caf30ae / 4582ae7, PR #8 at e5f1982.
    // Mirrors Android SupportContractTest. Sender-level (GDTransferClient.once) blank-token rows are not
    // here: the URLSession is private and ephemeral, so there is no seam to count requests without a source change.

    func testSupportMalformed202OpensMailto() {
        for body in ["{\"status\":\"received\"}","{\"status\":\"received\",\"requestId\":\"\"}","{\"requestId\":\"req-1\"}","{\"status\":\"queued\",\"requestId\":\"req-1\"}","{\"status\":\"RECEIVED\",\"requestId\":\"req-1\"}","not json",""] {
            let result=DeletionSupport.interpret(status:202,body:body,transportFailed:false)
            XCTAssertEqual(result.kind,.mailto,body)
            XCTAssertTrue(result.opensMailto,body)
        }
        XCTAssertEqual(DeletionSupport.interpret(status:202,body:"{\"status\":\"received\",\"requestId\":\"req-1\"}",transportFailed:false).kind,.sent)
    }

    func testSupportUnexpectedSuccessRedirectAnd423StatusesOpenMailto() {
        let received="{\"status\":\"received\",\"requestId\":\"req-1\"}"
        for code in [200,201,204,301,302,304,307,423] {
            XCTAssertEqual(DeletionSupport.interpret(status:code,body:received,transportFailed:false).kind,.mailto,"status \(code)")
        }
    }

    func testSupportOnly409SupportNotNeededRefreshes() {
        for body in ["","{}","{\"error\":\"deletion_not_retryable\"}","{\"code\":\"support_not_needed\"}","{\"error\":\"SUPPORT_NOT_NEEDED\"}"] {
            XCTAssertEqual(DeletionSupport.interpret(status:409,body:body,transportFailed:false).kind,.mailto,body)
        }
        XCTAssertEqual(DeletionSupport.interpret(status:409,body:"{\"error\":\"support_not_needed\"}",transportFailed:false).kind,.refresh)
    }

    func testSupportErrorsAreNeverAlreadySentOrRefresh() {
        let limited=BackendFixtures.responseBodyString(area:"account-deletion",name:"support-rate-limited")
        let notNeeded=BackendFixtures.responseBodyString(area:"account-deletion",name:"support-not-needed")
        for code in [401,404,500,502,503,504] {
            for body in [limited,notNeeded] {
                XCTAssertEqual(DeletionSupport.interpret(status:code,body:body,transportFailed:false).kind,.mailto,"status \(code)")
            }
        }
        XCTAssertEqual(DeletionSupport.interpret(status:429,body:limited,transportFailed:true).kind,.mailto)
        XCTAssertEqual(DeletionSupport.interpret(status:409,body:notNeeded,transportFailed:true).kind,.mailto)
        XCTAssertEqual(DeletionSupport.interpret(status:202,body:"{\"status\":\"received\",\"requestId\":\"r\"}",transportFailed:true).kind,.mailto)
    }

    func testSupportRefreshDoneForThisJobContinuesNormally() async {
        let dead=fixture("status-failed-not-retryable")
        var flow=await refreshing(dead)
        let s=ScriptedDeletionTransport();s.respond(status(dead.jobId,"done"));await flow.pollThrough(s)
        XCTAssertFalse(flow.openSupportMailto)
        XCTAssertFalse(flow.supportRefresh)
        XCTAssertEqual(flow.step,.done)
        XCTAssertTrue(flow.requestsWipe())
        XCTAssertFalse(flow.clearSession)
    }

    func testSupportRefreshIsASingleGet() async {
        let dead=fixture("status-failed-not-retryable")
        var flow=await refreshing(dead)
        let s=ScriptedDeletionTransport();s.respond(status(dead.jobId,"queued"));await flow.pollThrough(s)
        XCTAssertEqual(s.calls.count,1)
        XCTAssertEqual(s.calls.first?.0,"GET")
        XCTAssertFalse(flow.supportRefresh)
        XCTAssertEqual(flow.message,"Your deletion is still in progress.")
    }

    func testSupportEmptyTokenSendsNothing() {
        let job=fixture("status-failed-not-retryable").jobId ?? ""
        for value in [nil,""] as [String?] {
            let call=DeletionSupport.call(jobId:job,savedJobId:job,statusToken:value,enabled:true)
            XCTAssertFalse(call.send)
            XCTAssertNil(call.authorization)
        }
    }

    func testSupportWhitespaceTokenSendsNothing() {
        let job=fixture("status-failed-not-retryable").jobId ?? ""
        // Failed at e226d4e (validToken only checked isEmpty); fixed by e5f1982 validToken trim.
        for value in [" ","   ","\t","\n"," \t\n "] {
            let call=DeletionSupport.call(jobId:job,savedJobId:job,statusToken:value,enabled:true)
            XCTAssertFalse(call.send,"token length \(value.count)")
            XCTAssertNil(call.authorization)
        }
    }

    func testSupportWhitespaceTokenRefreshFallsBack() {
        let job=fixture("status-failed-not-retryable").jobId ?? ""
        // Failed at e226d4e; fixed by e5f1982.
        var flow=AccountDeletion.resume(DeletionReceipt.of(jobId:job,statusToken:"   "))
        XCTAssertFalse(flow.refreshAfterSupport())
    }

    /// Riley PR #5 at 0715b1a. Labels come from the server fields. `feeWaived` is required.
    func testWorkspacePriceUsesRileyFixturesAndNeverCounts() throws {
        XCTAssertEqual(BackendFixtures.workspacePriceSHA,"0715b1a")
        XCTAssertFalse(WorkspacePrice.enabled)
        let freeFirst=BackendFixtures.pricedWorkspaces("free-first")[0]
        let shown=try JSONDecoder().decode(MobileWorkspace.self,from:JSONSerialization.data(withJSONObject:freeFirst))
        XCTAssertEqual(shown.pickerLabel,"Free Hosted")
        XCTAssertEqual(pricedLabel(freeFirst,enabled:false),"Free Hosted")
        XCTAssertEqual(pricedLabel(freeFirst),"Free Hosted · Free")
        XCTAssertEqual(WorkspacePrice.priceLabel(isFree:true,grandfathered:true,cents:0),"Free")
        XCTAssertEqual(pricedLabel(BackendFixtures.pricedWorkspaces("second-paid")[0]),"Second Workspace · $5/mo")
        XCTAssertEqual(pricedLabel(BackendFixtures.pricedWorkspaces("delete-free-then-create")[0]),"Replacement Free · Free")
        let concurrent=BackendFixtures.pricedWorkspaces("concurrent-create-one-free")
        XCTAssertEqual(concurrent.count,2)
        XCTAssertEqual(pricedLabel(concurrent[0]),"Concurrent A · Free")
        XCTAssertEqual(pricedLabel(concurrent[1]),"Concurrent B · $5/mo")
        let mixed=BackendFixtures.pricedWorkspaces("list-hosted-plus-byo")
        XCTAssertEqual(pricedLabel(mixed[0]),"Free Hosted · $5/mo")
        XCTAssertEqual(pricedLabel(mixed[1]),"Second Workspace · Free")
        XCTAssertEqual(pricedLabel(BackendFixtures.pricedWorkspaces("list-byo-only")[0]),"Only BYO · $5/mo")
        XCTAssertEqual(WorkspacePrice.priceLabel(isFree:false,grandfathered:true,cents:0),"Included")
        let aged=BackendFixtures.pricedWorkspaces("grandfathered-plus-new")
        XCTAssertEqual(aged.count,2)
        XCTAssertEqual(pricedLabel(aged[0],enabled:false),"One-time paid")
        XCTAssertEqual(pricedLabel(aged[1],enabled:false),"New Hosted")
        XCTAssertEqual(pricedLabel(aged[0]),"One-time paid · Included")
        XCTAssertEqual(pricedLabel(aged[1]),"New Hosted · Free")
        XCTAssertEqual(WorkspacePrice.priceLabel(isFree:true,grandfathered:true,cents:0),"Free")
        XCTAssertNil(WorkspacePrice.formatCents(0))
        XCTAssertNil(WorkspacePrice.formatCents(nil))
        XCTAssertEqual(WorkspacePrice.pickerText(name:"Zero",isFree:false,grandfathered:false,cents:0,enabled:true),"Zero")
        XCTAssertEqual(WorkspacePrice.formatCents(1250),"$12.50/mo")
        XCTAssertFalse(WorkspacePrice.pickerText(name:"Zero",isFree:false,grandfathered:false,cents:0,enabled:true).contains("$0"))
        let byo=(BackendFixtures.sharedBody("workspaces","byo-first-paid"))
        XCTAssertEqual(byo["isFree"] as? Bool,false)
        XCTAssertEqual((byo["monthlyPriceCents"] as? NSNumber)?.intValue,500)
        XCTAssertEqual(WorkspacePrice.priceLabel(isFree:false,grandfathered:false,cents:500),"$5/mo")
        XCTAssertEqual(BackendFixtures.sharedBody("workspaces","free-to-byo-billable")["isFree"] as? Bool,false)
        let lapsed=CloudSignals.route(status:423,body:BackendFixtures.responseBodyData(area:"workspace-lock",name:"lapsed"),method:"POST")
        XCTAssertEqual(lapsed.destination,.lockScreen)
        XCTAssertEqual(lapsed.lock?.reasonText,"lapsed")
        XCTAssertTrue(lapsed.lock?.requiresPayment==true)
        let waived=BackendFixtures.pricedWorkspaces("owner-fee-waived")[0]
        XCTAssertEqual(waived["feeWaived"] as? Bool,true)
        XCTAssertEqual((waived["monthlyPriceCents"] as? NSNumber)?.intValue,0)
        let waivedModel=try JSONDecoder().decode(MobileWorkspace.self,from:JSONSerialization.data(withJSONObject:waived))
        XCTAssertTrue(waivedModel.feeWaived)
        XCTAssertEqual(pricedLabel(waived,enabled:false),"Owner Benefit")
        XCTAssertEqual(pricedLabel(waived),"Owner Benefit · Included")
        var missing=waived
        missing.removeValue(forKey:"feeWaived")
        XCTAssertThrowsError(try JSONDecoder().decode(MobileWorkspace.self,from:JSONSerialization.data(withJSONObject:missing)))
        let ended=BackendFixtures.sharedBody("workspaces","byo-register-ends-grandfathered")
        XCTAssertEqual(ended["grandfatheringEnded"] as? Bool,true)
        XCTAssertEqual(ended["grandfathered"] as? Bool,false)
        XCTAssertEqual(ended["feeWaived"] as? Bool,false)
        XCTAssertEqual((ended["monthlyPriceCents"] as? NSNumber)?.intValue,500)
        let endedLabel=WorkspacePrice.pickerText(name:"Workspace",isFree:ended["isFree"] as? Bool,grandfathered:(ended["grandfathered"] as? Bool)==true,feeWaived:ended["feeWaived"] as! Bool,cents:(ended["monthlyPriceCents"] as? NSNumber)?.intValue,enabled:true)
        XCTAssertEqual(endedLabel,"Workspace · $5/mo")
        XCTAssertFalse(endedLabel.contains("Included"))
    }

    /// Riley PR #5 at 0715b1a. Busy and deleting use the documented status strings. Lock and grace use the fixtures.
    func testThemeContrastIsAA() {
        let pairs:[(UInt32,UInt32)]=[
            (GDTheme.textHex,GDTheme.bgHex),(GDTheme.textHex,GDTheme.surfaceHex),(GDTheme.mutedHex,GDTheme.surfaceHex),
            (GDTheme.mutedHex,GDTheme.raisedHex),(GDTheme.kickerHex,GDTheme.bgHex),(0xFFFFFF,GDTheme.primaryHex),
            (GDTheme.secondaryTextHex,GDTheme.secondaryBgHex),(GDTheme.dangerTextHex,GDTheme.dangerBgHex),(GDTheme.warnTextHex,GDTheme.warnBgHex),
        ]
        for (fg,bg) in pairs {XCTAssertGreaterThanOrEqual(GDTheme.contrast(fg,bg),4.5,String(format:"%06X on %06X",fg,bg))}
        XCTAssertLessThan(GDTheme.contrast(GDTheme.dangerBgHex,GDTheme.surfaceHex),1.5)
        XCTAssertGreaterThanOrEqual(GDTheme.touch,44)
    }

    func testWorkspaceBusyDeletingLockAndGrace() {
        XCTAssertFalse(WorkspacePrice.enabled)
        XCTAssertFalse(EncryptedWorkspace.ENCRYPTED_WORKSPACE_ENABLED)
        XCTAssertFalse(ByoFeature.showInSettings)
        XCTAssertTrue(WorkspacePolicy.keepsWorkspace(status:409,error:"workspace_busy"))
        XCTAssertEqual(WorkspacePolicy.deleteNotice(status:409,error:"workspace_busy"),"busy, try again")
        XCTAssertFalse(WorkspacePolicy.keepsWorkspace(status:200,error:"workspace_busy"))
        XCTAssertFalse(WorkspacePolicy.keepsWorkspace(status:409,error:"conflict"))
        XCTAssertNil(WorkspacePolicy.deleteNotice(status:200,error:"ok"))

        XCTAssertEqual(WorkspacePolicy.rowTitle("Paid · Included",projectStatus:"deleting"),"Deleting...")
        XCTAssertFalse(WorkspacePolicy.actionsEnabled("deleting"))
        XCTAssertEqual(WorkspacePolicy.rowTitle("Paid · Included",projectStatus:"active"),"Paid · Included")
        XCTAssertTrue(WorkspacePolicy.actionsEnabled("active"))
        XCTAssertTrue(WorkspacePolicy.actionsEnabled(nil))

        let lapsedBody=BackendFixtures.responseBodyData(area:"workspace-lock",name:"byo-lapsed")
        XCTAssertEqual(BackendFixtures.responseStatus(area:"workspace-lock",name:"byo-lapsed"),423)
        let lapsed=WorkspaceLock.fromLockBody(String(data:lapsedBody,encoding:.utf8) ?? "")
        XCTAssertEqual(lapsed.reasonText,"lapsed")
        let unpaidId="11111111-1111-4111-8111-000000000022"
        XCTAssertEqual(lapsed.unpaidIds,[unpaidId])
        XCTAssertTrue(WorkspacePolicy.locksThisWorkspace(id:unpaidId,kind:"byo",isFree:false,unpaidIds:lapsed.unpaidIds))
        XCTAssertTrue(WorkspacePolicy.blocksLibrary(selectedId:unpaidId,kind:"byo",isFree:false,lock:lapsed))
        let sibling="11111111-1111-4111-8111-000000000024"
        XCTAssertFalse(WorkspacePolicy.locksThisWorkspace(id:sibling,kind:"paid",isFree:false,unpaidIds:lapsed.unpaidIds))
        XCTAssertFalse(WorkspacePolicy.blocksLibrary(selectedId:sibling,kind:"paid",isFree:false,lock:lapsed))
        XCTAssertEqual(BackendFixtures.responseStatus(area:"workspaces",name:"byo-lapsed-others-open"),201)
        XCTAssertTrue(BackendFixtures.requestPath(area:"workspaces",name:"byo-lapsed-others-open").contains(sibling))
        let cap=WorkspaceLock.fromLockBody(BackendFixtures.responseBodyString(area:"workspace-lock",name:"over-cap"))
        XCTAssertTrue(WorkspacePolicy.blocksLibrary(selectedId:"free",kind:"free",isFree:true,lock:cap))

        let hosted=BackendFixtures.sharedBody("workspaces","make-hosted")
        let demoted=hosted["demoted"] as? [String:Any]
        let through=(demoted?["paidThroughMs"] as? NSNumber)?.int64Value ?? 0
        let graceEnd=(demoted?["graceEndsAt"] as? NSNumber)?.int64Value ?? 0
        // #5 is still blocked; this fixture may be regenerated. Use graceEndsAt as sent.
        XCTAssertGreaterThan(graceEnd,through)
        XCTAssertTrue(WorkspacePolicy.isPaymentDue(graceEndsAtMs:graceEnd,nowMs:through,lapsed:false))
        XCTAssertTrue(WorkspacePolicy.isPaymentDue(graceEndsAtMs:graceEnd,nowMs:graceEnd-1,lapsed:false))
        XCTAssertFalse(WorkspacePolicy.isPaymentDue(graceEndsAtMs:graceEnd,nowMs:graceEnd,lapsed:false))
        XCTAssertFalse(WorkspacePolicy.isPaymentDue(graceEndsAtMs:graceEnd,nowMs:through,lapsed:true))
        XCTAssertFalse(WorkspacePolicy.isPaymentDue(graceEndsAtMs:nil,nowMs:through,lapsed:false))
        XCTAssertTrue(WorkspacePolicy.isPaymentDue(graceEndsAtMs:graceEnd+86_400_000*10,nowMs:graceEnd+1,lapsed:false))
        XCTAssertEqual(WorkspacePolicy.paymentDueText(graceEndsAtMs:graceEnd),"Payment due. Pay by Nov 20, 2023 to keep using this workspace.")
        XCTAssertEqual(WorkspacePolicy.paymentDue,"Payment due")
        XCTAssertEqual(BackendFixtures.responseStatus(area:"workspaces",name:"byo-in-grace"),201)
        XCTAssertTrue(BackendFixtures.requestPath(area:"workspaces",name:"byo-in-grace").contains("11111111-1111-4111-8111-000000000021"))
    }

    private func pricedLabel(_ row:[String:Any],enabled:Bool=true)->String {
        guard let feeWaived=row["feeWaived"] as? Bool else {preconditionFailure("feeWaived is required")}
        return WorkspacePrice.pickerText(name:row["name"] as? String ?? "Workspace",isFree:row["isFree"] as? Bool,grandfathered:(row["grandfathered"] as? Bool)==true,feeWaived:feeWaived,cents:(row["monthlyPriceCents"] as? NSNumber)?.intValue,enabled:enabled)
    }

    private func fixture(_ name:String)->AccountHttp {
        AccountHttp.parse(status:BackendFixtures.responseStatus(area:"account-deletion",name:name),data:BackendFixtures.responseBodyData(area:"account-deletion",name:name))
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

private final class ScriptedDeletionTransport:DeletionTransport {
    private var results:[Result<AccountHttp,Error>]=[]
    var calls:[(String,String)]=[]
    var authorizations:[String]=[]
    func respond(_ body:AccountHttp){results.append(.success(body))}
    func fail(_ error:Error){results.append(.failure(error))}
    func execute(method:String,path:String,body:Data?,authorization:String) async throws -> AccountHttp {
        calls.append((method,path))
        authorizations.append(authorization)
        return try results.removeFirst().get()
    }
}

private enum ReplacementFailure:Error { case upload, put, delete, offline }

private final class MemoryReplacement:ReplacementStore {
    var failUpload=false
    var conflict=false
    var failPut=false
    var failDelete=false
    var puts=0
    var uploaded:[String]=[]
    var deleted:[String]=[]
    var events:[String]=[]
    func uploadChunks(objectId:String) throws {
        events.append("upload")
        uploaded.append(objectId)
        if failUpload { throw ReplacementFailure.upload }
    }
    func putManifest(ifGeneration:Int64,objectId:String) throws -> Int64 {
        events.append("put")
        puts+=1
        if conflict { throw FileReplacement.Conflict(generation:9) }
        if failPut { throw ReplacementFailure.put }
        return ifGeneration+1
    }
    func deleteOldChunks(objectId:String) throws {
        events.append("delete")
        deleted.append(objectId)
        if failDelete { throw ReplacementFailure.delete }
    }
    func trashLocalOriginal() throws { events.append("trash") }
}

/// A status-token poll `invalid_token` stops polling, keeps the job, and asks for sign-in.
/// An owner-token DELETE `invalid_token` signs out, keeps the job, and keeps polling.
/// `reauth_required` and a 401 with no code go to sign-in. None of them wipe.
///
/// Generated fixtures live under `native/Mobile/fixtures/shared/account-deletion/`.
/// `status-invalid-token` and `status-unauthorized` are from fff0a84.
/// The export redacts tokens to `"<redacted>"`; that string is the opaque token here.
final class InvalidTokenDeletionTests: XCTestCase {
    private let area="account-deletion"

    private func fixture(_ name:String)->AccountHttp {
        AccountHttp.parse(status:BackendFixtures.responseStatus(area:area,name:name),data:BackendFixtures.responseBodyData(area:area,name:name))
    }

    private func ready()->AccountDeletion {
        var flow=AccountDeletion()
        flow.continueFromExplain()
        XCTAssertTrue(flow.confirmPhrase("DELETE"))
        XCTAssertTrue(flow.acceptFreshSignIn(authTime:Date(timeIntervalSince1970:1),now:Date(timeIntervalSince1970:1)))
        flow.noteDeleteSent()
        return flow
    }

    /// 410 account_deleted for job ...0005 starts polling, then the poll gets invalid_token.
    private func pollingThenInvalidToken()->AccountDeletion {
        var flow=ready()
        let gone=fixture("account-deleted")
        flow.onDeleteHttp(status:gone.status,jobId:gone.jobId,errorCode:gone.error,statusToken:gone.statusToken)
        XCTAssertEqual(flow.step,.polling)
        let invalid=fixture("status-invalid-token")
        flow.onPollHttp(status:invalid.status,jobStatus:invalid.jobStatus,errorCode:invalid.error,retryable:invalid.retryable)
        return flow
    }

    func testInvalidTokenFixtureIsTheGeneratedDelete401() {
        XCTAssertEqual(BackendFixtures.requestPath(area:area,name:"invalid-token"),"/v2/account")
        XCTAssertEqual(BackendFixtures.requestBody(area:area,name:"invalid-token")["confirm"] as? String,"DELETE")
        let invalid=fixture("invalid-token")
        XCTAssertEqual(invalid.status,401)
        XCTAssertEqual(invalid.error,"invalid_token")
        XCTAssertNil(invalid.jobId)
        XCTAssertNil(invalid.statusToken)
    }

    func testInvalidTokenOnDeleteSignsOutWithoutWipingOrInventingAJob() {
        var flow=ready()
        let invalid=fixture("invalid-token")
        flow.onDeleteHttp(status:invalid.status,jobId:invalid.jobId,errorCode:invalid.error,statusToken:invalid.statusToken)
        XCTAssertEqual(flow.step,.signedOut)
        XCTAssertFalse(flow.requestsWipe())
        XCTAssertNil(flow.receipt())
        XCTAssertFalse(flow.allowsDelete())
        XCTAssertTrue(LocalWipePlan.keychainServicesRemoved(wipe:flow.requestsWipe()).isEmpty)
    }

    func testInvalidTokenIsSignOutWhileReauthRequiredIsSignIn() {
        let invalid=pollingThenInvalidToken()
        XCTAssertEqual(invalid.step,.reauth)
        XCTAssertFalse(invalid.keepsPolling())
        XCTAssertFalse(invalid.clearSession)
        var reauth=ready()
        let gone=fixture("account-deleted")
        reauth.onDeleteHttp(status:gone.status,jobId:gone.jobId,errorCode:gone.error,statusToken:gone.statusToken)
        let needsReauth=fixture("reauth-required")
        reauth.onPollHttp(status:needsReauth.status,jobStatus:needsReauth.jobStatus,errorCode:needsReauth.error,retryable:needsReauth.retryable)
        XCTAssertEqual(reauth.step,.reauth)
        XCTAssertEqual(reauth.jobId,gone.jobId)
        XCTAssertFalse(reauth.requestsWipe())
        // Bare 401 with no code: AccountLogicTests.testLockAndUnauthorizedDoNotWipe.
    }

    func testInvalidTokenWhilePollingKeepsTheSavedJobAndToken() {
        let gone=fixture("account-deleted")
        let flow=pollingThenInvalidToken()
        XCTAssertFalse(flow.requestsWipe())
        XCTAssertFalse(flow.wipe)
        XCTAssertFalse(flow.dropReceipt,"stopping the poll must not drop the saved receipt")
        XCTAssertEqual(flow.jobId,gone.jobId)
        XCTAssertEqual(flow.statusToken,gone.statusToken)
        let receipt=flow.receipt()
        XCTAssertNotNil(receipt)
        XCTAssertTrue(AccountDeletion.resumesBeforeSignOut(receipt))
        XCTAssertTrue(LocalWipePlan.keychainServicesRemoved(wipe:flow.requestsWipe()).isEmpty)
    }

    func testAfterInvalidTokenTheSavedJobPollsWithBearerAndWipesOnlyOnDone() {
        let gone=fixture("account-deleted")
        let signedOut=pollingThenInvalidToken()
        // What the next launch does with the kept receipt (MobileSession -> AccountDeletion.resume).
        var resumed=AccountDeletion.resume(signedOut.receipt())
        XCTAssertEqual(resumed.step,.polling)
        XCTAssertEqual(resumed.statusPath,BackendFixtures.requestPath(area:area,name:"status-done"))
        let call=AccountDeletion.pollCall(path:resumed.statusPath ?? "",statusToken:resumed.statusToken ?? "")
        XCTAssertEqual(call?.method,"GET")
        XCTAssertEqual(call?.authorization,"Bearer "+(gone.statusToken ?? "missing"))

        let expired=fixture("expired-token")
        resumed.onPollHttp(status:expired.status,jobStatus:expired.jobStatus,errorCode:expired.error,retryable:expired.retryable)
        XCTAssertFalse(resumed.requestsWipe())
        XCTAssertEqual(resumed.jobId,gone.jobId)
        XCTAssertFalse(resumed.dropReceipt)
        resumed.retry()
        XCTAssertEqual(resumed.step,.reauth)
        XCTAssertTrue(resumed.acceptFreshSignIn(authTime:Date(timeIntervalSince1970:1),now:Date(timeIntervalSince1970:1)))
        XCTAssertTrue(resumed.allowsDelete())
    }

    /// A later poll is ignored once the status token has been rejected.
    func testStatusInvalidTokenStopsPollingSoDoneDoesNotWipe() {
        var flow=pollingThenInvalidToken()
        let done=fixture("status-done")
        flow.onPollHttp(status:done.status,jobStatus:done.jobStatus,errorCode:done.error,retryable:done.retryable)
        XCTAssertEqual(flow.step,.reauth)
        XCTAssertFalse(flow.requestsWipe())
    }

    /// DELETE invalid_token signs out, keeps the saved job, and a later done still wipes.
    func testOwnerTokenInvalidTokenKeepsPollingUntilDone() {
        var flow=ready()
        let gone=fixture("account-deleted")
        flow.onDeleteHttp(status:gone.status,jobId:gone.jobId,errorCode:gone.error,statusToken:gone.statusToken)
        flow.onPollHttp(status:200,jobStatus:"failed",errorCode:nil,retryable:true)
        flow.retry()
        XCTAssertTrue(flow.acceptFreshSignIn(authTime:Date(timeIntervalSince1970:1),now:Date(timeIntervalSince1970:1)))
        XCTAssertTrue(flow.allowsDelete())
        let invalid=fixture("invalid-token")
        flow.onDeleteHttp(status:invalid.status,jobId:invalid.jobId,errorCode:invalid.error,statusToken:invalid.statusToken)
        XCTAssertEqual(flow.step,.signedOut)
        XCTAssertTrue(flow.clearSession)
        XCTAssertTrue(flow.keepsPolling())
        XCTAssertEqual(flow.jobId,gone.jobId)
        XCTAssertEqual(flow.statusToken,gone.statusToken)
        XCTAssertFalse(flow.dropReceipt)
        XCTAssertFalse(flow.requestsWipe())
        let done=fixture("status-done")
        flow.onPollHttp(status:done.status,jobStatus:done.jobStatus,errorCode:done.error,retryable:done.retryable)
        XCTAssertTrue(flow.requestsWipe())
        XCTAssertTrue(LocalWipePlan.keychainServicesRemoved(wipe:false).isEmpty)
    }
}

/// The repo-root `fixtures/` directory wins when this branch has it.
/// `singular-path.json` is JSON. A non-JSON body in a test is synthetic.
/// Support responses are Riley's d33970c `support-*` files in `fixtures/account-deletion`.
/// Each request is `POST /v2/account/deletions/:jobId/support-request` with no body.
/// Workspace and pricing fixtures are the `workspaces/` files from PR #5 at 0715b1a,
/// including `owner-fee-waived`, `byo-register-ends-grandfathered`, `byo-in-grace`,
/// `byo-lapsed-others-open`, `make-hosted`, `list.json`, and `create.json`.
/// `cap-reached.json` stays on the shared fixtures at da39276.
/// `workspace-lock/byo-lapsed` is from 0715b1a. The other lock fixtures stay at da39276.
private enum BackendFixtures {
    static let accountDeletionSHA="fff0a84"
    static let supportFixtureSHA="d33970c"
    static let workspacePriceSHA="0715b1a"
    static let keyEnvelopeSHA="ee4f76f"
    static let sharedFixtureSHA="da39276"

    static func body(_ name:String)->String {
        let file:String
        switch name {
        case "delete202": file="accepted"
        case "accountDeleted410": file="account-deleted"
        case "reauth401": file="reauth-required"
        case "invalidToken401": file="invalid-token"
        case "pollQueued": file="status-queued"
        case "pollRunning": file="status-running"
        case "pollDone": file="status-done"
        case "pollFailed": file="status-failed"
        case "pollNotFound": file="expired-token"
        default: file=name
        }
        return responseBodyString(area:"account-deletion",name:file)
    }

    static func responseStatus(area:String,name:String)->Int {
        let response=shared(area:area,name:name)["response"] as? [String:Any]
        if let number=response?["status"] as? Int {return number}
        if let number=response?["status"] as? NSNumber {return number.intValue}
        preconditionFailure("Missing status \(area)/\(name)")
        return 0
    }

    static func responseBodyData(area:String,name:String)->Data {
        let body=(shared(area:area,name:name)["response"] as? [String:Any])?["body"]
        if body == nil || body is NSNull {return Data()}
        if let text=body as? String {return Data(text.utf8)}
        return (try? JSONSerialization.data(withJSONObject:body as Any)) ?? Data()
    }

    static func responseBodyString(area:String,name:String)->String {
        let body=(shared(area:area,name:name)["response"] as? [String:Any])?["body"]
        if let text=body as? String {return text}
        return String(data:responseBodyData(area:area,name:name),encoding:.utf8) ?? ""
    }

    static func requestPath(area:String,name:String)->String {
        (shared(area:area,name:name)["request"] as? [String:Any])?["path"] as? String ?? ""
    }

    static func requestBody(area:String,name:String)->[String:Any] {
        (shared(area:area,name:name)["request"] as? [String:Any])?["body"] as? [String:Any] ?? [:]
    }

    static func requestBodyString(area:String,name:String)->String {
        let body=(shared(area:area,name:name)["request"] as? [String:Any])?["body"]
        if body == nil || body is NSNull {return ""}
        guard let data=try? JSONSerialization.data(withJSONObject:body as Any) else {return ""}
        return String(data:data,encoding:.utf8) ?? ""
    }

    /// Named rows from a 0715b1a workspace fixture: each `workspaces[]` item, or `project`.
    static func pricedWorkspaces(_ name:String)->[[String:Any]] {
        let body=sharedBody("workspaces",name)
        if let rows=body["workspaces"] as? [[String:Any]],!rows.isEmpty {return rows}
        if let project=body["project"] as? [String:Any] {return [project]}
        return []
    }

    static func sharedBody(_ area:String,_ name:String)->[String:Any] {
        (shared(area:area,name:name)["response"] as? [String:Any])?["body"] as? [String:Any] ?? [:]
    }

    static func listedWorkspaces()->[WorkspaceLock.Item] {
        let body=(shared(area:"workspaces",name:"list")["response"] as? [String:Any])?["body"] as? [String:Any]
        let rows=body?["workspaces"] as? [[String:Any]] ?? []
        return rows.map { WorkspaceLock.Item(workspaceID:$0["id"] as? String,name:$0["name"] as? String,issue:nil) }
    }

    private static func shared(area:String,name:String)->[String:Any] {
        let data=(try? Data(contentsOf:sharedURL(area:area,name:name))) ?? Data()
        return (try? JSONSerialization.jsonObject(with:data) as? [String:Any]) ?? [:]
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

}
