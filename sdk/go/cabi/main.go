// Command cabi builds the GenDragoon C ABI, a shared library for engines and languages that can call C (the
// Unreal plugin in sdk/engines/unreal uses it):
//
//	go build -buildmode=c-shared -o libgendragoon.so ./cabi    (.dylib on macOS, .dll on Windows)
//
// The stable header is sdk/engines/unreal/GenDragoon/Source/ThirdParty/GenDragoonLib/include/gendragoon.h. Every
// function returns a GD_* status, writes results through out parameters, and on failure sets *err to a message the
// caller frees with gd_free. Objects are opaque handles released with gd_release. Calls block; run them off the
// game thread. Levels are enforced exactly as in the Go SDK (max_level < 0 means the default, L3).
package main

/*
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
*/
import "C"

import (
	"context"
	"encoding/json"
	"errors"
	"runtime/cgo"
	"sync"
	"time"
	"unsafe"

	gd "github.com/grimvirusoffical-source/gendragoon-apps/sdk/go"
)

// Status codes; keep in sync with gendragoon.h.
const (
	okStatus           = 0
	errLevel           = 1
	errNotFound        = 2
	errPrecondition    = 3
	errQuota           = 4
	errUnauthorized    = 5
	errWrongPassphrase = 6
	errInvalid         = 7
	errRateLimited     = 8
	errOther           = 9
)

const callTimeout = 5 * time.Minute

func main() {}

var versionOnce sync.Once
var versionStr *C.char

func status(err error, out **C.char) C.int {
	if err == nil {
		return okStatus
	}
	if out != nil {
		*out = C.CString(err.Error())
	}
	var le *gd.LevelError
	var ae *gd.APIError
	switch {
	case errors.As(err, &le):
		return errLevel
	case errors.Is(err, gd.ErrWrongPassphrase):
		return errWrongPassphrase
	case errors.Is(err, gd.ErrNotFound):
		return errNotFound
	case errors.Is(err, gd.ErrPreconditionFailed):
		return errPrecondition
	case errors.Is(err, gd.ErrQuotaExceeded):
		return errQuota
	case errors.Is(err, gd.ErrUnauthorized):
		return errUnauthorized
	case errors.Is(err, gd.ErrRateLimited):
		return errRateLimited
	case errors.As(err, &ae):
		switch ae.Status {
		case 404:
			return errNotFound
		case 412, 409:
			return errPrecondition
		case 401, 403:
			return errUnauthorized
		case 400:
			return errInvalid
		}
	}
	return errOther
}

func invalid(msg string, out **C.char) C.int {
	if out != nil {
		*out = C.CString("gendragoon: " + msg)
	}
	return errInvalid
}

func opts(maxLevel C.int) *gd.Options {
	if maxLevel < 0 {
		return nil
	}
	if maxLevel > 4 {
		maxLevel = 4
	}
	return &gd.Options{Gate: gd.LevelGate(gd.Level(maxLevel))}
}

func ctx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), callTimeout)
}

func handle[T any](h C.uint64_t) (T, bool) {
	var zero T
	if h == 0 {
		return zero, false
	}
	defer func() { recover() }()
	v, ok := cgo.Handle(h).Value().(T)
	return v, ok
}

func newHandle(v any) C.uint64_t { return C.uint64_t(cgo.NewHandle(v)) }

func putJSON(v any, out **C.char, err **C.char) C.int {
	b, e := json.Marshal(v)
	if e != nil {
		return status(e, err)
	}
	*out = C.CString(string(b))
	return okStatus
}

//export gd_version
func gd_version() *C.char {
	versionOnce.Do(func() { versionStr = C.CString(gd.Version) })
	return versionStr
}

//export gd_free
func gd_free(p unsafe.Pointer) { C.free(p) }

//export gd_release
func gd_release(h C.uint64_t) {
	if h == 0 {
		return
	}
	defer func() { recover() }()
	ch := cgo.Handle(h)
	if k, ok := ch.Value().(*gd.Keyring); ok {
		k.Lock()
	}
	ch.Delete()
}

//export gd_connect_grant
func gd_connect_grant(base, grant, appName *C.char, maxLevel C.int, connectionJSON **C.char, err **C.char) C.int {
	if base == nil || grant == nil || appName == nil || connectionJSON == nil {
		return invalid("missing argument", err)
	}
	c, cancel := ctx()
	defer cancel()
	conn, e := gd.NewConnector(C.GoString(base), opts(maxLevel)).RedeemGrant(c, C.GoString(grant), gd.ClientInfo{Name: C.GoString(appName)})
	if e != nil {
		return status(e, err)
	}
	return putJSON(conn, connectionJSON, err)
}

//export gd_client_new
func gd_client_new(base, apiKey *C.char, maxLevel C.int, client *C.uint64_t, err **C.char) C.int {
	if base == nil || apiKey == nil || client == nil {
		return invalid("missing argument", err)
	}
	c, e := gd.NewClient(C.GoString(base), C.GoString(apiKey), opts(maxLevel))
	if e != nil {
		return status(e, err)
	}
	*client = newHandle(c)
	return okStatus
}

