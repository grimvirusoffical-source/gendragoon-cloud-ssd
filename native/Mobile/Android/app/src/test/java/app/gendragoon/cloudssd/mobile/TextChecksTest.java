package app.gendragoon.cloudssd.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public final class TextChecksTest {
    @Test public void matchesStringIsBlank() {
        String[] samples = {"", " ", "\n", "\t", "\u000B", "\f", "\r", "\u001C", "\u2003", "\u00A0", "\u0000", "a", " a ", "  \t\n", "😀", " \uD83D\uDE00 "};
        for (String sample : samples) assertEquals(sample, sample.isBlank(), TextChecks.isBlank(sample));
    }

    @Test public void rejectsNull() {
        assertThrows(NullPointerException.class, () -> TextChecks.isBlank(null));
    }
}
