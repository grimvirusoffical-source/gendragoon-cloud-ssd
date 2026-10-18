package app.gendragoon.cloudssd.mobile;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Avery's ruling (Oct 17): a 401 {@code {"error":"invalid_token"}} signs the user out.
 * Sign-out clears only the session. The saved jobId and statusToken stay, polling continues
 * with {@code Bearer statusToken}, and local data is wiped only on {@code done}.
 * {@code reauth_required} and a 401 with no code go to sign-in instead. None of them wipe.
 *
 * Every server body here is Riley's generated fixture from PR #6 at d788ccb
 * ({@code fixtures/account-deletion/}, vendored under src/test/resources/fixtures/account-deletion).
 * The 410, poll-404 and status-done fixtures share job ...0005, so they chain as one job.
 * The export redacts tokens to {@code "<redacted>"}; that string is the opaque token here.
 *
 * After {@code invalid_token} the same session keeps polling, so {@code done} wipes without a relaunch.
 */
public final class InvalidTokenDeletionTest {
    private static final String AREA="account-deletion";
    private static final List<String> ALIASES=List.of("gd-byo-gcs","unrelated-alias");

    private static AccountActions.HttpBody fixture(String name){
        return AccountActions.parse(BackendFixtures.responseStatus(AREA,name),BackendFixtures.responseBody(AREA,name));
    }

    private static AccountDeletion ready(){
        AccountDeletion flow=new AccountDeletion();
        flow.continueFromExplain();
        if(!flow.confirmPhrase("DELETE"))throw new AssertionError("confirm");
        if(!flow.acceptFreshSignIn(1_000L,1_000L))throw new AssertionError("fresh");
        flow.noteDeleteSent();
        return flow;
    }

    /** 410 account_deleted for job ...0005 starts polling, then the poll gets invalid_token. */
    private static AccountDeletion pollingThenInvalidToken(){
        AccountDeletion flow=ready();
        AccountActions.HttpBody gone=fixture("account-deleted");
        flow.onDeleteHttp(gone.status,gone.jobId,gone.error,gone.statusToken);
        assertEquals(AccountDeletion.Step.POLLING,flow.step);
        AccountActions.HttpBody invalid=fixture("invalid-token");
        flow.onPollHttp(invalid.status,invalid.jobStatus,invalid.error,invalid.retryable);
        return flow;
    }

    @Test public void invalidTokenFixtureIsTheGeneratedDelete401(){
        assertEquals("/v2/account",BackendFixtures.requestPath(AREA,"invalid-token"));
        assertEquals("DELETE",JsonFields.string(BackendFixtures.requestBody(AREA,"invalid-token"),"confirm"));
        AccountActions.HttpBody invalid=fixture("invalid-token");
        assertEquals(401,invalid.status);
        assertEquals("invalid_token",invalid.error);
        assertNull(invalid.jobId);
        assertNull(invalid.statusToken);
    }

    @Test public void invalidTokenOnDeleteSignsOutWithoutWipingOrInventingAJob(){
        AccountDeletion flow=ready();
        AccountActions.HttpBody invalid=fixture("invalid-token");
        flow.onDeleteHttp(invalid.status,invalid.jobId,invalid.error,invalid.statusToken);
        assertEquals(AccountDeletion.Step.SIGNED_OUT,flow.step);
        assertFalse(flow.requestsWipe());
        assertNull(flow.receipt());
        assertFalse(flow.allowsDelete());
        assertTrue(LocalDataWipe.secretsRemoved(flow.requestsWipe(),ALIASES).isEmpty());
    }

    @Test public void invalidTokenIsSignOutWhileReauthRequiredAndBare401AreSignIn(){
        AccountDeletion invalid=pollingThenInvalidToken();
        assertEquals(AccountDeletion.Step.SIGNED_OUT,invalid.step);

        AccountDeletion reauth=ready();
        AccountActions.HttpBody gone=fixture("account-deleted");
        reauth.onDeleteHttp(gone.status,gone.jobId,gone.error,gone.statusToken);
        AccountActions.HttpBody needsReauth=fixture("reauth-required");
        reauth.onPollHttp(needsReauth.status,needsReauth.jobStatus,needsReauth.error,needsReauth.retryable);
        assertEquals(AccountDeletion.Step.REAUTH,reauth.step);
        assertEquals(gone.jobId,reauth.jobId);
        assertFalse(reauth.requestsWipe());
        // Bare 401 with no code: AccountDeletionTest.unauthorizedWithoutCodeGoesToSignIn.
    }

    @Test public void invalidTokenWhilePollingKeepsTheSavedJobAndToken(){
        AccountActions.HttpBody gone=fixture("account-deleted");
        AccountDeletion flow=pollingThenInvalidToken();
        assertFalse(flow.requestsWipe());
        assertFalse(flow.wipe);
        assertFalse("sign-out must not drop the saved receipt",flow.dropReceipt);
        assertEquals(gone.jobId,flow.jobId);
        assertEquals(gone.statusToken,flow.statusToken);
        DeletionReceipt receipt=flow.receipt();
        assertNotNull(receipt);
        DeletionReceiptMemory vault=new DeletionReceiptMemory();
        vault.save(receipt);
        assertTrue(vault.containsToken(gone.statusToken));
        assertEquals(gone.jobId,vault.read().jobId);
        assertTrue(LocalDataWipe.secretsRemoved(flow.requestsWipe(),ALIASES).isEmpty());
    }

    @Test public void afterInvalidTokenTheSavedJobPollsWithBearerAndWipesOnlyOnDone(){
        AccountActions.HttpBody gone=fixture("account-deleted");
        AccountDeletion signedOut=pollingThenInvalidToken();
        // What the next launch does with the kept receipt (MainActivity.onCreate -> AccountDeletion.resume).
        AccountDeletion resumed=AccountDeletion.resume(signedOut.receipt());
        assertEquals(AccountDeletion.Step.POLLING,resumed.step);
        assertEquals(BackendFixtures.requestPath(AREA,"status-done"),resumed.statusPath);
        AccountActions.PollCall call=AccountActions.pollCall(resumed.statusPath,resumed.statusToken);
        assertNotNull(call);
        assertEquals("GET",call.method);
        assertEquals("Bearer "+gone.statusToken,call.authorization);

        AccountActions.HttpBody expired=fixture("expired-token");
        resumed.onPollHttp(expired.status,expired.jobStatus,expired.error,expired.retryable);
        assertFalse(resumed.requestsWipe());
        assertEquals(gone.jobId,resumed.jobId);
        assertFalse(resumed.dropReceipt);
        resumed.retry();
        assertEquals(AccountDeletion.Step.POLLING,resumed.step);

        AccountActions.HttpBody done=fixture("status-done");
        resumed.onPollHttp(done.status,done.jobStatus,done.error,done.retryable);
        assertEquals(AccountDeletion.Step.DONE,resumed.step);
        assertTrue(resumed.requestsWipe());
    }

    /** After sign-out the same session still polls, so {@code done} wipes without a relaunch. */
    @Test
    public void bug_invalidTokenKeepsPollingInTheSameSessionAndWipesOnDone(){
        AccountDeletion flow=pollingThenInvalidToken();
        AccountActions.HttpBody done=fixture("status-done");
        flow.onPollHttp(done.status,done.jobStatus,done.error,done.retryable);
        assertTrue("done after invalid_token should wipe without a relaunch",flow.requestsWipe());
    }
}
