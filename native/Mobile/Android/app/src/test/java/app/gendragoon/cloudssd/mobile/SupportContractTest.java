package app.gendragoon.cloudssd.mobile;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * QA (Morgan) contract rows for the deletion support request on PR #8 at {@code e5f1982},
 * against gendragoon-apps core {@code caf30ae} / {@code 4582ae7} ({@code postDeletionSupport}).
 * Each test kills a mutant that the existing {@link AccountDeletionTest} rows let survive.
 * Sender-level blank-token rows live in {@link SenderTokenGuardTest}.
 */
public final class SupportContractTest {
    private static final String TOKEN="status-token-1";

    private static AccountActions.HttpBody fixture(String name){
        return AccountActions.parse(BackendFixtures.responseStatus("account-deletion",name),BackendFixtures.responseBody("account-deletion",name));
    }

    private static final class Script implements AccountDeletion.DeletionTransport {
        private final java.util.ArrayList<Object> steps=new java.util.ArrayList<>();
        int calls;
        Script respond(AccountActions.HttpBody body){steps.add(body);return this;}
        @Override public AccountActions.HttpBody execute(String method,String path,byte[] body,String authorization) throws Exception {
            calls++;
            Object step=steps.remove(0);
            if(step instanceof Exception error)throw error;
            return (AccountActions.HttpBody)step;
        }
    }

    private static AccountDeletion refreshing(AccountActions.HttpBody dead){
        AccountDeletion flow=AccountDeletion.resume(DeletionReceipt.of(dead.jobId,TOKEN));
        flow.pollThrough(new Script().respond(dead));
        DeletionSupport.Result refresh=DeletionSupport.interpret(409,BackendFixtures.responseBody("account-deletion","support-not-needed"),false);
        assertEquals(DeletionSupport.Kind.REFRESH,refresh.kind);
        assertFalse(flow.applySupport(refresh));
        return flow;
    }

    /** Core 202: only {@code status:"received"} with a non-empty string {@code requestId} is success. */
    @Test public void malformed202OpensMailto(){
        for(String body:new String[]{
                "{\"status\":\"received\"}",
                "{\"status\":\"received\",\"requestId\":\"\"}",
                "{\"requestId\":\"req-1\"}",
                "{\"status\":\"queued\",\"requestId\":\"req-1\"}",
                "{\"status\":\"RECEIVED\",\"requestId\":\"req-1\"}",
                "not json",
                ""}){
            DeletionSupport.Result result=DeletionSupport.interpret(202,body,false);
            assertEquals(body,DeletionSupport.Kind.MAILTO,result.kind);
            assertTrue(body,result.opensMailto());
        }
        assertEquals(DeletionSupport.Kind.SENT,DeletionSupport.interpret(202,"{\"status\":\"received\",\"requestId\":\"req-1\"}",false).kind);
    }

    /** Core: any status other than 202, 409 support_not_needed or 429 is the email fallback, including other 2xx and 3xx. */
    @Test public void unexpectedSuccessRedirectAnd423StatusesOpenMailto(){
        String received="{\"status\":\"received\",\"requestId\":\"req-1\"}";
        for(int status:new int[]{200,201,204,301,302,304,307,423}){
            assertEquals("status "+status,DeletionSupport.Kind.MAILTO,DeletionSupport.interpret(status,received,false).kind);
        }
    }

    /** Core matches {@code error === "support_not_needed"} only; a 409 with any other shape falls back. */
    @Test public void only409SupportNotNeededRefreshes(){
        for(String body:new String[]{"","{}","{\"error\":\"deletion_not_retryable\"}","{\"code\":\"support_not_needed\"}","{\"error\":\"SUPPORT_NOT_NEEDED\"}"}){
            assertEquals(body,DeletionSupport.Kind.MAILTO,DeletionSupport.interpret(409,body,false).kind);
        }
        assertEquals(DeletionSupport.Kind.REFRESH,DeletionSupport.interpret(409,"{\"error\":\"support_not_needed\"}",false).kind);
    }

