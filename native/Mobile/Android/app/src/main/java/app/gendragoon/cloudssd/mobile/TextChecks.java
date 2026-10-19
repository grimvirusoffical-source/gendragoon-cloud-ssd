package app.gendragoon.cloudssd.mobile;

/** {@link String#isBlank()} requires API 33. This follows the same code-point whitespace rules. */
final class TextChecks {
    private TextChecks() {}

    static boolean isBlank(String value) {
        int index = 0;
        int length = value.length();
        while (index < length) {
            int codePoint = value.codePointAt(index);
            if (!Character.isWhitespace(codePoint)) return false;
            index += Character.charCount(codePoint);
        }
        return true;
    }
}
