//go:build windows

package main

import (
	"sync/atomic"
	"testing"

	"github.com/winfsp/cgofuse/fuse"
)

type fixtureFS struct {
	fuse.FileSystemBase
	opens         atomic.Int32
	closes        atomic.Int32
	opening       chan struct{}
	proceed       chan struct{}
	closeError    int
	panicOpen     bool
	panicClose    bool
	panicRead     bool
	panicDirOpen  bool
	panicDirClose bool
}

func (*fixtureFS) Getattr(path string, s *fuse.Stat_t, fh uint64) int {
	s.Mode = fuse.S_IFREG | 0444
	if path == "/dir" {
		s.Mode = fuse.S_IFDIR | 0555
	}
	if path == "/link" {
		s.Mode = fuse.S_IFLNK | 0777
	}
	return 0
}
func (f *fixtureFS) OpenEx(_ string, fi *fuse.FileInfo_t) int {
	f.opens.Add(1)
	if f.opening != nil {
		close(f.opening)
		<-f.proceed
	}
	fi.Fh = 1
	if f.panicOpen {
		panic("synthetic dependency panic")
	}
	return 0
}
func (f *fixtureFS) Opendir(string) (int, uint64) {
	if f.panicDirOpen {
		panic("synthetic private directory open text")
	}
	return 0, 2
}
func (f *fixtureFS) Release(string, uint64) int {
	f.closes.Add(1)
	if f.panicClose {
		panic("synthetic private close text")
	}
	return f.closeError
}
func (f *fixtureFS) Releasedir(string, uint64) int {
	f.closes.Add(1)
	if f.panicDirClose {
		panic("synthetic private directory close text")
	}
	return f.closeError
}
func (*fixtureFS) Getpath(p string, _ uint64) (int, string) { return 0, p }
func (f *fixtureFS) Read(string, []byte, int64, uint64) int {
	if f.panicRead {
		panic("synthetic private read text")
	}
	return 0
}

func TestGuardedFSOpenAndOpenExAreTrackedExactlyOnce(t *testing.T) {
	base := &fixtureFS{}
	g := newGate()
	f := &guardedFS{base: base, gate: g, ready: make(chan struct{})}
	result, fh := f.Open("/file", fuse.O_RDONLY)
	if result != 0 || fh != 1 || base.opens.Load() != 1 || g.status().OpenFiles != 1 || g.prepareUnmount() {
		t.Fatal("Open did not reserve exactly one descriptor")
	}
	if paths, ok := g.cachePaths(); !ok || len(paths) != 1 || paths[0] != "/file" {
		t.Fatal("native open did not retain its private cache path")
	}
	if f.Release("/file", fh) != 0 || base.closes.Load() != 1 || g.status().OpenFiles != 0 {
		t.Fatal("native close not tracked")
	}
	if paths, ok := g.cachePaths(); !ok || len(paths) != 0 {
		t.Fatal("native close did not remove its private path")
	}
	fi := &fuse.FileInfo_t{Flags: fuse.O_RDONLY}
	if f.OpenEx("/file", fi) != 0 || base.opens.Load() != 2 || g.status().OpenFiles != 1 {
		t.Fatal("OpenEx bypassed gate")
	}
	if code, dir := f.Opendir("/dir"); code != 0 || dir != 2 || g.status().OpenDirectories != 1 {
		t.Fatal("directory lifetime untracked")
	}
	if f.Release("/file", fi.Fh) != 0 || f.Releasedir("/dir", 2) != 0 || !g.prepareUnmount() {
		t.Fatal("closed descriptors leaked")
	}
	if f.OpenEx("/file", fi) != -fuse.EBUSY {
		t.Fatal("quiescing OpenEx admitted")
	}
}

func TestGuardedFSPendingOpenAndReadOnlyReparseChecks(t *testing.T) {
	base := &fixtureFS{opening: make(chan struct{}), proceed: make(chan struct{})}
	g := newGate()
	f := &guardedFS{base: base, gate: g}
	done := make(chan struct{})
	go func() { f.Open("/file", fuse.O_RDONLY); close(done) }()
	<-base.opening
	if g.status().Pending != 1 || g.prepareUnmount() {
		t.Fatal("pending delegate open was invisible")
	}
	close(base.proceed)
	<-done
	if g.status().OpenFiles != 1 {
		t.Fatal("pending to live transition lost")
	}
	for _, flags := range []int{fuse.O_WRONLY, fuse.O_RDWR, fuse.O_CREAT, fuse.O_TRUNC, fuse.O_APPEND} {
		if code, _ := f.Open("/file", flags); code != -fuse.EROFS {
			t.Fatal("write open admitted")
		}
	}
	if code, _ := f.Open("/link", fuse.O_RDONLY); code != -fuse.EPERM {
		t.Fatal("reparse open admitted")
	}
	if base.opens.Load() != 1 {
		t.Fatal("rejected path called mutable delegate")
	}
}

func TestGuardedFSUncertainCloseAndPanicNeverReportIdle(t *testing.T) {
	base := &fixtureFS{closeError: -fuse.EIO}
	g := newGate()
	f := &guardedFS{base: base, gate: g}
	f.Open("/file", fuse.O_RDONLY)
	if f.Release("/file", 1) != -fuse.EIO || g.prepareUnmount() {
		t.Fatal("close error was treated as idle")
	}
	base = &fixtureFS{panicOpen: true}
	g = newGate()
	f = &guardedFS{base: base, gate: g}
	if code, fh := f.Open("/file", fuse.O_RDONLY); code != -fuse.EIO || fh != ^uint64(0) {
		t.Fatal("callback panic escaped or returned invalid failure")
	}
	if g.status().OpenFiles != 1 {
		t.Fatal("uncertain opened descriptor was discarded")
	}
	for _, closePanic := range []bool{false, true} {
		base = &fixtureFS{panicClose: closePanic, panicRead: !closePanic}
		g = newGate()
		f = &guardedFS{base: base, gate: g}
		f.Open("/file", fuse.O_RDONLY)
		code := 0
		if closePanic {
			code = f.Release("/file", 1)
		} else {
			code = f.Read("/file", make([]byte, 1), 0, 1)
		}
		if code != -fuse.EIO || g.prepareUnmount() || g.status().OpenFiles != 1 {
			t.Fatal("panic did not retain uncertain descriptor")
		}
	}

	if g.prepareUnmount() {
		t.Fatal("dependency panic made mount appear idle")
	}
}

func TestGuardedFSDirectoryPanicsPoisonWithoutEscaping(t *testing.T) {
	for _, closePanic := range []bool{false, true} {
		base := &fixtureFS{panicDirOpen: !closePanic, panicDirClose: closePanic}
		g := newGate()
		f := &guardedFS{base: base, gate: g}
		code, fh := f.Opendir("/dir")
		if closePanic {
			if code != 0 || fh != 2 {
				t.Fatal("directory fixture did not open")
			}
			code = f.Releasedir("/dir", fh)
			if g.status().OpenDirectories != 1 {
				t.Fatal("uncertain directory close discarded reservation")
			}
		} else if fh != ^uint64(0) {
			t.Fatal("panicking directory open returned usable handle")
		}
		if code != -fuse.EIO || g.prepareUnmount() || g.beginOpen(fileHandle) != nil || g.beginOperation() != nil {
			t.Fatal("directory panic escaped or allowed further admission/unmount")
		}
	}
}
