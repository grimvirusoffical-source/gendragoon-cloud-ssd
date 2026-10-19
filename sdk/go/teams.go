package gendragoon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// TeamsClient makes the Teams calls of a signed-in GenDragoon user (/v2/teams on the API origin). It
// authenticates with the user's Firebase ID token; the server refuses gdsk_ API keys for teams and
// team workspaces. Calls that start a subscription return a Stripe Checkout URL for the person to
// open; the SDK never completes a payment. Levels are listed in docs/LEVELS.md.
type TeamsClient struct {
	acct *AccountClient
}

// NewTeamsClient returns a Teams client for the API origin. token returns a current Firebase ID token.
func NewTeamsClient(origin string, token func(context.Context) (string, error), opts *Options) *TeamsClient {
	return &TeamsClient{acct: NewAccountClient(origin, token, opts)}
}

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func seg(s string) (string, error) {
	if s == "" || len(s) > 128 || strings.ContainsAny(s, "/?#") {
		return "", fmt.Errorf("gendragoon: invalid id %q", s)
	}
	return url.PathEscape(s), nil
}

func (t *TeamsClient) call(ctx context.Context, op, method string, out any, body any, parts ...string) error {
	path := "/v2/teams"
	for _, p := range parts {
		if strings.HasPrefix(p, "!") {
			path += "/" + p[1:]
			continue
		}
		e, err := seg(p)
		if err != nil {
			return err
		}
		path += "/" + e
	}
	r, err := t.acct.do(ctx, op, method, path, body)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(r.body, out)
}

// TeamMember is a member as other members see them.
type TeamMember struct {
	MemberID    string `json:"memberId"`
	DisplayName string `json:"displayName"`
	Color       string `json:"color"`
	ColorHex    string `json:"colorHex"`
	Role        string `json:"role"` // owner, member or viewer
	Muted       *struct {
		Until  *int64  `json:"until"` // milliseconds since the epoch; nil means until lifted
		Reason *string `json:"reason"`
	} `json:"muted"`
}

// Team is a team as the calling member sees it.
type Team struct {
	ID                 string       `json:"id"`
	Name               string       `json:"name"`
	Tier               string       `json:"tier"`
	Interval           string       `json:"interval"`
	MemberLimit        int          `json:"memberLimit"`
	MemberCount        int          `json:"memberCount"`
	PriceCents         int64        `json:"priceCents"`
	SubscriptionStatus string       `json:"subscriptionStatus"`
	SubscriptionActive bool         `json:"subscriptionActive"`
	Role               string       `json:"role"`
	Me                 TeamMember   `json:"me"`
	Members            []TeamMember `json:"members,omitempty"`
}

// MemberColor is one member color and whether someone in the team already uses it.
type MemberColor struct {
	ID    string `json:"id"`
	Hue   string `json:"hue"`
	Hex   string `json:"hex"`
	Taken bool   `json:"taken"`
}

// ColorChoices are the colors a member can pick.
type ColorChoices struct {
	MemberColors []MemberColor    `json:"memberColors"`
	OwnerShades  []map[string]any `json:"ownerShades"`
	ReservedHue  string           `json:"reservedHue"`
}

// TeamView is a team with its members and color choices.
type TeamView struct {
	Team   Team         `json:"team"`
	Colors ColorChoices `json:"colors"`
}

// Checkout is the result of a call that may need payment. URL is set when the person has to open a
// Stripe Checkout page; AlreadyActivated is set when nothing is due.
type Checkout struct {
	URL              string `json:"url,omitempty"`
	TotalCents       int64  `json:"totalCents,omitempty"`
	Resumed          bool   `json:"resumed,omitempty"`
	AlreadyActivated bool   `json:"alreadyActivated,omitempty"`
	Complimentary    bool   `json:"complimentary,omitempty"`
	CheckoutError    string `json:"checkoutError,omitempty"`
}

