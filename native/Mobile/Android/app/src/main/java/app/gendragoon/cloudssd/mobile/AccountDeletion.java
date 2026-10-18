package app.gendragoon.cloudssd.mobile;

/**
 * Account-deletion state machine. Freshness is the Firebase ID token {@code auth_time} claim.
 * {@code DELETE /v2/account} returns {@code 202 {"jobId"}}. Status is only
 * {@link AccountActions#DELETION_STATUS_PATH}. States are {@code queued | running | done | failed}.
 * A 401 never wipes local keys. Only {@code done} does.
 */
final class AccountDeletion {
    enum Step { EXPLAIN, CONFIRM, REAUTH, DELETING, POLLING, DONE, FAILED, WIPED, SIGNED_OUT }

    static final String CONFIRM_PHRASE="DELETE";
    static final long FRESH_SIGN_IN_MS=CloudSignals.FRESH_SIGN_IN_MS;
    static final int POLL_LIMIT=90;

    Step step=Step.EXPLAIN;
    String message;
    String jobId;
    String statusPath;
    int deleteAttempts;
    int polls;
    boolean wipe;
    boolean wiped;

    void continueFromExplain(){if(step==Step.EXPLAIN)step=Step.CONFIRM;}

    boolean confirmPhrase(String phrase){
        if(step!=Step.CONFIRM||!CONFIRM_PHRASE.equals(phrase))return false;
        step=Step.REAUTH;
        message=null;
        return true;
    }

    /** @return false when the Google sign-in is older than five minutes; the flow stays on re-authentication. */
    boolean acceptFreshSignIn(long authTimeMs,long nowMs){
        if(step!=Step.REAUTH)return false;
        if(authTimeMs<=0||nowMs<authTimeMs||nowMs-authTimeMs>FRESH_SIGN_IN_MS){
            step=Step.REAUTH;
            message="Sign in again. The server only accepts a sign-in from the last 5 minutes.";
            return false;
        }
        step=this.jobId==null?Step.DELETING:Step.POLLING;
        message=null;
        return true;
    }

    void noteDeleteSent(){deleteAttempts++;}

    /** True only after the deletion job reports {@code done}. A 401 never sets this. */
    boolean requestsWipe(){return wipe&&step==Step.DONE;}

    void onDeleteHttp(int status,String jobId,String errorCode){
        if(step!=Step.DELETING)return;
        if(status==401){onUnauthorized(errorCode);return;}
        if(status==202&&AccountActions.validJob(jobId)){
            this.jobId=jobId;
            this.statusPath=AccountActions.statusPath(jobId);
            step=Step.POLLING;
            wipe=false;
            message=null;
            return;
        }
        fail("Account deletion did not start. You can retry.");
    }

    void onPollHttp(int status,String state,String errorCode){
        if(step!=Step.POLLING)return;
        if(status==401){onUnauthorized(errorCode);return;}
        if(status>=200&&status<300){
            if("queued".equals(state)||"running".equals(state)){step=Step.POLLING;wipe=false;return;}
            if("done".equals(state)){step=Step.DONE;wipe=true;message=null;return;}
            if("failed".equals(state)){fail("Account deletion failed. You can retry.");return;}
        }
        fail("Could not read deletion status. You can retry.");
    }

    private void onUnauthorized(String errorCode){
        wipe=false;
        if("invalid_token".equals(errorCode)){
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

    void retry(){
        if(step!=Step.FAILED)return;
        step=Step.EXPLAIN;
        message=null;
        jobId=null;
        statusPath=null;
        deleteAttempts=0;
        polls=0;
        wipe=false;
        wiped=false;
    }

    void noteWiped(){if(step==Step.DONE&&wipe){wiped=true;step=Step.WIPED;}}
}

/** Documented client helpers that do not open a connection. */
final class AccountActions {
    static final class HttpBody {
        final int status;
        final String raw;
        final String error;
        final String jobId;
        final String state;
        HttpBody(int status,String raw,String error,String jobId,String state){
            this.status=status;this.raw=raw==null?"":raw;this.error=error;this.jobId=jobId;this.state=state;
        }
    }

    private AccountActions(){}

    /** The only deletion status route. It is plural: {@code GET /v2/account/deletions/:jobId}. */
    static final String DELETION_STATUS_PATH="/v2/account/deletions/";

    static HttpBody parse(int status,String raw){
        return new HttpBody(status,raw,JsonFields.string(raw,"error"),JsonFields.string(raw,"jobId"),JsonFields.string(raw,"state"));
    }

    static boolean validJob(String jobId){return jobId!=null&&jobId.matches("[A-Za-z0-9_-]{1,80}");}

    static String statusPath(String jobId){return DELETION_STATUS_PATH+jobId;}

    static boolean safeAccountPath(String path){
        if(path==null||!path.startsWith(DELETION_STATUS_PATH))return false;
        return validJob(path.substring(DELETION_STATUS_PATH.length()));
    }

    /**
     * Merge is not final. This does not perform a request.
     * Expected later call: {@code POST /v2/workspaces/{targetId}/merge} with {@code {"sourceId"}}.
     * Duplicate files are kept as {@code name (from <source>)}.
     */
    static String mergeUnavailable(String sourceName){
        String source=sourceName==null||sourceName.isEmpty()?"workspace":sourceName;
        return "Merge isn't available yet. Duplicates are kept as name (from "+source+").";
    }
}
