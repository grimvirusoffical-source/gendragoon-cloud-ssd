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
        XCTAssertTrue(LocalWipePlan.keychainServicesRemoved(wipe:flow.requestsWipe()).isEmpty)
        flow.retry()
        XCTAssertEqual(flow.step,.polling)
        XCTAssertEqual(flow.jobId,"job_404")
        XCTAssertEqual(flow.statusToken,token)
        XCTAssertFalse(flow.allowsDelete())
        flow.onPollHttp(status:404,jobStatus:nil,errorCode:"not_found",retryable:nil)
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
        XCTAssertEqual(unsigned.jobId,"job_auth")
        XCTAssertEqual(unsigned.statusToken,token)
        XCTAssertFalse(unsigned.requestsWipe())
        XCTAssertFalse(unsigned.allowsDelete())
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
            } else if shown.reasonText=="scope_unavailable" {
                XCTAssertEqual(shown.detailText,WorkspaceLock.detailScope)
                XCTAssertFalse(shown.detailText.contains("did not include a workspace list"))
                XCTAssertTrue(shown.workspaces.isEmpty)
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
        let sent=try XCTUnwrap(AccountDeletion.byoVerifyBody(presignedUrl:"https://bucket.example/object"))
        let sentJson=try XCTUnwrap(JSONSerialization.jsonObject(with:sent) as? [String:String])
        XCTAssertEqual(sentJson["presignedUrl"],"https://bucket.example/object")
        XCTAssertEqual(sentJson.count,1)
        let sentText=String(data:sent,encoding:.utf8) ?? ""
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

/// Avery's ruling (Oct 17): a 401 `{"error":"invalid_token"}` signs the user out. Sign-out clears
/// only the session. The saved jobId and statusToken stay, polling continues with
/// `Bearer statusToken`, and local data is wiped only on `done`. `reauth_required` and a 401
/// with no code go to sign-in instead. None of them wipe.
///
/// Every server body is Riley's generated fixture from PR #6 at d788ccb, vendored under
/// `native/Mobile/fixtures/shared/account-deletion/`. The 410, poll-404 and status-done
/// fixtures share job ...0005. The export redacts tokens to `"<redacted>"`; that string is the
/// opaque token here. `bug_*` tests wrap the ruling in `XCTExpectFailure`; they start failing
/// once the code meets the ruling, and the wrapper comes off then.
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
        let invalid=fixture("invalid-token")
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
        XCTAssertEqual(pollingThenInvalidToken().step,.signedOut)
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
        XCTAssertFalse(flow.dropReceipt,"sign-out must not drop the saved receipt")
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
        XCTAssertEqual(resumed.step,.polling)

        let done=fixture("status-done")
        resumed.onPollHttp(status:done.status,jobStatus:done.jobStatus,errorCode:done.error,retryable:done.retryable)
        XCTAssertEqual(resumed.step,.done)
        XCTAssertTrue(resumed.requestsWipe())
    }

    /// BUG(contract): polling should keep going after sign-out. Today invalid_token moves the flow
    /// to `.signedOut` (AccountDeletion.swift:123-124), `onPollHttp` ignores anything outside
    /// `.polling` (AccountDeletion.swift:89), and AccountFlows.swift:98 calls `session.signOut()`
    /// and dismisses, so polling stops until the next launch.
    func test_bug_invalidTokenKeepsPollingInTheSameSessionAndWipesOnDone() {
        var flow=pollingThenInvalidToken()
        let done=fixture("status-done")
        flow.onPollHttp(status:done.status,jobStatus:done.jobStatus,errorCode:done.error,retryable:done.retryable)
        XCTExpectFailure("BUG(contract): invalid_token stops polling (AccountDeletion.swift:123-124, :89)")
        XCTAssertTrue(flow.requestsWipe(),"done after invalid_token should wipe without a relaunch")
    }
}

/// Deletion bodies stay in `native/Mobile/fixtures/backend-http.json` (84f6fff).
/// Lock, merge, BYO, workspace, and ownership cases are `fixtures/<area>/<case>.json` at da39276.
/// The repo-root `fixtures/` directory wins when this branch has it.
private enum BackendFixtures {
    static let accountDeletionSHA="84f6fff"
    static let sharedFixtureSHA="da39276"

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
