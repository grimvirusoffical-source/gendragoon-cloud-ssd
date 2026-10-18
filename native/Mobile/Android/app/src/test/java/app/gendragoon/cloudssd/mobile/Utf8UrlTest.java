package app.gendragoon.cloudssd.mobile;

import static org.junit.Assert.assertEquals;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public final class Utf8UrlTest {
    @Test public void matchesCharsetOverload() throws Exception {
        String[] samples = {
            "",
            "abc",
            "a b",
            "a/b",
            "a+b",
            "100%",
            "a&b=c?",
            "cursor-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "uid/with space",
            "ü",
            "你好",
            "\n\t",
            "*",
            "~",
            "emoji 😀"
        };
        for (String sample : samples) {
            assertEquals(URLEncoder.encode(sample, StandardCharsets.UTF_8), Utf8Url.encode(sample));
        }
    }

    @Test(expected = NullPointerException.class)
    public void rejectsNull() {
        Utf8Url.encode(null);
    }
}
