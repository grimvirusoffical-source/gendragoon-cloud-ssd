package gendragoon_test

// Teams contract suite (sdk/spec/CONTRACT.md, T01-T10) against contract/teams_dev_server.cjs. Set
// GD_TEAMS_ORIGIN to a running server, or GD_TEAMS_SERVER to the script path (with GD_TEAMS_BACKEND)
// to start one; otherwise the suite skips.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"testing"
	"time"

	gd "github.com/grimvirusoffical-source/gendragoon-apps/sdk/go"
)

func teamsOrigin(t *testing.T) string {
	if o := os.Getenv("GD_TEAMS_ORIGIN"); o != "" {
		return o
	}
	script := os.Getenv("GD_TEAMS_SERVER")
	if script == "" {
		t.Skip("set GD_TEAMS_ORIGIN or GD_TEAMS_SERVER to run the Teams contract suite")
	}
	cmd := exec.Command("node", script, "--exit-with-stdin")
	cmd.Stderr = os.Stderr
	stdin, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stdin.Close(); cmd.Wait() })
	line, err := bufio.NewReader(out).ReadBytes('\n')
	var info struct{ Origin string }
	if err == nil {
		err = json.Unmarshal(line, &info)
	}
	if err != nil {
		t.Fatal(err)
	}
	return info.Origin
}

func uuid4() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func devPay(t *testing.T, origin, checkoutURL string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"url": checkoutURL})
	r, err := http.Post(origin+"/__dev/pay", "application/json", bytes.NewReader(body))
	if err != nil || r.StatusCode != 200 {
		t.Fatalf("dev pay: %v %v", err, r)
	}
	r.Body.Close()
}

func status(err error) int {
	var ae *gd.APIError
	if errors.As(err, &ae) {
		return ae.Status
	}
	return 0
}

