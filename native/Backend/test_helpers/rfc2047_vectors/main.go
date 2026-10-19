// Writes ../rfc2047_go_vectors.json: what Go's mime.QEncoding, mime.BEncoding and mail.Address produce for
// the subjects and names below. The Rotten Apple mailer uses these encoders; support_email.test.js checks that
// the Node port produces the same bytes. Regenerate with: (cd test_helpers/rfc2047_vectors && go run . > ../rfc2047_go_vectors.json)
package main

import (
	"encoding/json"
	"mime"
	"net/mail"
	"os"
	"strings"
)

func main() {
	in := []string{
		"Reset your GenDragoon password",
		"tab\tseparated",
		"Café",
		"Grüße aus Köln: Ihr Passwort zurücksetzen",
		strings.Repeat("ü", 40),
		strings.Repeat("a", 62) + "ü",
		strings.Repeat("a", 61) + "€x",
		"日本語のパスワードをリセットしてください。日本語のパスワードをリセットしてください。",
		"emoji 🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉 dragon",
		"= ? _ mixed é",
		strings.Repeat("x", 80) + "é",
		"Ünïcödé, with (specials)",
		strings.Repeat("Ü.", 40),
	}
	type V struct{ In, Q, B, Addr string }
	var out []V
	for _, s := range in {
		out = append(out, V{s, mime.QEncoding.Encode("utf-8", s), mime.BEncoding.Encode("utf-8", s), (&mail.Address{Name: s, Address: "support@infected-nation.com"}).String()})
	}
	json.NewEncoder(os.Stdout).Encode(out)
}
