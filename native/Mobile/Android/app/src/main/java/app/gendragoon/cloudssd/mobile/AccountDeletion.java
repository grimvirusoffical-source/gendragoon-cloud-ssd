package app.gendragoon.cloudssd.mobile;

/**
 * Account-deletion state machine. The server contract is not merged yet and is documented on
 * {@link AccountActions}: a fresh sign-in from the last five minutes, {@code DELETE /v2/account}
 * returning {@code 202 {"jobId"}}, then {@code queued | running | done | failed}.
 */
final class AccountDeletion {
    enum Step { EXPLAIN, CONFIRM, REAUTH, DELETING, POLLING, DONE, FAILED, WIPED }

    static final String CONFIRM_PHRASE="DELETE";
    static final long FRESH_SIGN_IN_MS=CloudSignals.FRESH_SIGN_IN_MS;
    static final int POLL_LIMIT=90;

    Step step=Step.EXPLAIN;
    String message;
    String jobId;
    String statusPath;
    int deleteAttempts;
    int staleRetries;
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
        step=Step.DELETING;
        message=null;
        return true;
    }

    void noteDeleteSent(){deleteAttempts++;}

    void onDeleteHttp(int status,String jobId,String statusUrl,String errorCode){
        if(step!=Step.DELETING)return;
        if(status==202&&AccountActions.validJob(jobId)){
            this.jobId=jobId;
            this.statusPath=AccountActions.statusPath(jobId,statusUrl);
            step=Step.POLLING;
            message=null;
            return;
        }
        if(status==404||status==410){succeed();return;}
        if(status==401){
            if(AccountActions.staleSession(errorCode)&&deleteAttempts<=1&&staleRetries==0){
                staleRetries=1;
                step=Step.REAUTH;
                message="Sign in again. The server only accepts a sign-in from the last 5 minutes.";
                return;
            }
            succeed();
            return;
        }
        fail("Account deletion did not start. You can retry.");
    }

    void onPollHttp(int status,String state){
        if(step!=Step.POLLING)return;
        if(status==401){succeed();return;}
        if(status>=200&&status<300){
            if("queued".equals(state)||"running".equals(state)){step=Step.POLLING;return;}
            if("done".equals(state)){succeed();return;}
            if("failed".equals(state)){fail("Account deletion failed. You can retry.");return;}
        }
        fail("Could not read deletion status. You can retry.");
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
        staleRetries=0;
        polls=0;
        wipe=false;
        wiped=false;
    }

    void noteWiped(){if(step==Step.DONE){wiped=true;step=Step.WIPED;}}

    private void succeed(){step=Step.DONE;wipe=true;message=null;}
}

/** Documented client helpers that do not open a connection. */
final class AccountActions {
    static final String ORIGIN="https://gendragoon-free-10068843866.us-central1.run.app";

    static final class HttpBody {
        final int status;
        final String raw;
        final String error;
        final String jobId;
        final String statusUrl;
        final String state;
        HttpBody(int status,String raw,String error,String jobId,String statusUrl,String state){
            this.status=status;this.raw=raw==null?"":raw;this.error=error;this.jobId=jobId;this.statusUrl=statusUrl;this.state=state;
        }
    }

    private AccountActions(){}

    static HttpBody parse(int status,String raw){
        return new HttpBody(status,raw,JsonFields.string(raw,"error"),JsonFields.string(raw,"jobId"),JsonFields.string(raw,"statusUrl"),JsonFields.string(raw,"state"));
    }

    static boolean validJob(String jobId){return jobId!=null&&jobId.matches("[A-Za-z0-9_-]{1,80}");}

    static boolean staleSession(String errorCode){
        return "session_stale".equals(errorCode)||"auth_too_old".equals(errorCode)||"signin_too_old".equals(errorCode);
    }

    /**
     * Poll path when {@code DELETE /v2/account} returns only {@code jobId}. A statusUrl is followed
     * only when it is already a {@code /v2/account/} path or an https URL on the cloud origin.
     */
    static String statusPath(String jobId,String statusUrl){
        String fallback="/v2/account/deletions/"+jobId;
        if(statusUrl==null||statusUrl.isEmpty())return fallback;
        String path=statusUrl;
        if(path.startsWith(ORIGIN+"/"))path=path.substring(ORIGIN.length());
        if(safeAccountPath(path))return path;
        return fallback;
    }

    static boolean safeAccountPath(String path){
        return path!=null&&path.startsWith("/v2/account/")&&!path.contains("..")&&!path.contains("\\")&&!path.contains(" ")&&!path.contains("@")&&!path.contains("?");
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
