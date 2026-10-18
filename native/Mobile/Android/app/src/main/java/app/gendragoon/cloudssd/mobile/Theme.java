package app.gendragoon.cloudssd.mobile;

/**
 * Dark purple tokens shared with the Expo app ({@code gendragoon-apps apps/mobile/src/theme.ts}
 * at {@code f1d3487}). Opaque ARGB so contrast is testable; {@code ThemeTest} checks AA.
 * Translucent Expo tints are flattened onto {@link #SURFACE}.
 */
final class Theme {
    static final int BG=0xFF100E17;
    static final int SURFACE=0xFF1C1828;
    static final int SURFACE_RAISED=0xFF241F34;
    static final int BORDER=0xFF3A3352;
    static final int CARD_BORDER=0xFF322C44;
    static final int TEXT=0xFFF6F3FB;
    static final int MUTED=0xFFB3ADC4;
    static final int KICKER=0xFFC8B7FF;
    static final int PRIMARY=0xFF6D4AFF;
    static final int PRIMARY_TEXT=0xFFFFFFFF;
    static final int SECONDARY_BG=0xFF2A2142;
    static final int SECONDARY_BORDER=0xFF5B4A99;
    static final int SECONDARY_TEXT=0xFFDDD4FF;
    /** Soft destructive: rose tint and outline, never a solid red slab. */
    static final int DANGER_BG=0xFF2C1A2B;
    static final int DANGER_BORDER=0xFF7A3A52;
    static final int DANGER_TEXT=0xFFFFC2D1;
    static final int WARN_BG=0xFF2E2622;
    static final int WARN_BORDER=0xFF6B5622;
    static final int WARN_TEXT=0xFFFFE3A3;
    /** Disabled: muted surface + muted text, no opacity, so the label keeps AA. */
    static final int DISABLED_BG=SURFACE_RAISED;
    static final int DISABLED_TEXT=MUTED;
    /** Minimum touch target in dp. */
    static final int TOUCH_DP=48;

    enum Tone { PRIMARY, SECONDARY, DANGER }

    private Theme(){}

    static int background(Tone tone){return tone==Tone.PRIMARY?PRIMARY:tone==Tone.DANGER?DANGER_BG:SECONDARY_BG;}
    static int foreground(Tone tone){return tone==Tone.PRIMARY?PRIMARY_TEXT:tone==Tone.DANGER?DANGER_TEXT:SECONDARY_TEXT;}
    static int stroke(Tone tone){return tone==Tone.PRIMARY?PRIMARY:tone==Tone.DANGER?DANGER_BORDER:SECONDARY_BORDER;}

    static double contrast(int fg,int bg){
        double a=luminance(fg),b=luminance(bg);
        return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
    }
    private static double luminance(int argb){
        double[] c={(argb>>16&0xFF)/255.0,(argb>>8&0xFF)/255.0,(argb&0xFF)/255.0};
        for(int i=0;i<3;i++)c[i]=c[i]<=0.03928?c[i]/12.92:Math.pow((c[i]+0.055)/1.055,2.4);
        return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2];
    }
}
