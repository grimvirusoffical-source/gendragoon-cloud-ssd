package gendragoon

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"testing"
)

func vectors(t *testing.T) map[string]json.RawMessage {
	raw, err := os.ReadFile("../spec/vectors/v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]json.RawMessage
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func unhex(t *testing.T, s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestVectorsAreCurrent(t *testing.T) {
	want, err := os.ReadFile("../spec/vectors/v1.json")
	if err != nil {
		t.Fatal(err)
	}
	got, err := TestVectors()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(bytes.TrimSpace(want), bytes.TrimSpace(got)) {
		t.Fatal("spec/vectors/v1.json is out of date: go run ./cmd/gd-vectors")
	}
}

func TestVectorEnvelopes(t *testing.T) {
	v := vectors(t)
	for _, name := range []string{"envelopeScrypt", "envelopeArgon2id"} {
		var e struct {
			Passphrase string      `json:"passphrase"`
			MasterKey  string      `json:"masterKey"`
			Envelope   KeyEnvelope `json:"envelope"`
		}
		json.Unmarshal(v[name], &e)
		mk, err := UnwrapMasterKey(&e.Envelope, e.Passphrase)
		if err != nil || hex.EncodeToString(mk) != e.MasterKey {
			t.Fatalf("%s: %v", name, err)
		}
		if _, err := UnwrapMasterKey(&e.Envelope, "wrong passphrase!"); !errors.Is(err, ErrWrongPassphrase) {
			t.Fatalf("%s: wrong passphrase gave %v", name, err)
		}
	}
}

func TestVectorChunkManifestShare(t *testing.T) {
	v := vectors(t)
	var c struct{ FileKey, Plaintext, Nonce, ID, Blob string }
	json.Unmarshal(v["chunk"], &c)
	pt, err := OpenChunk(unhex(t, c.FileKey), c.ID, unhex(t, c.Blob))
	if err != nil || !bytes.Equal(pt, unhex(t, c.Plaintext)) {
		t.Fatal("chunk vector does not open", err)
	}
	tampered := unhex(t, c.Blob)
	tampered[len(tampered)-1] ^= 1
	if _, err := OpenChunk(unhex(t, c.FileKey), c.ID, tampered); !errors.Is(err, ErrCorrupt) {
		t.Fatal("tampered chunk opened")
	}
	var m struct{ MasterKey, DriveName, ManifestKey, PlainManifestKey, Nonce, Plaintext, Sealed string }
	json.Unmarshal(v["manifest"], &m)
	if DriveManifestKey(unhex(t, m.MasterKey), m.DriveName) != m.ManifestKey || DriveManifestKey(nil, m.DriveName) != m.PlainManifestKey {
		t.Fatal("manifest key mismatch")
	}
	got, err := OpenManifest(unhex(t, m.MasterKey), m.ManifestKey, unhex(t, m.Sealed))
	if err != nil || string(got) != m.Plaintext {
		t.Fatal("manifest vector does not open", err)
	}
	if _, err := OpenManifest(unhex(t, m.MasterKey), m.PlainManifestKey, unhex(t, m.Sealed)); !errors.Is(err, ErrCorrupt) {
		t.Fatal("manifest opened under another key (AAD not bound)")
	}
	var s struct {
		RecipientPrivate, RecipientPublic, Payload string
		Share                                      Share
	}
	json.Unmarshal(v["share"], &s)
	id, _ := IdentityFromPrivate(unhex(t, s.RecipientPrivate))
	if id.Public() != s.RecipientPublic {
		t.Fatal("public id mismatch")
	}
	f, err := OpenShareEnvelope(id, &s.Share)
	if err != nil || f.Path != "slot1.sav" || f.Entry.Chunks[0] != c.ID {
		t.Fatal("share vector does not open", err)
	}
	var hk []struct{ IKM, Purpose, Out string }
	json.Unmarshal(v["hkdf"], &hk)
	for _, h := range hk {
		if hex.EncodeToString(SubKey(unhex(t, h.IKM), h.Purpose)) != h.Out {
			t.Fatal("hkdf", h.Purpose)
		}
	}
}

func TestGateDefaultsAndEnvironmentCap(t *testing.T) {
	g := LevelGate(DefaultMaxLevel)
	if g(Op("files.deleteFolder")) != nil {
		t.Fatal("L3 refused by default")
	}
	var le *LevelError
	if err := g(Op("crypto.exportMasterKey")); !errors.As(err, &le) || le.Allowed != L3 {
		t.Fatal("L4 allowed by default")
	}
	t.Setenv(MaxLevelEnv, "L2")
	if LevelGate(L4)(Op("files.deleteFolder")) == nil {
		t.Fatal("environment did not lower the cap")
	}
	t.Setenv(MaxLevelEnv, "L4")
	if LevelGate(L2)(Op("files.deleteFolder")) == nil {
		t.Fatal("environment raised the cap")
	}
	t.Setenv(MaxLevelEnv, "nonsense")
	if LevelGate(L4)(Op("usage")) == nil {
		t.Fatal("unreadable cap must lock down")
	}
}

func TestOperationTableMatchesSpec(t *testing.T) {
	raw, _ := os.ReadFile("../spec/operations.json")
	var spec struct {
		Operations []struct {
			ID, Level, Risk, Context string
		}
	}
	json.Unmarshal(raw, &spec)
	if len(spec.Operations) != len(Operations) {
		t.Fatal("table length differs from spec")
	}
	for i, o := range spec.Operations {
		g := Operations[i]
		if g.ID != o.ID || g.Level.String() != o.Level || string(g.Risk) != o.Risk || g.Context != o.Context {
			t.Fatalf("operation %s differs from spec", o.ID)
		}
	}
}

func TestPathsAndLinks(t *testing.T) {
	for _, bad := range []string{"", "/a", "a/", "a//b", "a/../b", ".", "a\\b", "a/\x01", string(make([]byte, 1025))} {
		if _, err := CleanPath(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	if _, err := CleanPath("saves/slot 1.sav"); err != nil {
		t.Fatal(err)
	}
	p := NewPKCE()
	link, err := ConnectLink(ClientInfo{Name: "My Game"}, p, "http://127.0.0.1:5000/cb")
	if err != nil {
		t.Fatal(err)
	}
	req, err := ParseConnectLink(link)
	if err != nil || req.Challenge != p.Challenge || req.Client.Name != "My Game" {
		t.Fatal("link round trip", err)
	}
	if _, err := ConnectLink(ClientInfo{Name: "x"}, p, "https://example.com/cb"); err == nil {
		t.Fatal("remote redirect accepted")
	}
}

func TestEnvelopeRoundTrip(t *testing.T) {
	mk := randomBytes(32)
	env, err := WrapMasterKey(mk, "a long passphrase", KDF{Alg: "scrypt", N: 1 << 14, R: 8, P: 1}, 3, nil)
	if err != nil {
		t.Fatal(err)
	}
	got, err := UnwrapMasterKey(env, "a long passphrase")
	if err != nil || !bytes.Equal(got, mk) || env.Version != 3 {
		t.Fatal(err)
	}
	if _, err := WrapMasterKey(mk, "short", DefaultScrypt, 1, nil); err == nil {
		t.Fatal("short passphrase accepted")
	}
}
