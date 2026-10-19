package app.gendragoon.cloudssd.mobile;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class ThemeTest {
    private static void aa(String name,int fg,int bg){
        double ratio=Theme.contrast(fg,bg);
        assertTrue(name+" "+ratio,ratio>=4.5);
    }
    @Test public void textPairsMeetAA(){
        aa("text/bg",Theme.TEXT,Theme.BG);
        aa("text/surface",Theme.TEXT,Theme.SURFACE);
        aa("muted/bg",Theme.MUTED,Theme.BG);
        aa("muted/surface",Theme.MUTED,Theme.SURFACE);
        aa("kicker/bg",Theme.KICKER,Theme.BG);
        aa("warn",Theme.WARN_TEXT,Theme.WARN_BG);
        aa("disabled",Theme.DISABLED_TEXT,Theme.DISABLED_BG);
        for(Theme.Tone tone:Theme.Tone.values())aa(tone.name(),Theme.foreground(tone),Theme.background(tone));
    }
    @Test public void dangerIsSoftNotASolidSlab(){
        assertTrue(Theme.contrast(Theme.DANGER_BG,Theme.SURFACE)<1.5);
        assertTrue(Theme.contrast(Theme.DANGER_BORDER,Theme.DANGER_BG)>=1.5);
    }
    @Test public void touchTargetsAre48dp(){assertEquals(48,Theme.TOUCH_DP);}
    @Test public void matchesExpoPalette(){
        assertEquals(0xFF6D4AFF,Theme.PRIMARY);
        assertEquals(0xFF100E17,Theme.BG);
        assertEquals(0xFFB3ADC4,Theme.MUTED);
        assertEquals(0xFFFFC2D1,Theme.DANGER_TEXT);
    }
}
