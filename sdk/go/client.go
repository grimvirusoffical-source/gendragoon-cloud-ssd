// Package gendragoon is the Go SDK for GenDragoon Cloud SSD storage (/provider/v1).
//
// A Client talks to one binding with its API key: blobs, manifests, the key envelope, usage and change
// polling. Drive adds encrypted files and folders on top, Sync mirrors a local folder, and AccountClient
// covers the calls a signed-in GenDragoon user makes (connect codes, connected apps).
//
// Every operation has a Rotten Apple level and a risk class (Operations, docs/LEVELS.md). A Gate checks
// them before any request is sent.
package gendragoon

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync/atomic"
	"time"
)

// Version is the SDK version.
const Version = "0.1.0"

// APIError is a non-2xx answer from the server. Code is the server's machine code ("quota_exceeded").
type APIError struct {
	Status     int
	Code       string
	RetryAfter time.Duration
}

func (e *APIError) Error() string { return fmt.Sprintf("gendragoon: %d %s", e.Status, e.Code) }

// Sentinel errors, matched with errors.Is.
var (
	ErrNotFound           = errors.New("gendragoon: not found")
	ErrPreconditionFailed = errors.New("gendragoon: precondition failed")
	ErrQuotaExceeded      = errors.New("gendragoon: quota exceeded")
	ErrUnauthorized       = errors.New("gendragoon: key revoked, expired or invalid")
	ErrRateLimited        = errors.New("gendragoon: rate limited")
	ErrChecksum           = errors.New("gendragoon: checksum mismatch")
	ErrLocked             = errors.New("gendragoon: master key not unlocked")
)

func (e *APIError) Is(target error) bool {
	switch target {
	case ErrNotFound:
		return e.Status == 404
	case ErrPreconditionFailed:
		return e.Status == 412 || e.Code == "precondition_failed" || e.Code == "version_mismatch"
	case ErrQuotaExceeded:
		return e.Status == 507 || e.Code == "quota_exceeded"
	case ErrUnauthorized:
		return e.Status == 401
	case ErrRateLimited:
		return e.Status == 429
	case ErrChecksum:
		return e.Code == "checksum_mismatch"
	}
	return false
}

// Options configure a Client.
type Options struct {
	HTTPClient *http.Client
	// Gate checks every operation first. Nil means LevelGate(DefaultMaxLevel).
	Gate Gate
	// UserAgent is appended to the SDK's own.
	UserAgent string
}

// Client is one binding, authenticated with its gdpk_ API key. It is safe for concurrent use.
type Client struct {
	base string
	key  atomic.Pointer[string]
	hc   *http.Client
	ua   string
	gated
}

var apiKeyRe = regexp.MustCompile(`^gdpk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$`)
var hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

// NewClient returns a client for the provider API at base ("https://host/provider/v1").
func NewClient(base, apiKey string, opts *Options) (*Client, error) {
	if !apiKeyRe.MatchString(apiKey) {
		return nil, errors.New("gendragoon: malformed API key")
	}
	c := &Client{base: strings.TrimRight(base, "/")}
	c.key.Store(&apiKey)
	c.apply(opts)
	return c, nil
}

func (c *Client) apply(opts *Options) {
	c.hc = http.DefaultClient
	c.gate = LevelGate(DefaultMaxLevel)
	c.ua = "gendragoon-sdk-go/" + Version
	if opts != nil {
		if opts.HTTPClient != nil {
			c.hc = opts.HTTPClient
		}
		if opts.Gate != nil {
			c.gate = opts.Gate
		}
		if opts.UserAgent != "" {
			c.ua += " " + opts.UserAgent
		}
	}
}

// APIKey returns the key in use (after Rotate, the new one).
func (c *Client) APIKey() string { return *c.key.Load() }

// Base returns the provider API base URL.
func (c *Client) Base() string { return c.base }

type response struct {
	status int
	header http.Header
	body   []byte
}

func (c *Client) do(ctx context.Context, op, method, path string, body []byte, header map[string]string, auth bool) (*response, error) {
	if err := c.check(op); err != nil {
		return nil, err
	}
	return send(ctx, c.hc, c.ua, method, c.base+path, body, header, func() string {
		if auth {
			return "Bearer " + c.APIKey()
		}
		return ""
	}())
}

