package app.gendragoon.cloudssd.mobile;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class AccountDeletionTest {
    @Test public void phraseAndFreshSignInGateTheDelete(){
        AccountDeletion flow=new AccountDeletion();
        assertFalse(flow.confirmPhrase("DELETE"));
        flow.continueFromExplain();
        assertFalse(flow.confirmPhrase("delete"));
        assertTrue(flow.confirmPhrase("DELETE"));
        assertEquals(AccountDeletion.Step.REAUTH,flow.step);
        long now=10_000_000L;
        assertFalse(flow.acceptFreshSignIn(now-AccountDeletion.FRESH_SIGN_IN_MS-1,now));
        assertEquals(AccountDeletion.Step.REAUTH,flow.step);
        assertTrue(flow.message.contains("5 minutes"));
        assertTrue(flow.acceptFreshSignIn(now-AccountDeletion.FRESH_SIGN_IN_MS,now));
        assertEquals(AccountDeletion.Step.DELETING,flow.step);
    }

    @Test public void queuedAndRunningStayInProgressUntilDone(){
        AccountDeletion flow=ready();
        flow.onDeleteHttp(202,"job_1",null);
        assertEquals(AccountDeletion.Step.POLLING,flow.step);
        assertEquals(AccountActions.DELETION_STATUS_PATH+"job_1",flow.statusPath);
        flow.onPollHttp(200,"queued",null);
        assertEquals(AccountDeletion.Step.POLLING,flow.step);
        assertFalse(flow.requestsWipe());
        flow.onPollHttp(200,"running",null);
        assertEquals(AccountDeletion.Step.POLLING,flow.step);
        flow.onPollHttp(200,"done",null);
        assertEquals(AccountDeletion.Step.DONE,flow.step);
        assertTrue(flow.requestsWipe());
        flow.noteWiped();
        assertEquals(AccountDeletion.Step.WIPED,flow.step);
    }

    @Test public void failedPollCanBeRetried(){
        AccountDeletion flow=ready();
        flow.onDeleteHttp(202,"job_2",null);
        flow.onPollHttp(200,"failed",null);
        assertEquals(AccountDeletion.Step.FAILED,flow.step);
        assertFalse(flow.requestsWipe());
        assertTrue(LocalDataWipe.secretsRemoved(flow.requestsWipe(),List.of("gd-byo-gcs")).isEmpty());
        flow.retry();
        assertEquals(AccountDeletion.Step.EXPLAIN,flow.step);
    }

    @Test public void unauthorizedDeletionDoesNotWipeKeystore(){
        List<String> aliases=List.of("gd-byo-gcs","unrelated-alias");
        AccountDeletion reauth=ready();
        reauth.onDeleteHttp(401,null,"reauth_required");
        assertEquals(AccountDeletion.Step.REAUTH,reauth.step);
        assertFalse(reauth.requestsWipe());
        assertTrue(LocalDataWipe.secretsRemoved(reauth.requestsWipe(),aliases).isEmpty());
        assertTrue(reauth.acceptFreshSignIn(5_000L,5_000L));
        reauth.noteDeleteSent();
        reauth.onDeleteHttp(401,null,"reauth_required");
        assertEquals(AccountDeletion.Step.REAUTH,reauth.step);
        assertFalse(reauth.requestsWipe());
        assertTrue(LocalDataWipe.secretsRemoved(reauth.requestsWipe(),aliases).isEmpty());

        AccountDeletion invalid=ready();
        invalid.onDeleteHttp(401,null,"invalid_token");
        assertEquals(AccountDeletion.Step.SIGNED_OUT,invalid.step);
        assertFalse(invalid.requestsWipe());
        assertTrue(LocalDataWipe.secretsRemoved(invalid.requestsWipe(),aliases).isEmpty());

        AccountDeletion polling=ready();
        polling.onDeleteHttp(202,"job_3",null);
        polling.onPollHttp(401,null,"reauth_required");
        assertEquals(AccountDeletion.Step.REAUTH,polling.step);
        assertFalse(polling.requestsWipe());
        assertTrue(polling.acceptFreshSignIn(6_000L,6_000L));
        assertEquals(AccountDeletion.Step.POLLING,polling.step);
        polling.onPollHttp(401,null,"invalid_token");
        assertEquals(AccountDeletion.Step.SIGNED_OUT,polling.step);
        assertTrue(LocalDataWipe.secretsRemoved(polling.requestsWipe(),aliases).isEmpty());

        AccountDeletion done=ready();
        done.onDeleteHttp(202,"job_4",null);
        done.onPollHttp(200,"done",null);
        assertEquals(List.of("gd-byo-gcs"),LocalDataWipe.secretsRemoved(done.requestsWipe(),aliases));
    }

    @Test public void pollBackoffAndStatusPath(){
        AccountDeletion flow=ready();
        assertEquals(1000L,flow.nextPollDelayMillis());
        assertEquals(2000L,flow.nextPollDelayMillis());
        assertEquals(4000L,flow.nextPollDelayMillis());
        assertEquals(8000L,flow.nextPollDelayMillis());
        assertEquals(8000L,flow.nextPollDelayMillis());
        AccountDeletion hosted=ready();
        hosted.onDeleteHttp(202,"job_9",null);
        assertEquals(AccountActions.DELETION_STATUS_PATH+"job_9",hosted.statusPath);
        assertEquals("/v2/account/deletions/",AccountActions.DELETION_STATUS_PATH);
        assertTrue(AccountActions.mergeUnavailable("Photos").contains("name (from Photos)"));
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
