package gendragoon

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sync"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/hkdf"
	"golang.org/x/crypto/scrypt"
)

// Encryption formats are specified in spec/FORMATS.md. Everything is AES-256-GCM with keys derived by
// HKDF-SHA256 from a 32-byte master key; the master key itself is stored only wrapped, in the binding's
// key envelope (the same record as the workspace key envelope, G9).

const (
	keyBytes   = 32
	nonceBytes = 12
	infoPrefix = "gendragoon-sdk/v1/"
)

var b64 = base64.RawURLEncoding

// KDF parameters of a key envelope. Alg is "scrypt" (N, R, P) or "argon2id" (MemoryKiB, Iterations, Parallelism).
type KDF struct {
	Alg         string `json:"alg"`
	N           int    `json:"N,omitempty"`
	R           int    `json:"r,omitempty"`
	P           int    `json:"p,omitempty"`
	MemoryKiB   int    `json:"memoryKiB,omitempty"`
	Iterations  int    `json:"iterations,omitempty"`
	Parallelism int    `json:"parallelism,omitempty"`
}

// KeyEnvelope is the wrapped master key exactly as the server stores it.
type KeyEnvelope struct {
	Version    int    `json:"version"`
	KDF        KDF    `json:"kdf"`
	Salt       string `json:"salt"`
	IV         string `json:"iv"`
	WrappedKey string `json:"wrappedKey"`
}

// DefaultScrypt is what new envelopes use: 32 MiB of memory, about a quarter of a second on a laptop.
var DefaultScrypt = KDF{Alg: "scrypt", N: 1 << 15, R: 8, P: 1}

func (e *KeyEnvelope) validate() error {
	bad := errors.New("gendragoon: key envelope is not valid")
	if e.Version < 1 {
		return bad
	}
	switch e.KDF.Alg {
	case "scrypt":
		if e.KDF.N < 1<<14 || e.KDF.N > 1<<20 || e.KDF.N&(e.KDF.N-1) != 0 || e.KDF.R != 8 || e.KDF.P < 1 || e.KDF.P > 4 {
			return bad
		}
	case "argon2id":
		if e.KDF.MemoryKiB < 19456 || e.KDF.MemoryKiB > 1048576 || e.KDF.Iterations < 1 || e.KDF.Iterations > 10 || e.KDF.Parallelism < 1 || e.KDF.Parallelism > 4 {
			return bad
		}
	default:
		return bad
	}
	salt, err1 := b64.DecodeString(e.Salt)
	iv, err2 := b64.DecodeString(e.IV)
	wk, err3 := b64.DecodeString(e.WrappedKey)
	if err1 != nil || err2 != nil || err3 != nil || len(salt) < 16 || len(salt) > 64 || len(iv) < 12 || len(iv) > 32 || len(wk) < 32 {
		return bad
	}
	return nil
}

func deriveKEK(passphrase string, k KDF, salt []byte) ([]byte, error) {
	if len(passphrase) < 8 {
		return nil, errors.New("gendragoon: recovery passphrase must be at least 8 characters")
	}
	switch k.Alg {
	case "scrypt":
		return scrypt.Key([]byte(passphrase), salt, k.N, k.R, k.P, keyBytes)
	case "argon2id":
		return argon2.IDKey([]byte(passphrase), salt, uint32(k.Iterations), uint32(k.MemoryKiB), uint8(k.Parallelism), keyBytes), nil
	}
	return nil, errors.New("gendragoon: unsupported KDF")
}

func gcmSeal(key, nonce, plaintext, aad []byte) []byte {
	block, _ := aes.NewCipher(key)
	g, _ := cipher.NewGCM(block)
	return g.Seal(nil, nonce, plaintext, aad)
}

func gcmOpen(key, nonce, ciphertext, aad []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCMWithNonceSize(block, len(nonce))
	if err != nil {
		return nil, err
	}
	return g.Open(nil, nonce, ciphertext, aad)
}

// WrapMasterKey seals a master key under a passphrase. rnd may be nil (crypto/rand).
func WrapMasterKey(mk []byte, passphrase string, k KDF, version int, rnd io.Reader) (*KeyEnvelope, error) {
	if len(mk) != keyBytes {
		return nil, errors.New("gendragoon: master key must be 32 bytes")
	}
	if rnd == nil {
		rnd = rand.Reader
	}
	salt, iv := make([]byte, 16), make([]byte, nonceBytes)
	if _, err := io.ReadFull(rnd, salt); err != nil {
		return nil, err
	}
	if _, err := io.ReadFull(rnd, iv); err != nil {
		return nil, err
	}
	kek, err := deriveKEK(passphrase, k, salt)
	if err != nil {
		return nil, err
	}
	defer wipe(kek)
	env := &KeyEnvelope{Version: version, KDF: k, Salt: b64.EncodeToString(salt), IV: b64.EncodeToString(iv),
		WrappedKey: b64.EncodeToString(gcmSeal(kek, iv, mk, nil))}
	return env, env.validate()
}

