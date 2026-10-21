package gendragoon

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

// AccountClient makes the calls of a signed-in GenDragoon user: issuing connect codes, approving connect
// links and managing connected apps. It authenticates with the user's Firebase ID token, never with an
// app's API key. These calls act on the person's account, so a Rotten Apple app should not make them
// on the person's behalf; their levels reflect that (docs/LEVELS.md).
type AccountClient struct {
	base  string
	token func(context.Context) (string, error)
	hc    *http.Client
	ua    string
	gated
}

// NewAccountClient returns an account client. token returns a current Firebase ID token.
func NewAccountClient(base string, token func(context.Context) (string, error), opts *Options) *AccountClient {
	c := &Client{}
	c.apply(opts)
	return &AccountClient{base: strings.TrimRight(base, "/"), token: token, hc: c.hc, ua: c.ua, gated: c.gated}
}

func (a *AccountClient) do(ctx context.Context, op, method, path string, body any) (*response, error) {
	if err := a.check(op); err != nil {
		return nil, err
	}
	tok, err := a.token(ctx)
	if err != nil {
		return nil, err
	}
	var raw []byte
	h := map[string]string{}
	if body != nil {
		raw, _ = json.Marshal(body)
		h["Content-Type"] = "application/json"
	}
	return send(ctx, a.hc, a.ua, method, a.base+path, raw, h, "Bearer "+tok)
}

// Grant is a one-time connect code.
type Grant struct {
	Grant      string `json:"grant"`
	ExpiresAt  string `json:"expiresAt"`
	TTLSeconds int    `json:"ttlSeconds"`
}

// CreateGrant issues a one-time connect code for a workspace. Level L3, risk sharing.
func (a *AccountClient) CreateGrant(ctx context.Context, workspaceID string, requester ClientInfo, scopes ...string) (*Grant, error) {
	if len(scopes) == 0 {
		scopes = []string{"blobs:rw"}
	}
	r, err := a.do(ctx, "account.createGrant", "POST", "/connect/grants", map[string]any{"workspaceId": workspaceID, "scopes": scopes, "requester": requester})
	if err != nil {
		return nil, err
	}
	var g Grant
	if err := json.Unmarshal(r.body, &g); err != nil || !grantRe.MatchString(g.Grant) {
		return nil, errors.New("gendragoon: unexpected grant response")
	}
	return &g, nil
}

// ConnectRequest is a parsed gendragoon://connect link.
type ConnectRequest struct {
	Client      ClientInfo
	Scopes      []string
	Challenge   string
	RedirectURI string
	State       string
}

// ParseConnectLink validates a connect link the way GenDragoon does before showing it to the user.
func ParseConnectLink(link string) (*ConnectRequest, error) {
	u, err := url.Parse(link)
	if err != nil || u.Scheme != "gendragoon" || (u.Host != "connect" && strings.Trim(u.Path, "/") != "connect") {
		return nil, errors.New("gendragoon: not a connect link")
	}
	q := u.Query()
	req := &ConnectRequest{Client: ClientInfo{Name: q.Get("client"), Host: q.Get("host")}, Challenge: q.Get("code_challenge"),
		RedirectURI: q.Get("redirect_uri"), State: q.Get("state"), Scopes: strings.Fields(strings.ReplaceAll(q.Get("scope"), ",", " "))}
	if len(req.Scopes) == 0 {
		req.Scopes = []string{"blobs:rw"}
	}
	r, rerr := url.Parse(req.RedirectURI)
	switch {
	case req.Client.Name == "":
		return nil, errors.New("gendragoon: the app did not say who it is")
	case q.Get("code_challenge_method") != "S256" || len(req.Challenge) != 43:
		return nil, errors.New("gendragoon: missing PKCE challenge")
	case rerr != nil || r.Scheme != "http" || (r.Hostname() != "127.0.0.1" && r.Hostname() != "::1") || r.Port() == "" || r.User != nil:
		return nil, errors.New("gendragoon: the code can only go to an app on this device")
	case req.State == "":
		return nil, errors.New("gendragoon: missing state")
	}
	for _, s := range req.Scopes {
		if s != "blobs:rw" && s != "blobs:r" {
			return nil, errors.New("gendragoon: unknown scope " + s)
		}
	}
	return req, nil
}

// Authorize approves a connect link and returns the redirect URL (loopback, with code and state) to open.
// Level L3, risk sharing.
func (a *AccountClient) Authorize(ctx context.Context, workspaceID string, req *ConnectRequest) (string, error) {
	r, err := a.do(ctx, "account.authorize", "POST", "/connect/authorize", map[string]any{"workspaceId": workspaceID, "scopes": req.Scopes,
		"requester": req.Client, "codeChallenge": req.Challenge, "codeChallengeMethod": "S256"})
	if err != nil {
		return "", err
	}
	var out struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(r.body, &out); err != nil || !codeRe.MatchString(out.Code) {
		return "", errors.New("gendragoon: unexpected authorize response")
	}
	u, _ := url.Parse(req.RedirectURI)
	q := u.Query()
	q.Set("code", out.Code)
	q.Set("state", req.State)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// Binding is one connected app as the account owner sees it. It never contains a key.
type Binding struct {
	ID          string     `json:"id"`
	WorkspaceID string     `json:"workspaceId"`
	Client      ClientInfo `json:"client"`
	Scopes      []string   `json:"scopes"`
	UsedBytes   int64      `json:"usedBytes"`
	QuotaBytes  int64      `json:"quotaBytes"`
	ObjectCount int64      `json:"objectCount"`
	CreatedAt   string     `json:"createdAt"`
	LastUsedAt  *string    `json:"lastUsedAt"`
	Active      bool       `json:"active"`
}

// ListBindings lists the account's connected apps. Level L2, risk read.
func (a *AccountClient) ListBindings(ctx context.Context) ([]Binding, error) {
	r, err := a.do(ctx, "account.listBindings", "GET", "/bindings", nil)
	if err != nil {
		return nil, err
	}
	var out struct {
		Bindings []Binding `json:"bindings"`
	}
	return out.Bindings, json.Unmarshal(r.body, &out)
}

// RevokeBinding disconnects an app at once; its data is kept. Level L3, risk sharing.
func (a *AccountClient) RevokeBinding(ctx context.Context, id string) error {
	_, err := a.do(ctx, "account.revokeBinding", "DELETE", "/bindings/"+url.PathEscape(id), nil)
	return err
}

// RevokeAndDelete disconnects an app and deletes everything it stored. Level L4, risk bulk-destructive:
// the default gate refuses it.
func (a *AccountClient) RevokeAndDelete(ctx context.Context, id string) (int, error) {
	r, err := a.do(ctx, "account.revokeAndDelete", "DELETE", "/bindings/"+url.PathEscape(id)+"?deleteData=true", nil)
	if err != nil {
		return 0, err
	}
	var out struct {
		PurgedObjects int `json:"purgedObjects"`
	}
	return out.PurgedObjects, json.Unmarshal(r.body, &out)
}
