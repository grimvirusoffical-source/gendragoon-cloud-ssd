package gendragoon

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"golang.org/x/crypto/hkdf"
)

// Sharing hands one file to a recipient without giving them the drive. The sender encrypts the file's
// entry (chunk ids and its file key) to the recipient's public key; the recipient needs read access to
// the same binding (a read-only connect code from the account owner, account.createGrant with scope
// blobs:r) to fetch the chunks. The server never sees the file key. Format: spec/FORMATS.md.

const (
	identityPrefix = "gdid1_"
	shareAlg       = "ECDH-P256+HKDF-SHA256+A256GCM"
	shareAAD       = "gd-share-v1"
)

// Identity is a recipient key pair (P-256).
type Identity struct{ priv *ecdh.PrivateKey }

// NewIdentity creates a recipient key pair. Level L2, risk key (local).
func (c *Client) NewIdentity() (*Identity, error) {
	if err := c.check("share.createIdentity"); err != nil {
		return nil, err
	}
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return &Identity{k}, nil
}

// IdentityFromPrivate restores an identity from PrivateBytes (97 bytes: the 32-byte scalar followed by
// the 65-byte uncompressed public point, so platforms without point arithmetic can import it).
func IdentityFromPrivate(b []byte) (*Identity, error) {
	if len(b) != 97 {
		return nil, errors.New("gendragoon: identity must be 97 bytes")
	}
	k, err := ecdh.P256().NewPrivateKey(b[:32])
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(k.PublicKey().Bytes(), b[32:]) {
		return nil, errors.New("gendragoon: identity public key does not match")
	}
	return &Identity{k}, nil
}

// PrivateBytes serializes the identity: scalar (32 bytes) then public point (65). Keep it secret.
func (i *Identity) PrivateBytes() []byte {
	return append(i.priv.Bytes(), i.priv.PublicKey().Bytes()...)
}

// Public is the shareable recipient id: "gdid1_" + base64url(uncompressed P-256 point).
func (i *Identity) Public() string {
	return identityPrefix + b64.EncodeToString(i.priv.PublicKey().Bytes())
}

func parseRecipient(id string) (*ecdh.PublicKey, error) {
	if !strings.HasPrefix(id, identityPrefix) {
		return nil, errors.New("gendragoon: not a recipient id")
	}
	raw, err := b64.DecodeString(id[len(identityPrefix):])
	if err != nil {
		return nil, errors.New("gendragoon: not a recipient id")
	}
	return ecdh.P256().NewPublicKey(raw)
}

// Share is the encrypted envelope a sender gives a recipient (as JSON).
type Share struct {
	V         int    `json:"v"`
	Alg       string `json:"alg"`
	Recipient string `json:"recipient"`
	EPK       string `json:"epk"`
	Nonce     string `json:"nonce"`
	CT        string `json:"ct"`
}

// SharedFile is what a share contains.
type SharedFile struct {
	V     int       `json:"v"`
	Path  string    `json:"path"`
	Entry FileEntry `json:"entry"`
}

func shareKey(shared, epk, rpk []byte) []byte {
	out := make([]byte, 32)
	io.ReadFull(hkdf.New(sha256.New, shared, append(append([]byte{}, epk...), rpk...), []byte(infoPrefix+"share")), out)
	return out
}

func recipientTag(rpk []byte) string { s := sha256.Sum256(rpk); return b64.EncodeToString(s[:8]) }

// ExportShare encrypts one file of an encrypted drive to a recipient. Level L3, risk sharing.
func (d *Drive) ExportShare(ctx context.Context, p, recipient string) (*Share, error) {
	if err := d.c.check("share.export"); err != nil {
		return nil, err
	}
	if d.keys == nil {
		return nil, errors.New("gendragoon: plain drives have nothing to share; give the reader access to the binding instead")
	}
	rpk, err := parseRecipient(recipient)
	if err != nil {
		return nil, err
	}
	doc, _, err := d.load(ctx)
	if err != nil {
		return nil, err
	}
	e := doc.Files[p]
	if e == nil {
		return nil, &APIError{Status: 404, Code: "not_found"}
	}
	payload, _ := json.Marshal(SharedFile{V: 1, Path: p, Entry: *e})
	return sealShare(rpk, payload, rand.Reader)
}

func sealShare(rpk *ecdh.PublicKey, payload []byte, rnd io.Reader) (*Share, error) {
	eph, err := ecdh.P256().GenerateKey(rnd)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, nonceBytes)
	if _, err := io.ReadFull(rnd, nonce); err != nil {
		return nil, err
	}
	return sealShareWith(eph, rpk, payload, nonce)
}

