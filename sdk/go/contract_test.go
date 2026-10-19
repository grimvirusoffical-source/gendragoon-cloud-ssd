package gendragoon_test

// Shared contract suite (sdk/spec/CONTRACT.md) against a local backend. Set GD_SDK_BASE to a running
// provider_dev_server, or GD_DEV_SERVER to its script path to start one; otherwise these tests skip.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	gd "github.com/grimvirusoffical-source/gendragoon-apps/sdk/go"
)

var (
	serverOnce sync.Once
	serverBase string
	serverErr  error
	serverIn   any // the server's stdin; it exits when this closes (with the test binary)
)

func base(t *testing.T) string {
	t.Helper()
	serverOnce.Do(func() {
		if b := os.Getenv("GD_SDK_BASE"); b != "" {
			serverBase = b
			return
		}
		script := os.Getenv("GD_DEV_SERVER")
		if script == "" {
			return
		}
		cmd := exec.Command("node", script, "--exit-with-stdin")
		cmd.Env = append(os.Environ(), "PROVIDER_V1_ENABLED=true")
		cmd.Stderr = os.Stderr
		stdin, _ := cmd.StdinPipe()
		out, _ := cmd.StdoutPipe()
		if serverErr = cmd.Start(); serverErr != nil {
			return
		}
		serverIn = stdin
		var info struct{ Base string }
		line, err := bufio.NewReader(out).ReadBytes('\n')
		if err == nil {
			err = json.Unmarshal(line, &info)
		}
		serverBase, serverErr = info.Base, err
	})
	if serverErr != nil {
		t.Fatal(serverErr)
	}
	if serverBase == "" {
		t.Skip("set GD_SDK_BASE or GD_DEV_SERVER to run the contract suite")
	}
	return serverBase
}

func uid() string { b := make([]byte, 6); rand.Read(b); return "u" + hex.EncodeToString(b) }

type rig struct {
	acct    *gd.AccountClient
	client  *gd.Client
	conn    *gd.Connection
	keys    *gd.Keyring
	baseURL string
}

func account(b, user string, opts *gd.Options) *gd.AccountClient {
	return gd.NewAccountClient(b, func(context.Context) (string, error) { return "dev-user:" + user, nil }, opts)
}

func connect(t *testing.T, workspace string, opts *gd.Options) *rig {
	t.Helper()
	b := base(t)
	ctx := context.Background()
	acct := account(b, uid(), nil)
	g, err := acct.CreateGrant(ctx, workspace, gd.ClientInfo{Name: "Go contract", Host: "test"})
	if err != nil {
		t.Fatal(err)
	}
	conn, err := gd.NewConnector(b, opts).RedeemGrant(ctx, g.Grant, gd.ClientInfo{Name: "Go contract"})
	if err != nil {
		t.Fatal(err)
	}
	c, err := gd.NewClient(b, conn.APIKey, opts)
	if err != nil {
		t.Fatal(err)
	}
	return &rig{acct: acct, client: c, conn: conn, keys: c.NewKeyring(), baseURL: b}
}

func (r *rig) unlockNew(t *testing.T) {
	t.Helper()
	if err := r.client.CreateMasterKey(context.Background(), r.keys, "contract passphrase"); err != nil {
		t.Fatal(err)
	}
}

var ctx = context.Background()

func TestC01ConnectWithGrant(t *testing.T) {
	r := connect(t, "ws", nil)
	if err := r.client.Health(ctx); err != nil {
		t.Fatal(err)
	}
	caps, err := r.client.Capabilities(ctx)
	if err != nil || !caps.Events.Poll || caps.MaxBlobBytes != 16<<20 {
		t.Fatal("capabilities", caps, err)
	}
	_, err = gd.NewConnector(r.baseURL, nil).RedeemGrant(ctx, "gdpg_"+string(bytes.Repeat([]byte("A"), 43)), gd.ClientInfo{})
	var ae *gd.APIError
	if !errors.As(err, &ae) || ae.Code != "invalid_grant" {
		t.Fatal("unknown grant", err)
	}
}