func send(ctx context.Context, hc *http.Client, ua, method, u string, body []byte, header map[string]string, authorization string) (*response, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", ua)
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	res, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("gendragoon: %s %s: %w", method, redactURL(u), err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		ae := &APIError{Status: res.StatusCode}
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &e) == nil {
			ae.Code = e.Error
		}
		if ra := res.Header.Get("Retry-After"); ra != "" {
			var s int
			fmt.Sscanf(ra, "%d", &s)
			ae.RetryAfter = time.Duration(s) * time.Second
		}
		return nil, ae
	}
	return &response{status: res.StatusCode, header: res.Header, body: data}, nil
}

func redactURL(u string) string {
	if i := strings.IndexByte(u, '?'); i >= 0 {
		return u[:i]
	}
	return u
}

func (c *Client) getJSON(ctx context.Context, op, path string, out any) error {
	r, err := c.do(ctx, op, "GET", path, nil, nil, true)
	if err != nil {
		return err
	}
	return json.Unmarshal(r.body, out)
}

// Capabilities are the server's limits.
type Capabilities struct {
	Version          int      `json:"version"`
	MaxBlobBytes     int      `json:"maxBlobBytes"`
	MaxManifestBytes int      `json:"maxManifestBytes"`
	IDModes          []string `json:"idModes"`
	ManifestCAS      bool     `json:"manifestCas"`
	BatchHasMax      int      `json:"batchHasMax"`
	ListMax          int      `json:"listMax"`
	Events           struct {
		Poll      bool `json:"poll"`
		ChangeSeq bool `json:"changeSeq"`
		Webhook   bool `json:"webhook"`
		Stream    bool `json:"stream"`
	} `json:"events"`
}

// Capabilities reads the server limits (no key needed, but the gate still applies).
func (c *Client) Capabilities(ctx context.Context) (*Capabilities, error) {
	r, err := c.do(ctx, "capabilities", "GET", "/capabilities", nil, nil, false)
	if err != nil {
		return nil, err
	}
	var out Capabilities
	return &out, json.Unmarshal(r.body, &out)
}

// Health checks that the key works.
func (c *Client) Health(ctx context.Context) error {
	_, err := c.do(ctx, "health", "GET", "/health", nil, nil, true)
	return err
}

// Usage is the binding's storage use.
type Usage struct {
	UsedBytes    int64  `json:"usedBytes"`
	QuotaBytes   int64  `json:"quotaBytes"`
	ObjectCount  int64  `json:"objectCount"`
	WorkspaceID  string `json:"workspaceId"`
	ChangeSeq    int64  `json:"changeSeq"`
	LastChangeAt string `json:"lastChangeAt"`
}

// Remaining is QuotaBytes minus UsedBytes, never negative.
func (u Usage) Remaining() int64 {
	if u.QuotaBytes > u.UsedBytes {
		return u.QuotaBytes - u.UsedBytes
	}
	return 0
}

// Usage reads the binding's usage and change sequence.
func (c *Client) Usage(ctx context.Context) (*Usage, error) {
	var u Usage
	return &u, c.getJSON(ctx, "usage", "/usage", &u)
}

// ---- blobs ----------------------------------------------------------------------------------------

// PutResult reports a blob or manifest write.
type PutResult struct {
	Created    bool
	Generation string
}

// PutBlob stores data as a content-addressed blob (id = SHA-256 of data) and returns the id.
func (c *Client) PutBlob(ctx context.Context, data []byte) (string, PutResult, error) {
	sum := sha256.Sum256(data)
	id := hex.EncodeToString(sum[:])
	res, err := c.putBlob(ctx, id, data, "content")
	return id, res, err
}

// PutSealedBlob stores data under an id the caller chose (for example an HMAC of the plaintext).
func (c *Client) PutSealedBlob(ctx context.Context, id string, data []byte) (PutResult, error) {
	return c.putBlob(ctx, id, data, "sealed")
}

func (c *Client) putBlob(ctx context.Context, id string, data []byte, mode string) (PutResult, error) {
	if !hex64.MatchString(id) {
		return PutResult{}, errors.New("gendragoon: blob id must be 64 lower-case hex characters")
	}
	sum := sha256.Sum256(data)
	r, err := c.do(ctx, "blobs.put", "PUT", "/blobs/"+id, data, map[string]string{
		"Content-Type": "application/octet-stream", "X-Id-Mode": mode, "X-Content-SHA256": hex.EncodeToString(sum[:])}, true)
	if err != nil {
		return PutResult{}, err
	}
	return PutResult{Created: r.status == 201, Generation: etag(r.header)}, nil
}

