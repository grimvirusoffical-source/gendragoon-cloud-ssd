package app.gendragoon.cloudssd.mobile;

import org.junit.Test;

import static org.junit.Assert.assertFalse;

/** Release-flavor check. Fails while the shared-core placeholder is still installed. */
public final class SupportContactReleaseTest {
    @Test public void releaseBuildRejectsPlaceholderSupportContact(){
        assertFalse("RELEASE BLOCKER: replace SupportContact.ADDRESS with packages/core SUPPORT_CONTACT before shipping",SupportContact.IS_PLACEHOLDER);
    }
}