//export gd_usage
func gd_usage(client C.uint64_t, usageJSON **C.char, err **C.char) C.int {
	cl, ok := handle[*gd.Client](client)
	if !ok || usageJSON == nil {
		return invalid("invalid client handle", err)
	}
	c, cancel := ctx()
	defer cancel()
	u, e := cl.Usage(c)
	if e != nil {
		return status(e, err)
	}
	return putJSON(u, usageJSON, err)
}

func keyring(client C.uint64_t, passphrase *C.char, create bool, out *C.uint64_t, err **C.char) C.int {
	cl, ok := handle[*gd.Client](client)
	if !ok || passphrase == nil || out == nil {
		return invalid("invalid argument", err)
	}
	c, cancel := ctx()
	defer cancel()
	k := cl.NewKeyring()
	var e error
	if create {
		e = cl.CreateMasterKey(c, k, C.GoString(passphrase))
	} else {
		e = cl.Unlock(c, k, C.GoString(passphrase))
	}
	if e != nil {
		return status(e, err)
	}
	*out = newHandle(k)
	return okStatus
}

//export gd_keyring_unlock
func gd_keyring_unlock(client C.uint64_t, passphrase *C.char, keyringOut *C.uint64_t, err **C.char) C.int {
	return keyring(client, passphrase, false, keyringOut, err)
}

//export gd_keyring_create
func gd_keyring_create(client C.uint64_t, passphrase *C.char, keyringOut *C.uint64_t, err **C.char) C.int {
	return keyring(client, passphrase, true, keyringOut, err)
}

//export gd_drive_open
func gd_drive_open(client C.uint64_t, name *C.char, keyringH C.uint64_t, drive *C.uint64_t, err **C.char) C.int {
	cl, ok := handle[*gd.Client](client)
	if !ok || name == nil || drive == nil {
		return invalid("invalid argument", err)
	}
	var k *gd.Keyring
	o := &gd.DriveOptions{Plain: keyringH == 0}
	if keyringH != 0 {
		if k, ok = handle[*gd.Keyring](keyringH); !ok {
			return invalid("invalid keyring handle", err)
		}
	}
	d, e := cl.OpenDrive(C.GoString(name), k, o)
	if e != nil {
		return status(e, err)
	}
	*drive = newHandle(d)
	return okStatus
}

type entryJSON struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Folder bool   `json:"folder"`
	Size   int64  `json:"size"`
	MTime  int64  `json:"mtimeMs"`
}

//export gd_drive_list
func gd_drive_list(drive C.uint64_t, folder *C.char, entriesJSON **C.char, err **C.char) C.int {
	d, ok := handle[*gd.Drive](drive)
	if !ok || entriesJSON == nil {
		return invalid("invalid drive handle", err)
	}
	f := ""
	if folder != nil {
		f = C.GoString(folder)
	}
	c, cancel := ctx()
	defer cancel()
	list, e := d.List(c, f)
	if e != nil {
		return status(e, err)
	}
	out := make([]entryJSON, 0, len(list))
	for _, x := range list {
		var ms int64
		if !x.MTime.IsZero() {
			ms = x.MTime.UnixMilli()
		}
		out = append(out, entryJSON{x.Name, x.Path, x.Folder, x.Size, ms})
	}
	return putJSON(out, entriesJSON, err)
}

//export gd_drive_read
func gd_drive_read(drive C.uint64_t, path *C.char, data **C.uint8_t, length *C.size_t, err **C.char) C.int {
	d, ok := handle[*gd.Drive](drive)
	if !ok || path == nil || data == nil || length == nil {
		return invalid("invalid argument", err)
	}
	c, cancel := ctx()
	defer cancel()
	b, e := d.ReadFile(c, C.GoString(path))
	if e != nil {
		return status(e, err)
	}
	*data = (*C.uint8_t)(C.CBytes(b))
	*length = C.size_t(len(b))
	return okStatus
}

//export gd_drive_write
func gd_drive_write(drive C.uint64_t, path *C.char, data *C.uint8_t, length C.size_t, err **C.char) C.int {
	d, ok := handle[*gd.Drive](drive)
	if !ok || path == nil || (data == nil && length > 0) {
		return invalid("invalid argument", err)
	}
	c, cancel := ctx()
	defer cancel()
	var b []byte
	if length > 0 {
		b = C.GoBytes(unsafe.Pointer(data), C.int(length))
	}
	_, e := d.WriteFile(c, C.GoString(path), b, nil)
	return status(e, err)
}

func driveOp(drive C.uint64_t, err **C.char, fn func(context.Context, *gd.Drive) error) C.int {
	d, ok := handle[*gd.Drive](drive)
	if !ok {
		return invalid("invalid drive handle", err)
	}
	c, cancel := ctx()
	defer cancel()
	return status(fn(c, d), err)
}