func TestTeamsContract(t *testing.T) {
	origin := teamsOrigin(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	user := func(uid string, max gd.Level) *gd.TeamsClient {
		return gd.NewTeamsClient(origin, func(context.Context) (string, error) { return "dev-user:" + uid, nil }, &gd.Options{Gate: gd.LevelGate(max)})
	}
	alice, bob := user("alice"+uuid4()[:8], gd.L3), user("bob"+uuid4()[:8], gd.L3)
	var teamID, bobID string
	var lastSeq int64

	t.Run("T01 catalog", func(t *testing.T) {
		c, err := alice.Catalog(ctx)
		if err != nil || len(c["tiers"].([]any)) < 3 {
			t.Fatal(err, c)
		}
	})
	t.Run("T02 create and pay", func(t *testing.T) {
		if _, err := user("x", gd.L2).Create(ctx, gd.CreateTeamRequest{IntentID: uuid4(), Name: "Studio", Tier: "team"}); !errors.As(err, new(*gd.LevelError)) {
			t.Fatalf("L2 gate allowed teams.create: %v", err)
		}
		r, err := alice.Create(ctx, gd.CreateTeamRequest{IntentID: uuid4(), Name: "Studio", Tier: "team", Interval: "month"})
		if err != nil || r.URL == "" || r.Team.Role != "owner" {
			t.Fatal(err, r)
		}
		teamID = r.Team.ID
		devPay(t, origin, r.URL)
		list, err := alice.List(ctx)
		if err != nil || len(list) != 1 || !list[0].SubscriptionActive {
			t.Fatal(err, list)
		}
	})
	t.Run("T03 invite, preview, join", func(t *testing.T) {
		inv, err := alice.CreateInvite(ctx, teamID, gd.InviteOptions{MaxUses: 2})
		if err != nil || inv.Code == "" {
			t.Fatal(err)
		}
		p, err := bob.PreviewInvite(ctx, inv.Code)
		if err != nil || p.TeamName != "Studio" {
			t.Fatal(err, p)
		}
		color := ""
		for _, c := range p.Colors.MemberColors {
			if !c.Taken {
				color = c.ID
				break
			}
		}
		j, err := bob.Join(ctx, gd.JoinRequest{Code: inv.Code, Color: color, DisplayName: "Bob"})
		if err != nil || j.TeamID != teamID || j.AlreadyMember {
			t.Fatal(err, j)
		}
		j, err = bob.Join(ctx, gd.JoinRequest{Code: inv.Code, Color: color})
		if err != nil || !j.AlreadyMember {
			t.Fatal(err, j)
		}
		if err := alice.RevokeInvite(ctx, teamID, inv.InviteID); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("T04 view and update me", func(t *testing.T) {
		if err := bob.UpdateMe(ctx, teamID, gd.MemberUpdate{DisplayName: ptr("Bobby")}); err != nil {
			t.Fatal(err)
		}
		v, err := alice.Get(ctx, teamID)
		if err != nil || len(v.Team.Members) != 2 {
			t.Fatal(err, v)
		}
		for _, m := range v.Team.Members {
			if m.Role == "member" {
				bobID = m.MemberID
				if m.DisplayName != "Bobby" {
					t.Fatal("display name not updated")
				}
			}
		}
	})
	t.Run("T05 chat post, list, watch", func(t *testing.T) {
		m, err := bob.Post(ctx, teamID, "hello")
		if err != nil || m.Seq == 0 {
			t.Fatal(err, m)
		}
		lastSeq = m.Seq
		p, err := alice.Messages(ctx, teamID, 0, 0)
		if err != nil || p.LatestSeq != m.Seq || p.Messages[len(p.Messages)-1].Text != "hello" {
			t.Fatal(err, p)
		}
		wctx, stop := context.WithTimeout(ctx, 15*time.Second)
		defer stop()
		ch, err := bob.WatchChat(wctx, teamID, p.LatestSeq, 0)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := alice.Post(ctx, teamID, "welcome"); err != nil {
			t.Fatal(err)
		}
		got := <-ch
		if got.Text != "welcome" {
			t.Fatalf("watch got %+v", got)
		}
	})
	t.Run("T06 report and delete", func(t *testing.T) {
		if err := alice.Report(ctx, teamID, lastSeq, "spam", "test"); err != nil {
			t.Fatal(err)
		}
		if err := bob.DeleteMessage(ctx, teamID, lastSeq, "cleanup"); status(err) != 403 {
			t.Fatalf("member deleted a message: %v", err)
		}
		if err := alice.DeleteMessage(ctx, teamID, lastSeq, "off topic"); err != nil {
			t.Fatal(err)
		}
		p, _ := alice.Messages(ctx, teamID, lastSeq-1, 1)
		if len(p.Messages) == 0 || p.Messages[0].Kind != "removed" {
			t.Fatalf("not removed: %+v", p)
		}
	})
	t.Run("T07 team workspace and roles", func(t *testing.T) {
		w, err := alice.CreateWorkspace(ctx, teamID, gd.CreateWorkspaceRequest{IntentID: uuid4(), Name: "Art", Plans: map[string]any{"storageTier": "100GB", "performanceTier": "boost"}})
		if err != nil || w.URL == "" || w.Workspace.StorageRoutes["v3"] != "/v3/cloud/"+w.Workspace.ID {
			t.Fatal(err, w)
		}
		devPay(t, origin, w.URL)
		if err := alice.SetRole(ctx, teamID, bobID, "viewer"); err != nil {
			t.Fatal(err)
		}
		ws, err := bob.Workspaces(ctx, teamID)
		if err != nil || len(ws.TeamWorkspaces) != 1 || ws.TeamWorkspaces[0].Access != "read" || !ws.SubscriptionActive {
			t.Fatal(err, ws)
		}
		if err := alice.SetRole(ctx, teamID, bobID, "member"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("T08 mute and unmute", func(t *testing.T) {
		if err := alice.Mute(ctx, teamID, bobID, "cool down", nil); err != nil {
			t.Fatal(err)
		}
		if _, err := bob.Post(ctx, teamID, "hi"); status(err) != 403 {
			t.Fatalf("muted member posted: %v", err)
		}
		if err := alice.Unmute(ctx, teamID, bobID, ""); err != nil {
			t.Fatal(err)
		}
		if _, err := bob.Post(ctx, teamID, "back"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("T09 audit", func(t *testing.T) {
		if _, err := bob.Audit(ctx, teamID); status(err) != 403 {
			t.Fatalf("member read the audit log: %v", err)
		}
		a, err := alice.Audit(ctx, teamID)
		if err != nil || len(a) < 4 || !gd.VerifyAuditChain(a) {
			t.Fatal(err, a)
		}
		a[1].Prev = a[0].Prev
		if gd.VerifyAuditChain(a) {
			t.Fatal("tampered chain verified")
		}
	})
	t.Run("T10 levels and removal", func(t *testing.T) {
		if err := alice.Transfer(ctx, teamID, gd.TransferRequest{MemberID: bobID, Color: "blue-500"}); !errors.As(err, new(*gd.LevelError)) {
			t.Fatalf("L3 gate allowed teams.transfer: %v", err)
		}
		if err := alice.Delete(ctx, teamID, "Studio"); !errors.As(err, new(*gd.LevelError)) {
			t.Fatalf("L3 gate allowed teams.delete: %v", err)
		}
		if err := alice.Kick(ctx, teamID, bobID, "done"); err != nil {
			t.Fatal(err)
		}
		if _, err := bob.Get(ctx, teamID); status(err) != 403 && status(err) != 404 {
			t.Fatalf("kicked member still reads the team: %v", err)
		}
	})
}

func ptr[T any](v T) *T { return &v }
