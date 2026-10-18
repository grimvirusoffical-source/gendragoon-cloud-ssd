package app.gendragoon.cloudssd.mobile;

import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public final class AccountDeletionTest {
    private static final String TOKEN="status-token-1";
    private static final List<String> ALIASES=List.of("gd-byo-gcs","unrelated-alias");

    @Test public void phraseAndFreshSignInGateTheDelete(){
        AccountDeletion flow=new AccountDeletion();
        assertFalse(flow.confirmPhrase("DELETE"));
        flow.continueFromExplain();
        assertFalse(flow.confirmPhrase("delete"));
        assertTrue(flow.confirmPhrase("DELETE"));
        assertEquals(AccountDeletion.Step.REAUTH,flow.step);
        long now=10_000_000L;
        assertFalse(flow.acceptFreshSignIn(0L,now));
        assertFalse(flow.acceptFreshSignIn(now+1,now));
        assertFalse(flow.acceptFreshSignIn(now-AccountDeletion.FRESH_SIGN_IN_MS-1,now));
        assertEquals(AccountDeletion.Step.REAUTH,flow.step);
        assertTrue(flow.message.contains("5 minutes"));
        assertTrue(flow.acceptFreshSignIn(now-AccountDeletion.FRESH_SIGN_IN_MS,now));
        assertEquals(AccountDeletion.Step.DELETING,flow.step);
    }

    @Test public void confirmBodyIsJsonDelete(){
        assertEquals("{\"confirm\":\"DELETE\"}",AccountActions.CONFIRM_JSON);
        assertEquals("application/json",AccountActions.CONFIRM_TYPE);
        assertEquals(AccountActions.CONFIRM_JSON,new String(AccountActions.CONFIRM_BODY,StandardCharsets.UTF_8));
    }

    @Test public void parsesRealStatusJson(){
        AccountActions.HttpBody created=AccountActions.parse(202,BackendFixtures.body("delete202"));
        assertEquals("deleting",created.jobStatus);
        assertEquals(BackendFixtures.ACCOUNT_DELETION_SHA,"9d0f056");
        assertTrue(AccountActions.validJob(created.jobId));
        assertTrue(AccountActions.validToken(created.statusToken));
        AccountActions.HttpBody running=AccountActions.parse(200,BackendFixtures.body("pollRunning"));
        assertTrue(AccountActions.validJob(running.jobId));
        assertEquals("running",running.jobStatus);
        assertEquals(Boolean.TRUE,running.retryable);
        AccountActions.HttpBody done=AccountActions.parse(200,BackendFixtures.body("pollDone"));
        assertEquals("done",done.jobStatus);
        assertEquals(Boolean.FALSE,done.retryable);
        AccountActions.HttpBody failed=AccountActions.parse(200,BackendFixtures.body("pollFailed"));
        assertEquals("failed",failed.jobStatus);
        assertEquals(Boolean.TRUE,failed.retryable);
        AccountActions.HttpBody queued=AccountActions.parse(200,BackendFixtures.body("pollQueued"));
        assertEquals("queued",queued.jobStatus);
        AccountActions.HttpBody malformed=AccountActions.parse(200,"{not json");
        assertNull(malformed.jobId);
        assertNull(malformed.jobStatus);
        assertNull(malformed.retryable);
        assertNull(malformed.statusToken);
    }

    @Test public void queuedAndRunningStayInProgressUntilDone(){
        AccountDeletion flow=ready();
        flow.onDeleteHttp(202,"job_1",null,TOKEN);
        assertEquals(AccountDeletion.Step.POLLING,flow.step);
        assertEquals(AccountActions.DELETION_STATUS_PATH+"job_1",flow.statusPath);
        flow.onPollHttp(200,"queued",null,true);
        assertEquals(AccountDeletion.Step.POLLING,flow.step);
        assertFalse(flow.requestsWipe());
        flow.onPollHttp(200,"running",null,true);
        assertEquals(AccountDeletion.Step.POLLING,flow.step);
        flow.onPollHttp(200,"done",null,false);
        assertEquals(AccountDeletion.Step.DONE,flow.step);
        assertTrue(flow.requestsWipe());
        flow.noteWiped();
        assertEquals(AccountDeletion.Step.WIPED,flow.step);
    }

    @Test public void goneAccountPollsWithoutWipingUntilDone(){
        AccountDeletion flow=ready();
        flow.onDeleteHttp(410,"job_410","account_deleted",TOKEN);
        assertEquals(AccountDeletion.Step.POLLING,flow.step);
        assertEquals("/v2/account/deletions/job_410",flow.statusPath);
        assertFalse(flow.requestsWipe());
        assertTrue(LocalDataWipe.secretsRemoved(flow.requestsWipe(),ALIASES).isEmpty());
        flow.onPollHttp(200,"done",null,false);
        assertTrue(flow.requestsWipe());
        assertEquals(List.of("gd-byo-gcs"),LocalDataWipe.secretsRemoved(flow.requestsWipe(),ALIASES));
    }

    @Test public void goneAccountWithoutJobDoesNotWipe(){
        AccountDeletion missing=ready();
        missing.onDeleteHttp(410,null,"account_deleted",TOKEN);
        assertEquals(AccountDeletion.Step.FAILED,missing.step);
        assertFalse(missing.requestsWipe());
        assertTrue(missing.message!=null&&!missing.message.isEmpty());
        assertTrue(LocalDataWipe.secretsRemoved(missing.requestsWipe(),ALIASES).isEmpty());
        AccountDeletion invalid=ready();
        invalid.onDeleteHttp(410,"../secret","account_deleted",TOKEN);
        assertEquals(AccountDeletion.Step.POLLING,invalid.step);
        assertEquals("/v2/account/deletions/..%2Fsecret",invalid.statusPath);
        assertFalse(invalid.requestsWipe());
        AccountDeletion noToken=ready();
        noToken.onDeleteHttp(410,"job_410","account_deleted",null);
        assertEquals(AccountDeletion.Step.FAILED,noToken.step);
        assertFalse(noToken.requestsWipe());
    }

    @Test public void retryKeepsJobAndGoneAccountRecovers(){
        AccountDeletion kept=ready();
        kept.onDeleteHttp(202,"job_keep",null,TOKEN);
        kept.onPollHttp(500,"done",null,null);
        assertEquals(AccountDeletion.Step.FAILED,kept.step);
        assertEquals("job_keep",kept.jobId);
        assertFalse(kept.requestsWipe());
        kept.retry();
        assertEquals(AccountDeletion.Step.REAUTH,kept.step);
        assertEquals("job_keep",kept.jobId);
        assertEquals(TOKEN,kept.statusToken);
        assertTrue(kept.acceptFreshSignIn(2_000L,2_000L));
        assertTrue(kept.allowsDelete());
        kept.onDeleteHttp(202,"job_keep",null,"status-token-new");
        assertEquals(AccountDeletion.Step.POLLING,kept.step);
        assertEquals("status-token-new",kept.statusToken);
        assertFalse(kept.requestsWipe());

        AccountDeletion again=ready();
        again.onDeleteHttp(500,null,"bad",null);
        again.retry();
        assertEquals(AccountDeletion.Step.REAUTH,again.step);
        assertNull(again.jobId);
        assertTrue(again.acceptFreshSignIn(2_000L,2_000L));
        again.onDeleteHttp(410,"job_again","account_deleted","status-token-again");
        assertEquals(AccountDeletion.Step.POLLING,again.step);
        assertEquals("/v2/account/deletions/job_again",again.statusPath);
        assertFalse(again.requestsWipe());
        assertTrue(LocalDataWipe.secretsRemoved(again.requestsWipe(),ALIASES).isEmpty());
    }

    @Test public void completedIsNeverDone(){
        for(String status:new String[]{"completed","deleting","succeeded",null}){
            AccountDeletion flow=ready();
            flow.onDeleteHttp(202,"job_c",null,TOKEN);
            flow.onPollHttp(200,status,null,false);
            assertEquals(AccountDeletion.Step.FAILED,flow.step);
            assertNotEquals(AccountDeletion.Step.POLLING,flow.step);
            assertEquals(0,flow.polls);
            assertFalse(flow.requestsWipe());
            flow.onPollHttp(200,"done",null,false);
            assertEquals(AccountDeletion.Step.FAILED,flow.step);
            assertFalse(flow.requestsWipe());
            assertTrue(flow.polls<AccountDeletion.POLL_LIMIT);
            assertTrue(LocalDataWipe.secretsRemoved(flow.requestsWipe(),ALIASES).isEmpty());
        }
    }

    @Test public void errorFieldBodiesDriveAuthAndGoneAccount(){
        AccountActions.HttpBody reauth=AccountActions.parse(401,BackendFixtures.body("reauth401"));
        assertEquals("reauth_required",reauth.error);
        AccountDeletion again=ready();
        again.onDeleteHttp(reauth.status,reauth.jobId,reauth.error,reauth.statusToken);
        assertEquals(AccountDeletion.Step.REAUTH,again.step);
        assertFalse(again.requestsWipe());

        AccountActions.HttpBody invalid=AccountActions.parse(401,BackendFixtures.body("invalidToken401"));
        assertEquals("invalid_token",invalid.error);
        AccountDeletion signedOut=ready();
        signedOut.onDeleteHttp(invalid.status,invalid.jobId,invalid.error,invalid.statusToken);
        assertEquals(AccountDeletion.Step.SIGNED_OUT,signedOut.step);
        assertFalse(signedOut.requestsWipe());
        assertTrue(LocalDataWipe.secretsRemoved(signedOut.requestsWipe(),ALIASES).isEmpty());

        AccountActions.HttpBody fromCode=AccountActions.parse(401,"{\"code\":\"reauth_required\"}");
        assertEquals("reauth_required",fromCode.error);
        AccountActions.HttpBody errorWins=AccountActions.parse(401,"{\"error\":\"invalid_token\",\"code\":\"reauth_required\"}");
        assertEquals("invalid_token",errorWins.error);

        AccountActions.HttpBody gone=AccountActions.parse(410,BackendFixtures.body("accountDeleted410"));
        assertEquals(410,gone.status);
        assertEquals("account_deleted",gone.error);
        assertNotEquals(401,gone.status);
        AccountDeletion deleted=ready();
        assertTrue(deleted.allowsDelete());
        deleted.onDeleteHttp(gone.status,gone.jobId,gone.error,gone.statusToken);
        assertEquals(AccountDeletion.Step.POLLING,deleted.step);
        assertNotEquals(AccountDeletion.Step.SIGNED_OUT,deleted.step);
        assertEquals("/v2/account/deletions/"+gone.jobId,deleted.statusPath);
        assertFalse(deleted.allowsDelete());
        assertFalse(deleted.requestsWipe());
        assertTrue(LocalDataWipe.secretsRemoved(deleted.requestsWipe(),ALIASES).isEmpty());
        String savedToken=deleted.statusToken;
        deleted.onDeleteHttp(gone.status,gone.jobId,gone.error,gone.statusToken);
        assertEquals(AccountDeletion.Step.POLLING,deleted.step);
        assertEquals(savedToken,deleted.statusToken);
        AccountDeletion kept=AccountDeletion.resume(DeletionReceipt.of(gone.jobId,gone.statusToken));
        assertEquals(AccountDeletion.Step.POLLING,kept.step);
        assertFalse(kept.allowsDelete());
    }

    @Test public void nonSuccessPollNeverWipes(){
        AccountDeletion flow=ready();
        flow.onDeleteHttp(202,"job_http",null,TOKEN);
        flow.onPollHttp(500,"done",null,null);
        assertEquals(AccountDeletion.Step.FAILED,flow.step);
        assertFalse(flow.requestsWipe());
        assertTrue(LocalDataWipe.secretsRemoved(flow.requestsWipe(),ALIASES).isEmpty());
    }

    @Test public void failedRetryableFalseClearsReceiptOnly(){
        AccountDeletion flow=ready();
        flow.onDeleteHttp(202,"job_dead",null,TOKEN);
        flow.onPollHttp(200,"failed",null,false);
        assertEquals(AccountDeletion.Step.FAILED,flow.step);
        assertFalse(flow.dropReceipt);
        assertTrue(flow.showSupport);
        assertFalse(flow.offersRetry());
        assertTrue(flow.canDismiss());
        assertEquals("job_dead",flow.jobId);
        assertEquals(TOKEN,flow.statusToken);
        assertFalse(flow.requestsWipe());
        assertTrue(flow.dismissError());
        assertTrue(flow.dropReceipt);
        assertNull(flow.jobId);
        assertFalse(flow.requestsWipe());
        assertTrue(LocalDataWipe.secretsRemoved(flow.requestsWipe(),ALIASES).isEmpty());
        AccountDeletion retryable=ready();
        retryable.onDeleteHttp(202,"job_live",null,TOKEN);
        retryable.onPollHttp(200,"failed",null,true);
        assertFalse(retryable.dropReceipt);
        assertFalse(retryable.showSupport);
        assertEquals("job_live",retryable.jobId);
        retryable.retry();
        assertEquals(AccountDeletion.Step.REAUTH,retryable.step);
        assertTrue(retryable.acceptFreshSignIn(2_000L,2_000L));
        assertTrue(retryable.allowsDelete());
    }

    @Test public void storesTokenAndResumesWithBearer(){
        DeletionReceipt receipt=DeletionReceipt.of("job_saved",TOKEN);
        assertEquals("DeletionReceipt(job_saved)",receipt.toString());
        assertFalse(receipt.toString().contains(TOKEN));
        DeletionReceiptMemory memory=new DeletionReceiptMemory();
        memory.save(receipt);
        assertTrue(memory.containsToken(TOKEN));
        AccountDeletion resumed=AccountDeletion.resume(memory.read());
        assertEquals(AccountDeletion.Step.POLLING,resumed.step);
        assertEquals("job_saved",resumed.jobId);
        assertFalse(resumed.requestsWipe());
        AccountActions.PollCall call=AccountActions.pollCall(resumed.receipt());
        assertEquals("GET",call.method);
        assertEquals("/v2/account/deletions/job_saved",call.path);
        assertEquals("Bearer "+TOKEN,call.authorization);
        assertFalse(call.describeForLog().contains(TOKEN));
        assertFalse(DeletionReceiptVault.STORES_PLAINTEXT);
        resumed.onPollHttp(200,"done",null,false);
        assertTrue(resumed.requestsWipe());
        memory.clear();
        assertNull(memory.read());
    }

    @Test public void pollNotFoundKeepsPairUntilDismissed(){
        DeletionReceiptMemory memory=new DeletionReceiptMemory();
        memory.save(DeletionReceipt.of("job_404",TOKEN));
        AccountDeletion flow=AccountDeletion.resume(memory.read());
        AccountActions.HttpBody missing=AccountActions.parse(404,BackendFixtures.body("pollNotFound"));
        flow.onPollHttp(missing.status,missing.jobStatus,missing.error,missing.retryable);
        assertEquals(AccountDeletion.Step.FAILED,flow.step);
        assertTrue(flow.canDismiss());
        assertEquals("job_404",flow.jobId);
        assertEquals(TOKEN,flow.statusToken);
        assertFalse(flow.dropReceipt);
        assertFalse(flow.requestsWipe());
        assertTrue(flow.message!=null&&!flow.message.isEmpty());
        assertFalse(flow.message.contains(TOKEN));
        assertTrue(flow.offersRetry());
        assertTrue(LocalDataWipe.secretsRemoved(flow.requestsWipe(),ALIASES).isEmpty());
        assertTrue(flow.dismissError());
        assertTrue(flow.dropReceipt);
        assertNull(flow.jobId);
        assertNull(flow.statusToken);
        assertFalse(flow.requestsWipe());
        assertTrue(LocalDataWipe.secretsRemoved(flow.requestsWipe(),ALIASES).isEmpty());
        int attempts=flow.deleteAttempts;
        flow.retry();
        assertEquals(AccountDeletion.Step.FAILED,flow.step);
        assertEquals(attempts,flow.deleteAttempts);
        assertFalse(flow.allowsDelete());
        AccountDeletion again=AccountDeletion.resume(DeletionReceipt.of("job_404",TOKEN));
        again.onPollHttp(404,null,"not_found",null);
        again.retry();
        assertEquals(AccountDeletion.Step.REAUTH,again.step);
        assertEquals("job_404",again.jobId);
        assertEquals(TOKEN,again.statusToken);
        assertTrue(again.acceptFreshSignIn(2_000L,2_000L));
        assertTrue(again.allowsDelete());
        assertEquals(AccountDeletion.Step.DELETING,again.step);
    }

    @Test public void lockDuringDeleteOrPollDoesNotWipe(){
        String body=BackendFixtures.responseBody("workspace-lock","over-cap");
        assertEquals(423,BackendFixtures.responseStatus("workspace-lock","over-cap"));
        CloudSignals.Route deleteRoute=CloudSignals.route(423,body,"DELETE");
        assertEquals(CloudSignals.Destination.LOCK_SCREEN,deleteRoute.destination);
        assertNull(deleteRoute.toast);
        AccountDeletion flow=ready();
        flow.onDeleteHttp(423,null,"workspace_lock",null);
        assertEquals(AccountDeletion.Step.DELETING,flow.step);
        assertFalse(flow.requestsWipe());
        flow.onDeleteHttp(202,"job_lock",null,TOKEN);
        CloudSignals.Route pollRoute=CloudSignals.route(423,body,"GET");
        assertEquals(CloudSignals.Destination.LOCK_SCREEN,pollRoute.destination);
        assertNull(pollRoute.toast);
        flow.onPollHttp(423,"done","workspace_lock",null);
        assertEquals(AccountDeletion.Step.POLLING,flow.step);
        assertFalse(flow.requestsWipe());
        assertTrue(LocalDataWipe.secretsRemoved(flow.requestsWipe(),ALIASES).isEmpty());
    }

    @Test public void unauthorizedWithoutCodeGoesToSignIn(){
        AccountDeletion flow=ready();
        flow.onDeleteHttp(202,"job_auth",null,TOKEN);
        flow.onPollHttp(401,null,null,null);
        assertEquals(AccountDeletion.Step.REAUTH,flow.step);
        assertNotEquals(AccountDeletion.Step.SIGNED_OUT,flow.step);
        assertEquals("job_auth",flow.jobId);
        assertEquals(TOKEN,flow.statusToken);
        assertFalse(flow.requestsWipe());
        assertFalse(flow.allowsDelete());
        assertTrue(LocalDataWipe.secretsRemoved(flow.requestsWipe(),ALIASES).isEmpty());
        AccountDeletion named=ready();
        named.onDeleteHttp(401,null,"reauth_required",null);
        assertEquals(AccountDeletion.Step.REAUTH,named.step);
        assertFalse(named.requestsWipe());
    }

    @Test public void reauthRequiredRejectsADifferentAccount(){
        AccountDeletion flow=ready();
        AccountActions.HttpBody reauth=AccountActions.parse(401,BackendFixtures.body("reauth401"));
        flow.onDeleteHttp(reauth.status,reauth.jobId,reauth.error,reauth.statusToken);
        assertEquals(AccountDeletion.Step.REAUTH,flow.step);
        int attempts=flow.deleteAttempts;
        assertFalse(flow.rejectDifferentAccount("uid-1","uid-1","owner@example.com","owner@example.com"));
        assertEquals(AccountDeletion.Step.REAUTH,flow.step);
        assertTrue(flow.rejectDifferentAccount("uid-1","uid-2","owner@example.com","owner@example.com"));
        assertEquals(AccountDeletion.Step.FAILED,flow.step);
        assertEquals(AccountDeletion.DIFFERENT_ACCOUNT,flow.message);
        assertEquals(attempts,flow.deleteAttempts);
        assertFalse(flow.allowsDelete());
        assertFalse(flow.requestsWipe());
        assertTrue(LocalDataWipe.secretsRemoved(flow.requestsWipe(),ALIASES).isEmpty());
    }

    @Test public void jobAndTokenNeedOnlyBeNonEmpty(){
        assertTrue(AccountActions.validJob("a/b"));
        assertTrue(AccountActions.validJob(".."));
        assertTrue(AccountActions.validJob("a..b"));
        assertTrue(AccountActions.validJob("x".repeat(200)));
        assertFalse(AccountActions.validJob(""));
        assertFalse(AccountActions.validJob(null));
        assertTrue(AccountActions.validToken("<redacted>"));
        assertTrue(AccountActions.validToken("x"));
        assertTrue(AccountActions.validToken("t".repeat(600)));
        assertFalse(AccountActions.validToken(""));
        assertFalse(AccountActions.validToken(null));
        assertEquals("/v2/account/deletions/a%2Fb",AccountActions.statusPath("a/b"));
        assertEquals("/v2/account/deletions/..",AccountActions.statusPath(".."));
        assertEquals("/v2/account/deletions/job_1",AccountActions.statusPath("job_1"));
        assertEquals("job_1",AccountActions.encodeJob("job_1"));
        assertNull(AccountActions.statusPath(""));
        assertFalse(AccountActions.safeAccountPath("/v2/account/deletion/job_1"));
        assertFalse(AccountActions.safeAccountPath("/v2/account/deletions/a/b"));
        assertTrue(AccountActions.safeAccountPath("/v2/account/deletions/.."));
        assertTrue(AccountActions.safeAccountPath("/v2/account/deletions/a%2Fb"));
        assertTrue(AccountActions.safeAccountPath("/v2/account/deletions/job_1"));
        assertNull(AccountActions.pollCall("/v2/account/deletion/job_1",TOKEN));
        assertNotNull(AccountActions.pollCall(AccountActions.statusPath("a/b"),TOKEN));
    }

    @Test public void sameGoogleAccountIsRequired(){
        assertTrue(AccountMatch.same("uid-1","owner@example.com","uid-1","owner@example.com"));
        assertFalse(AccountMatch.same("uid-1","owner@example.com","uid-2","owner@example.com"));
        assertFalse(AccountMatch.same("uid-1","owner@example.com","uid-1","other@example.com"));
        assertFalse(AccountMatch.same("uid-1","owner@example.com",null,"owner@example.com"));
    }

    @Test public void missingOrFutureAuthTimeIsRejected(){
        long now=1_700_003_600_000L;
        String missing="{\"iat\":1700003600}";
        String missingJwt="eyJhbGciOiJub25lIn0."+Base64.getUrlEncoder().withoutPadding().encodeToString(missing.getBytes(StandardCharsets.UTF_8))+".";
        assertNull(CloudSignals.authTimeMillis(missingJwt));
        assertFalse(CloudSignals.freshSignIn(missingJwt,now));
        String future="{\"auth_time\":1700007200}";
        String futureJwt="eyJhbGciOiJub25lIn0."+Base64.getUrlEncoder().withoutPadding().encodeToString(future.getBytes(StandardCharsets.UTF_8))+".";
        assertFalse(CloudSignals.freshSignIn(futureJwt,now));
    }

    @Test public void lockNamesComeFromTheWorkspaceList(){
        assertEquals(BackendFixtures.SHARED_FIXTURE_SHA,"da39276");
        List<WorkspaceLock.Item> cache=BackendFixtures.listedWorkspaces();
        assertEquals("Fixture Project",cache.get(0).name);
        String overCap=BackendFixtures.responseBody("workspace-lock","over-cap");
        WorkspaceLock over=WorkspaceLock.fromLockBody(overCap).named(cache);
        assertEquals("Choose 1 workspaces to remove.",over.chooseMessage());
        assertEquals("Fixture Project",over.workspaces.get(0).name);
        String lapsed=BackendFixtures.responseBody("workspace-lock","lapsed");
        WorkspaceLock unpaid=WorkspaceLock.fromLockBody(lapsed).named(cache);
        assertEquals("Fixture Project",unpaid.workspaces.get(0).name);
        assertEquals("unpaid",unpaid.workspaces.get(0).issue);
        String both=BackendFixtures.responseBody("workspace-lock","over-cap-and-lapsed");
        WorkspaceLock mixed=WorkspaceLock.fromLockBody(both).named(cache);
        assertEquals("Choose 1 workspaces to remove.",mixed.chooseMessage());
        assertEquals("Fixture Project",mixed.workspaces.get(0).name);
        for(String name:List.of("over-cap","lapsed","over-cap-and-lapsed","scope-unavailable","merge-in-progress")){
            String raw=BackendFixtures.responseBody("workspace-lock",name);
            CloudSignals.Route route=CloudSignals.route(BackendFixtures.responseStatus("workspace-lock",name),raw,"POST");
            assertEquals(CloudSignals.Destination.LOCK_SCREEN,route.destination);
            assertNull(route.toast);
            assertEquals("workspace_lock",JsonFields.string(raw,"error"));
            WorkspaceLock shown=WorkspaceLock.fromLockBody(raw).named(cache);
            assertEquals(JsonFields.string(raw,"reason"),shown.reasonText());
            assertFalse(shown.reasonText().isEmpty());
            assertEquals("Over by "+JsonFields.number(raw,"overBy"),shown.overByText());
            if("merge_in_progress".equals(shown.reasonText())){
                assertEquals(WorkspaceLock.DETAIL_MERGE,shown.detailText());
                assertFalse(shown.detailText().contains("did not include a workspace list"));
                assertTrue(shown.workspaces.isEmpty());
                assertFalse(shown.requiresPayment());
            }else if("scope_unavailable".equals(shown.reasonText())){
                assertEquals(WorkspaceLock.DETAIL_SCOPE,shown.detailText());
                assertFalse(shown.detailText().contains("did not include a workspace list"));
                assertTrue(shown.workspaces.isEmpty());
                assertFalse(shown.requiresPayment());
            }else if(shown.requiresPayment()){
                assertEquals(WorkspaceLock.DETAIL_PAY,shown.detailText());
                assertFalse(shown.detailText().contains("did not include a workspace list"));
            }else{
                assertTrue(shown.detailText().isEmpty());
                assertFalse(shown.workspaces.isEmpty());
            }
            assertEquals("Delete",WorkspaceLock.ACTION_DELETE);
            assertEquals("Merge",WorkspaceLock.ACTION_MERGE);
            assertEquals("Download files",WorkspaceLock.ACTION_DOWNLOAD);
        }
        String mergePath=BackendFixtures.requestPath("merge","completed");
        String source=mergePath.substring("/v2/workspaces/".length(),mergePath.lastIndexOf("/merge"));
        assertEquals(mergePath,AccountActions.mergePath(source));
        String mergeRequest=BackendFixtures.requestBody("merge","completed");
        String sent=AccountActions.mergeBody(JsonFields.string(mergeRequest,"targetId"),JsonFields.string(mergeRequest,"confirmName"));
        assertEquals(JsonFields.string(mergeRequest,"targetId"),JsonFields.string(sent,"targetId"));
        assertEquals(JsonFields.string(mergeRequest,"confirmName"),JsonFields.string(sent,"confirmName"));
        assertTrue(BackendFixtures.responseBody("merge","renamed-file").contains("notes.txt (from Alpha)"));
        assertTrue(AccountActions.mergeUnavailable("Alpha").contains("name (from Alpha)"));
        assertEquals(400,BackendFixtures.responseStatus("merge","confirm-name"));
        assertEquals("CONFIRM_NAME_REQUIRED",JsonFields.string(BackendFixtures.responseBody("merge","confirm-name"),"error"));
        CloudSignals.Route cap=CloudSignals.route(BackendFixtures.responseStatus("workspaces","cap-reached"),BackendFixtures.responseBody("workspaces","cap-reached"),"POST");
        assertEquals(CloudSignals.Destination.GENERIC_ERROR,cap.destination);
        assertEquals(201,BackendFixtures.responseStatus("workspaces","create"));
        String foreign=BackendFixtures.responseBody("ownership","foreign-workspace");
        CloudSignals.Route missing=CloudSignals.route(BackendFixtures.responseStatus("ownership","foreign-workspace"),foreign,"GET");
        assertEquals(CloudSignals.Destination.GENERIC_ERROR,missing.destination);
        assertEquals("PROJECT_NOT_FOUND",JsonFields.string(foreign,"error"));
        AccountDeletion flow=ready();
        flow.onDeleteHttp(404,null,JsonFields.string(foreign,"error"),null);
        assertFalse(flow.requestsWipe());
    }

    @Test public void unsupportedProviderIsFriendly(){
        String raw=BackendFixtures.responseBody("byo","provider-unsupported");
        assertEquals(422,BackendFixtures.responseStatus("byo","provider-unsupported"));
        assertEquals("sftp",JsonFields.string(raw,"provider"));
        String message=ByoMessages.friendly(422,JsonFields.string(raw,"error"));
        assertEquals(ByoMessages.UNSUPPORTED,message);
        assertFalse(message.contains("byo_provider_unsupported"));
        assertTrue(ByoMessages.comingSoon("SFTP"));
        assertTrue(ByoMessages.comingSoon("Azure"));
        assertTrue(ByoMessages.comingSoon("WebDAV"));
        assertFalse(ByoMessages.comingSoon("s3"));
        String register=BackendFixtures.requestBody("byo","register");
        assertEquals("s3",JsonFields.string(register,"provider"));
        assertFalse(register.toLowerCase(java.util.Locale.ROOT).contains("secret"));
        CloudSignals.Route route=CloudSignals.route(422,raw,"POST");
        assertEquals(ByoMessages.UNSUPPORTED,route.toast);
        assertFalse(route.toast.contains("byo_provider_unsupported"));
        assertFalse(ByoFeature.showInSettings());
        for(String name:List.of("verify-expired","verify-host-mismatch","verify-mismatch","verify-used","verify-missing-url","verify-success")){
            String request=BackendFixtures.requestBody("byo",name);
            assertFalse(request.contains("readBack"));
            assertFalse(request.contains("proofUrl"));
            String response=BackendFixtures.responseBody("byo",name);
            int status=BackendFixtures.responseStatus("byo",name);
            String code=JsonFields.string(response,"error");
            if("verify-missing-url".equals(name)){
                assertFalse(request.contains("presignedUrl"));
                assertEquals(400,status);
                assertEquals("presigned_url_required",code);
            }else assertTrue(request.contains("\"presignedUrl\""));
            if(code==null)continue;
            String friendly=ByoMessages.friendly(status,code);
            assertNotNull(friendly);
            assertFalse(friendly.contains(code));
            CloudSignals.Route mapped=CloudSignals.route(status,response,"POST");
            assertEquals(friendly,mapped.toast);
        }
        String sent=AccountActions.byoVerifyBody("https://bucket.example/object");
        assertTrue(sent.contains("\"presignedUrl\""));
        assertFalse(sent.contains("readBack"));
        assertFalse(sent.contains("proofUrl"));
        assertEquals("/v2/workspaces/11111111-1111-4111-8111-000000000001/byo/verify",AccountActions.byoVerifyPath("11111111-1111-4111-8111-000000000001"));
    }

    @Test public void googleIdentityMismatchBlocksSignInAndForeignCancelStaysOut(){
        assertTrue(DeletionSignIn.blocksCredential("google-a","a@example.com","google-b","b@example.com"));
        assertTrue(DeletionSignIn.blocksCredential("google-a","a@example.com","google-b","a@example.com"));
        assertFalse(DeletionSignIn.blocksCredential("google-a","a@example.com","google-a","A@example.com"));
        assertFalse(DeletionSignIn.blocksCredential("","a@example.com","google-sub","a@example.com"));
        assertTrue(DeletionSignIn.switchedAccount("uid-a","uid-b"));
        assertFalse(DeletionSignIn.switchedAccount("uid-a","uid-a"));
        assertFalse(DeletionSignIn.cancelOpensLibrary(true));
        assertTrue(DeletionSignIn.cancelOpensLibrary(false));
        DeletionReceipt saved=DeletionReceipt.of("job_saved",TOKEN,"uid-a");
        DeletionReceiptMemory memory=new DeletionReceiptMemory();
        memory.save(saved);
        DeletionReceipt loaded=memory.read();
        assertEquals("uid-a",loaded.accountUid);
        assertEquals("uid-a",DeletionSignIn.ownerUid(loaded,"uid-b"));
        assertFalse(loaded.toString().contains(TOKEN));
        AccountDeletion flow=new AccountDeletion();
        flow.continueFromExplain();
        flow.confirmPhrase("DELETE");
        assertTrue(flow.rejectDifferentAccount("uid-a","uid-b","a@example.com","b@example.com"));
        assertEquals(AccountDeletion.DIFFERENT_ACCOUNT,flow.message);
        assertFalse(flow.requestsWipe());
        assertFalse(flow.allowsDelete());
    }

    @Test public void transportRunsFixtureFlowWithoutWipingEarly() throws Exception {
        AccountDeletion flow=ready();
        Script script=new Script().respond(fixture("accepted")).respond(fixture("status-running")).respond(fixture("status-done"));
        int attempts=flow.deleteAttempts;
        flow.deleteThrough(script,"Bearer firebase-token");
        assertEquals(AccountDeletion.Step.POLLING,flow.step);
        assertEquals("DELETE /v2/account",script.calls.get(0));
        assertTrue(script.authorizations.get(0).startsWith("Bearer "));
        assertFalse(flow.requestsWipe());
        flow.pollThrough(script);
        assertEquals(AccountDeletion.Step.POLLING,flow.step);
        assertTrue(script.calls.get(1).startsWith("GET /v2/account/deletions/"));
        assertEquals("Bearer "+flow.statusToken,script.authorizations.get(1));
        flow.pollThrough(script);
        assertEquals(AccountDeletion.Step.DONE,flow.step);
        assertTrue(flow.requestsWipe());
        assertEquals(attempts+1,flow.deleteAttempts);

        AccountDeletion gone=ready();
        gone.deleteThrough(new Script().respond(fixture("account-deleted")),"Bearer firebase-token");
        assertEquals(AccountDeletion.Step.POLLING,gone.step);
        assertFalse(gone.requestsWipe());
        assertFalse(gone.allowsDelete());
    }

    @Test public void singularPathIsJson404AndSyntheticNonJsonDoesNotThrow() throws Exception {
        assertTrue(BackendFixtures.requestPath("account-deletion","singular-path").contains("/v2/account/deletion/"));
        AccountActions.HttpBody missingPath=fixture("singular-path");
        assertEquals(404,missingPath.status);
        assertEquals("not_found",missingPath.error);
        assertNull(missingPath.jobId);
        AccountDeletion polling=AccountDeletion.resume(DeletionReceipt.of("job_html",TOKEN));
        polling.pollThrough(new Script().respond(missingPath));
        assertEquals(AccountDeletion.Step.FAILED,polling.step);
        assertTrue(polling.offersRetry());
        assertTrue(polling.canDismiss());
        assertEquals("job_html",polling.jobId);
        assertEquals(TOKEN,polling.statusToken);
        assertFalse(polling.dropReceipt);
        assertFalse(polling.requestsWipe());

        // SYNTHETIC non-JSON body. singular-path.json is JSON 404 and is not this case.
        AccountDeletion generic=AccountDeletion.resume(DeletionReceipt.of("job_html",TOKEN));
        AccountActions.HttpBody other=AccountActions.parse(503,"<html>unavailable</html>");
        assertTrue(other.raw.contains("<html>unavailable</html>"));
        assertNull(other.error);
        generic.pollThrough(new Script().respond(other));
        assertTrue(generic.offersRetry());
        assertFalse(generic.plainError);
        assertEquals("job_html",generic.jobId);
        assertEquals(TOKEN,generic.statusToken);
        assertFalse(generic.requestsWipe());

        AccountDeletion missing=ready();
        missing.deleteThrough(new Script().respond(missingPath),"Bearer firebase-token");
        assertTrue(missing.plainError);
        assertFalse(missing.offersRetry());
        assertFalse(missing.requestsWipe());
        assertNull(missing.jobId);

        AccountActions.HttpBody expired=fixture("expired-token");
        assertEquals(404,expired.status);
        assertEquals("not_found",expired.error);
        assertTrue(BackendFixtures.requestPath("account-deletion","expired-token").endsWith("000000000005"));
        AccountActions.HttpBody otherJob=fixture("other-job-token");
        assertEquals(404,otherJob.status);
        assertEquals("not_found",otherJob.error);
        assertTrue(BackendFixtures.requestPath("account-deletion","other-job-token").endsWith("000000000006"));
        assertEquals("<redacted>",fixture("accepted").statusToken);
        assertEquals("<redacted>",fixture("retry-after-failed").statusToken);
        assertTrue(AccountActions.validToken("<redacted>"));
    }

    @Test public void statusTokenPollStopsOnInvalidTokenAndUnauthorized() throws Exception {
        AccountActions.HttpBody invalid=fixture("status-invalid-token");
        assertTrue(BackendFixtures.requestPath("account-deletion","status-invalid-token").startsWith("/v2/account/deletions/"));
        assertEquals(401,invalid.status);
        assertEquals("invalid_token",invalid.error);
        AccountDeletion stopped=AccountDeletion.resume(DeletionReceipt.of("job_poll",TOKEN));
        stopped.pollThrough(new Script().respond(invalid));
        assertEquals(AccountDeletion.Step.REAUTH,stopped.step);
        assertFalse(stopped.keepsPolling());
        assertFalse(stopped.clearSession);
        assertTrue(stopped.repeatDelete);
        assertEquals("job_poll",stopped.jobId);
        assertEquals(TOKEN,stopped.statusToken);
        assertFalse(stopped.dropReceipt);
        assertFalse(stopped.requestsWipe());
        stopped.pollThrough(new Script().respond(AccountActions.parse(200,"{\"jobId\":\"job_poll\",\"status\":\"done\",\"retryable\":false}")));
        assertEquals(AccountDeletion.Step.REAUTH,stopped.step);
        assertFalse(stopped.requestsWipe());
        assertTrue(stopped.acceptFreshSignIn(2_000L,2_000L));
        assertTrue(stopped.allowsDelete());

        AccountActions.HttpBody unauthorized=fixture("status-unauthorized");
        assertEquals(401,unauthorized.status);
        assertEquals("unauthorized",unauthorized.error);
        AccountDeletion signIn=AccountDeletion.resume(DeletionReceipt.of("job_poll",TOKEN));
        signIn.pollThrough(new Script().respond(unauthorized));
        assertEquals(AccountDeletion.Step.REAUTH,signIn.step);
        assertFalse(signIn.keepsPolling());
        assertFalse(signIn.clearSession);
        assertEquals("job_poll",signIn.jobId);
        assertEquals(TOKEN,signIn.statusToken);
        assertFalse(signIn.requestsWipe());
    }

    @Test public void retryAfterFailureSendsDeleteAndSavesTheNewToken() throws Exception {
        AccountActions.HttpBody failed=fixture("status-failed");
        assertEquals(Boolean.TRUE,failed.retryable);
        AccountDeletion flow=AccountDeletion.resume(DeletionReceipt.of(failed.jobId,TOKEN));
        flow.pollThrough(new Script().respond(failed));
        assertEquals(AccountDeletion.Step.FAILED,flow.step);
        assertTrue(flow.offersRetry());
        assertFalse(flow.showSupport);
        assertEquals(failed.jobId,flow.jobId);
        flow.retry();
        assertEquals(AccountDeletion.Step.REAUTH,flow.step);
        assertTrue(flow.acceptFreshSignIn(2_000L,2_000L));
        assertTrue(flow.allowsDelete());
        AccountActions.HttpBody again=fixture("retry-after-failed");
        assertEquals(202,again.status);
        assertEquals("queued",again.jobStatus);
        assertEquals("<redacted>",again.statusToken);
        assertEquals("/v2/account",BackendFixtures.requestPath("account-deletion","retry-after-failed"));
        Script retried=new Script().respond(again);
        flow.deleteThrough(retried,"Bearer firebase-token");
        assertEquals("DELETE /v2/account",retried.calls.get(0));
        assertEquals(AccountDeletion.Step.POLLING,flow.step);
        assertEquals(again.jobId,flow.jobId);
        assertEquals("<redacted>",flow.statusToken);
        assertFalse(flow.requestsWipe());

        AccountDeletion gone=AccountDeletion.resume(DeletionReceipt.of(failed.jobId,TOKEN));
        gone.pollThrough(new Script().respond(failed));
        gone.retry();
        assertTrue(gone.acceptFreshSignIn(2_000L,2_000L));
        AccountActions.HttpBody deleted=fixture("account-deleted");
        Script finished=new Script().respond(deleted);
        gone.deleteThrough(finished,"Bearer firebase-token");
        assertEquals("DELETE /v2/account",finished.calls.get(0));
        assertEquals(AccountDeletion.Step.POLLING,gone.step);
        assertEquals(deleted.jobId,gone.jobId);
        assertEquals("<redacted>",gone.statusToken);
        assertFalse(gone.requestsWipe());
    }

    @Test public void notRetryableFailureShowsSupportAndDismissWipesNothing() throws Exception {
        assertTrue(SupportContact.IS_PLACEHOLDER);
        assertEquals("SUPPORT_CONTACT_PLACEHOLDER@invalid",SupportContact.ADDRESS);
        AccountDeletion failed=ready();
        failed.onDeleteHttp(202,"job_support",null,TOKEN);
        failed.onPollHttp(200,"failed",null,false);
        assertTrue(failed.showSupport);
        assertTrue(failed.canDismiss());
        assertFalse(failed.offersRetry());
        assertEquals("job_support",failed.jobId);
        assertTrue(failed.dismissError());
        assertNull(failed.jobId);
        assertFalse(failed.requestsWipe());

        AccountActions.HttpBody failedBody=fixture("status-failed");
        AccountDeletion blocked=AccountDeletion.resume(DeletionReceipt.of(failedBody.jobId,TOKEN));
        blocked.pollThrough(new Script().respond(failedBody));
        blocked.retry();
        assertTrue(blocked.acceptFreshSignIn(2_000L,2_000L));
        AccountActions.HttpBody conflict=fixture("retry-not-retryable");
        assertEquals(409,conflict.status);
        assertEquals("deletion_not_retryable",conflict.error);
        assertEquals("/v2/account",BackendFixtures.requestPath("account-deletion","retry-not-retryable"));
        Script script=new Script().respond(conflict);
        blocked.deleteThrough(script,"Bearer firebase-token");
        assertEquals("DELETE /v2/account",script.calls.get(0));
        assertEquals(AccountDeletion.Step.FAILED,blocked.step);
        assertTrue(blocked.showSupport);
        assertFalse(blocked.offersRetry());
        assertTrue(blocked.canDismiss());
        assertEquals("00000000-0000-4000-8000-0000000000aa",blocked.jobId);
        assertEquals(TOKEN,blocked.statusToken);
        assertTrue(SupportContact.mailto(blocked.jobId).contains("Account%20deletion%20"+conflict.jobId));
        assertFalse(blocked.requestsWipe());
        assertTrue(blocked.dismissError());
        assertNull(blocked.jobId);
        assertFalse(blocked.requestsWipe());
        assertTrue(LocalDataWipe.secretsRemoved(blocked.requestsWipe(),ALIASES).isEmpty());
    }

    @Test public void vendoredKeyEnvelopeAndPayloadTooLargeAreLoaded(){
        assertEquals("9d0f056",BackendFixtures.ACCOUNT_DELETION_SHA);
        assertEquals("24fba02",BackendFixtures.KEY_ENVELOPE_SHA);
        AccountActions.HttpBody tooLarge=AccountActions.parse(BackendFixtures.responseStatus("errors","payload-too-large"),BackendFixtures.responseBody("errors","payload-too-large"));
        assertEquals(413,tooLarge.status);
        assertEquals("payload_too_large",tooLarge.error);
        assertEquals("/v2/account",BackendFixtures.requestPath("errors","payload-too-large"));
        AccountDeletion huge=ready();
        huge.onDeleteHttp(tooLarge.status,tooLarge.jobId,tooLarge.error,tooLarge.statusToken);
        assertEquals(AccountDeletion.Step.FAILED,huge.step);
        assertFalse(huge.requestsWipe());
        assertEquals(201,BackendFixtures.responseStatus("key-envelope","create"));
        assertTrue(BackendFixtures.requestPath("key-envelope","create").endsWith("/key-envelope"));
        AccountActions.HttpBody conflict=AccountActions.parse(BackendFixtures.responseStatus("key-envelope","conflict"),BackendFixtures.responseBody("key-envelope","conflict"));
        assertEquals(409,conflict.status);
        assertEquals("envelope_exists",conflict.error);
        AccountActions.HttpBody mismatch=AccountActions.parse(BackendFixtures.responseStatus("key-envelope","version-mismatch"),BackendFixtures.responseBody("key-envelope","version-mismatch"));
        assertEquals(412,mismatch.status);
        assertEquals("version_mismatch",mismatch.error);
        AccountActions.HttpBody envelopeSize=AccountActions.parse(BackendFixtures.responseStatus("key-envelope","payload-too-large"),BackendFixtures.responseBody("key-envelope","payload-too-large"));
        assertEquals(413,envelopeSize.status);
        assertEquals("payload_too_large",envelopeSize.error);
    }

    @Test public void retryAfterNetworkErrorSendsDeleteAgain() throws Exception {
        AccountDeletion flow=ready();
        flow.onDeleteHttp(202,"job_net",null,TOKEN);
        int attempts=flow.deleteAttempts;
        flow.pollThrough(new Script().fail(new IOException("offline")));
        assertEquals(AccountDeletion.Step.FAILED,flow.step);
        assertTrue(flow.offersRetry());
        assertEquals("job_net",flow.jobId);
        assertEquals(TOKEN,flow.statusToken);
        assertFalse(flow.requestsWipe());
        flow.retry();
        assertEquals(AccountDeletion.Step.REAUTH,flow.step);
        assertEquals(attempts,flow.deleteAttempts);
        assertTrue(flow.acceptFreshSignIn(2_000L,2_000L));
        assertTrue(flow.allowsDelete());
        flow.onDeleteHttp(202,"job_net",null,"status-token-net");
        assertEquals("status-token-net",flow.statusToken);
        Script again=new Script().respond(AccountActions.parse(200,"{\"jobId\":\"job_net\",\"status\":\"running\",\"retryable\":true}"));
        flow.pollThrough(again);
        assertEquals("GET /v2/account/deletions/job_net",again.calls.get(0));
        assertEquals("Bearer status-token-net",again.authorizations.get(0));
        assertEquals(AccountDeletion.Step.POLLING,flow.step);
    }

    @Test public void errorCodeIgnoresMessageText(){
        assertEquals("other",AccountActions.errorCode("{\"error\":\"other\",\"message\":\"manifest_generation_required\"}"));
        assertEquals("manifest_generation_required",AccountActions.errorCode("{\"message\":\"try manifest_generation_required\",\"code\":\"manifest_generation_required\"}"));
        assertEquals("reauth_required",AccountActions.errorCode("{\"error\":\"\",\"code\":\"reauth_required\"}"));
        assertEquals("not a code!!",AccountActions.errorCode("{\"error\":\"not a code!!\",\"code\":\"reauth_required\"}"));
    }

    @Test public void fileReplacementFailureLeavesTheOldCopyReadable() throws Exception {
        FileReplacement.Manifest upload=manifest();
        try{
            FileReplacement.replace(new MemoryStore(){public void uploadChunks(String objectId) throws Exception{throw new IOException("chunk");}},upload,"new-object");
            throw new AssertionError("upload should fail");
        }catch(IOException expected){
            assertEquals("chunk",expected.getMessage());
        }
        assertEquals("old-object",upload.objectId);
        assertTrue(upload.oldReadable);
        assertFalse(upload.localTrashed);

        FileReplacement.Manifest conflicted=manifest();
        boolean[] held={false,false};
        FileReplacement.replace(new MemoryStore(){
            int puts;
            public long putManifest(long ifGeneration,String objectId) throws Exception {
                puts++;
                if(puts==1){
                    held[0]="old-object".equals(conflicted.objectId)&&conflicted.oldReadable;
                    held[1]=!conflicted.localTrashed;
                    throw new FileReplacement.Conflict(9);
                }
                return 10;
            }
            public long refetchGeneration(){return 9;}
        },conflicted,"new-object");
        assertTrue(held[0]);
        assertTrue(held[1]);
        assertEquals("new-object",conflicted.objectId);
        assertTrue(conflicted.localTrashed);

        FileReplacement.Manifest put=manifest();
        try{
            FileReplacement.replace(new MemoryStore(){public long putManifest(long ifGeneration,String objectId) throws Exception{throw new IOException("put");}},put,"new-object");
            throw new AssertionError("put should fail");
        }catch(IOException expected){
            assertEquals("put",expected.getMessage());
        }
        assertEquals("old-object",put.objectId);
        assertTrue(put.oldReadable);
        assertFalse(put.localTrashed);

        FileReplacement.Manifest deleted=manifest();
        FileReplacement.replace(new MemoryStore(){public void deleteOldChunks(String objectId) throws Exception{throw new IOException("delete");}},deleted,"new-object");
        assertEquals("old-object",deleted.objectId);
        assertTrue(deleted.oldReadable);
        assertFalse(deleted.localTrashed);
    }

    private static FileReplacement.Manifest manifest(){
        FileReplacement.Manifest manifest=new FileReplacement.Manifest();
        manifest.objectId="old-object";
        manifest.generation=3;
        return manifest;
    }

    private static class MemoryStore implements FileReplacement.Store {
        public void uploadChunks(String objectId) throws Exception {}
        public long putManifest(long ifGeneration,String objectId) throws Exception {return ifGeneration+1;}
        public long refetchGeneration() throws Exception {return 4;}
        public void deleteOldChunks(String objectId) throws Exception {}
        public void trashLocalOriginal() throws Exception {}
    }

    private static AccountActions.HttpBody fixture(String name){
        return AccountActions.parse(BackendFixtures.responseStatus("account-deletion",name),BackendFixtures.responseBody("account-deletion",name));
    }

    private static final class Script implements AccountDeletion.DeletionTransport {
        private final ArrayList<Object> steps=new ArrayList<>();
        final ArrayList<String> calls=new ArrayList<>();
        final ArrayList<String> authorizations=new ArrayList<>();
        Script respond(AccountActions.HttpBody body){steps.add(body);return this;}
        Script fail(Exception error){steps.add(error);return this;}
        @Override public AccountActions.HttpBody execute(String method,String path,byte[] body,String authorization) throws Exception {
            calls.add(method+" "+path);
            authorizations.add(authorization==null?"":authorization);
            Object step=steps.remove(0);
            if(step instanceof Exception error)throw error;
            return (AccountActions.HttpBody)step;
        }
    }

    private static AccountDeletion ready(){
        AccountDeletion flow=new AccountDeletion();
        flow.continueFromExplain();
        if(!flow.confirmPhrase("DELETE"))throw new AssertionError("confirm");
        if(!flow.acceptFreshSignIn(1_000L,1_000L))throw new AssertionError("fresh");
        flow.noteDeleteSent();
        return flow;
    }
}
