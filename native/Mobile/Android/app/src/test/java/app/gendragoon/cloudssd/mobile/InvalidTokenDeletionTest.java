package app.gendragoon.cloudssd.mobile;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * A status-token poll {@code invalid_token} stops polling, keeps the job, and asks for sign-in.
 * An owner-token DELETE {@code invalid_token} signs out, keeps the job, and keeps polling.
 * {@code reauth_required} and a 401 with no code go to sign-in. None of them wipe.
 *
 * Generated fixtures are vendored under src/test/resources/fixtures/account-deletion.
 * {@code status-invalid-token} and {@code status-unauthorized} are from 9d0f056.
 * The export redacts tokens to {@code "<redacted>"}; that string is the opaque token here.
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

    /** 410 account_deleted starts polling, then the status poll returns invalid_token. */
    private static AccountDeletion pollingThenInvalidToken(){
        AccountDeletion flow=ready();
        AccountActions.HttpBody gone=fixture("account-deleted");
        flow.onDeleteHttp(gone.status,gone.jobId,gone.error,gone.statusToken);
        assertEquals(AccountDeletion.Step.POLLING,flow.step);
        AccountActions.HttpBody invalid=fixture("status-invalid-token");
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
        assertEquals(AccountDeletion.Step.REAUTH,invalid.step);
        assertFalse(invalid.keepsPolling());
        assertFalse(invalid.clearSession);

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
        assertFalse("stopping the poll must not drop the saved receipt",flow.dropReceipt);
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
        assertEquals(AccountDeletion.Step.REAUTH,resumed.step);
        assertTrue(resumed.acceptFreshSignIn(1_000L,1_000L));
        assertTrue(resumed.allowsDelete());
    }

    /** A later poll is ignored once the status token has been rejected. */
    @Test
    public void statusInvalidTokenStopsPollingSoDoneDoesNotWipe(){
        AccountDeletion flow=pollingThenInvalidToken();
        AccountActions.HttpBody done=fixture("status-done");
        flow.onPollHttp(done.status,done.jobStatus,done.error,done.retryable);
        assertEquals(AccountDeletion.Step.REAUTH,flow.step);
        assertFalse(flow.requestsWipe());
    }

    /** DELETE invalid_token signs out, keeps the saved job, and a later done still wipes. */
    @Test public void ownerTokenInvalidTokenKeepsPollingUntilDone(){
        AccountDeletion flow=ready();
        AccountActions.HttpBody gone=fixture("account-deleted");
        flow.onDeleteHttp(gone.status,gone.jobId,gone.error,gone.statusToken);
        flow.onPollHttp(200,"failed",null,true);
        flow.retry();
        assertTrue(flow.acceptFreshSignIn(1_000L,1_000L));
        assertTrue(flow.allowsDelete());
        AccountActions.HttpBody invalid=fixture("invalid-token");
        flow.onDeleteHttp(invalid.status,invalid.jobId,invalid.error,invalid.statusToken);
        assertEquals(AccountDeletion.Step.SIGNED_OUT,flow.step);
        assertTrue(flow.clearSession);
        assertTrue(flow.keepsPolling());
        assertEquals(gone.jobId,flow.jobId);
        assertEquals(gone.statusToken,flow.statusToken);
        assertFalse(flow.dropReceipt);
        assertFalse(flow.requestsWipe());
        AccountActions.HttpBody done=fixture("status-done");
        flow.onPollHttp(done.status,done.jobStatus,done.error,done.retryable);
        assertTrue(flow.requestsWipe());
        assertTrue(LocalDataWipe.secretsRemoved(false,ALIASES).isEmpty());
    }
}