//export gd_drive_delete
func gd_drive_delete(drive C.uint64_t, path *C.char, err **C.char) C.int {
	if path == nil {
		return invalid("missing path", err)
	}
	p := C.GoString(path)
	return driveOp(drive, err, func(c context.Context, d *gd.Drive) error { return d.Delete(c, p) })
}

//export gd_drive_delete_slot
func gd_drive_delete_slot(drive C.uint64_t, folder, slot *C.char, err **C.char) C.int {
	if slot == nil {
		return invalid("missing slot", err)
	}
	f, n := "", C.GoString(slot)
	if folder != nil {
		f = C.GoString(folder)
	}
	return driveOp(drive, err, func(c context.Context, d *gd.Drive) error { return d.DeleteSlot(c, f, n) })
}

//export gd_drive_mkdir
func gd_drive_mkdir(drive C.uint64_t, path *C.char, err **C.char) C.int {
	if path == nil {
		return invalid("missing path", err)
	}
	p := C.GoString(path)
	return driveOp(drive, err, func(c context.Context, d *gd.Drive) error { return d.Mkdir(c, p) })
}

//export gd_drive_move
func gd_drive_move(drive C.uint64_t, from, to *C.char, err **C.char) C.int {
	if from == nil || to == nil {
		return invalid("missing path", err)
	}
	f, t := C.GoString(from), C.GoString(to)
	return driveOp(drive, err, func(c context.Context, d *gd.Drive) error { return d.Move(c, f, t) })
}

type teams struct {
	mu    sync.Mutex
	token string
	c     *gd.TeamsClient
}

//export gd_teams_new
func gd_teams_new(origin, idToken *C.char, maxLevel C.int, out *C.uint64_t, err **C.char) C.int {
	if origin == nil || idToken == nil || out == nil {
		return invalid("missing argument", err)
	}
	t := &teams{token: C.GoString(idToken)}
	t.c = gd.NewTeamsClient(C.GoString(origin), func(context.Context) (string, error) {
		t.mu.Lock()
		defer t.mu.Unlock()
		return t.token, nil
	}, opts(maxLevel))
	*out = newHandle(t)
	return okStatus
}

//export gd_teams_set_token
func gd_teams_set_token(h C.uint64_t, idToken *C.char, err **C.char) C.int {
	t, ok := handle[*teams](h)
	if !ok || idToken == nil {
		return invalid("invalid argument", err)
	}
	t.mu.Lock()
	t.token = C.GoString(idToken)
	t.mu.Unlock()
	return okStatus
}

func teamsCall(h C.uint64_t, out **C.char, err **C.char, fn func(context.Context, *gd.TeamsClient) (any, error)) C.int {
	t, ok := handle[*teams](h)
	if !ok || out == nil {
		return invalid("invalid teams handle", err)
	}
	c, cancel := ctx()
	defer cancel()
	v, e := fn(c, t.c)
	if e != nil {
		return status(e, err)
	}
	return putJSON(v, out, err)
}

//export gd_teams_list
func gd_teams_list(h C.uint64_t, teamsJSON **C.char, err **C.char) C.int {
	return teamsCall(h, teamsJSON, err, func(c context.Context, t *gd.TeamsClient) (any, error) { return t.List(c) })
}

//export gd_teams_workspaces
func gd_teams_workspaces(h C.uint64_t, teamID *C.char, workspacesJSON **C.char, err **C.char) C.int {
	if teamID == nil {
		return invalid("missing team id", err)
	}
	id := C.GoString(teamID)
	return teamsCall(h, workspacesJSON, err, func(c context.Context, t *gd.TeamsClient) (any, error) { return t.Workspaces(c, id) })
}

//export gd_teams_messages
func gd_teams_messages(h C.uint64_t, teamID *C.char, after C.int64_t, pageJSON **C.char, err **C.char) C.int {
	if teamID == nil {
		return invalid("missing team id", err)
	}
	id := C.GoString(teamID)
	return teamsCall(h, pageJSON, err, func(c context.Context, t *gd.TeamsClient) (any, error) {
		p, e := t.Messages(c, id, int64(after), 100)
		if e != nil {
			return nil, e
		}
		raw := make([]map[string]any, len(p.Messages))
		for i, m := range p.Messages {
			raw[i] = m.Raw
		}
		return map[string]any{"messages": raw, "latestSeq": p.LatestSeq, "pollAfterMs": p.PollAfterMs}, nil
	})
}

//export gd_teams_post
func gd_teams_post(h C.uint64_t, teamID, text *C.char, messageJSON **C.char, err **C.char) C.int {
	if teamID == nil || text == nil {
		return invalid("missing argument", err)
	}
	id, s := C.GoString(teamID), C.GoString(text)
	return teamsCall(h, messageJSON, err, func(c context.Context, t *gd.TeamsClient) (any, error) {
		m, e := t.Post(c, id, s)
		if e != nil {
			return nil, e
		}
		return m.Raw, nil
	})
}