// ErrWrongPassphrase is returned when an envelope does not open.
var ErrWrongPassphrase = errors.New("gendragoon: the recovery passphrase did not unlock this key")

// UnwrapMasterKey opens an envelope.
func UnwrapMasterKey(env *KeyEnvelope, passphrase string) ([]byte, error) {
	if err := env.validate(); err != nil {
		return nil, err
	}
	salt, _ := b64.DecodeString(env.Salt)
	iv, _ := b64.DecodeString(env.IV)
	wk, _ := b64.DecodeString(env.WrappedKey)
	kek, err := deriveKEK(passphrase, env.KDF, salt)
	if err != nil {
		return nil, err
	}
	defer wipe(kek)
	mk, err := gcmOpen(kek, iv, wk, nil)
	if err != nil || len(mk) != keyBytes {
		return nil, ErrWrongPassphrase
	}
	return mk, nil
}

// SubKey derives a 32-byte key: HKDF-SHA256(ikm, salt = none, info = "gendragoon-sdk/v1/" + purpose).
func SubKey(ikm []byte, purpose string) []byte {
	out := make([]byte, keyBytes)
	io.ReadFull(hkdf.New(sha256.New, ikm, nil, []byte(infoPrefix+purpose)), out)
	return out
}

func hmacSHA256(key, data []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(data)
	return m.Sum(nil)
}

// Keyring holds an unlocked master key in memory. The zero value is locked.
type Keyring struct {
	mu sync.RWMutex
	mk []byte
	gated
}

// Unlocked reports whether a master key is loaded.
func (k *Keyring) Unlocked() bool { k.mu.RLock(); defer k.mu.RUnlock(); return k.mk != nil }

// Lock wipes the master key from memory.
func (k *Keyring) Lock() { k.mu.Lock(); wipe(k.mk); k.mk = nil; k.mu.Unlock() }

func (k *Keyring) master() ([]byte, error) {
	k.mu.RLock()
	defer k.mu.RUnlock()
	if k.mk == nil {
		return nil, ErrLocked
	}
	return k.mk, nil
}

// ExportMasterKey returns a copy of the raw master key. Level L4, risk key-export: the default gate refuses it.
func (k *Keyring) ExportMasterKey() ([]byte, error) {
	if err := k.check("crypto.exportMasterKey"); err != nil {
		return nil, err
	}
	mk, err := k.master()
	if err != nil {
		return nil, err
	}
	return append([]byte(nil), mk...), nil
}

// ImportMasterKey loads a master key handed over by the host (for example the Rotten Apple launcher).
func (k *Keyring) ImportMasterKey(mk []byte) error {
	if err := k.check("crypto.importMasterKey"); err != nil {
		return err
	}
	if len(mk) != keyBytes {
		return errors.New("gendragoon: master key must be 32 bytes")
	}
	k.mu.Lock()
	wipe(k.mk)
	k.mk = append([]byte(nil), mk...)
	k.mu.Unlock()
	return nil
}

// NewKeyring returns a locked keyring that uses the client's gate.
func (c *Client) NewKeyring() *Keyring { return &Keyring{gated: c.gated} }

// Unlock reads the binding's key envelope and opens it with the passphrase.
func (c *Client) Unlock(ctx context.Context, k *Keyring, passphrase string) error {
	if err := c.check("crypto.unlock"); err != nil {
		return err
	}
	env, err := c.GetKeyEnvelope(ctx)
	if err != nil {
		return err
	}
	mk, err := UnwrapMasterKey(env, passphrase)
	if err != nil {
		return err
	}
	k.mu.Lock()
	wipe(k.mk)
	k.mk = mk
	k.mu.Unlock()
	return nil
}

// CreateMasterKey generates a master key, stores its envelope (create-only) and loads it into k.
// Level L2, risk key: it can only create the first envelope, never replace one. Fails with
// ErrPreconditionFailed if the binding already has an envelope.
func (c *Client) CreateMasterKey(ctx context.Context, k *Keyring, passphrase string) error {
	if err := c.check("keyEnvelope.create"); err != nil {
		return err
	}
	mk := make([]byte, keyBytes)
	if _, err := rand.Read(mk); err != nil {
		return err
	}
	env, err := WrapMasterKey(mk, passphrase, DefaultScrypt, 1, nil)
	if err != nil {
		return err
	}
	if err := c.putKeyEnvelope(ctx, "keyEnvelope.create", env, map[string]string{"If-None-Match": "*"}); err != nil {
		if ae := (*APIError)(nil); errors.As(err, &ae) && ae.Code == "envelope_exists" {
			return fmt.Errorf("%w: the binding already has a master key", ErrPreconditionFailed)
		}
		return err
	}
	k.mu.Lock()
	wipe(k.mk)
	k.mk = mk
	k.mu.Unlock()
	return nil
}

