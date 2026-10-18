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
