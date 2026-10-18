package app.gendragoon.cloudssd.mobile;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class LocalDataWipeTest {
    @Test public void accountWipeRemovesCheckpointsAndByoSecrets(){
        assertTrue(LocalDataWipe.accountWipeClears("gd-transfer-checkpoints"));
        assertTrue(LocalDataWipe.accountWipeClears("gd-settings"));
        assertTrue(LocalDataWipe.accountWipeClears("gd-byo-credentials"));
        assertTrue(LocalDataWipe.accountWipeClears("gd-inputs"));
        assertTrue(LocalDataWipe.accountWipeClears("gd-downloads"));
        assertTrue(LocalDataWipe.accountWipeClears("gd-folder-inputs"));
        assertTrue(LocalDataWipe.accountWipeClears("exports"));
        assertTrue(LocalDataWipe.accountWipeClears("data-saver"));
        assertTrue(LocalDataWipe.accountWipeClears("gd-byo-gcs"));
        assertFalse(LocalDataWipe.accountWipeClears("unrelated-alias"));
        assertEquals(List.of("gd-byo-gcs"),LocalDataWipe.keystoreAliasesToDelete(List.of("gd-byo-gcs","unrelated-alias")));
    }

    @Test public void lockPauseDoesNotRemoveUploadState(){
        assertTrue(LocalDataWipe.lockPauseDeletes().isEmpty());
        assertFalse(LocalDataWipe.lockPauseClears("gd-transfer-checkpoints"));
        assertFalse(LocalDataWipe.lockPauseClears("gd-inputs"));
        assertFalse(LocalDataWipe.lockPauseClears("gd-downloads"));
        assertFalse(LocalDataWipe.lockPauseClears("gd-folder-inputs"));
    }
}