// GetBlob reads a blob and verifies its checksum.
func (c *Client) GetBlob(ctx context.Context, id string) ([]byte, error) {
	if !hex64.MatchString(id) {
		return nil, errors.New("gendragoon: blob id must be 64 lower-case hex characters")
	}
	r, err := c.do(ctx, "blobs.get", "GET", "/blobs/"+id, nil, nil, true)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(r.body)
	if want := r.header.Get("X-Content-SHA256"); want != "" && want != hex.EncodeToString(sum[:]) {
		return nil, ErrChecksum
	}
	return r.body, nil
}

// BlobInfo is the result of HeadBlob.
type BlobInfo struct {
	Size       int64
	Generation string
	SHA256     string
}

// HeadBlob returns a blob's size and checksum, or ErrNotFound.
func (c *Client) HeadBlob(ctx context.Context, id string) (*BlobInfo, error) {
	r, err := c.do(ctx, "blobs.head", "HEAD", "/blobs/"+id, nil, nil, true)
	if err != nil {
		return nil, err
	}
	var size int64
	fmt.Sscanf(r.header.Get("Content-Length"), "%d", &size)
	return &BlobInfo{Size: size, Generation: etag(r.header), SHA256: r.header.Get("X-Content-SHA256")}, nil
}

// DeleteBlob deletes one blob. Deleting a missing blob succeeds. Level L2, risk destructive.
func (c *Client) DeleteBlob(ctx context.Context, id string) error {
	_, err := c.do(ctx, "blobs.delete", "DELETE", "/blobs/"+id, nil, nil, true)
	return err
}

// ListItem is one entry of a blob or manifest listing.
type ListItem struct {
	ID         string `json:"id"`
	Size       int64  `json:"size"`
	Generation string `json:"generation"`
}

// ListPage is one page of a listing; Next is "" on the last page.
type ListPage struct {
	Items []ListItem
	Next  string
}

func (c *Client) list(ctx context.Context, op, path, cursor string, limit int) (*ListPage, error) {
	q := url.Values{}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	if limit > 0 {
		q.Set("limit", fmt.Sprint(limit))
	}
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	var out struct {
		IDs   []string   `json:"ids"`
		Items []ListItem `json:"items"`
		Next  *string    `json:"next"`
	}
	if err := c.getJSON(ctx, op, path, &out); err != nil {
		return nil, err
	}
	p := &ListPage{Items: out.Items}
	if p.Items == nil { // older servers return ids only
		for _, id := range out.IDs {
			p.Items = append(p.Items, ListItem{ID: id})
		}
	}
	if out.Next != nil {
		p.Next = *out.Next
	}
	return p, nil
}

// ListBlobs returns one page of blob ids in order.
func (c *Client) ListBlobs(ctx context.Context, cursor string, limit int) (*ListPage, error) {
	return c.list(ctx, "blobs.list", "/blobs", cursor, limit)
}

// AllBlobs walks every page.
func (c *Client) AllBlobs(ctx context.Context) ([]ListItem, error) {
	return c.all(ctx, c.ListBlobs)
}

func (c *Client) all(ctx context.Context, page func(context.Context, string, int) (*ListPage, error)) ([]ListItem, error) {
	var out []ListItem
	cursor := ""
	for {
		p, err := page(ctx, cursor, 0)
		if err != nil {
			return nil, err
		}
		out = append(out, p.Items...)
		if p.Next == "" {
			return out, nil
		}
		cursor = p.Next
	}
}

// HasBlobs returns the subset of ids that exist, in input order, batching as needed.
func (c *Client) HasBlobs(ctx context.Context, ids []string) ([]string, error) {
	var present []string
	for len(ids) > 0 {
		n := min(len(ids), 1000)
		body, _ := json.Marshal(map[string][]string{"ids": ids[:n]})
		r, err := c.do(ctx, "blobs.batchHas", "POST", "/blobs/batch-has", body, map[string]string{"Content-Type": "application/json"}, true)
		if err != nil {
			return nil, err
		}
		var out struct {
			Present []string `json:"present"`
		}
		if err := json.Unmarshal(r.body, &out); err != nil {
			return nil, err
		}
		present = append(present, out.Present...)
		ids = ids[n:]
	}
	return present, nil
}

