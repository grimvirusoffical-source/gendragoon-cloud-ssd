package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func requestFixture(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:1234/v1/unmount", strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:5555"
	r.Header.Set("Authorization", "Bearer "+strings.Repeat("b", 43))
	r.Header.Set("Content-Type", "application/json")
	return r
}

func TestControlBusyNeverCallsNativeStopAndFailedUnmountReopens(t *testing.T) {
	g := newGate()
	done := make(chan struct{})
	var calls atomic.Int32
	h := &controlHandler{gate: g, host: "127.0.0.1:1234", token: strings.Repeat("b", 43), session: &mountSession{Done: done, Unmount: func() bool { calls.Add(1); return false }}}
	g.beginOpen(fileHandle)(true, 4)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, requestFixture("{}"))
	if w.Code != 409 || calls.Load() != 0 || g.status().State != "mounted" {
		t.Fatal("busy request stopped or changed mount")
	}
	closeHandleForTest(t, g, fileHandle, 4)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, requestFixture("{}"))
	if w.Code != 503 || calls.Load() != 1 || g.status().State != "mounted" {
		t.Fatal("failed unmount lost admission")
	}
	if op := g.beginOperation(); op == nil {
		t.Fatal("rollback did not restore reads")
	} else {
		op()
	}
}

func TestControlSuccessWaitsForNativeReturn(t *testing.T) {
	g := newGate()
	done := make(chan struct{})
	called := make(chan struct{})
	returned := make(chan struct{})
	h := &controlHandler{gate: g, host: "127.0.0.1:1234", token: strings.Repeat("b", 43), mountPoint: "X:", session: &mountSession{Done: done, Unmount: func() bool { close(called); return true }}}
	w := httptest.NewRecorder()
	go func() { h.ServeHTTP(w, requestFixture("{}")); close(returned) }()
	<-called
	if g.status().State != "quiescing" || g.beginOpen(fileHandle) != nil {
		t.Fatal("new open entered during unmount")
	}
	select {
	case <-returned:
		t.Fatal("reported unmounted before native returned")
	default:
	}
	close(done)
	<-returned
	if w.Code != 200 || g.status().State != "unmounted" || !strings.Contains(w.Body.String(), `"mountPoint":"X:"`) {
		t.Fatal("confirmed native return missing")
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, requestFixture("{}"))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"mountPoint":"X:"`) {
		t.Fatal("repeated success lost original mount identity")
	}
}

func TestControlBoundsOriginsHostsAndBodyBeforeGate(t *testing.T) {
	g := newGate()
	calls := 0
	h := &controlHandler{gate: g, host: "127.0.0.1:1234", token: strings.Repeat("b", 43), session: &mountSession{Unmount: func() bool { calls++; return false }}}
	for _, change := range []func(*http.Request){func(r *http.Request) { r.Host = "localhost:1234" }, func(r *http.Request) { r.Header.Set("Origin", "null") }, func(r *http.Request) { r.Header.Del("Authorization") }, func(r *http.Request) { r.RemoteAddr = "127.0.0.2:1" }, func(r *http.Request) { r.URL.RawQuery = "force=true" }} {
		r := requestFixture("{}")
		change(r)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code < 400 {
			t.Fatal("unsafe request accepted")
		}
	}
	for _, body := range []string{"null", "[]", `{"force":true}`, strings.Repeat(" ", 1025) + "{}", "{} {}"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, requestFixture(body))
		if w.Code != 400 {
			t.Fatal("unbounded/invalid body accepted")
		}
	}
	if calls != 0 || g.status().State != "mounted" {
		t.Fatal("invalid body reached gate")
	}
	// A blocked body is parsed before serial/admission locks.
	reader, writer := io.Pipe()
	r := requestFixture("")
	r.Body = reader
	done := make(chan struct{})
	go func() { h.ServeHTTP(httptest.NewRecorder(), r); close(done) }()
	status := httptest.NewRecorder()
	s := requestFixture("")
	s.Method = "GET"
	s.URL.Path = "/v1/status"
	h.ServeHTTP(status, s)
	if status.Code != 200 {
		t.Fatal("stalled body blocked status")
	}
	_ = writer.Close()
	<-done
}
