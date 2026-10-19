package app.gendragoon.cloudssd.mobile;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class AboutTest {
    @Test public void ownershipCopyIsExact(){
        assertEquals("Gendragoon is developed and maintained by Red-XAI LLC. Red-XAI LLC is wholly owned by GRIM-VIRUS, an independent recording artist who leads development under the alias MainDirectory. © Red-XAI LLC. All rights reserved.",About.OWNERSHIP);
        assertEquals("© Red-XAI LLC",About.COPYRIGHT);
        assertEquals("Red-XAI LLC",About.PUBLISHER);
    }
}
