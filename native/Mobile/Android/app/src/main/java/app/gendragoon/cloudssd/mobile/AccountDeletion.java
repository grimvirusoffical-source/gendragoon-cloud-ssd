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
    static final String STILL_IN_PROGRESS="Your deletion is still in progress.";

    Step step=Step.EXPLAIN;
    String message;
    String jobId;
    String statusToken;
    String statusPath;
    int deleteAttempts;
    int polls;
    boolean wipe;
    boolean wiped;
    /** Retry must send DELETE again, even when a job and status token are already saved. */
    boolean repeatDelete;
    /** Non-retryable failure. The screen shows {@link SupportContact#ADDRESS} next to Dismiss. */
    boolean showSupport;
    /** Dismiss clears the saved job and wipes nothing. */
    boolean dismissible;
    /** Dismiss already cleared the job. Retry must not send DELETE after that. */
    boolean closed;
    /** Clear the saved job and token without erasing the rest of the device. */
    boolean dropReceipt;
    /** An owner-token {@code invalid_token} cleared the Firebase session. Polling may continue. */
    boolean clearSession;
    /** A DELETE 404 with no saved job. Show the error without Retry. */
    boolean plainError;
    AccountActions.HttpBody lastBody;
    /** A support 409 asked for a status refresh. If that refresh fails, fall back to mailto. */
    boolean supportRefresh;
    /** Set when a failed support refresh needs the screen to open the mailto fallback once. */
    boolean openSupportMailto;

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
        if(repeatDelete){
            step=Step.DELETING;
            message=null;
            return true;
        }
        if(beginPolling(jobId,statusToken))return true;
        if(jobId!=null||statusToken!=null){
            fail("A saved deletion is already in progress. DELETE was not sent again.");
            return false;
        }
        step=Step.DELETING;
        message=null;
        return true;
    }

    /** DELETE when nothing is saved, or when Retry asked to send it again for a saved job. */
    boolean allowsDelete(){return step==Step.DELETING&&(repeatDelete||(jobId==null&&statusToken==null));}

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
        if(status==409&&"deletion_not_retryable".equals(errorCode)){noteNotRetryable(jobId);return;}
        if(status==202&&beginPolling(jobId,statusToken))return;
        if(status==404&&this.jobId==null&&this.statusToken==null){
            plainError=true;
            fail("Account deletion did not start. Nothing on this device was erased.");
            return;
        }
        plainError=false;
        showSupport=false;
        fail("Account deletion did not start. You can retry.");
    }

    /** Polling continues after an owner-token sign-out that kept a status token. A status-token {@code invalid_token} stops it. */
    boolean keepsPolling(){return step==Step.POLLING||(step==Step.SIGNED_OUT&&jobId!=null&&statusToken!=null&&!statusToken.isEmpty());}

    void onPollHttp(int status,String jobStatus,String errorCode,Boolean retryable){
        onPollHttp(status,jobStatus,errorCode,retryable,null);
    }

    void onPollHttp(int status,String jobStatus,String errorCode,Boolean retryable,String reportedJobId){
        if(!keepsPolling())return;
        plainError=false;
        showSupport=false;
        if(status==423&&CloudSignals.CODE_LOCK.equals(errorCode)){wipe=false;return;}
        if(status==401){onUnauthorized(errorCode);return;}
        if(status==404){
            // Keep the saved job and token. Retry sends DELETE again. Dismiss clears the job.
            wipe=false;
            dismissible=true;
            dropReceipt=false;
            fail("This deletion could not be confirmed. Nothing on this device was erased.");
            return;
        }
        if(status==409&&"deletion_not_retryable".equals(errorCode)){noteNotRetryable(reportedJobId);return;}
        if(status>=200&&status<300){
            if("queued".equals(jobStatus)||"running".equals(jobStatus)){if(step!=Step.SIGNED_OUT)step=Step.POLLING;wipe=false;return;}
            if("done".equals(jobStatus)){step=Step.DONE;wipe=true;message=null;return;}
            if("failed".equals(jobStatus)){
                if(Boolean.FALSE.equals(retryable)){
                    showSupport=true;
                    dismissible=true;
                    dropReceipt=false;
                    fail("Account deletion failed and cannot be resumed. Nothing on this device was erased.");
                }else fail("Account deletion failed. You can retry.");
                return;
            }
            // Anything else, including "completed", stops now. Do not poll until the timeout.
            fail("Account deletion reported an unknown status. Nothing on this device was erased.");
            return;
        }
        wipe=false;
        dismissible=false;
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
        repeatDelete=false;
        showSupport=false;
        dismissible=false;
        message=null;
        return true;
    }

    /** A support 409 {@code support_not_needed} polls the saved job again. Nothing is wiped. */
    boolean refreshAfterSupport(){
        if(!AccountActions.validJob(jobId)||!AccountActions.validToken(statusToken))return false;
        return beginPolling(jobId,statusToken);
    }

    /**
     * Applies a support-request result. Returns true when the screen should open the mailto fallback.
     * A 404 does that and does not move to sign-in. The account may already be deleted.
     */
    boolean applySupport(DeletionSupport.Result result){
        if(result==null)return false;
        if(result.kind==DeletionSupport.Kind.SENT||result.kind==DeletionSupport.Kind.ALREADY){
            message=result.message;
            return false;
        }
        if(result.kind==DeletionSupport.Kind.REFRESH){
            if(!refreshAfterSupport()){supportFallback();return true;}
            supportRefresh=true;
            return false;
        }
        if(result.opensMailto()){supportFallback();return true;}
        return false;
    }

    /** Mailto fallback for a support request. Stays on the failure screen; never moves to sign-in. */
    private void supportFallback(){
        supportRefresh=false;
        showSupport=true;
        dismissible=true;
        dropReceipt=false;
        wipe=false;
        if(step!=Step.FAILED||message==null)fail("We couldn't reach support. Email us and we'll finish deleting your account.");
    }

    /** A non-retryable failure keeps the job until Dismiss. Dismiss wipes nothing. */
    private void noteNotRetryable(String reportedJobId){
        if(AccountActions.validJob(reportedJobId))this.jobId=reportedJobId;
        showSupport=true;
        dismissible=true;
        dropReceipt=false;
        repeatDelete=false;
        wipe=false;
        fail("This deletion cannot be retried. Nothing on this device was erased.");
    }

    private void onUnauthorized(String errorCode){
        wipe=false;
        plainError=false;
        boolean polling=step==Step.POLLING||(step==Step.SIGNED_OUT&&keepsPolling());
        if(polling&&"invalid_token".equals(errorCode)){
            // A rejected status token stops polling and asks for a new DELETE.
            // Only a Firebase/owner-token invalid_token signs out and keeps polling.
            showResignIn();
            return;
        }
        if(polling&&(errorCode==null||errorCode.isEmpty()||"unauthorized".equals(errorCode)||"reauth_required".equals(errorCode))){
            // A status GET 401 unauthorized, or a 401 with no code, means reauth_required.
            requireReauth();
            return;
        }
        if("invalid_token".equals(errorCode)){
            clearSession=true;
            repeatDelete=false;
            if(AccountActions.validJob(jobId)&&AccountActions.validToken(statusToken)){
                dropReceipt=false;
                step=Step.SIGNED_OUT;
                message="Deleting your account…";
                return;
            }
            step=Step.SIGNED_OUT;
            message="Sign in again to continue.";
            return;
        }
        if(errorCode==null||errorCode.isEmpty()){
            step=Step.REAUTH;
            message="Sign in again to continue.";
            return;
        }
        step=Step.REAUTH;
        message="Sign in again. The server only accepts a sign-in from the last 5 minutes.";
    }

    /** Status GET 401 unauthorized, or a 401 with no code. Stay on the deletion screen and re-sign-in. */
    private void requireReauth(){
        clearSession=false;
        dropReceipt=false;
        repeatDelete=false;
        showSupport=false;
        dismissible=false;
        wipe=false;
        step=Step.REAUTH;
        message="Sign in again. The server only accepts a sign-in from the last 5 minutes.";
    }

    /** Re-sign-in stays on the deletion screen. The next fresh sign-in sends DELETE again. */
    private void showResignIn(){
        clearSession=false;
        dropReceipt=false;
        repeatDelete=true;
        showSupport=false;
        dismissible=false;
        wipe=false;
        step=Step.REAUTH;
        message="Sign in again to continue.";
    }

    boolean exhausted(){return polls>=POLL_LIMIT;}

    long nextPollDelayMillis(){
        long delay=1000L<<Math.min(polls,3);
        polls++;
        return delay;
    }

    void fail(String text){step=Step.FAILED;wipe=false;message=text==null?"Account deletion did not finish. You can retry.":text;}

    /** Re-authenticate when needed, then send DELETE again and poll the job from 202 or 410. */
    void retry(){
        if(!offersRetry())return;
        wipe=false;
        message=null;
        polls=0;
        dismissible=false;
        repeatDelete=true;
        step=Step.REAUTH;
    }

    /** Failed responses offer Retry, except a non-retryable failure and a DELETE 404 that never saved a job. */
    boolean offersRetry(){return step==Step.FAILED&&!plainError&&!showSupport&&!closed;}

    /** True when Dismiss should clear the saved job without wiping the device. */
    boolean canDismiss(){return step==Step.FAILED&&dismissible&&!closed;}

    /**
     * The user dismissed the 404 error. Clears the saved pair and wipes nothing.
     * The pair is otherwise cleared only after {@code done}.
     */
    boolean dismissError(){
        if(!canDismiss())return false;
        wipe=false;
        dropReceipt=true;
        closed=true;
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
        if(!keepsPolling())return;
        AccountActions.PollCall call=AccountActions.pollCall(statusPath,statusToken);
        if(call==null){
            plainError=false;
            fail("Could not read deletion status. You can retry.");
            return;
        }
        completePoll(exchange(transport,"GET",call.path,null,call.authorization));
    }

    void completePoll(Exchange exchange){
        if(!keepsPolling())return;
        if(supportRefresh){
            boolean ok=exchange!=null&&!exchange.failed&&exchange.body!=null&&exchange.body.status>=200&&exchange.body.status<300;
            String refreshed=ok?exchange.body.jobStatus:null;
            supportRefresh=false;
            if(ok&&("running".equals(refreshed)||"queued".equals(refreshed))){
                // Still running: no mailto and no error.
                lastBody=exchange.body;
                onPollHttp(exchange.body.status,refreshed,exchange.body.error,exchange.body.retryable,exchange.body.jobId);
                message=STILL_IN_PROGRESS;
                return;
            }
            if(ok&&"done".equals(refreshed)){lastBody=exchange.body;onPollHttp(exchange.body.status,refreshed,exchange.body.error,exchange.body.retryable,exchange.body.jobId);return;}
            // failed, an invalid status body, a non-2xx or a transport failure: mailto.
            {
                lastBody=exchange==null?null:exchange.body;
                supportFallback();
                openSupportMailto=true;
                return;
            }
        }
        if(exchange==null||exchange.failed||exchange.body==null){
            plainError=false;
            lastBody=null;
            wipe=false;
            fail("Could not read deletion status. You can retry.");
            return;
        }
        lastBody=exchange.body;
        onPollHttp(exchange.body.status,exchange.body.jobStatus,exchange.body.error,exchange.body.retryable,exchange.body.jobId);
    }
}

