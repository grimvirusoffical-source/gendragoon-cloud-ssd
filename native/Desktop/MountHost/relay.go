package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

// davRelay isolates the unchanged backend's redirect/proxy behavior. Its only
// destination is the validated IPv4 loopback origin. RoundTrip never redirects.
type davRelay struct {
	host      string
	token     string
	upstream  *url.URL
	bearer    string
	transport http.RoundTripper
	permits   chan struct{}
}

func relayTransport(upstream *url.URL) *http.Transport {
	return &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			if network != "tcp" || address != upstream.Host {
				return nil, &net.OpError{Op: "dial", Net: "tcp", Err: context.Canceled}
			}
			return (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, "tcp4", upstream.Host)
		},
		ResponseHeaderTimeout: 30 * time.Second,
		IdleConnTimeout:       30 * time.Second,
		MaxIdleConns:          16,
		MaxIdleConnsPerHost:   16,
		DisableCompression:    true,
	}
}

func (h *davRelay) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !localAuthorized(r, h.host, h.token) || r.URL.RawQuery != "" || r.URL.ForceQuery {
		http.Error(w, "denied", http.StatusForbidden)
		return
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions, "PROPFIND":
	default:
		http.Error(w, "read_only", http.StatusMethodNotAllowed)
		return
	}
	select {
	case h.permits <- struct{}{}:
		defer func() { <-h.permits }()
	default:
		http.Error(w, "busy", http.StatusTooManyRequests)
		return
	}
	if r.ContentLength > 64*1024 {
		http.Error(w, "invalid_request", http.StatusRequestEntityTooLarge)
		return
	}
	request := r.Clone(r.Context())
	request.URL.Scheme, request.URL.Host = h.upstream.Scheme, h.upstream.Host
	request.Host, request.RequestURI = h.upstream.Host, ""
	request.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	request.Header = make(http.Header)
	for _, name := range []string{"Depth", "Content-Type", "Range", "If-Match", "If-None-Match", "If-Modified-Since", "If-Unmodified-Since"} {
		if value := r.Header.Get(name); value != "" {
			request.Header.Set(name, value)
		}
	}
	request.Header.Set("Authorization", "Bearer "+h.bearer)
	request.Header.Set("User-Agent", "GenDragoon-MountHost/1.0.0")
	response, err := h.transport.RoundTrip(request)
	if err != nil {
		http.Error(w, "backend_unavailable", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 && response.StatusCode != http.StatusNotModified {
		http.Error(w, "redirect_denied", http.StatusBadGateway)
		return
	}
	for _, name := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified", "DAV", "Allow"} {
		if value := response.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, response.Body)
}
