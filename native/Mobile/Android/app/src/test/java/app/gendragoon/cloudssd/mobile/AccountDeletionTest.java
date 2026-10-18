package app.gendragoon.cloudssd.mobile;

import org.junit.Test;

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
        flow.onDeleteHttp(202,"job_1",null,null);
        assertEquals(AccountDeletion.Step.POLLING,flow.step);
        assertEquals("/v2/account/deletions/job_1",flow.statusPath);
        flow.onPollHttp(200,"queued");
        assertEquals(AccountDeletion.Step.POLLING,flow.step);
        assertFalse(flow.wipe);
        flow.onPollHttp(200,"running");
        assertEquals(AccountDeletion.Step.POLLING,flow.step);
        flow.onPollHttp(200,"done");
        assertEquals(AccountDeletion.Step.DONE,flow.step);
        assertTrue(flow.wipe);
        flow.noteWiped();
        assertEquals(AccountDeletion.Step.WIPED,flow.step);
    }

    @Test public void failedPollCanBeRetried(){
        AccountDeletion flow=ready();
        flow.onDeleteHttp(202,"job_2",null,null);
        flow.onPollHttp(200,"failed");
        assertEquals(AccountDeletion.Step.FAILED,flow.step);
        assertFalse(flow.wipe);
        flow.retry();
        assertEquals(AccountDeletion.Step.EXPLAIN,flow.step);
    }

    @Test public void staleSessionRetriesOnceAndSecond401Wipes(){
        AccountDeletion flow=ready();
        flow.onDeleteHttp(401,null,null,"session_stale");
        assertEquals(AccountDeletion.Step.REAUTH,flow.step);
        assertFalse(flow.wipe);
        assertTrue(flow.acceptFreshSignIn(5_000L,5_000L));
        flow.noteDeleteSent();
        flow.onDeleteHttp(401,null,null,null);
        assertTrue(flow.wipe);
        assertEquals(AccountDeletion.Step.DONE,flow.step);
    }

    @Test public void missingAccountWipes(){
        AccountDeletion gone=ready();
        gone.onDeleteHttp(404,null,null,null);
        assertTrue(gone.wipe);
        AccountDeletion finished=ready();
        finished.onDeleteHttp(410,null,null,null);
        assertTrue(finished.wipe);
    }

    @Test public void pollBackoffAndStatusPath(){
        AccountDeletion flow=ready();
        assertEquals(1000L,flow.nextPollDelayMillis());
        assertEquals(2000L,flow.nextPollDelayMillis());
        assertEquals(4000L,flow.nextPollDelayMillis());
        assertEquals(8000L,flow.nextPollDelayMillis());
        assertEquals(8000L,flow.nextPollDelayMillis());
        AccountDeletion foreign=ready();
        foreign.onDeleteHttp(202,"job_9","https://evil.example/v2/account/deletions/job_9",null);
        assertEquals("/v2/account/deletions/job_9",foreign.statusPath);
        AccountDeletion hosted=ready();
        hosted.onDeleteHttp(202,"job_9","https://gendragoon-free-10068843866.us-central1.run.app/v2/account/deletions/job_9",null);
        assertEquals("/v2/account/deletions/job_9",hosted.statusPath);
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
