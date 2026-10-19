// Package redxpack is a client for Gendragoon's /provider/v1 that has exactly the method set of RedX's
// engine/pack ChunkStore and ManifestStore. It exists to prove the HTTP contract against RedX's interface.
// The production adapter belongs to RedX (RedX Dev); this one is a reference and a test harness.
package redxpack

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

var (
	ErrChunkNotFound    = errors.New("redxpack: chunk not in store")
	ErrManifestNotFound = errors.New("redxpack: manifest not in store")
	ErrQuotaExceeded    = errors.New("redxpack: quota exceeded")
	ErrChecksum         = errors.New("redxpack: checksum mismatch")
	ErrPrecondition     = errors.New("redxpack: precondition failed")
)

// Remote talks to one binding. NotFoundChunk/NotFoundManifest let a caller substitute RedX's own sentinels.
type Remote struct {
	Base             string // e.g. https://host/provider/v1
	Key              string // gdpk_...
	HTTP             *http.Client
	NotFoundChunk    error
	NotFoundManifest error
}

func (r *Remote) client() *http.Client {
	if r.HTTP != nil {
		return r.HTTP
	}
	return http.DefaultClient
}
func (r *Remote) nfc() error {
	if r.NotFoundChunk != nil {
		return r.NotFoundChunk
	}
	return ErrChunkNotFound
}
func (r *Remote) nfm() error {
	if r.NotFoundManifest != nil {
		return r.NotFoundManifest
	}
	return ErrManifestNotFound
}

func validID(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func (r *Remote) do(method, path string, body []byte, hdr map[string]string) (*http.Response, []byte, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, r.Base+path, rd)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+r.Key)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := r.client().Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	return resp, b, err
}

func apiErr(resp *http.Response, b []byte) error {
	var e struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(b, &e)
	switch {
	case resp.StatusCode == 507:
		return ErrQuotaExceeded
	case resp.StatusCode == 422:
		return ErrChecksum
	case resp.StatusCode == 412:
		return ErrPrecondition
	}
	return fmt.Errorf("redxpack: %s %d %s", resp.Request.Method, resp.StatusCode, e.Error)
}

// ---- ChunkStore ----

func (r *Remote) PutChunk(id string, data []byte) error {
	if !validID(id) {
		return fmt.Errorf("redxpack: bad chunk id %q", id)
	}
	sum := sha256.Sum256(data)
	resp, b, err := r.do("PUT", "/blobs/"+id, data, map[string]string{"X-Content-SHA256": hex.EncodeToString(sum[:]), "Content-Type": "application/octet-stream"})
	if err != nil {
		return err
	}
	if resp.StatusCode == 200 || resp.StatusCode == 201 {
		return nil
	}
	return apiErr(resp, b)
}

func (r *Remote) GetChunk(id string) ([]byte, error) {
	if !validID(id) {
		return nil, r.nfc()
	}
	resp, b, err := r.do("GET", "/blobs/"+id, nil, nil)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == 404 {
		return nil, r.nfc()
	}
	if resp.StatusCode != 200 {
		return nil, apiErr(resp, b)
	}
	sum := sha256.Sum256(b)
	if got := hex.EncodeToString(sum[:]); got != resp.Header.Get("X-Content-SHA256") {
		return nil, ErrChecksum
	}
	return b, nil
}

func (r *Remote) HasChunk(id string) (bool, error) {
	if !validID(id) {
		return false, nil
	}
	resp, b, err := r.do("HEAD", "/blobs/"+id, nil, nil)
	if err != nil {
		return false, err
	}
	switch resp.StatusCode {
	case 200:
		return true, nil
	case 404:
		return false, nil
	}
	return false, apiErr(resp, b)
}

func (r *Remote) DeleteChunk(id string) error {
	if !validID(id) {
		return nil
	}
	resp, b, err := r.do("DELETE", "/blobs/"+id, nil, nil)
	if err != nil {
		return err
	}
	if resp.StatusCode == 204 {
		return nil
	}
	return apiErr(resp, b)
}

func (r *Remote) list(kind string) ([]string, error) {
	var out []string
	cursor := ""
	for {
		q := "?limit=1000"
		if cursor != "" {
			q += "&cursor=" + url.QueryEscape(cursor)
		}
		resp, b, err := r.do("GET", "/"+kind+q, nil, nil)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != 200 {
			return nil, apiErr(resp, b)
		}
		var page struct {
			IDs  []string `json:"ids"`
			Next *string  `json:"next"`
		}
		if err := json.Unmarshal(b, &page); err != nil {
			return nil, err
		}
		out = append(out, page.IDs...)
		if page.Next == nil || *page.Next == "" {
			return out, nil
		}
		cursor = *page.Next
	}
}

func (r *Remote) ListChunks() ([]string, error) { return r.list("blobs") }

// ---- ManifestStore ----

func (r *Remote) LoadManifest(key string) ([]byte, error) {
	b, _, err := r.LoadManifestVersion(key)
	return b, err
}

// LoadManifestVersion also returns the ETag for SaveManifestIf.
func (r *Remote) LoadManifestVersion(key string) ([]byte, string, error) {
	if !validID(key) {
		return nil, "", r.nfm()
	}
	resp, b, err := r.do("GET", "/manifests/"+key, nil, nil)
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode == 404 {
		return nil, "", r.nfm()
	}
	if resp.StatusCode != 200 {
		return nil, "", apiErr(resp, b)
	}
	return b, resp.Header.Get("ETag"), nil
}

// SaveManifest is RedX's atomic overwrite.
func (r *Remote) SaveManifest(key string, data []byte) error { return r.SaveManifestIf(key, data, "") }

// SaveManifestIf is compare-and-swap: etag "" = unconditional, "*" = must not exist, else must match.
func (r *Remote) SaveManifestIf(key string, data []byte, etag string) error {
	if !validID(key) {
		return fmt.Errorf("redxpack: bad manifest key %q", key)
	}
	h := map[string]string{"Content-Type": "application/octet-stream"}
	switch {
	case etag == "*":
		h["If-None-Match"] = "*"
	case etag != "":
		h["If-Match"] = etag
	}
	sum := sha256.Sum256(data)
	h["X-Content-SHA256"] = hex.EncodeToString(sum[:])
	resp, b, err := r.do("PUT", "/manifests/"+key, data, h)
	if err != nil {
		return err
	}
	if resp.StatusCode == 200 || resp.StatusCode == 201 {
		return nil
	}
	return apiErr(resp, b)
}

func (r *Remote) DeleteManifest(key string) error {
	if !validID(key) {
		return nil
	}
	resp, b, err := r.do("DELETE", "/manifests/"+key, nil, nil)
	if err != nil {
		return err
	}
	if resp.StatusCode == 204 {
		return nil
	}
	return apiErr(resp, b)
}

func (r *Remote) ListManifests() ([]string, error) { return r.list("manifests") }

// Usage reports the binding's quota (for RedX Usage()).
func (r *Remote) Usage() (used, quota int64, err error) {
	resp, b, err := r.do("GET", "/usage", nil, nil)
	if err != nil {
		return 0, 0, err
	}
	if resp.StatusCode != 200 {
		return 0, 0, apiErr(resp, b)
	}
	var u struct {
		Used  int64 `json:"usedBytes"`
		Quota int64 `json:"quotaBytes"`
	}
	err = json.Unmarshal(b, &u)
	return u.Used, u.Quota, err
}

