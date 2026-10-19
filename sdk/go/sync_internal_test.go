package gendragoon

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalTargetRefusesLinks(t *testing.T) {
	tmp := t.TempDir()
	root, outside := filepath.Join(tmp, "root"), filepath.Join(tmp, "outside")
	for _, d := range []string{root, outside, filepath.Join(root, "real")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Skip("symlinks not available:", err)
	}
	os.WriteFile(filepath.Join(outside, "f"), []byte("x"), 0o644)
	os.Symlink(filepath.Join(outside, "f"), filepath.Join(root, "real", "file-link"))
	os.WriteFile(filepath.Join(root, "plain"), []byte("x"), 0o644)
	for _, rel := range []string{"link/x.txt", "link", "real/file-link", "plain/x", "../x", "a/../../x", "/abs", ""} {
		if _, err := localTarget(root, rel); !errors.Is(err, ErrUnsafePath) {
			t.Errorf("%q: %v", rel, err)
		}
	}
	got, err := localTarget(root, "real/new/deep.txt")
	if err != nil {
		t.Fatal(err)
	}
	real, _ := filepath.EvalSymlinks(root)
	if got != filepath.Join(real, "real", "new", "deep.txt") {
		t.Fatal(got)
	}
	// A root that is itself a link is followed once; everything below it is checked.
	alias := filepath.Join(tmp, "alias")
	os.Symlink(root, alias)
	if _, err := localTarget(alias, "real/ok.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := localTarget(alias, "link/x.txt"); !errors.Is(err, ErrUnsafePath) {
		t.Fatal(err)
	}
}
