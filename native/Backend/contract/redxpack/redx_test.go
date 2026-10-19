//go:build redx

// Runs RedX's real engine/pack.Pack on top of Gendragoon's /provider/v1. Needs a RedX checkout; see run_redx.sh.
package redxpack

import (
	"bytes"
	"io"
	"testing"

	"redx/engine/pack"
)

var (
	_ pack.ChunkStore    = (*Remote)(nil)
	_ pack.ManifestStore = (*Remote)(nil)
)

func TestRealRedXPackOverProvider(t *testing.T) {
	r := startServer(t, "67108864")
	r.NotFoundChunk, r.NotFoundManifest = pack.ErrChunkNotFound, pack.ErrManifestNotFound
	p, err := pack.New(r, r, pack.Config{ChunkSize: 4096})
	if err != nil {
		t.Fatal(err)
	}
	payload := bytes.Repeat([]byte("gendragoon-redx "), 2000) // ~32 KB, several chunks with repeats (dedupe)
	if _, err := p.Put("games/saves/slot1.bin", bytes.NewReader(payload)); err != nil {
		t.Fatal(err)
	}
	rc, _, err := p.Get("games/saves/slot1.bin")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(rc)
	rc.Close()
	if !bytes.Equal(got, payload) {
		t.Fatal("round trip mismatch")
	}
	if err := p.Verify("games/saves/slot1.bin"); err != nil {
		t.Fatal(err)
	}
	infos, err := p.List("games/saves")
	if err != nil || len(infos) != 1 {
		t.Fatalf("list %v %v", infos, err)
	}
	if err := p.Delete("games/saves/slot1.bin"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := p.Get("games/saves/slot1.bin"); err == nil {
		t.Fatal("deleted file still readable")
	}
}
