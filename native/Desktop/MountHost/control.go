package main

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"sync"
)

type mountSession struct {
	Ready    <-chan struct{}
	Done     <-chan struct{}
	Unmount  func() bool
	Shutdown func()
	Success  func() bool
}

type controlHandler struct {
	gate       *admissionGate
	session    *mountSession
	host       string
	token      string
	mountPoint string
	serial     sync.Mutex
}

func writeResponse(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func fixedResponse(w http.ResponseWriter, status int, code string) {
	writeResponse(w, status, map[string]any{"schema": 1, "status": code})
}

func localAuthorized(r *http.Request, host, token string) bool {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	return err == nil && ip == "127.0.0.1" && r.Host == host && len(r.Header.Values("Origin")) == 0 && subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) == 1
}

func (h *controlHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !localAuthorized(r, h.host, h.token) {
		fixedResponse(w, http.StatusForbidden, "denied")
		return
	}
	if r.URL.RawQuery != "" || r.URL.ForceQuery || r.URL.RawPath != "" {
		fixedResponse(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/v1/status" {
		writeResponse(w, http.StatusOK, h.gate.status())
		return
	}
	if r.Method != http.MethodPost || r.URL.Path != "/v1/unmount" {
		fixedResponse(w, http.StatusNotFound, "not_found")
		return
	}
	// Parse before either lock: a stalled local body cannot stall status or a
	// different unmount request, and the server imposes an absolute read timeout.
	if r.Header.Get("Content-Type") != "application/json" {
		fixedResponse(w, http.StatusBadRequest, "invalid_request")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024))
	var value map[string]json.RawMessage
	if err != nil || json.Unmarshal(body, &value) != nil || value == nil || len(value) != 0 {
		fixedResponse(w, http.StatusBadRequest, "invalid_request")
		return
	}
	h.serial.Lock()
	defer h.serial.Unlock()
	if h.gate.status().State == "unmounted" {
		writeResponse(w, http.StatusOK, map[string]any{"schema": 1, "status": "unmounted", "mountPoint": h.mountPoint})
		return
	}
	if !h.gate.prepareUnmount() {
		fixedResponse(w, http.StatusConflict, "busy")
		return
	}
	if !h.session.Unmount() {
		h.gate.rollbackUnmount()
		fixedResponse(w, http.StatusServiceUnavailable, "retained")
		return
	}
	// Do not stop the process or backend on a caller deadline. The authenticated
	// operation keeps its gate until the native host confirms it has returned.
	<-h.session.Done
	h.gate.markUnmounted()
	writeResponse(w, http.StatusOK, map[string]any{"schema": 1, "status": "unmounted", "mountPoint": h.mountPoint})
}