// ChangePassphrase re-wraps the unlocked master key under a new passphrase (compare-and-swap on the
// envelope version). Level L3, risk key.
func (c *Client) ChangePassphrase(ctx context.Context, k *Keyring, newPassphrase string) error {
	if err := c.check("keyEnvelope.replace"); err != nil {
		return err
	}
	mk, err := k.master()
	if err != nil {
		return err
	}
	cur, err := c.GetKeyEnvelope(ctx)
	if err != nil {
		return err
	}
	env, err := WrapMasterKey(mk, newPassphrase, DefaultScrypt, cur.Version+1, nil)
	if err != nil {
		return err
	}
	return c.putKeyEnvelope(ctx, "keyEnvelope.replace", env, map[string]string{"If-Match": fmt.Sprintf(`"%d"`, cur.Version)})
}

// ---- sealed objects ---------------------------------------------------------------------------------

var (
	chunkMagic    = []byte("GDC1")
	manifestMagic = []byte("GDM1")
	plainManifest = []byte("GDM0")
)

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

// SealChunk encrypts one chunk with a file key. It returns the blob id (HMAC of the plaintext under the
// file's id key, so identical chunks of one file share an id) and the stored bytes.
func SealChunk(fileKey, plaintext []byte) (id string, blob []byte) {
	return sealChunkNonce(fileKey, plaintext, randomBytes(nonceBytes))
}

func sealChunkNonce(fileKey, plaintext, nonce []byte) (string, []byte) {
	rawID := hmacSHA256(SubKey(fileKey, "chunk-id"), plaintext)
	aad := append(append([]byte{}, chunkMagic...), rawID...)
	out := append(append(append([]byte{}, chunkMagic...), nonce...), gcmSeal(SubKey(fileKey, "chunk-enc"), nonce, plaintext, aad)...)
	return hex.EncodeToString(rawID), out
}

// ErrCorrupt is returned when sealed data does not decrypt or does not match its id.
var ErrCorrupt = errors.New("gendragoon: data is corrupt or was encrypted with another key")

// OpenChunk decrypts a chunk and checks it against its id.
func OpenChunk(fileKey []byte, id string, blob []byte) ([]byte, error) {
	rawID, err := hex.DecodeString(id)
	if err != nil || len(rawID) != 32 || len(blob) < 4+nonceBytes+16 || string(blob[:4]) != string(chunkMagic) {
		return nil, ErrCorrupt
	}
	aad := append(append([]byte{}, chunkMagic...), rawID...)
	pt, err := gcmOpen(SubKey(fileKey, "chunk-enc"), blob[4:4+nonceBytes], blob[4+nonceBytes:], aad)
	if err != nil || !hmac.Equal(hmacSHA256(SubKey(fileKey, "chunk-id"), pt), rawID) {
		return nil, ErrCorrupt
	}
	return pt, nil
}

// DriveManifestKey is the manifest key of a named drive: HMAC under the master key's manifest-name key
// for encrypted drives, SHA-256 of a fixed prefix for plain ones.
func DriveManifestKey(mk []byte, name string) string {
	if mk == nil {
		s := sha256.Sum256([]byte(infoPrefix + "drive:" + name))
		return hex.EncodeToString(s[:])
	}
	return hex.EncodeToString(hmacSHA256(SubKey(mk, "manifest-name"), []byte("drive:"+name)))
}

// SealManifest encrypts manifest bytes under the master key; mk nil stores them in the plain format.
func SealManifest(mk []byte, key string, plaintext []byte) []byte {
	if mk == nil {
		return append(append([]byte{}, plainManifest...), plaintext...)
	}
	return sealManifestNonce(mk, key, plaintext, randomBytes(nonceBytes))
}

func sealManifestNonce(mk []byte, key string, plaintext, nonce []byte) []byte {
	raw, _ := hex.DecodeString(key)
	aad := append(append([]byte{}, manifestMagic...), raw...)
	return append(append(append([]byte{}, manifestMagic...), nonce...), gcmSeal(SubKey(mk, "manifest-enc"), nonce, plaintext, aad)...)
}

// OpenManifest reverses SealManifest. A plain manifest opens without a key.
func OpenManifest(mk []byte, key string, data []byte) ([]byte, error) {
	if len(data) >= 4 && string(data[:4]) == string(plainManifest) {
		return data[4:], nil
	}
	if len(data) < 4+nonceBytes+16 || string(data[:4]) != string(manifestMagic) {
		return nil, ErrCorrupt
	}
	if mk == nil {
		return nil, ErrLocked
	}
	raw, err := hex.DecodeString(key)
	if err != nil {
		return nil, ErrCorrupt
	}
	aad := append(append([]byte{}, manifestMagic...), raw...)
	pt, err := gcmOpen(SubKey(mk, "manifest-enc"), data[4:4+nonceBytes], data[4+nonceBytes:], aad)
	if err != nil {
		return nil, ErrCorrupt
	}
	return pt, nil
}

func wipe(b []byte) {
	for i := range b {
		b[i] = 0
	}
}
