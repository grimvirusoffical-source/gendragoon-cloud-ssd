package app.gendragoon.cloudssd.mobile;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
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
        assertEquals(BackendFixtures.ACCOUNT_DELETION_SHA,"84f6fff");
        AccountActions.HttpBody running=AccountActions.parse(200,BackendFixtures.body("pollRunning"));
        assertEquals(created.jobId,running.jobId);
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
        assertEquals(AccountDeletion.Step.FAILED,invalid.step);
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
        assertEquals(AccountDeletion.Step.POLLING,kept.step);
        assertEquals("job_keep",kept.jobId);
        assertEquals(TOKEN,kept.statusToken);
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
        assertTrue(flow.dropReceipt);
        assertFalse(flow.requestsWipe());
        assertNull(flow.jobId);
        assertTrue(LocalDataWipe.secretsRemoved(flow.requestsWipe(),ALIASES).isEmpty());
        AccountDeletion retryable=ready();
        retryable.onDeleteHttp(202,"job_live",null,TOKEN);
        retryable.onPollHttp(200,"failed",null,true);
        assertFalse(retryable.dropReceipt);
        assertEquals("job_live",retryable.jobId);
        retryable.retry();
        assertEquals(AccountDeletion.Step.POLLING,retryable.step);
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

    @Test public void pollNotFoundDoesNotWipe(){
        DeletionReceiptMemory memory=new DeletionReceiptMemory();
        memory.save(DeletionReceipt.of("job_404",TOKEN));
        AccountDeletion flow=AccountDeletion.resume(memory.read());
        AccountActions.HttpBody missing=AccountActions.parse(404,BackendFixtures.body("pollNotFound"));
        flow.onPollHttp(missing.status,missing.jobStatus,missing.error,missing.retryable);
        assertEquals(AccountDeletion.Step.FAILED,flow.step);
        assertTrue(flow.refuseDelete);
        flow.retry();
        assertEquals(AccountDeletion.Step.FAILED,flow.step);
        assertFalse(flow.allowsDelete());
        assertTrue(flow.dropReceipt);
        assertFalse(flow.requestsWipe());
        assertTrue(flow.message!=null&&!flow.message.isEmpty());
        assertFalse(flow.message.contains(TOKEN));
        assertTrue(LocalDataWipe.secretsRemoved(flow.requestsWipe(),ALIASES).isEmpty());
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
        flow.onDeleteHttp(401,null,null,null);
        assertEquals(AccountDeletion.Step.SIGNED_OUT,flow.step);
        assertFalse(flow.requestsWipe());
        assertTrue(LocalDataWipe.secretsRemoved(flow.requestsWipe(),ALIASES).isEmpty());
        AccountDeletion named=ready();
        named.onDeleteHttp(401,null,"reauth_required",null);
        assertEquals(AccountDeletion.Step.REAUTH,named.step);
        assertFalse(named.requestsWipe());
    }

    @Test public void unsafeJobAndSingularPathAreRefused(){
        assertFalse(AccountActions.validJob("a/b"));
        assertFalse(AccountActions.validJob(".."));
        assertFalse(AccountActions.validJob("a..b"));
        assertNull(AccountActions.statusPath("a/b"));
        assertNull(AccountActions.statusPath(".."));
        assertEquals("/v2/account/deletions/job_1",AccountActions.statusPath("job_1"));
        assertEquals("job_1",AccountActions.encodeJob("job_1"));
        assertFalse(AccountActions.safeAccountPath("/v2/account/deletion/job_1"));
        assertFalse(AccountActions.safeAccountPath("/v2/account/deletions/a/b"));
        assertFalse(AccountActions.safeAccountPath("/v2/account/deletions/.."));
        assertTrue(AccountActions.safeAccountPath("/v2/account/deletions/job_1"));
        assertNull(AccountActions.pollCall("/v2/account/deletion/job_1",TOKEN));
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
        assertEquals(BackendFixtures.SHARED_FIXTURE_SHA,"4dfde4b");
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