func TestC02ConnectWithPKCE(t *testing.T) {
	b := base(t)
	acct := account(b, uid(), nil)
	p := gd.NewPKCE()
	link, err := gd.ConnectLink(gd.ClientInfo{Name: "Go contract"}, p, "http://127.0.0.1:9/cb")
	if err != nil {
		t.Fatal(err)
	}
	req, err := gd.ParseConnectLink(link)
	if err != nil {
		t.Fatal(err)
	}
	redirect, err := acct.Authorize(ctx, "ws", req)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(redirect)
	if u.Query().Get("state") != p.State {
		t.Fatal("state not echoed")
	}
	k := gd.NewConnector(b, nil)
	if _, err := k.ExchangeCode(ctx, u.Query().Get("code"), gd.NewPKCE().Verifier); err == nil {
		t.Fatal("wrong verifier accepted")
	}
	conn, err := k.ExchangeCode(ctx, u.Query().Get("code"), p.Verifier)
	if err != nil || conn.WorkspaceID != "ws" {
		t.Fatal("exchange", err)
	}
}

func TestC03MasterKeyLifecycle(t *testing.T) {
	r := connect(t, "ws", nil)
	r.unlockNew(t)
	if err := r.client.CreateMasterKey(ctx, r.client.NewKeyring(), "contract passphrase"); !errors.Is(err, gd.ErrPreconditionFailed) {
		t.Fatal("second create", err)
	}
	k2 := r.client.NewKeyring()
	if err := r.client.Unlock(ctx, k2, "not the passphrase"); !errors.Is(err, gd.ErrWrongPassphrase) {
		t.Fatal("wrong passphrase", err)
	}
	if err := r.client.ChangePassphrase(ctx, r.keys, "a brand new passphrase"); err != nil {
		t.Fatal(err)
	}
	if err := r.client.Unlock(ctx, k2, "a brand new passphrase"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.keys.ExportMasterKey(); err == nil {
		t.Fatal("L4 export allowed by default")
	}
}

func TestC04EncryptedFilesAndFolders(t *testing.T) {
	r := connect(t, "ws", nil)
	r.unlockNew(t)
	d, _ := r.client.OpenDrive("saves", r.keys, &gd.DriveOptions{ChunkSize: 1024})
	data := make([]byte, 5000)
	rand.Read(data)
	if err := d.Mkdir(ctx, "levels/1"); err != nil {
		t.Fatal(err)
	}
	e, err := d.WriteFile(ctx, "slots/slot1.sav", data, nil)
	if err != nil || len(e.Chunks) != 5 {
		t.Fatal(err)
	}
	got, err := d.ReadFile(ctx, "slots/slot1.sav")
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("read back", err)
	}
	root, _ := d.List(ctx, "")
	if len(root) != 2 || root[0].Name != "levels" || root[1].Name != "slots" || !root[0].Folder {
		t.Fatalf("root listing %+v", root)
	}
	if err := d.Move(ctx, "slots/slot1.sav", "slots/slot2.sav"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Stat(ctx, "slots/slot2.sav"); err != nil {
		t.Fatal(err)
	}
	if err := d.Delete(ctx, "levels"); err == nil {
		t.Fatal("deleted a non-empty folder")
	}
	if n, err := d.DeleteFolder(ctx, "levels"); err != nil || n != 0 {
		t.Fatal(err)
	}
	if err := d.Delete(ctx, "slots/slot2.sav"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ReadFile(ctx, "slots/slot2.sav"); !errors.Is(err, gd.ErrNotFound) {
		t.Fatal("deleted file still readable", err)
	}
	// Stored bytes are ciphertext.
	blobs, _ := r.client.AllBlobs(ctx)
	for _, b := range blobs {
		raw, _ := r.client.GetBlob(ctx, b.ID)
		if bytes.Contains(raw, data[:64]) {
			t.Fatal("plaintext stored")
		}
	}
}

func TestC05PlainDrive(t *testing.T) {
	r := connect(t, "ws", nil)
	d, _ := r.client.OpenDrive("public", nil, &gd.DriveOptions{Plain: true})
	if _, err := d.WriteFile(ctx, "readme.txt", []byte("hello"), nil); err != nil {
		t.Fatal(err)
	}
	e, _ := d.Stat(ctx, "readme.txt")
	if e.Chunks[0] != "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" || e.FileKey != "" {
		t.Fatal("plain chunk is not content-addressed", e)
	}
}

func TestC06ConcurrentWriters(t *testing.T) {
	r := connect(t, "ws", nil)
	r.unlockNew(t)
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for w := 0; w < 2; w++ {
		d, _ := r.client.OpenDrive("shared", r.keys, nil)
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < 10; i++ {
				if _, err := d.WriteFile(ctx, fmt.Sprintf("w%d/f%d", w, i), []byte{byte(i)}, nil); err != nil {
					errs <- err
				}
			}
		}(w)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	d, _ := r.client.OpenDrive("shared", r.keys, nil)
	snap, _ := d.Snapshot(ctx)
	if len(snap.Files) != 20 {
		t.Fatalf("lost writes: %d files", len(snap.Files))
	}
}

func TestC07Quota(t *testing.T) {
	r := connect(t, "small", nil)
	d, _ := r.client.OpenDrive("big", nil, &gd.DriveOptions{Plain: true})
	_, err := d.WriteFile(ctx, "too-big.bin", make([]byte, 100<<10), nil)
	if !errors.Is(err, gd.ErrQuotaExceeded) {
		t.Fatal("quota", err)
	}
	u, _ := r.client.Usage(ctx)
	if u.QuotaBytes != 64<<10 || u.UsedBytes > u.QuotaBytes {
		t.Fatalf("usage %+v", u)
	}
}

func TestC08Gate(t *testing.T) {
	r := connect(t, "ws", &gd.Options{Gate: gd.LevelGate(gd.L2)})
	d, _ := r.client.OpenDrive("x", nil, &gd.DriveOptions{Plain: true})
	_, err := d.DeleteFolder(ctx, "a")
	var le *gd.LevelError
	if !errors.As(err, &le) || le.Op.ID != "files.deleteFolder" || le.Op.Level != gd.L3 {
		t.Fatal("L2 client ran an L3 call", err)
	}
	if _, err := r.client.Wipe(ctx); !errors.As(err, &le) {
		t.Fatal("wipe not gated")
	}
}

func TestC09Events(t *testing.T) {
	r := connect(t, "ws", nil)
	r.unlockNew(t)
	d, _ := r.client.OpenDrive("watched", r.keys, nil)
	wctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	ch, err := r.client.Watch(wctx, gd.WatchOptions{Interval: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(1200 * time.Millisecond) // first poll records the baseline
	next := func(want gd.EventType) gd.Event {
		for e := range ch {
			if e.Type == want {
				return e
			}
		}
		t.Fatalf("no %s event", want)
		return gd.Event{}
	}
	d.WriteFile(ctx, "a", []byte("1"), nil)
	if e := next(gd.ManifestCreated); e.Key != d.ManifestKey() {
		t.Fatal("created event for another key")
	}
	d.WriteFile(ctx, "a", []byte("2"), nil)
	next(gd.ManifestUpdated)
	if err := r.acct.RevokeBinding(ctx, r.conn.BindingID); err != nil {
		t.Fatal(err)
	}
	next(gd.BindingRevoked)
}

func TestC10Sharing(t *testing.T) {
	r := connect(t, "ws", nil)
	r.unlockNew(t)
	d, _ := r.client.OpenDrive("docs", r.keys, nil)
	d.WriteFile(ctx, "letter.txt", []byte("for your eyes only"), nil)
	rk, err := r.client.CreateReadKey(ctx, "recipient", 1)
	if err != nil {
		t.Fatal(err)
	}
	reader, _ := gd.NewClient(r.baseURL, rk.APIKey, nil)
	id, _ := reader.NewIdentity()
	share, err := d.ExportShare(ctx, "letter.txt", id.Public())
	if err != nil {
		t.Fatal(err)
	}
	f, data, err := reader.OpenShare(ctx, id, share)
	if err != nil || f.Path != "letter.txt" || string(data) != "for your eyes only" {
		t.Fatal("open share", err)
	}
	other, _ := reader.NewIdentity()
	if _, _, err := reader.OpenShare(ctx, other, share); err == nil {
		t.Fatal("share opened by the wrong recipient")
	}
	if _, err := reader.PutSealedBlob(ctx, hex.EncodeToString(make([]byte, 32)), []byte("x")); err == nil {
		t.Fatal("read key wrote")
	}
	if err := r.client.Unlock(ctx, reader.NewKeyring(), "contract passphrase"); err != nil {
		t.Fatal("owner unlock", err)
	}
	if err := reader.Unlock(ctx, reader.NewKeyring(), "contract passphrase"); err == nil {
		t.Fatal("read key could read the key envelope")
	}
	keys, _ := r.client.ListReadKeys(ctx)
	if len(keys) != 1 || keys[0].APIKey != "" {
		t.Fatal("list read keys", keys)
	}
	r.client.RevokeReadKey(ctx, rk.KeyID)
	if _, _, err := reader.OpenShare(ctx, id, share); !errors.Is(err, gd.ErrUnauthorized) {
		t.Fatal("revoked read key still works", err)
	}
}

func TestC11Sync(t *testing.T) {
	r := connect(t, "ws", nil)
	r.unlockNew(t)
	d, _ := r.client.OpenDrive("sync", r.keys, nil)
	src, dst := t.TempDir(), t.TempDir()
	os.MkdirAll(filepath.Join(src, "a/b"), 0o755)
	os.WriteFile(filepath.Join(src, "a/b/one.txt"), []byte("one"), 0o644)
	os.WriteFile(filepath.Join(src, "two.txt"), []byte("two"), 0o644)
	rep, err := d.Push(ctx, src, gd.SyncOptions{Prefix: "backup"})
	if err != nil || len(rep.Uploaded) != 2 {
		t.Fatal("push", rep, err)
	}
	if rep, _ := d.Push(ctx, src, gd.SyncOptions{Prefix: "backup"}); len(rep.Uploaded) != 0 || rep.Unchanged != 2 {
		t.Fatal("second push uploaded again", rep)
	}
	if rep, err := d.Pull(ctx, dst, gd.SyncOptions{Prefix: "backup"}); err != nil || len(rep.Downloaded) != 2 {
		t.Fatal("pull", rep, err)
	}
	if b, _ := os.ReadFile(filepath.Join(dst, "a/b/one.txt")); string(b) != "one" {
		t.Fatal("pulled content")
	}
	os.Remove(filepath.Join(src, "two.txt"))
	dry, _ := d.Mirror(ctx, src, gd.ToDrive, gd.SyncOptions{Prefix: "backup", DryRun: true})
	if len(dry.Deleted) != 1 || dry.Deleted[0] != "backup/two.txt" {
		t.Fatal("dry run", dry)
	}
	if _, err := d.Stat(ctx, "backup/two.txt"); err != nil {
		t.Fatal("dry run deleted")
	}
	d.Mirror(ctx, src, gd.ToDrive, gd.SyncOptions{Prefix: "backup"})
	if _, err := d.Stat(ctx, "backup/two.txt"); !errors.Is(err, gd.ErrNotFound) {
		t.Fatal("mirror kept a deleted file")
	}
}

func TestC12GarbageAndWipe(t *testing.T) {
	r := connect(t, "ws", &gd.Options{Gate: gd.LevelGate(gd.L4)})
	r.unlockNew(t)
	d, _ := r.client.OpenDrive("g", r.keys, nil)
	d.WriteFile(ctx, "keep", []byte("keep"), nil)
	d.WriteFile(ctx, "drop", []byte("drop"), nil)
	d.Delete(ctx, "drop")
	n, err := r.client.CollectGarbage(ctx, r.keys, false)
	if err != nil || n != 1 {
		t.Fatal("gc", n, err)
	}
	if b, err := d.ReadFile(ctx, "keep"); err != nil || string(b) != "keep" {
		t.Fatal("gc removed a live blob")
	}
	if _, err := r.client.CollectGarbage(ctx, nil, false); err == nil {
		t.Fatal("gc ran without being able to read the drives")
	}
	if _, err := r.client.Wipe(ctx); err != nil {
		t.Fatal(err)
	}
	if m, _ := r.client.AllManifests(ctx); len(m) != 0 {
		t.Fatal("wipe left manifests")
	}
	if u, _ := r.client.Usage(ctx); u.UsedBytes != 0 || u.ObjectCount != 0 {
		t.Fatalf("usage after wipe %+v", u)
	}
}

func TestC13RotateKey(t *testing.T) {
	r := connect(t, "ws", nil)
	old := r.client.APIKey()
	nk, err := r.client.RotateAPIKey(ctx)
	if err != nil || nk == old {
		t.Fatal(err)
	}
	if err := r.client.Health(ctx); err != nil {
		t.Fatal("new key", err)
	}
}

func TestC14AccountBindings(t *testing.T) {
	r := connect(t, "ws", nil)
	d, _ := r.client.OpenDrive("p", nil, &gd.DriveOptions{Plain: true})
	d.WriteFile(ctx, "x", []byte("12345"), nil)
	list, err := r.acct.ListBindings(ctx)
	if err != nil || len(list) != 1 || !list[0].Active || list[0].UsedBytes == 0 {
		t.Fatal("bindings", list, err)
	}
	var le *gd.LevelError
	if _, err := r.acct.RevokeAndDelete(ctx, list[0].ID); !errors.As(err, &le) {
		t.Fatal("L4 revoke-and-delete allowed by default")
	}
	full := gd.NewAccountClient(r.baseURL, func(context.Context) (string, error) {
		return "dev-user:" + "nobody", nil
	}, &gd.Options{Gate: gd.LevelGate(gd.L4)})
	if _, err := full.RevokeAndDelete(ctx, list[0].ID); !errors.Is(err, gd.ErrNotFound) {
		t.Fatal("another account revoked the binding", err)
	}
}
