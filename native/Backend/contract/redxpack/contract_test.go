package redxpack

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"sync"
	"testing"
)

func id(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

// The ChunkStore and ManifestStore semantics documented in redx/engine/pack/backend.go.
func TestChunkStoreContract(t *testing.T) {
	r := startServer(t, "67108864")
	data := []byte("chunk one")
	if err := r.PutChunk(id(data), data); err != nil {
		t.Fatal(err)
	}
	if err := r.PutChunk(id(data), data); err != nil { // may overwrite (idempotent)
		t.Fatal(err)
	}
	if err := r.PutChunk("NOTHEX", data); err == nil {
		t.Fatal("bad id accepted")
	}
	if err := r.PutChunk(id([]byte("other")), data); !errors.Is(err, ErrChecksum) {
		t.Fatalf("want checksum error, got %v", err)
	}
	got, err := r.GetChunk(id(data))
	if err != nil || string(got) != string(data) {
		t.Fatalf("get: %q %v", got, err)
	}
	if _, err := r.GetChunk(id([]byte("absent"))); !errors.Is(err, ErrChunkNotFound) {
		t.Fatalf("want ErrChunkNotFound, got %v", err)
	}
	if ok, err := r.HasChunk(id(data)); !ok || err != nil {
		t.Fatal("has")
	}
	if ok, _ := r.HasChunk(id([]byte("absent"))); ok {
		t.Fatal("has absent")
	}
	var want []string
	for i := 0; i < 1005; i++ { // crosses one list page
		d := []byte(fmt.Sprintf("c%d", i))
		if err := r.PutChunk(id(d), d); err != nil {
			t.Fatal(err)
		}
		want = append(want, id(d))
	}
	want = append(want, id(data))
	sort.Strings(want)
	ids, err := r.ListChunks()
	if err != nil || len(ids) != len(want) {
		t.Fatalf("list: %d %v", len(ids), err)
	}
	for i := range ids {
		if ids[i] != want[i] {
			t.Fatalf("list order at %d", i)
		}
	}
	if err := r.DeleteChunk(id(data)); err != nil {
		t.Fatal(err)
	}
	if err := r.DeleteChunk(id(data)); err != nil { // no-op if absent
		t.Fatal(err)
	}
}

func TestManifestStoreContract(t *testing.T) {
	r := startServer(t, "67108864")
	key := id([]byte("redx-pack-folder\x00"))
	if _, err := r.LoadManifest(key); !errors.Is(err, ErrManifestNotFound) {
		t.Fatalf("want ErrManifestNotFound, got %v", err)
	}
	if err := r.SaveManifest(key, []byte("m1")); err != nil {
		t.Fatal(err)
	}
	if err := r.SaveManifest(key, []byte("m2")); err != nil { // atomic overwrite
		t.Fatal(err)
	}
	b, etag, err := r.LoadManifestVersion(key)
	if err != nil || string(b) != "m2" || etag == "" {
		t.Fatalf("load %q %q %v", b, etag, err)
	}
	if err := r.SaveManifestIf(key, []byte("x"), "*"); !errors.Is(err, ErrPrecondition) {
		t.Fatalf("create-only over existing: %v", err)
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins := 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := r.SaveManifestIf(key, []byte(fmt.Sprintf("racer%d", i)), etag); err == nil {
				mu.Lock()
				wins++
				mu.Unlock()
			} else if !errors.Is(err, ErrPrecondition) {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	if wins != 1 {
		t.Fatalf("CAS winners = %d, want 1", wins)
	}
	keys, err := r.ListManifests()
	if err != nil || len(keys) != 1 || keys[0] != key {
		t.Fatalf("list manifests %v %v", keys, err)
	}
	if err := r.DeleteManifest(key); err != nil {
		t.Fatal(err)
	}
	if _, err := r.LoadManifest(key); !errors.Is(err, ErrManifestNotFound) {
		t.Fatal("deleted manifest still loads")
	}
}

func TestQuotaError(t *testing.T) {
	r := startServer(t, "100")
	a := make([]byte, 80)
	b := make([]byte, 30)
	b[0] = 1
	if err := r.PutChunk(id(a), a); err != nil {
		t.Fatal(err)
	}
	if err := r.PutChunk(id(b), b); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("want ErrQuotaExceeded, got %v", err)
	}
	used, quota, err := r.Usage()
	if err != nil || used != 80 || quota != 100 {
		t.Fatalf("usage %d/%d %v", used, quota, err)
	}
}
