package app.gendragoon.cloudssd.mobile;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;

/** Form-encodes with UTF-8 using the API 1 overload. The {@code Charset} overload requires API 33. */
final class Utf8Url {
    private Utf8Url() {}

    static String encode(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8");
        } catch (UnsupportedEncodingException error) {
            throw new IllegalStateException("UTF-8 is required", error);
        }
    }
}
