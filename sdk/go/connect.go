package gendragoon

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Connecting gives an app its API key. Two ways, both one-time and valid for five minutes:
//
//  1. Connect code: the user creates a code in GenDragoon (Connected apps) and pastes it into the app,
//     which calls RedeemGrant.
//  2. Connect link with PKCE: the app opens ConnectLink in GenDragoon, the user approves, GenDragoon
//     redirects to the app's loopback listener with a code, and the app calls ExchangeCode with the
//     verifier only it knows.

// Connection is the result of a successful connect.
type Connection struct {
	BindingID    string        `json:"bindingId"`
	APIKey       string        `json:"apiKey"`
	KeyExpiresAt string        `json:"keyExpiresAt"`
	Scopes       []string      `json:"scopes"`
	WorkspaceID  string        `json:"workspaceId"`
	QuotaBytes   int64         `json:"quotaBytes"`
	Capabilities *Capabilities `json:"capabilities"`
}

// ClientInfo names the connecting app to the user.
type ClientInfo struct {
	Name string `json:"name"`
	Host string `json:"host,omitempty"`
}

// Connector performs the app-side connect calls (no API key yet).
type Connector struct {
	base string
	hc   *http.Client
	ua   string
	gated
}

// NewConnector returns a connector for the provider API at base.
func NewConnector(base string, opts *Options) *Connector {
	c := &Client{}
	c.apply(opts)
	return &Connector{base: strings.TrimRight(base, "/"), hc: c.hc, ua: c.ua, gated: c.gated}
}

var grantRe = regexp.MustCompile(`^gdpg_[A-Za-z0-9_-]{43}$`)
var codeRe = regexp.MustCompile(`^gdpc_[A-Za-z0-9_-]{43}$`)

func (k *Connector) post(ctx context.Context, op, path string, body any) (*Connection, error) {
	if err := k.check(op); err != nil {
		return nil, err
	}
	raw, _ := json.Marshal(body)
	r, err := send(ctx, k.hc, k.ua, "POST", k.base+path, raw, map[string]string{"Content-Type": "application/json"}, "")
	if err != nil {
		return nil, err
	}
	var c Connection
	if err := json.Unmarshal(r.body, &c); err != nil || !apiKeyRe.MatchString(c.APIKey) {
		return nil, errors.New("gendragoon: unexpected connect response")
	}
	return &c, nil
}

// RedeemGrant exchanges a one-time connect code (gdpg_…) for an API key. Level L2, risk credential.
func (k *Connector) RedeemGrant(ctx context.Context, grant string, client ClientInfo) (*Connection, error) {
	grant = strings.TrimSpace(grant)
	if !grantRe.MatchString(grant) {
		return nil, errors.New("gendragoon: that is not a GenDragoon connect code")
	}
	return k.post(ctx, "connect.redeemGrant", "/connect/redeem", map[string]any{"grant": grant, "client": client})
}

// ExchangeCode exchanges an authorization code (gdpc_…) and the PKCE verifier for an API key.
// Level L2, risk credential.
func (k *Connector) ExchangeCode(ctx context.Context, code, verifier string) (*Connection, error) {
	if !codeRe.MatchString(code) {
		return nil, errors.New("gendragoon: that is not a GenDragoon authorization code")
	}
	return k.post(ctx, "connect.exchangeCode", "/connect/token", map[string]string{"code": code, "codeVerifier": verifier})
}

// PKCE is a verifier and its S256 challenge.
type PKCE struct {
	Verifier  string
	Challenge string
	State     string
}

// NewPKCE creates a fresh verifier (43 characters), its challenge and a random state value.
func NewPKCE() PKCE {
	v := b64.EncodeToString(randomBytes(32))
	s := sha256.Sum256([]byte(v))
	return PKCE{Verifier: v, Challenge: b64.EncodeToString(s[:]), State: b64.EncodeToString(randomBytes(16))}
}

// ConnectLink is the gendragoon://connect link the app opens. redirect must be an http://127.0.0.1:port
// loopback URL; GenDragoon refuses anything else.
func ConnectLink(client ClientInfo, p PKCE, redirect string, scopes ...string) (string, error) {
	u, err := url.Parse(redirect)
	if err != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "::1") || u.Port() == "" || u.User != nil {
		return "", errors.New("gendragoon: redirect must be http://127.0.0.1:<port>/…")
	}
	if len(scopes) == 0 {
		scopes = []string{"blobs:rw"}
	}
	q := url.Values{}
	q.Set("client", client.Name)
	if client.Host != "" {
		q.Set("host", client.Host)
	}
	q.Set("scope", strings.Join(scopes, " "))
	q.Set("code_challenge", p.Challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("redirect_uri", redirect)
	q.Set("state", p.State)
	return "gendragoon://connect?" + q.Encode(), nil
}

// Loopback listens on 127.0.0.1 for the redirect that carries the authorization code.
type Loopback struct {
	ln    net.Listener
	srv   *http.Server
	codes chan string
	state string
	// RedirectURI is the URL to put in ConnectLink.
	RedirectURI string
}

// ListenLoopback starts a listener on a free loopback port that accepts one redirect with the right state.
func ListenLoopback(p PKCE) (*Loopback, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	l := &Loopback{ln: ln, codes: make(chan string, 1), state: p.State,
		RedirectURI: fmt.Sprintf("http://127.0.0.1:%d/gendragoon/callback", ln.Addr().(*net.TCPAddr).Port)}
	mux := http.NewServeMux()
	mux.HandleFunc("/gendragoon/callback", func(w http.ResponseWriter, r *http.Request) {
		code, state := r.URL.Query().Get("code"), r.URL.Query().Get("state")
		if subtle.ConstantTimeCompare([]byte(state), []byte(l.state)) != 1 || !codeRe.MatchString(code) {
			http.Error(w, "This link is not for this app.", http.StatusBadRequest)
			return
		}
		select {
		case l.codes <- code:
		default:
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintln(w, "Connected. You can close this window and return to the app.")
	})
	l.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go l.srv.Serve(ln)
	return l, nil
}

// Wait returns the authorization code, or an error when ctx ends.
func (l *Loopback) Wait(ctx context.Context) (string, error) {
	defer l.Close()
	select {
	case c := <-l.codes:
		return c, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// Close stops the listener.
func (l *Loopback) Close() error { return l.srv.Close() }