func sealShareWith(eph *ecdh.PrivateKey, rpk *ecdh.PublicKey, payload, nonce []byte) (*Share, error) {
	shared, err := eph.ECDH(rpk)
	if err != nil {
		return nil, err
	}
	epk := eph.PublicKey().Bytes()
	key := shareKey(shared, epk, rpk.Bytes())
	return &Share{V: 1, Alg: shareAlg, Recipient: recipientTag(rpk.Bytes()), EPK: b64.EncodeToString(epk),
		Nonce: b64.EncodeToString(nonce), CT: b64.EncodeToString(gcmSeal(key, nonce, payload, []byte(shareAAD)))}, nil
}

// OpenShareEnvelope decrypts a share with the recipient's identity (no network).
func OpenShareEnvelope(id *Identity, s *Share) (*SharedFile, error) {
	if s.V != 1 || s.Alg != shareAlg {
		return nil, errors.New("gendragoon: unsupported share")
	}
	rpk := id.priv.PublicKey().Bytes()
	if s.Recipient != recipientTag(rpk) {
		return nil, errors.New("gendragoon: this share is addressed to someone else")
	}
	epkRaw, err1 := b64.DecodeString(s.EPK)
	nonce, err2 := b64.DecodeString(s.Nonce)
	ct, err3 := b64.DecodeString(s.CT)
	if err1 != nil || err2 != nil || err3 != nil {
		return nil, ErrCorrupt
	}
	epk, err := ecdh.P256().NewPublicKey(epkRaw)
	if err != nil {
		return nil, ErrCorrupt
	}
	shared, err := id.priv.ECDH(epk)
	if err != nil {
		return nil, ErrCorrupt
	}
	pt, err := gcmOpen(shareKey(shared, epkRaw, rpk), nonce, ct, []byte(shareAAD))
	if err != nil {
		return nil, ErrCorrupt
	}
	var f SharedFile
	if err := json.Unmarshal(pt, &f); err != nil || f.V != 1 {
		return nil, ErrCorrupt
	}
	return &f, nil
}

// OpenShare decrypts a share and downloads the file through this client (which needs read access to
// the sender's binding). Level L2, risk read.
func (c *Client) OpenShare(ctx context.Context, id *Identity, s *Share) (*SharedFile, []byte, error) {
	if err := c.check("share.open"); err != nil {
		return nil, nil, err
	}
	f, err := OpenShareEnvelope(id, s)
	if err != nil {
		return nil, nil, err
	}
	data, err := readEntry(ctx, c, &f.Entry)
	return f, data, err
}

// ReadKey is a read-only key for this binding (the secret is only in APIKey, returned once).
type ReadKey struct {
	KeyID     string   `json:"keyId"`
	APIKey    string   `json:"apiKey,omitempty"`
	Scopes    []string `json:"scopes"`
	Label     string   `json:"label"`
	CreatedAt string   `json:"createdAt,omitempty"`
	ExpiresAt string   `json:"expiresAt"`
	Revoked   bool     `json:"revoked,omitempty"`
}

// CreateReadKey mints a read-only key for this binding, valid ttlDays (1 to 90). Give it to the person
// or device that opens your shares. It cannot write, mint keys or read the key envelope.
// Level L3, risk sharing.
func (c *Client) CreateReadKey(ctx context.Context, label string, ttlDays int) (*ReadKey, error) {
	body, _ := json.Marshal(map[string]any{"label": label, "ttlDays": ttlDays})
	r, err := c.do(ctx, "share.createReadKey", "POST", "/keys", body, map[string]string{"Content-Type": "application/json"}, true)
	if err != nil {
		return nil, err
	}
	var k ReadKey
	if err := json.Unmarshal(r.body, &k); err != nil || !apiKeyRe.MatchString(k.APIKey) {
		return nil, errors.New("gendragoon: unexpected key response")
	}
	return &k, nil
}

// ListReadKeys lists this binding's read-only keys (never their secrets). Level L2, risk read.
func (c *Client) ListReadKeys(ctx context.Context) ([]ReadKey, error) {
	var out struct {
		Keys []ReadKey `json:"keys"`
	}
	return out.Keys, c.getJSON(ctx, "share.listReadKeys", "/keys", &out)
}

// RevokeReadKey revokes a read-only key at once. Level L3, risk sharing.
func (c *Client) RevokeReadKey(ctx context.Context, keyID string) error {
	_, err := c.do(ctx, "share.revokeReadKey", "DELETE", "/keys/"+keyID, nil, nil, true)
	return err
}
