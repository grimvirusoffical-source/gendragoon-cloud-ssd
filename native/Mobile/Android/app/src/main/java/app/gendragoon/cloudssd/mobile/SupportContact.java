package app.gendragoon.cloudssd.mobile;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;

/**
 * Mirrors {@code packages/core} {@code SUPPORT_CONTACT} in gendragoon-apps.
 * RELEASE BLOCKER until grim supplies the real contact. {@link #IS_PLACEHOLDER} must be false
 * before a release ships. Release CI runs {@code gradle :app:testReleaseUnitTest}, which fails
 * {@code SupportContactReleaseTest} while this flag is true. Debug unit tests only check that
 * the placeholder is still the shared value.
 */
public final class SupportContact {
    /** Shared-core placeholder. Not a deliverable address. */
    public static final String ADDRESS="SUPPORT_CONTACT_PLACEHOLDER@invalid";
    public static final boolean IS_PLACEHOLDER=true;

    private SupportContact(){}

    /** Mailto for the Contact support button. The job id is the subject. */
    public static String mailto(String jobId){
        String id=jobId==null?"":jobId;
        String subject="Account deletion"+(id.isEmpty()?"":" "+id);
        try{return "mailto:"+ADDRESS+"?subject="+URLEncoder.encode(subject,"UTF-8").replace("+","%20");}
        catch(UnsupportedEncodingException error){return "mailto:"+ADDRESS;}
    }
}

/**
 * Contact support for a deletion that cannot be retried. Off until the Discord webhook is
 * configured in production. The only path is {@code POST} {@link #PATH}. There is no request
 * body: no {@code jobId} field, no uid, and no user data. {@code Authorization} is
 * {@code Bearer statusToken}, so this still works while signed out. Riley's {@code d33970c}
 * fixtures in {@code fixtures/account-deletion/} describe the responses.
 */
final class DeletionSupport {
    static final boolean ENABLED=false;
    /** Pinned. {@code POST /v2/account/deletions/:jobId/support-request}. */
    static final String PATH="/v2/account/deletions/%s/support-request";
    static final String SENT="Request sent.";
    static final String ALREADY="Request already sent.";

    enum Kind { SENT, ALREADY, REFRESH, MAILTO, HOLD }

    static final class Call {
        final boolean send;
        final String path;
        final String statusToken;
        /** Always null. The pinned route takes no body. */
        final byte[] body=null;
        private Call(boolean send,String path,String statusToken){this.send=send;this.path=path;this.statusToken=statusToken;}
        static Call mailto(){return new Call(false,null,null);}
        String authorization(){return statusToken==null?null:"Bearer "+statusToken;}
    }

    static final class Result {
        final Kind kind;
        final String requestId;
        final String message;
        Result(Kind kind,String requestId,String message){this.kind=kind;this.requestId=requestId;this.message=message;}
        boolean opensMailto(){return kind==Kind.MAILTO;}
    }

    private DeletionSupport(){}

    static Call call(String jobId,String statusToken){return call(jobId,statusToken,ENABLED);}

    static Call call(String jobId,String statusToken,boolean enabled){
        if(!enabled)return Call.mailto();
        String encoded=AccountActions.encodeJob(jobId);
        if(encoded==null||!AccountActions.validToken(statusToken))return Call.mailto();
        if(encoded.indexOf('/')>=0||encoded.indexOf('\\')>=0||encoded.contains(".."))return Call.mailto();
        return new Call(true,String.format(java.util.Locale.ROOT,PATH,encoded),statusToken);
    }

    /**
     * 202 {@code received} (including a repeat with the same {@code requestId}) shows "Request sent."
     * 409 {@code support_not_needed} refreshes deletion status. 429 shows "Request already sent."
     * and does not open mailto. A 404, a 401 {@code unauthorized}, a 401 with no code, a transport
     * failure, or HTTP 5xx opens mailto and does not ask for sign-in. The account may already be deleted.
     */
    static Result interpret(int status,String raw,boolean transportFailed){
        if(transportFailed||status>=500||status==404||unauthorized(status,raw))return new Result(Kind.MAILTO,null,null);
        String requestId=JsonFields.string(raw,"requestId");
        if(status==202&&"received".equals(JsonFields.string(raw,"status"))&&requestId!=null&&!requestId.isEmpty())return new Result(Kind.SENT,requestId,SENT);
        if(status==409&&"support_not_needed".equals(JsonFields.string(raw,"error")))return new Result(Kind.REFRESH,null,null);
        if(status==429)return new Result(Kind.ALREADY,null,ALREADY);
        return new Result(Kind.HOLD,null,null);
    }

    /** A support-request 401 {@code unauthorized}, or a 401 with no code, matches a 404. */
    private static boolean unauthorized(int status,String raw){
        if(status!=401)return false;
        String code=JsonFields.string(raw,"error");
        if(code==null||code.isEmpty())code=JsonFields.string(raw,"code");
        return code==null||code.isEmpty()||"unauthorized".equals(code);
    }
}