/**
 * Matches Expo {@code ENCRYPTED_WORKSPACE_ENABLED}. Off until native adopts the shared sealed
 * manifest and the {@code packages/core/test/vectors/manifest-merge/} vectors. File replace is
 * the only encrypted-workspace write path on mobile, and it stays off with this flag.
 */
final class EncryptedWorkspace {
    static final boolean ENCRYPTED_WORKSPACE_ENABLED=false;
    private EncryptedWorkspace(){}
}

/**
 * Replaces a file only when {@link EncryptedWorkspace#ENCRYPTED_WORKSPACE_ENABLED} is on:
 * upload the new chunks, PUT the manifest once with ifGeneration, delete the old chunks, then
 * trash the local original. A 412 stops. The new chunks stay, the old chunks stay, and the local
 * original stays. There is no second PUT and no refetch. Mobile uploads are raw bytes with
 * {@code X-Chunk-SHA256}. This is not the shared sealed manifest.
 */
final class FileReplacement {
    static final String CHANGED_ON_ANOTHER_DEVICE="changed on another device, retry";
    static final class Conflict extends Exception {
        final long generation;
        Conflict(long generation){this.generation=generation;}
    }
    /** Recoverable. The caller may try the replace again later. Nothing remote was overwritten. */
    static final class ChangedOnAnotherDevice extends Exception {
        ChangedOnAnotherDevice(){super(CHANGED_ON_ANOTHER_DEVICE);}
    }
    static final class Disabled extends Exception {
        Disabled(){super("Encrypted workspace writes are off.");}
    }
    interface Store {
        void uploadChunks(String objectId) throws Exception;
        long putManifest(long ifGeneration,String objectId) throws Exception;
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
        replace(store,manifest,newObjectId,EncryptedWorkspace.ENCRYPTED_WORKSPACE_ENABLED);
    }
    static void replace(Store store,Manifest manifest,String newObjectId,boolean enabled) throws Exception {
        if(!enabled)throw new Disabled();
        String oldId=manifest.objectId;
        store.uploadChunks(newObjectId);
        try{
            long next=store.putManifest(manifest.generation,newObjectId);
            manifest.objectId=newObjectId;
            manifest.generation=next;
        }catch(Conflict conflict){
            manifest.objectId=oldId;
            manifest.oldReadable=true;
            manifest.localTrashed=false;
            throw new ChangedOnAnotherDevice();
        }
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

    /** A non-empty {@code error} string wins. Otherwise {@code code}. No pattern check on either. */
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

    /** Non-empty only. No length or character-set check. */
    static boolean validJob(String jobId){
        return jobId!=null&&!jobId.isEmpty();
    }

    /** Non-empty only. No length or character-set check. Redacted fixture tokens such as {@code <redacted>} stay valid. */
    static boolean validToken(String token){
        return token!=null&&!token.isEmpty();
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
        return !rest.isEmpty()&&!rest.contains("/")&&!rest.contains("\\");
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
