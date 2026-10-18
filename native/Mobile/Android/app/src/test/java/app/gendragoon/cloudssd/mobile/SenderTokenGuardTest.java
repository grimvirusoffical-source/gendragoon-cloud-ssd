package app.gendragoon.cloudssd.mobile;

import org.junit.BeforeClass;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.nio.charset.StandardCharsets;
import java.security.cert.Certificate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import javax.net.ssl.HttpsURLConnection;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * QA (Morgan), PR #8 at {@code e5f1982}. Core {@code 4582ae7}: a missing, empty or whitespace-only
 * token never becomes an {@code Authorization: Bearer} header, so zero requests go out.
 * e5f1982 fixed {@code AccountActions.validToken}, but the low-level senders still trust their input:
 * {@code CloudApi.exchangeAuthorized} (CloudApi.java:59-65) has no check,
 * {@code deleteAccountCall} (:86) and {@code postDeletionSupport} (:102) check {@code isEmpty()} only.
 * Every https request in this JVM goes to a recording fake; nothing reaches the network.
 * {@link #itFails} rows pass while the bug is present and fail once it is fixed: then drop the wrapper.
 */
public final class SenderTokenGuardTest {
    static final List<String> SENT=new ArrayList<>();
    private static final String[] BLANK={null,"","   ","\t","\n"," \t\n "};

    @BeforeClass public static void interceptHttps(){
        try{
            URL.setURLStreamHandlerFactory(protocol->"https".equals(protocol)?new URLStreamHandler(){
                @Override protected URLConnection openConnection(URL u){return new Recording(u);}
            }:null);
        }catch(Error alreadySet){
            // Another class set a factory first. Requests would not be recorded, so refuse to run rather than hit the network.
            throw new AssertionError("URLStreamHandlerFactory already set; SenderTokenGuardTest cannot isolate the network",alreadySet);
        }
    }

    interface Call {void run() throws Exception;}

    /** Runs {@code call} and returns how many requests it sent. Exceptions are expected and swallowed. */
    private static int sent(Call call){
        synchronized(SENT){SENT.clear();}
        try{call.run();}catch(Exception expected){}
        synchronized(SENT){return SENT.size();}
    }

    private static void itFails(String why,Runnable body){
        try{body.run();}catch(AssertionError expected){return;}
        fail("it.fails now passes, remove the marker: "+why);
    }

    private static final String ORIGIN="https://gendragoon-free-10068843866.us-central1.run.app";
    private static final String JOB="00000000-0000-4000-8000-000000000009";

    /** Control: the fake records a real token, so a zero below means nothing was sent. */
    @Test public void fakeRecordsARealToken(){
        assertEquals(1,sent(()->new CloudApi("qa-uid").exchangeAuthorized(ORIGIN+"/v2/account/deletions/"+JOB,"GET",null,Map.of(),"status-token-1")));
        assertTrue(SENT.get(0).endsWith("Bearer status-token-1"));
        assertEquals(1,sent(()->new CloudApi("qa-uid").deleteAccountCall("fresh-jwt")));
    }

    /** Status poll is guarded by AccountActions.pollCall -> validToken, so this passes at e5f1982. */
    @Test public void statusPollBlankTokenSendsNothing(){
        for(String token:BLANK){
            assertEquals("token "+show(token),0,sent(()->new CloudApi("qa-uid").pollDeletion("/v2/account/deletions/"+JOB,token)));
        }
    }

    /** Support POST: DeletionSupport.ENABLED=false throws first, so this only proves nothing is sent today. */
    @Test public void supportPostBlankTokenSendsNothingWhileFlagOff(){
        for(String token:BLANK){
            assertEquals("token "+show(token),0,sent(()->CloudApi.postDeletionSupport("/v2/account/deletions/"+JOB+"/support-request",token)));
        }
    }

    @Test public void deleteEmptyOrNullTokenSendsNothing(){
        for(String token:new String[]{null,""}){
            assertEquals("token "+show(token),0,sent(()->new CloudApi("qa-uid").deleteAccountCall(token)));
        }
    }

    /** CloudApi.java:86 checks isEmpty() only, so DELETE /v2/account goes out with "Bearer   ". */
    @Test public void deleteWhitespaceTokenSendsNothing(){
        itFails("deleteAccountCall (CloudApi.java:86) only checks isEmpty",()->{
            for(String token:new String[]{"   ","\t","\n"," \t\n "}){
                assertEquals("token "+show(token),0,sent(()->new CloudApi("qa-uid").deleteAccountCall(token)));
            }
        });
    }

    /** CloudApi.java:59-65 has no token check; Avery's ask is that the guard lives here for every caller. */
    @Test public void exchangeAuthorizedBlankTokenSendsNothing(){
        itFails("exchangeAuthorized (CloudApi.java:65) sends \"Bearer \"+bearer for any bearer, including null",()->{
            for(String token:BLANK){
                assertEquals("token "+show(token),0,sent(()->new CloudApi("qa-uid").exchangeAuthorized(ORIGIN+"/v2/account/deletions/"+JOB+"/support-request","POST",null,Map.of(),token)));
            }
        });
    }

    private static String show(String token){return token==null?"null":"\""+token.replace("\t","\\t").replace("\n","\\n")+"\"";}

    /** Records the method, URL and Authorization header when the request would go out, then answers 401. */
    private static final class Recording extends HttpsURLConnection {
        private final ByteArrayOutputStream body=new ByteArrayOutputStream();
        private boolean recorded;
        Recording(URL url){super(url);}
        private void record(){
            if(recorded)return;recorded=true;
            synchronized(SENT){SENT.add(getRequestMethod()+" "+url+" Authorization: "+getRequestProperty("Authorization"));}
        }
        @Override public void connect(){record();connected=true;}
        @Override public OutputStream getOutputStream(){record();return body;}
        @Override public int getResponseCode(){record();return 401;}
        @Override public InputStream getInputStream() throws IOException {throw new IOException("401");}
        @Override public InputStream getErrorStream(){return new ByteArrayInputStream("{\"error\":\"unauthorized\"}".getBytes(StandardCharsets.UTF_8));}
        @Override public Map<String,List<String>> getHeaderFields(){return Map.of();}
        @Override public void disconnect(){}
        @Override public boolean usingProxy(){return false;}
        @Override public String getCipherSuite(){return "TLS_FAKE";}
        @Override public Certificate[] getLocalCertificates(){return new Certificate[0];}
        @Override public Certificate[] getServerCertificates(){return new Certificate[0];}
    }
}
