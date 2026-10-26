package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func trimFixture() *http.Request {
	r := requestFixture("{}")
	r.URL.Path = "/v1/cache/trim"
	return r
}

func TestControlTrimUsesNativeCallbacksOutsideGateAndNeverDropsReservations(t *testing.T) {
	g := newGate()
	g.beginOpen(fileHandle, "/private-name")(true, 7)
	var calls atomic.Int32
	h := &controlHandler{gate: g, host: "127.0.0.1:1234", token: strings.Repeat("b", 43), session: &mountSession{
		Notify: func(path string) bool {
			calls.Add(1)
			if path != "/private-name" || g.status().OpenFiles != 1 {
				t.Error("notification lost its reserved file")
			}
			// This simulates the native Close delivered by cache invalidation.
			// A gate lock held across Notify would deadlock here.
			g.beginClose(fileHandle, 7, path)(true)
			return true
		}, Unmount: func() bool { t.Error("trim called native unmount"); return false },
	}}
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { h.ServeHTTP(w, trimFixture()); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("trim held admission lock across native callback")
	}
	if w.Code != 200 || calls.Load() != 1 || g.status().OpenFiles != 0 || g.status().State != "mounted" || strings.Contains(w.Body.String(), "private-name") || !strings.Contains(w.Body.String(), `"requested":1`) {
		t.Fatal("trim did not return bounded nonsecret maintenance status")
	}
	// GET remains a read-only observation and never invokes cache maintenance.
	r := requestFixture("")
	r.Method, r.URL.Path = "GET", "/v1/status"
	h.ServeHTTP(httptest.NewRecorder(), r)
	if calls.Load() != 1 {
		t.Fatal("status GET invoked native maintenance")
	}
}

func TestControlTrimFailureAndCompetingOpenRemainMounted(t *testing.T) {
	for _, fail := range []bool{true, false} {
		g := newGate()
		g.beginOpen(fileHandle, "/still-open")(true, 1)
		notifies, unmounts := 0, 0
		h := &controlHandler{gate: g, host: "127.0.0.1:1234", token: strings.Repeat("b", 43), session: &mountSession{
			Notify: func(path string) bool {
				notifies++
				if !fail {
					g.beginClose(fileHandle, 1, path)(true)
					// Another successful open after the snapshot must still win
					// against the unchanged final atomic unmount gate.
					g.beginOpen(fileHandle, "/competing-open")(true, 2)
				}
				return !fail
			}, Unmount: func() bool { unmounts++; return false },
		}}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, requestFixture("{}"))
		want := 409
		if fail {
			want = 503
		}
		if w.Code != want || notifies != 1 || unmounts != 0 || g.status().State != "mounted" || g.status().OpenFiles != 1 || g.prepareUnmount() {
			t.Fatal("failed notify or competing open bypassed lifetime gate")
		}
		if op := g.beginOperation(); op == nil {
			t.Fatal("busy maintenance interrupted existing reads")
		} else {
			op()
		}
	}
}

func TestControlTrimAcknowledgementNeverReleasesActiveHandle(t *testing.T) {
	g := newGate()
	g.beginOpen(fileHandle, "/active-view")(true, 1)
	notifies, unmounts := 0, 0
	h := &controlHandler{gate: g, host: "127.0.0.1:1234", token: strings.Repeat("b", 43), session: &mountSession{
		Notify:  func(string) bool { notifies++; return true },
		Unmount: func() bool { unmounts++; return false },
	}}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, trimFixture())
	if w.Code != 200 || g.status().OpenFiles != 1 || g.prepareUnmount() {
		t.Fatal("notification acknowledgement was treated as native Close")
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, requestFixture("{}"))
	if w.Code != 409 || notifies != 2 || unmounts != 0 || g.status().OpenFiles != 1 || g.status().State != "mounted" {
		t.Fatal("active handle was not retained through busy unmount")
	}
}

func TestControlTrimRejectsUnauthenticatedUnboundedAndNonPostRequests(t *testing.T) {
	g := newGate()
	g.beginOpen(fileHandle, "/retained")(true, 1)
	calls := 0
	h := &controlHandler{gate: g, host: "127.0.0.1:1234", token: strings.Repeat("b", 43), session: &mountSession{Notify: func(string) bool { calls++; return true }}}
	for _, change := range []func(*http.Request){func(r *http.Request) { r.Header.Del("Authorization") }, func(r *http.Request) { r.Method = "GET" }, func(r *http.Request) { r.Header.Set("Origin", "null") }, func(r *http.Request) { r.Host = "localhost:1234" }, func(r *http.Request) { r.Body = io.NopCloser(strings.NewReader(`{"path":"/caller-chosen"}`)) }, func(r *http.Request) { r.URL.RawQuery = "force=true" }} {
		r := trimFixture()
		change(r)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code < 400 {
			t.Fatal("unsafe cache maintenance request accepted")
		}
	}
	if calls != 0 || g.status().OpenFiles != 1 {
		t.Fatal("rejected request reached native maintenance")
	}
}

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