// ---- manifests -------------------------------------------------------------------------------------

// Manifest is a manifest's bytes and storage generation.
type Manifest struct {
	Data       []byte
	Generation string
}

// GetManifest reads one manifest, or returns ErrNotFound.
func (c *Client) GetManifest(ctx context.Context, key string) (*Manifest, error) {
	if !hex64.MatchString(key) {
		return nil, errors.New("gendragoon: manifest key must be 64 lower-case hex characters")
	}
	r, err := c.do(ctx, "manifests.get", "GET", "/manifests/"+key, nil, nil, true)
	if err != nil {
		return nil, err
	}
	return &Manifest{Data: r.body, Generation: etag(r.header)}, nil
}

// Precondition for PutManifest and DeleteManifest.
type Precondition struct {
	// IfAbsent: create only (If-None-Match: *).
	IfAbsent bool
	// IfGeneration: compare-and-swap on this generation (If-Match).
	IfGeneration string
}

func (p Precondition) headers(h map[string]string) {
	if p.IfAbsent {
		h["If-None-Match"] = "*"
	} else if p.IfGeneration != "" {
		h["If-Match"] = `"` + p.IfGeneration + `"`
	}
}

// PutManifest writes one manifest. Losing a race returns ErrPreconditionFailed.
func (c *Client) PutManifest(ctx context.Context, key string, data []byte, pre Precondition) (PutResult, error) {
	if !hex64.MatchString(key) {
		return PutResult{}, errors.New("gendragoon: manifest key must be 64 lower-case hex characters")
	}
	sum := sha256.Sum256(data)
	h := map[string]string{"Content-Type": "application/octet-stream", "X-Content-SHA256": hex.EncodeToString(sum[:])}
	pre.headers(h)
	r, err := c.do(ctx, "manifests.put", "PUT", "/manifests/"+key, data, h, true)
	if err != nil {
		return PutResult{}, err
	}
	return PutResult{Created: r.status == 201, Generation: etag(r.header)}, nil
}

// DeleteManifest deletes one manifest. Level L2, risk destructive.
func (c *Client) DeleteManifest(ctx context.Context, key string, pre Precondition) error {
	h := map[string]string{}
	pre.headers(h)
	_, err := c.do(ctx, "manifests.delete", "DELETE", "/manifests/"+key, nil, h, true)
	return err
}

// ListManifests returns one page of manifest keys with generations.
func (c *Client) ListManifests(ctx context.Context, cursor string, limit int) (*ListPage, error) {
	return c.list(ctx, "manifests.list", "/manifests", cursor, limit)
}

// AllManifests walks every page.
func (c *Client) AllManifests(ctx context.Context) ([]ListItem, error) {
	return c.all(ctx, c.ListManifests)
}

// ---- key envelope ------------------------------------------------------------------------------------

// GetKeyEnvelope reads the binding's wrapped master key, or returns ErrNotFound.
func (c *Client) GetKeyEnvelope(ctx context.Context) (*KeyEnvelope, error) {
	var env KeyEnvelope
	if err := c.getJSON(ctx, "keyEnvelope.get", "/key-envelope", &env); err != nil {
		return nil, err
	}
	return &env, env.validate()
}

func (c *Client) putKeyEnvelope(ctx context.Context, op string, env *KeyEnvelope, h map[string]string) error {
	if err := env.validate(); err != nil {
		return err
	}
	body, _ := json.Marshal(env)
	h["Content-Type"] = "application/json"
	_, err := c.do(ctx, op, "PUT", "/key-envelope", body, h, true)
	return err
}

// ---- api key rotation -------------------------------------------------------------------------------

// RotateAPIKey replaces the key; the old one keeps working for ten minutes. The client switches to the
// new key and returns it so the caller can store it.
func (c *Client) RotateAPIKey(ctx context.Context) (string, error) {
	r, err := c.do(ctx, "apiKey.rotate", "POST", "/connect/rotate", nil, nil, true)
	if err != nil {
		return "", err
	}
	var out struct {
		APIKey string `json:"apiKey"`
	}
	if err := json.Unmarshal(r.body, &out); err != nil || !apiKeyRe.MatchString(out.APIKey) {
		return "", errors.New("gendragoon: unexpected rotate response")
	}
	c.key.Store(&out.APIKey)
	return out.APIKey, nil
}

func etag(h http.Header) string { return strings.Trim(h.Get("ETag"), `"`) }