    /** A 401, 404, 5xx or transport failure is mailto, never "Request already sent." and never a refresh. */
    @Test public void errorsAreNeverAlreadySentOrRefresh(){
        String limited=BackendFixtures.responseBody("account-deletion","support-rate-limited");
        String notNeeded=BackendFixtures.responseBody("account-deletion","support-not-needed");
        for(int status:new int[]{401,404,500,502,503,504}){
            for(String body:new String[]{limited,notNeeded}){
                assertEquals("status "+status,DeletionSupport.Kind.MAILTO,DeletionSupport.interpret(status,body,false).kind);
            }
        }
        // A transport failure wins over whatever status or body came with it.
        assertEquals(DeletionSupport.Kind.MAILTO,DeletionSupport.interpret(429,limited,true).kind);
        assertEquals(DeletionSupport.Kind.MAILTO,DeletionSupport.interpret(409,notNeeded,true).kind);
        assertEquals(DeletionSupport.Kind.MAILTO,DeletionSupport.interpret(202,"{\"status\":\"received\",\"requestId\":\"r\"}",true).kind);
    }

    /** Refresh {@code done} for this job continues normally: no mailto, no error, the done flow runs. */
    @Test public void refreshDoneForThisJobContinuesNormally(){
        AccountActions.HttpBody dead=fixture("status-failed-not-retryable");
        AccountDeletion flow=refreshing(dead);
        flow.pollThrough(new Script().respond(AccountActions.parse(200,"{\"jobId\":\""+dead.jobId+"\",\"status\":\"done\"}")));
        assertFalse(flow.openSupportMailto);
        assertFalse(flow.supportRefresh);
        assertEquals(AccountDeletion.Step.DONE,flow.step);
        assertTrue(flow.requestsWipe());
        assertFalse(flow.clearSession);
    }

    /** The refresh is exactly one GET; a queued or running answer does not trigger a second support POST. */
    @Test public void refreshIsASingleGet(){
        AccountActions.HttpBody dead=fixture("status-failed-not-retryable");
        AccountDeletion flow=refreshing(dead);
        Script script=new Script().respond(AccountActions.parse(200,"{\"jobId\":\""+dead.jobId+"\",\"status\":\"queued\"}"));
        flow.pollThrough(script);
        assertEquals(1,script.calls);
        assertFalse(flow.supportRefresh);
        assertEquals("Your deletion is still in progress.",flow.message);
    }

    /** Core {@code 4582ae7}: an empty or whitespace-only token is the email fallback with zero requests. */
    @Test public void emptyTokenSendsNothing(){
        String job=fixture("status-failed-not-retryable").jobId;
        for(String token:new String[]{null,""}){
            DeletionSupport.Call call=DeletionSupport.call(job,job,token,true);
            assertFalse(call.send);
            assertNull(call.authorization());
        }
    }

    @Test public void whitespaceTokenSendsNothing(){
        String job=fixture("status-failed-not-retryable").jobId;
        // Failed at e226d4e (validToken only checked isEmpty); fixed by e5f1982 validToken trim.
        for(String token:new String[]{" ","   ","\t","\n"," \t\n "}){
            DeletionSupport.Call call=DeletionSupport.call(job,job,token,true);
            assertFalse("token "+token.length(),call.send);
            assertNull(call.authorization());
        }
    }

    /** A 409 refresh with a blank saved token must not poll with an empty Bearer; it falls back. */
    @Test public void whitespaceTokenRefreshFallsBack(){
        AccountActions.HttpBody dead=fixture("status-failed-not-retryable");
        // Failed at e226d4e; fixed by e5f1982.
        AccountDeletion flow=AccountDeletion.resume(DeletionReceipt.of(dead.jobId,"   "));
        assertFalse(flow.refreshAfterSupport());
    }
}
