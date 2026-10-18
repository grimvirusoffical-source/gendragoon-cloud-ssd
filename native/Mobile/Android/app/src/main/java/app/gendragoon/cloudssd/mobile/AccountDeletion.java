package app.gendragoon.cloudssd.mobile;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Account-deletion state machine. Freshness is the Firebase ID token {@code auth_time} claim.
 * {@code DELETE /v2/account} sends {@code {"confirm":"DELETE"}} and returns
 * {@code 202 {"status":"deleting","jobId","statusToken"}}. A repeat delete of an account that is
 * already gone returns {@code 410 {"error":"account_deleted","jobId","statusToken"}}.
 * Status is only {@link AccountActions#DELETION_STATUS_PATH} and is authorized with the status token.
 * The JSON field is {@code status} ({@code queued | running | done | failed}) plus {@code retryable}.
 * Local keys are wiped only after {@code done}.
 */
final class AccountDeletion {
    enum Step { EXPLAIN, CONFIRM, REAUTH, DELETING, POLLING, DONE, FAILED, WIPED, SIGNED_OUT }

    static final String CONFIRM_PHRASE="DELETE";
    static final long FRESH_SIGN_IN_MS=CloudSignals.FRESH_SIGN_IN_MS;
    static final int POLL_LIMIT=90;

    Step step=Step.EXPLAIN;
    String message;
    String jobId;
    String statusToken;
    String statusPath;
    int deleteAttempts;
    int polls;
    boolean wipe;
    boolean wiped;
    /** A 404 means this token does not match the job. Do not send DELETE again. */
    boolean refuseDelete;
    /** Clear the saved job and token without erasing the rest of the device. */
    boolean dropReceipt;
    /** A poll {@code invalid_token} cleared the session. The saved job keeps polling. */
    boolean clearSession;
    /** A DELETE 404 with no saved job. Show the error without Retry. */
    boolean plainError;
    AccountActions.HttpBody lastBody;

    void continueFromExplain(){if(step==Step.EXPLAIN)step=Step.CONFIRM;}

    boolean confirmPhrase(String phrase){
        if(step!=Step.CONFIRM||!CONFIRM_PHRASE.equals(phrase))return false;
        step=Step.REAUTH;
        message=null;
        return true;
    }

    /** @return false when {@code auth_time} is missing, in the future, or older than five minutes. */
    boolean acceptFreshSignIn(long authTimeMs,long nowMs){
        if(step!=Step.REAUTH)return false;
        if(authTimeMs<=0||nowMs<authTimeMs||nowMs-authTimeMs>FRESH_SIGN_IN_MS){
            step=Step.REAUTH;
            message="Sign in again. The server only accepts a sign-in from the last 5 minutes.";
            return false;
        }
        if(beginPolling(jobId,statusToken))return true;
        if(refuseDelete||jobId!=null||statusToken!=null){
            fail("A saved deletion is already in progress. DELETE was not sent again.");
            return false;
        }
        step=Step.DELETING;
        message=null;
        return true;
    }

    /** DELETE is sent only when nothing is saved. Up to 5 status tokens stay valid, so a saved token is kept and polled. */
    boolean allowsDelete(){return step==Step.DELETING&&!refuseDelete&&jobId==null&&statusToken==null;}

    void noteDeleteSent(){deleteAttempts++;}

    /** True only after the deletion job reports {@code done}. */
    boolean requestsWipe(){return wipe&&step==Step.DONE;}

    DeletionReceipt receipt(){return DeletionReceipt.of(jobId,statusToken);}

    /** Continue a saved job after restart. Does not sign out and does not wipe. */
    static AccountDeletion resume(DeletionReceipt receipt){
        AccountDeletion flow=new AccountDeletion();
        if(receipt==null||!flow.beginPolling(receipt.jobId,receipt.statusToken)){
            flow.dropReceipt=true;
            flow.fail("Saved deletion could not be resumed. Nothing on this device was erased.");
        }
        return flow;
    }

    void onDeleteHttp(int status,String jobId,String errorCode,String statusToken){
        if(step!=Step.DELETING)return;
        if(status==423&&CloudSignals.CODE_LOCK.equals(errorCode)){wipe=false;return;}
        if(status==401){onUnauthorized(errorCode);return;}
        if(status==410){
            // A repeat DELETE after done is 410 account_deleted, never 401.
            // Up to 5 status tokens for the job stay valid, so this token is polled and not discarded.
            wipe=false;
            if("account_deleted".equals(errorCode)&&beginPolling(jobId,statusToken))return;
            fail("Account deletion did not include a usable job. Nothing on this device was erased.");
            return;
        }
        if(status==202&&beginPolling(jobId,statusToken))return;
        if(status==404&&this.jobId==null&&this.statusToken==null){
            plainError=true;
            fail("Account deletion did not start. Nothing on this device was erased.");
            return;
        }
        plainError=false;
        fail("Account deletion did not start. You can retry.");
    }

    void onPollHttp(int status,String jobStatus,String errorCode,Boolean retryable){
        if(step!=Step.POLLING)return;
        plainError=false;
        if(status==423&&CloudSignals.CODE_LOCK.equals(errorCode)){wipe=false;return;}
        if(status==401){onUnauthorized(errorCode);return;}
        if(status==404){
            // Keep the saved job and token. Retry polls again. Dismiss is the only clear.
            wipe=false;
            refuseDelete=true;
            dropReceipt=false;
            fail("This deletion could not be confirmed. Nothing on this device was erased.");
            return;
        }
        if(status>=200&&status<300){
            if("queued".equals(jobStatus)||"running".equals(jobStatus)){step=Step.POLLING;wipe=false;return;}
            if("done".equals(jobStatus)){step=Step.DONE;wipe=true;message=null;return;}
            if("failed".equals(jobStatus)){
                if(Boolean.FALSE.equals(retryable)){
                    dropReceipt=true;
                    this.jobId=null;
                    this.statusToken=null;
                    this.statusPath=null;
                    fail("Account deletion failed and cannot be resumed. Nothing on this device was erased.");
                }else fail("Account deletion failed. You can retry.");
                return;
            }
            // Anything else, including "completed", stops now. Do not poll until the timeout.
            fail("Account deletion reported an unknown status. Nothing on this device was erased.");
            return;
        }
        wipe=false;
        fail("Could not read deletion status. You can retry.");
    }

    private boolean beginPolling(String jobId,String statusToken){
        String path=AccountActions.statusPath(jobId);
        if(!AccountActions.validToken(statusToken)||path==null||!AccountActions.safeAccountPath(path))return false;
        this.jobId=jobId;
        this.statusToken=statusToken;
        this.statusPath=path;
        step=Step.POLLING;
        wipe=false;
        dropReceipt=false;
        message=null;
        return true;
    }

    private void onUnauthorized(String errorCode){
        wipe=false;
        plainError=false;
        if("invalid_token".equals(errorCode)){
            if(AccountActions.validJob(jobId)&&AccountActions.validToken(statusToken)){
                clearSession=true;
                dropReceipt=false;
                return;
            }
            step=Step.SIGNED_OUT;
            message="Sign in again to continue.";
            return;
        }
        // A 401 with no code goes back to sign-in and keeps any saved job and token.
        if(errorCode==null||errorCode.isEmpty()){
            step=Step.REAUTH;
            message="Sign in again to continue.";
            return;
        }
        step=Step.REAUTH;
        message="Sign in again. The server only accepts a sign-in from the last 5 minutes.";
    }

    boolean exhausted(){return polls>=POLL_LIMIT;}

    long nextPollDelayMillis(){
        long delay=1000L<<Math.min(polls,3);
        polls++;
        return delay;
    }

    void fail(String text){step=Step.FAILED;wipe=false;message=text==null?"Account deletion did not finish. You can retry.":text;}

    /** Keeps a known job id and token and resumes polling. Never sends DELETE, including after a 404. */
    void retry(){
        if(step!=Step.FAILED)return;
        wipe=false;
        message=null;
        polls=0;
        if(AccountActions.validJob(jobId)&&AccountActions.validToken(statusToken)){
            statusPath=AccountActions.statusPath(jobId);
            step=Step.POLLING;
            dropReceipt=false;
            return;
        }
        if(refuseDelete)return;
        jobId=null;
        statusToken=null;
        statusPath=null;
        step=Step.REAUTH;
    }

    /** Failed responses offer Retry, except a DELETE 404 for a job that was never saved. */
    boolean offersRetry(){return step==Step.FAILED&&!plainError;}

    /** True after a 404 while the saved pair is still held. */
    boolean canDismiss(){return step==Step.FAILED&&refuseDelete;}

    /**
     * The user dismissed the 404 error. Clears the saved pair and wipes nothing.
     * The pair is otherwise cleared only after {@code done}.
     */
    boolean dismissError(){
        if(!canDismiss())return false;
        wipe=false;
        dropReceipt=true;
        jobId=null;
        statusToken=null;
        statusPath=null;
        message="Nothing on this device was erased.";
        return true;
    }

    static final String DIFFERENT_ACCOUNT="Sign in with the same Google account. Nothing was deleted.";

    /** A {@code reauth_required} sign-in for a different uid is rejected. Nothing is deleted or wiped. */
    boolean rejectDifferentAccount(String expectedUid,String actualUid,String expectedEmail,String actualEmail){
        if(step!=Step.REAUTH)return false;
        if(AccountMatch.same(expectedUid,expectedEmail,actualUid,actualEmail))return false;
        fail(DIFFERENT_ACCOUNT);
        return true;
    }

    void noteWiped(){if(step==Step.DONE&&wipe){wiped=true;step=Step.WIPED;}}

    /** Injected HTTP client. Production and tests share {@link #deleteThrough} and {@link #pollThrough}. */
    interface DeletionTransport {
        AccountActions.HttpBody execute(String method,String path,byte[] body,String authorization) throws Exception;
    }

    static final class Exchange {
        final AccountActions.HttpBody body;
        final boolean failed;
        Exchange(AccountActions.HttpBody body,boolean failed){this.body=body;this.failed=failed;}
    }

    static Exchange exchange(DeletionTransport transport,String method,String path,byte[] body,String authorization){
        try{return new Exchange(transport.execute(method,path,body,authorization),false);}
        catch(Exception error){return new Exchange(null,true);}
    }

    void deleteThrough(DeletionTransport transport,String authorization){
        completeDelete(exchange(transport,"DELETE","/v2/account",AccountActions.CONFIRM_BODY,authorization));
    }

    void completeDelete(Exchange exchange){
        if(!allowsDelete())return;
        noteDeleteSent();
        if(exchange==null||exchange.failed||exchange.body==null){
            plainError=false;
            lastBody=null;
            fail("Account deletion did not start. You can retry.");
            return;
        }
        lastBody=exchange.body;
        onDeleteHttp(exchange.body.status,exchange.body.jobId,exchange.body.error,exchange.body.statusToken);
    }

    void pollThrough(DeletionTransport transport){
        if(step!=Step.POLLING)return;
        AccountActions.PollCall call=AccountActions.pollCall(statusPath,statusToken);
        if(call==null){
            plainError=false;
            fail("Could not read deletion status. You can retry.");
            return;
        }
        completePoll(exchange(transport,"GET",call.path,null,call.authorization));
    }

    void completePoll(Exchange exchange){
        if(step!=Step.POLLING)return;
        if(exchange==null||exchange.failed||exchange.body==null){
            plainError=false;
            lastBody=null;
            wipe=false;
            fail("Could not read deletion status. You can retry.");
            return;
        }
        lastBody=exchange.body;
        onPollHttp(exchange.body.status,exchange.body.jobStatus,exchange.body.error,exchange.body.retryable);
    }
}

/**
 * Replaces a file only in this order: upload the new chunks, PUT the manifest with ifGeneration
 * (on 412, refetch and retry), delete the old chunks, then trash the local original.
 * Mobile uploads are raw bytes with {@code X-Chunk-SHA256}. Chunks are not sealed.
 */
final class FileReplacement {
    static final class Conflict extends Exception {
        final long generation;
        Conflict(long generation){this.generation=generation;}
    }
    interface Store {
        void uploadChunks(String objectId) throws Exception;
        long putManifest(long ifGeneration,String objectId) throws Exception;
        long refetchGeneration() throws Exception;
        void deleteOldChunks(String objectId) throws Exception;
        void trashLocalOriginal() throws Exception;
    }
    static final class Manifest {
        String objectId;
        long generation;
        boolean oldReadable=true;
        boolean localTrashed;
    }
    private FileReplacement(){}
    static void replace(Store store,Manifest manifest,String newObjectId) throws Exception {
        String oldId=manifest.objectId;
        store.uploadChunks(newObjectId);
        long generation=manifest.generation;
        boolean committed=false;
        for(int attempt=0;attempt<2&&!committed;attempt++){
            try{
                long next=store.putManifest(generation,newObjectId);
                manifest.objectId=newObjectId;
                manifest.generation=next;
                committed=true;
            }catch(Conflict conflict){
                generation=store.refetchGeneration();
            }
        }
        if(!committed)return;
        try{
            store.deleteOldChunks(oldId);
            manifest.oldReadable=false;
        }catch(Exception error){
            manifest.objectId=oldId;
            manifest.oldReadable=true;
            return;
        }
        store.trashLocalOriginal();
        manifest.localTrashed=true;
    }
}

/** Documented client helpers that do not open a connection. */
final class AccountActions {
    static final String CONFIRM_JSON="{\"confirm\":\"DELETE\"}";
    static final String CONFIRM_TYPE="application/json";
    static final byte[] CONFIRM_BODY=CONFIRM_JSON.getBytes(java.nio.charset.StandardCharsets.UTF_8);

    static final class HttpBody {
        final int status;
        final String raw;
        final String error;
        final String jobId;
        /** JSON {@code status}. This is not the HTTP status. */
        final String jobStatus;
        final Boolean retryable;
        final String statusToken;
        HttpBody(int status,String raw,String error,String jobId,String jobStatus,Boolean retryable,String statusToken){
            this.status=status;this.raw=raw==null?"":raw;this.error=error;this.jobId=jobId;this.jobStatus=jobStatus;this.retryable=retryable;this.statusToken=statusToken;
        }
    }

    static final class PollCall {
        final String method="GET";
        final String path;
        final String authorization;
        PollCall(String path,String authorization){this.path=path;this.authorization=authorization;}
        /** Safe to log. The status token is never included. */
        String describeForLog(){return method+" "+path+" Authorization: Bearer [redacted]";}
    }

    private AccountActions(){}

    /** The only deletion status route. It is plural: {@code GET /v2/account/deletions/:jobId}. */
    static final String DELETION_STATUS_PATH="/v2/account/deletions/";

    /** PR #6 sends the machine code in {@code error}. {@code code} is only a fallback. */
    static String errorCode(String raw){
        String error=JsonFields.string(raw,"error");
        if(error!=null&&!error.isEmpty())return error;
        return JsonFields.string(raw,"code");
    }

    static HttpBody parse(int status,String raw){
        try{
            return new HttpBody(status,raw,errorCode(raw),JsonFields.string(raw,"jobId"),JsonFields.string(raw,"status"),JsonFields.bool(raw,"retryable"),JsonFields.string(raw,"statusToken"));
        }catch(RuntimeException error){
            return new HttpBody(status,raw==null?"":raw,null,null,null,null,null);
        }
    }

    static boolean validJob(String jobId){
        if(jobId==null||!jobId.matches("[A-Za-z0-9_-]{1,80}"))return false;
        return !jobId.contains("..")&&!jobId.contains("/")&&!jobId.contains("\\");
    }

    static boolean validToken(String token){
        if(token==null||token.length()<8||token.length()>512)return false;
        for(int i=0;i<token.length();i++){
            char c=token.charAt(i);
            if(c<=' '||c=='"'||c=='\\'||c>=127)return false;
        }
        return true;
    }

    static String encodeJob(String jobId){
        if(!validJob(jobId))return null;
        try{return URLEncoder.encode(jobId,"UTF-8");}
        catch(UnsupportedEncodingException error){return null;}
    }

    static String statusPath(String jobId){
        String encoded=encodeJob(jobId);
        return encoded==null?null:DELETION_STATUS_PATH+encoded;
    }

    static boolean safeAccountPath(String path){
        if(path==null||!path.startsWith(DELETION_STATUS_PATH))return false;
        if(path.contains("/v2/account/deletion/"))return false;
        String rest=path.substring(DELETION_STATUS_PATH.length());
        if(rest.contains("/")||rest.contains("\\")||rest.contains("..")||rest.contains("%"))return false;
        return validJob(rest);
    }

    static PollCall pollCall(String path,String statusToken){
        if(!safeAccountPath(path)||!validToken(statusToken))return null;
        return new PollCall(path,"Bearer "+statusToken);
    }

    static PollCall pollCall(DeletionReceipt receipt){
        if(receipt==null)return null;
        return pollCall(statusPath(receipt.jobId),receipt.statusToken);
    }

    /** {@code POST /v2/workspaces/{sourceId}/merge} with {@code {"targetId","confirmName"}}. */
    static String mergePath(String sourceId){
        if(sourceId==null)return null;
        if(!"free".equals(sourceId)&&!sourceId.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))return null;
        return "/v2/workspaces/"+sourceId+"/merge";
    }

    static String byoVerifyPath(String workspaceId){
        if(workspaceId==null||(!"free".equals(workspaceId)&&!workspaceId.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")))return null;
        return "/v2/workspaces/"+workspaceId+"/byo/verify";
    }

    /** {@code POST /byo/verify} body is {@code {"presignedUrl"}}. Never {@code readBack} or {@code proofUrl}. */
    static String byoVerifyBody(String presignedUrl){
        if(presignedUrl==null||presignedUrl.isEmpty()||presignedUrl.indexOf('"')>=0||presignedUrl.indexOf('\\')>=0)return null;
        return "{\"presignedUrl\":\""+presignedUrl+"\"}";
    }

    static String mergeBody(String targetId,String confirmName){
        if(targetId==null||confirmName==null||confirmName.isEmpty())return null;
        if(!"free".equals(targetId)&&!targetId.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))return null;
        return "{\"targetId\":\""+targetId+"\",\"confirmName\":\""+confirmName.replace("\\","\\\\").replace("\"","\\\"")+"\"}";
    }

    /**
     * Duplicate files are kept as {@code name (from <source>)}.
     * The request itself is {@link #mergePath} and {@link #mergeBody}.
     */
    static String mergeUnavailable(String sourceName){
        String source=sourceName==null||sourceName.isEmpty()?"workspace":sourceName;
        return "Duplicates are kept as name (from "+source+").";
    }
}

/** Job id, status token, and the account uid that started the job. The token is never written into a log line. */
final class DeletionReceipt {
    final String jobId;
    final String statusToken;
    /** Firebase uid of the account being deleted. Not a secret. Empty when an older receipt has none. */
    final String accountUid;
    private DeletionReceipt(String jobId,String statusToken,String accountUid){
        this.jobId=jobId;this.statusToken=statusToken;this.accountUid=accountUid==null?"":accountUid;
    }
    static DeletionReceipt of(String jobId,String statusToken){return of(jobId,statusToken,"");}
    static DeletionReceipt of(String jobId,String statusToken,String accountUid){
        if(!AccountActions.validJob(jobId)||!AccountActions.validToken(statusToken))return null;
        return new DeletionReceipt(jobId,statusToken,accountUid);
    }
    @Override public String toString(){return "DeletionReceipt("+jobId+")";}
}

/** In-memory stand-in for the keystore-backed receipt. Tests use this. Production uses {@link DeletionReceiptVault}. */
final class DeletionReceiptMemory {
    private final Map<String,String> values=new LinkedHashMap<>();
    void save(DeletionReceipt receipt){
        if(receipt==null)return;
        values.put("jobId",receipt.jobId);
        values.put("statusToken",receipt.statusToken);
        values.put("accountUid",receipt.accountUid==null?"":receipt.accountUid);
    }
    DeletionReceipt read(){return DeletionReceipt.of(values.get("jobId"),values.get("statusToken"),values.get("accountUid"));}
    void clear(){values.clear();}
    boolean containsToken(String token){return token!=null&&token.equals(values.get("statusToken"));}
}

/**
 * Google re-sign-in for account deletion. The Google account id and email are checked
 * before {@code signInWithCredential}. A Google subject is not a Firebase uid, so the
 * subject is compared only with a saved Google id. The Firebase uid on the receipt is
 * what a resumed job checks after the credential exchange.
 */
final class DeletionSignIn {
    private DeletionSignIn(){}

    static String claim(String jwt,String key){
        if(jwt==null||key==null)return null;
        String[] parts=jwt.split("\\.");
        if(parts.length<2)return null;
        try{
            byte[] json=java.util.Base64.getUrlDecoder().decode(pad(parts[1]));
            return JsonFields.string(new String(json,java.nio.charset.StandardCharsets.UTF_8),key);
        }catch(RuntimeException error){return null;}
    }

    /**
     * True when {@code signInWithCredential} must not be called.
     * An email mismatch, or a Google id mismatch against the saved Google id, blocks the call.
     */
    static boolean blocksCredential(String expectedGoogleId,String expectedEmail,String googleId,String googleEmail){
        boolean emailKnown=expectedEmail!=null&&!expectedEmail.isEmpty();
        boolean idKnown=expectedGoogleId!=null&&!expectedGoogleId.isEmpty();
        if(emailKnown&&(googleEmail==null||!expectedEmail.equalsIgnoreCase(googleEmail)))return true;
        if(idKnown&&(googleId==null||!expectedGoogleId.equals(googleId)))return true;
        return false;
    }

    /** The uid stored with the job wins over whoever happens to be signed in after a restart. */
    static String ownerUid(DeletionReceipt receipt,String signedInUid){
        if(receipt!=null&&receipt.accountUid!=null&&!receipt.accountUid.isEmpty())return receipt.accountUid;
        return signedInUid==null?"":signedInUid;
    }

    static boolean switchedAccount(String expectedUid,String signedUid){
        if(expectedUid==null||expectedUid.isEmpty())return false;
        return signedUid==null||!expectedUid.equals(signedUid);
    }

    /** Cancel must not open the library of an account that replaced the one being deleted. */
    static boolean cancelOpensLibrary(boolean foreignSession){return !foreignSession;}

    private static String pad(String value){
        int mod=value.length()%4;
        return mod==0?value:value+"====".substring(mod);
    }
}
