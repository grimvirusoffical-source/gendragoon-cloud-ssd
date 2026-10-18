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
        fail("Account deletion did not start. You can retry.");
    }

    void onPollHttp(int status,String jobStatus,String errorCode,Boolean retryable){
        if(step!=Step.POLLING)return;
        if(status==423&&CloudSignals.CODE_LOCK.equals(errorCode)){wipe=false;return;}
        if(status==401){onUnauthorized(errorCode);return;}
        if(status==404){
            wipe=false;
            refuseDelete=true;
            dropReceipt=true;
            this.jobId=null;
            this.statusToken=null;
            this.statusPath=null;
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
        if(errorCode==null||errorCode.isEmpty()||"invalid_token".equals(errorCode)){
            step=Step.SIGNED_OUT;
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
        if(step!=Step.FAILED||refuseDelete)return;
        wipe=false;
        message=null;
        polls=0;
        if(AccountActions.validJob(jobId)&&AccountActions.validToken(statusToken)){
            statusPath=AccountActions.statusPath(jobId);
            step=Step.POLLING;
            dropReceipt=false;
            return;
        }
        jobId=null;
        statusToken=null;
        statusPath=null;
        step=Step.REAUTH;
    }

    void noteWiped(){if(step==Step.DONE&&wipe){wiped=true;step=Step.WIPED;}}
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

/** Job id plus the single-job status token. The token is never written into a log line. */
final class DeletionReceipt {
    final String jobId;
    final String statusToken;
    private DeletionReceipt(String jobId,String statusToken){this.jobId=jobId;this.statusToken=statusToken;}
    static DeletionReceipt of(String jobId,String statusToken){
        if(!AccountActions.validJob(jobId)||!AccountActions.validToken(statusToken))return null;
        return new DeletionReceipt(jobId,statusToken);
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
    }
    DeletionReceipt read(){return DeletionReceipt.of(values.get("jobId"),values.get("statusToken"));}
    void clear(){values.clear();}
    boolean containsToken(String token){return token!=null&&token.equals(values.get("statusToken"));}
}