// CreateTeamRequest creates a team. IntentID is a UUID you keep for retries: the same intent resumes
// the same team and checkout instead of creating a second one.
type CreateTeamRequest struct {
	IntentID   string `json:"intentId"`
	Name       string `json:"name"`
	Tier       string `json:"tier"`               // team, team_plus or business
	Interval   string `json:"interval,omitempty"` // month or year
	OwnerShade string `json:"ownerShade,omitempty"`
}

// CreatedTeam is the result of Create.
type CreatedTeam struct {
	Team Team `json:"team"`
	Checkout
}

// Catalog returns the team tiers, the Enterprise contact and the color palette. Level L2, risk read.
func (t *TeamsClient) Catalog(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	return out, t.call(ctx, "teams.catalog", "GET", &out, nil, "!catalog")
}

// List returns the teams the account belongs to. Level L2, risk read.
func (t *TeamsClient) List(ctx context.Context) ([]Team, error) {
	var out struct {
		Teams []Team `json:"teams"`
	}
	return out.Teams, t.call(ctx, "teams.list", "GET", &out, nil)
}

// Create creates a team and opens its subscription checkout. Level L3, risk billing.
func (t *TeamsClient) Create(ctx context.Context, req CreateTeamRequest) (*CreatedTeam, error) {
	if !uuidRe.MatchString(req.IntentID) {
		return nil, errors.New("gendragoon: IntentID must be a UUID")
	}
	var out CreatedTeam
	if err := t.call(ctx, "teams.create", "POST", &out, req); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get returns a team with its members and color choices. Level L2, risk read.
func (t *TeamsClient) Get(ctx context.Context, teamID string) (*TeamView, error) {
	var out TeamView
	if err := t.call(ctx, "teams.get", "GET", &out, nil, teamID); err != nil {
		return nil, err
	}
	return &out, nil
}

// Checkout resumes or replaces the team's subscription checkout. Empty tier and interval keep the
// current ones. Level L3, risk billing.
func (t *TeamsClient) Checkout(ctx context.Context, teamID, tier, interval string) (*Checkout, error) {
	body := map[string]string{}
	if tier != "" {
		body["tier"] = tier
	}
	if interval != "" {
		body["interval"] = interval
	}
	var out Checkout
	if err := t.call(ctx, "teams.checkout", "POST", &out, body, teamID, "!checkout"); err != nil {
		return nil, err
	}
	return &out, nil
}

// Invite is an invite code. Code is shown once; only its hash is stored.
type Invite struct {
	Code        string `json:"code"`
	InviteID    string `json:"inviteId"`
	Link        string `json:"link"`
	ExpiresAtMs int64  `json:"expiresAtMs"`
	MaxUses     int    `json:"maxUses"`
}

// InviteOptions configure CreateInvite. Zero values use the server defaults.
type InviteOptions struct {
	ExpiresInHours int `json:"expiresInHours,omitempty"`
	MaxUses        int `json:"maxUses,omitempty"`
}

// CreateInvite creates an invite code (owner). Level L3, risk sharing.
func (t *TeamsClient) CreateInvite(ctx context.Context, teamID string, opts InviteOptions) (*Invite, error) {
	var out Invite
	if err := t.call(ctx, "teams.createInvite", "POST", &out, opts, teamID, "!invites"); err != nil {
		return nil, err
	}
	return &out, nil
}

// RevokeInvite revokes an invite code (owner). Level L3, risk sharing.
func (t *TeamsClient) RevokeInvite(ctx context.Context, teamID, inviteID string) error {
	return t.call(ctx, "teams.revokeInvite", "POST", nil, map[string]any{}, teamID, "!invites", inviteID, "!revoke")
}

// InvitePreview is what an invite code shows before joining.
type InvitePreview struct {
	TeamName    string       `json:"teamName"`
	MemberCount int          `json:"memberCount"`
	MemberLimit int          `json:"memberLimit"`
	Colors      ColorChoices `json:"colors"`
}

// PreviewInvite returns the team name, size and free colors for an invite code. Level L2, risk read.
func (t *TeamsClient) PreviewInvite(ctx context.Context, code string) (*InvitePreview, error) {
	var out InvitePreview
	if err := t.call(ctx, "teams.previewInvite", "POST", &out, map[string]string{"code": code}, "!join", "!preview"); err != nil {
		return nil, err
	}
	return &out, nil
}

// JoinRequest joins a team. Color must be a free member color from PreviewInvite.
type JoinRequest struct {
	Code        string `json:"code"`
	Color       string `json:"color"`
	DisplayName string `json:"displayName,omitempty"`
	DeviceName  string `json:"deviceName,omitempty"`
}

// JoinResult is the result of Join.
type JoinResult struct {
	TeamID        string `json:"teamId"`
	AlreadyMember bool   `json:"alreadyMember"`
}

// Join joins a team with an invite code. Level L3, risk sharing.
func (t *TeamsClient) Join(ctx context.Context, req JoinRequest) (*JoinResult, error) {
	var out JoinResult
	if err := t.call(ctx, "teams.join", "POST", &out, req, "!join"); err != nil {
		return nil, err
	}
	return &out, nil
}

// MemberUpdate changes how you appear in a team. Nil fields are left as they are.
type MemberUpdate struct {
	DisplayName *string `json:"displayName,omitempty"`
	Color       *string `json:"color,omitempty"`
}

// UpdateMe changes your display name or color in a team. Level L2, risk write.
func (t *TeamsClient) UpdateMe(ctx context.Context, teamID string, u MemberUpdate) error {
	return t.call(ctx, "teams.updateMe", "PATCH", nil, u, teamID, "!me")
}

// Leave leaves a team; the personal workspaces you shared with it are unshared. The owner must
// transfer or delete the team instead. Level L3, risk destructive.
func (t *TeamsClient) Leave(ctx context.Context, teamID string) error {
	return t.call(ctx, "teams.leave", "POST", nil, map[string]any{}, teamID, "!leave")
}

// TeamWorkspace is a workspace owned by a team. Its files use the workspace routes in StorageRoutes
// (/v3/cloud/<id> and /v2/workspaces/<id>/cloud) with the member's Firebase token; Access is "read"
// for viewers and "write" otherwise.
type TeamWorkspace struct {
	ID               string            `json:"id"`
	TeamID           string            `json:"teamId"`
	Name             string            `json:"name"`
	Scope            string            `json:"scope"`
	CustomStorage    bool              `json:"customStorage"`
	RequiredPlans    map[string]any    `json:"requiredPlans"`
	PlansStatus      string            `json:"plansStatus"`
	QuotaGB          float64           `json:"quotaGB"`
	NeedsCustomSetup bool              `json:"needsCustomSetup"`
	UsedBytes        int64             `json:"usedBytes"`
	StorageRoutes    map[string]string `json:"storageRoutes"`
	ProjectStatus    string            `json:"projectStatus"`
	Access           string            `json:"access"`
}

// SharedWorkspace is a member's personal workspace shown to the team (view only).
type SharedWorkspace struct {
	ID       string `json:"id"`
	Scope    string `json:"scope"`
	Name     string `json:"name"`
	SharedBy struct {
		MemberID    string `json:"memberId"`
		DisplayName string `json:"displayName"`
	} `json:"sharedBy"`
	Mine       bool   `json:"mine"`
	Permission string `json:"permission"`
}

// TeamWorkspaces lists a team's workspaces.
type TeamWorkspaces struct {
	TeamWorkspaces     []TeamWorkspace   `json:"teamWorkspaces"`
	SharedWorkspaces   []SharedWorkspace `json:"sharedWorkspaces"`
	SubscriptionActive bool              `json:"subscriptionActive"`
}

// Workspaces lists the team workspaces and the shared personal workspaces. Level L2, risk read.
func (t *TeamsClient) Workspaces(ctx context.Context, teamID string) (*TeamWorkspaces, error) {
	var out TeamWorkspaces
	if err := t.call(ctx, "teams.workspaces", "GET", &out, nil, teamID, "!workspaces"); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateWorkspaceRequest creates a team workspace. Plans carries the storage and performance plan
// ids, for example {"storageTier":"100GB","performanceTier":"boost"}; Storage is "managed" (default)
// or "custom".
type CreateWorkspaceRequest struct {
	IntentID string         `json:"intentId"`
	Name     string         `json:"name"`
	Storage  string         `json:"storage,omitempty"`
	Plans    map[string]any `json:"plans"`
}

// CreatedWorkspace is the result of CreateWorkspace.
type CreatedWorkspace struct {
	Workspace TeamWorkspace `json:"workspace"`
	Checkout
}

// CreateWorkspace creates a team workspace and opens its plans checkout (owner). Level L3, risk billing.
func (t *TeamsClient) CreateWorkspace(ctx context.Context, teamID string, req CreateWorkspaceRequest) (*CreatedWorkspace, error) {
	if !uuidRe.MatchString(req.IntentID) {
		return nil, errors.New("gendragoon: IntentID must be a UUID")
	}
	var out CreatedWorkspace
	if err := t.call(ctx, "teams.createWorkspace", "POST", &out, req, teamID, "!workspaces"); err != nil {
		return nil, err
	}
	return &out, nil
}

// CheckoutWorkspace resumes a team workspace's plans checkout (owner). Level L3, risk billing.
func (t *TeamsClient) CheckoutWorkspace(ctx context.Context, teamID, workspaceID string) (*Checkout, error) {
	var out Checkout
	if err := t.call(ctx, "teams.checkoutWorkspace", "POST", &out, map[string]any{}, teamID, "!workspaces", workspaceID, "!checkout"); err != nil {
		return nil, err
	}
	return &out, nil
}

// Share shows one of your personal workspaces to the team, view only. Level L3, risk sharing.
func (t *TeamsClient) Share(ctx context.Context, teamID, workspaceID string) error {
	return t.call(ctx, "teams.share", "POST", nil, map[string]string{"workspaceId": workspaceID}, teamID, "!shares")
}

// Unshare stops showing a personal workspace to the team. Level L3, risk sharing.
func (t *TeamsClient) Unshare(ctx context.Context, teamID, workspaceID string) error {
	return t.call(ctx, "teams.unshare", "DELETE", nil, nil, teamID, "!shares", workspaceID)
}

// ChatCard is a workspace card attached to a message.
type ChatCard struct {
	Scope       string `json:"scope"` // team or personal
	WorkspaceID string `json:"workspaceId"`
	Name        string `json:"name,omitempty"`
}

// ChatMessage is one chat message. Kind "removed" has empty Text and a Removed reason.
type ChatMessage struct {
	Seq     int64          `json:"seq"`
	Kind    string         `json:"kind"`
	Text    string         `json:"text"`
	Card    *ChatCard      `json:"card"`
	Removed map[string]any `json:"removed,omitempty"`
	Raw     map[string]any `json:"-"`
}

// UnmarshalJSON keeps every field the server sends in Raw.
func (m *ChatMessage) UnmarshalJSON(b []byte) error {
	type plain ChatMessage
	if err := json.Unmarshal(b, (*plain)(m)); err != nil {
		return err
	}
	return json.Unmarshal(b, &m.Raw)
}

// ChatPage is one page of chat.
type ChatPage struct {
	Messages    []ChatMessage `json:"messages"`
	LatestSeq   int64         `json:"latestSeq"`
	PollAfterMs int           `json:"pollAfterMs"`
}

// Messages returns chat messages with a sequence number above after (0 for the latest page). limit 0
// uses the server default. Level L2, risk read.
func (t *TeamsClient) Messages(ctx context.Context, teamID string, after int64, limit int) (*ChatPage, error) {
	q := "?after=" + strconv.FormatInt(after, 10)
	if limit > 0 {
		q += "&limit=" + strconv.Itoa(limit)
	}
	var out ChatPage
	if err := t.call(ctx, "teams.chat.list", "GET", &out, nil, teamID, "!chat"+q); err != nil {
		return nil, err
	}
	return &out, nil
}

// WatchChat polls the chat and sends new messages until ctx ends or you lose access to the team; the
// channel is closed then. It waits pollAfterMs between polls (at least interval when interval > 0).
// The server also offers Server-Sent Events at /chat/stream; this SDK polls. Level L2, risk read.
func (t *TeamsClient) WatchChat(ctx context.Context, teamID string, after int64, interval time.Duration) (<-chan ChatMessage, error) {
	if err := t.acct.check("teams.chat.watch"); err != nil {
		return nil, err
	}
	ch := make(chan ChatMessage, 64)
	go func() {
		defer close(ch)
		wait := 3 * time.Second
		for {
			p, err := t.Messages(ctx, teamID, after, 100)
			var ae *APIError
			if errors.As(err, &ae) && (ae.Status == 401 || ae.Status == 403 || ae.Status == 404) {
				return
			}
			if err == nil {
				for _, m := range p.Messages {
					if m.Seq <= after {
						continue
					}
					select {
					case ch <- m:
						after = m.Seq
					case <-ctx.Done():
						return
					}
				}
				if p.PollAfterMs > 0 {
					wait = time.Duration(p.PollAfterMs) * time.Millisecond
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(max(wait, interval)):
			}
		}
	}()
	return ch, nil
}

// Post posts a text message. Level L2, risk write.
func (t *TeamsClient) Post(ctx context.Context, teamID, text string) (*ChatMessage, error) {
	return t.post(ctx, teamID, map[string]any{"text": text})
}

// PostCard posts a workspace card with optional text. A personal-workspace card also shares that
// workspace with the team, so it is checked at the sharing level as well. Level L2, risk write.
func (t *TeamsClient) PostCard(ctx context.Context, teamID string, card ChatCard, text string) (*ChatMessage, error) {
	if card.Scope == "personal" {
		if err := t.acct.check("teams.share"); err != nil {
			return nil, err
		}
	}
	return t.post(ctx, teamID, map[string]any{"text": text, "card": map[string]string{"scope": card.Scope, "workspaceId": card.WorkspaceID}})
}

func (t *TeamsClient) post(ctx context.Context, teamID string, body map[string]any) (*ChatMessage, error) {
	var out struct {
		Message ChatMessage `json:"message"`
	}
	if err := t.call(ctx, "teams.chat.post", "POST", &out, body, teamID, "!chat"); err != nil {
		return nil, err
	}
	return &out.Message, nil
}

// Report reports a message to the platform. category is spam, abuse, harassment, illegal or other.
// Level L2, risk write.
func (t *TeamsClient) Report(ctx context.Context, teamID string, seq int64, category, note string) error {
	return t.call(ctx, "teams.chat.report", "POST", nil, map[string]string{"category": category, "note": note}, teamID, "!chat", strconv.FormatInt(seq, 10), "!report")
}

// DeleteMessage removes a message (owner; a reason is required). Level L3, risk destructive.
func (t *TeamsClient) DeleteMessage(ctx context.Context, teamID string, seq int64, reason string) error {
	return t.call(ctx, "teams.chat.delete", "POST", nil, map[string]string{"reason": reason}, teamID, "!chat", strconv.FormatInt(seq, 10), "!delete")
}

func (t *TeamsClient) moderate(ctx context.Context, action, teamID, memberID, reason string, until *time.Time) error {
	body := map[string]any{"reason": reason}
	if until != nil {
		body["until"] = until.UnixMilli()
	}
	return t.call(ctx, "teams.members."+action, "POST", nil, body, teamID, "!members", memberID, "!"+action)
}

// Mute mutes a member until a time, or until lifted when until is nil (owner; a reason is required).
// Level L3, risk destructive.
func (t *TeamsClient) Mute(ctx context.Context, teamID, memberID, reason string, until *time.Time) error {
	return t.moderate(ctx, "mute", teamID, memberID, reason, until)
}

// Unmute lifts a mute (owner). Level L3, risk write.
func (t *TeamsClient) Unmute(ctx context.Context, teamID, memberID, reason string) error {
	return t.moderate(ctx, "unmute", teamID, memberID, reason, nil)
}

// Kick removes a member; they can rejoin with a new invite (owner; a reason is required).
// Level L3, risk destructive.
func (t *TeamsClient) Kick(ctx context.Context, teamID, memberID, reason string) error {
	return t.moderate(ctx, "kick", teamID, memberID, reason, nil)
}

// Ban removes a member and blocks rejoining until a time, or for good when until is nil (owner; a
// reason is required). Level L3, risk destructive.
func (t *TeamsClient) Ban(ctx context.Context, teamID, memberID, reason string, until *time.Time) error {
	return t.moderate(ctx, "ban", teamID, memberID, reason, until)
}

// SetRole makes a member a "viewer" (read team files) or a "member" (read and write) (owner).
// Level L3, risk sharing.
func (t *TeamsClient) SetRole(ctx context.Context, teamID, memberID, role string) error {
	if role != "viewer" && role != "member" {
		return errors.New(`gendragoon: role must be "viewer" or "member"`)
	}
	return t.call(ctx, "teams.members.setRole", "POST", nil, map[string]string{"role": role}, teamID, "!members", memberID, "!role")
}

// AuditEntry is one entry of a team's hash-chained audit log.
type AuditEntry struct {
	Seq     int64   `json:"seq"`
	Prev    string  `json:"prev"`
	Hash    string  `json:"hash"`
	Action  string  `json:"action"`
	Actor   string  `json:"actor"`
	Target  *string `json:"target"`
	Reason  *string `json:"reason"`
	UntilMs *int64  `json:"untilMs,omitempty"`
	Source  string  `json:"source"`
	Rule    *string `json:"rule"`
	AtMs    int64   `json:"atMs"`
}

// Audit returns the team's audit log, oldest first (owner). Level L2, risk read.
func (t *TeamsClient) Audit(ctx context.Context, teamID string) ([]AuditEntry, error) {
	var out struct {
		Entries []AuditEntry `json:"entries"`
	}
	return out.Entries, t.call(ctx, "teams.audit", "GET", &out, nil, teamID, "!audit")
}

// VerifyAuditChain checks that entries are consecutive and that each links to the previous hash. It
// detects removed, reordered or inserted entries. The digests themselves are recomputed by the server.
func VerifyAuditChain(entries []AuditEntry) bool {
	prev := strings.Repeat("0", 64)
	for i, e := range entries {
		if e.Seq != int64(i+1) || e.Prev != prev || len(e.Hash) != 64 {
			return false
		}
		prev = e.Hash
	}
	return true
}

// TransferRequest hands the team to another member. Color is the member color you take after the
// handover; OwnerShade is the new owner's shade.
type TransferRequest struct {
	MemberID   string `json:"memberId"`
	Color      string `json:"color"`
	OwnerShade string `json:"ownerShade,omitempty"`
}

// Transfer hands the team to another member (owner). Billing stays with the current payer until it
// lapses. Level L4, risk sharing.
func (t *TeamsClient) Transfer(ctx context.Context, teamID string, req TransferRequest) error {
	return t.call(ctx, "teams.transfer", "POST", nil, req, teamID, "!transfer")
}

// Delete deletes the team, its chat and its team workspaces with their files, and cancels its
// subscriptions (owner). confirmName must equal the team name. Level L4, risk bulk-destructive.
func (t *TeamsClient) Delete(ctx context.Context, teamID, confirmName string) error {
	return t.call(ctx, "teams.delete", "POST", nil, map[string]string{"confirmName": confirmName}, teamID, "!delete")
}
