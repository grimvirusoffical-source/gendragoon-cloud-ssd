package app.gendragoon.cloudssd.mobile;

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
}
