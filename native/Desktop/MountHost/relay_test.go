package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

func relayFixture(t *testing.T, upstream http.Handler) (*davRelay, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)
	u, _ := url.Parse(server.URL)
	return &davRelay{host: "127.0.0.1:1234", token: strings.Repeat("i", 43), upstream: u, bearer: strings.Repeat("s", 43), transport: relayTransport(u), permits: make(chan struct{}, 2)}, server
}

func relayRequest(method, path string, body io.Reader) *http.Request {
	r := httptest.NewRequest(method, "http://127.0.0.1:1234"+path, body)
	r.RemoteAddr = "127.0.0.1:5555"
	r.Header.Set("Authorization", "Bearer "+strings.Repeat("i", 43))
	return r
}

func TestDAVRelayExactBytesBearerRangeAndNoProxy(t *testing.T) {
	data := bytes.Repeat([]byte{0, 1, 2, 255}, 256*1024)
	var calls atomic.Int32
	h, server := relayFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("s", 43) || r.Header.Get("Range") != "bytes=0-1048575" || r.Header.Get("X-Untrusted") != "" {
			t.Error("upstream headers wrong")
		}
		w.Header().Set("ETag", `"fixture"`)
		w.WriteHeader(206)
		_, _ = w.Write(data)
	}))
	transport := h.transport.(*http.Transport)
	if transport.Proxy != nil {
		t.Fatal("relay honors ambient proxy")
	}
	// The upstream transport refuses another loopback port too.
	u, _ := url.Parse(server.URL)
	wrong, _ := http.NewRequest("GET", "http://127.0.0.1:1/", nil)
	if _, err := relayTransport(u).RoundTrip(wrong); err == nil {
		t.Fatal("transport left pinned origin")
	}
	r := relayRequest("GET", "/Unicode%20%F0%9F%98%80.bin", nil)
	r.Header.Set("Range", "bytes=0-1048575")
	r.Header.Set("X-Untrusted", "discard")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 206 || !bytes.Equal(w.Body.Bytes(), data) || calls.Load() != 1 || w.Header().Get("ETag") != `"fixture"` {
		t.Fatal("streamed bytes or headers differ")
	}
}

func TestDAVRelayRejectsRedirectsWritesAndUnknownOrigins(t *testing.T) {
	var forbidden atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forbidden.Add(1) }))
	defer other.Close()
	h, _ := relayFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", other.URL+"/secret")
		w.WriteHeader(302)
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, relayRequest("GET", "/", nil))
	if w.Code != 502 || forbidden.Load() != 0 || w.Header().Get("Location") != "" {
		t.Fatal("redirect escaped pinned relay")
	}
	for _, method := range []string{"PUT", "DELETE", "MOVE", "COPY", "MKCOL", "POST", "PATCH"} {
		w = httptest.NewRecorder()
		h.ServeHTTP(w, relayRequest(method, "/", strings.NewReader("secret")))
		if w.Code != 405 {
			t.Fatal("write method forwarded")
		}
	}
	for _, change := range []func(*http.Request){func(r *http.Request) { r.Host = "localhost:1234" }, func(r *http.Request) { r.Header.Set("Origin", "https://example.invalid") }, func(r *http.Request) { r.Header.Set("Authorization", "Bearer wrong") }} {
		r := relayRequest("GET", "/", nil)
		change(r)
		w = httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal("unauthorized relay access")
		}
	}
}

func TestDAVRelayAllowsOnlyBoundedReadRequests(t *testing.T) {
	var calls atomic.Int32
	h, _ := relayFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(207)
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, relayRequest("PROPFIND", "/", strings.NewReader("<propfind/>")))
	if w.Code != 207 || calls.Load() != 1 {
		t.Fatal("valid PROPFIND refused")
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, relayRequest("PROPFIND", "/", strings.NewReader(strings.Repeat("x", 65537))))
	if w.Code != 413 || calls.Load() != 1 {
		t.Fatal("oversized request reached upstream")
	}
}
