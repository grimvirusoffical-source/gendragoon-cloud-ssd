package main

import (
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestGateCachePathsFollowEachSuccessfulNativeClose(t *testing.T) {
	g := newGate()
	g.beginOpen(fileHandle, "/first")(true, 7)
	g.beginOpen(fileHandle, "/second")(true, 7) // A reused backend fh is not a unique lifetime.
	g.beginOpen(fileHandle, "/first")(true, 8)
	g.beginOpen(fileHandle, "/failed")(false, 9)
	g.beginOpen(directoryHandle, "/directory")(true, 4)
	paths, ok := g.cachePaths()
	if !ok || !reflect.DeepEqual(paths, []string{"/first", "/second"}) {
		t.Fatal("live paths were not a deduplicated snapshot")
	}
	paths[0] = "/changed-copy"
	closing := g.beginClose(fileHandle, 7, "/second")
	if paths, ok = g.cachePaths(); !ok || len(paths) != 2 {
		t.Fatal("pending native close lost its path")
	}
	closing(true)
	paths, ok = g.cachePaths()
	if !ok || !reflect.DeepEqual(paths, []string{"/first"}) || g.status().OpenFiles != 2 {
		t.Fatal("one close consumed a different lifetime")
	}
	g.beginClose(fileHandle, 7, "/first")(true)
	g.beginClose(fileHandle, 8, "/first")(true)
	if paths, ok = g.cachePaths(); !ok || len(paths) != 0 || g.prepareUnmount() {
		t.Fatal("paths outlived files or trimming bypassed directory reservation")
	}
	closeHandleForTest(t, g, directoryHandle, 4)
	if !g.prepareUnmount() {
		t.Fatal("native closes did not end reservations")
	}
}

func TestGateCachePathsAreBoundedWithoutDiscardingHandleReservations(t *testing.T) {
	for _, name := range []string{"", "relative", "/", "/a/../b", "/bad\x00name", "/bad\\name", "/" + strings.Repeat("a", 4096), "/\xff"} {
		g := newGate()
		g.beginOpen(fileHandle, name)(true, 1)
		if _, ok := g.cachePaths(); ok || g.prepareUnmount() || g.status().OpenFiles != 1 {
			t.Fatal("an untracked path weakened lifetime tracking")
		}
		g.beginClose(fileHandle, 1, name)(true)
		if _, ok := g.cachePaths(); !ok || !g.prepareUnmount() {
			t.Fatal("a successful native close remained reserved")
		}
	}
	g := newGate()
	for i := 0; i <= maxCacheTrimPaths; i++ {
		g.beginOpen(fileHandle, fmt.Sprintf("/file-%d", i))(true, uint64(i))
	}
	if len(g.paths) != maxCacheTrimPaths || g.status().OpenFiles != maxCacheTrimPaths+1 {
		t.Fatal("path budget was not bounded independently of lifetime counts")
	}
	if _, ok := g.cachePaths(); ok || g.prepareUnmount() {
		t.Fatal("partial path tracking authorized maintenance/unmount")
	}
	g.beginClose(fileHandle, maxCacheTrimPaths, fmt.Sprintf("/file-%d", maxCacheTrimPaths))(true)
	if paths, ok := g.cachePaths(); !ok || len(paths) != maxCacheTrimPaths {
		t.Fatal("closed untracked descriptor was not released by its native callback")
	}
}

func TestGateFailedCloseRetainsPrivateCachePathAndFault(t *testing.T) {
	g := newGate()
	g.beginOpen(fileHandle, "/retained")(true, 1)
	g.beginClose(fileHandle, 1, "/retained")(false)
	if len(g.paths) != 1 || g.status().OpenFiles != 1 || !g.status().Fault {
		t.Fatal("failed close discarded a private path or reservation")
	}
	if _, ok := g.cachePaths(); ok || g.prepareUnmount() {
		t.Fatal("uncertain native close allowed trim/unmount")
	}
}

func closeHandleForTest(t *testing.T, g *admissionGate, kind handleKind, fh uint64) {
	t.Helper()
	close := g.beginClose(kind, fh)
	if close == nil {
		t.Fatal("expected tracked close")
	}
	close(true)
}

func TestGatePendingOpenAndCloseLifetimes(t *testing.T) {
	g := newGate()
	opened := g.beginOpen(fileHandle)
	if opened == nil || g.prepareUnmount() || g.status().Pending != 1 {
		t.Fatal("pending open was not reserved")
	}
	opened(true, 7)
	opened(true, 7) // Ticket completion is idempotent.
	if g.prepareUnmount() || g.status().OpenFiles != 1 {
		t.Fatal("successful open lost")
	}
	closing := g.beginClose(fileHandle, 7)
	if closing == nil || g.prepareUnmount() || g.status().Inflight != 1 {
		t.Fatal("close must remain busy until completed")
	}
	closing(true)
	closing(true)
	if !g.prepareUnmount() || g.beginOpen(fileHandle) != nil || g.beginOperation() != nil {
		t.Fatal("quiescing must close admission")
	}
	g.markUnmounted()
	if g.status().State != "unmounted" {
		t.Fatal("not marked unmounted")
	}
}

func TestGateFailedOpenInflightAndRollback(t *testing.T) {
	g := newGate()
	op := g.beginOperation()
	if g.prepareUnmount() {
		t.Fatal("operation must block unmount")
	}
	op()
	op()
	opened := g.beginOpen(directoryHandle)
	opened(false, ^uint64(0))
	if !g.prepareUnmount() {
		t.Fatal("failed open leaked pending count")
	}
	g.rollbackUnmount()
	if g.status().State != "mounted" {
		t.Fatal("failed native unmount did not reopen admission")
	}
	if op = g.beginOperation(); op == nil {
		t.Fatal("rollback still rejects operations")
	}
	op()
}

func TestGateDuplicateHandleCountsAndKinds(t *testing.T) {
	g := newGate()
	for _, kind := range []handleKind{fileHandle, fileHandle, directoryHandle} {
		g.beginOpen(kind)(true, 2)
	}
	if s := g.status(); s.OpenFiles != 2 || s.OpenDirectories != 1 {
		t.Fatal(s)
	}
	closeHandleForTest(t, g, fileHandle, 2)
	if g.prepareUnmount() || g.status().OpenFiles != 1 {
		t.Fatal("one release cleared two references")
	}
	closeHandleForTest(t, g, fileHandle, 2)
	if g.prepareUnmount() {
		t.Fatal("directory handle ignored")
	}
	closeHandleForTest(t, g, directoryHandle, 2)
	if !g.prepareUnmount() {
		t.Fatal("all references closed")
	}
}

func TestGateUncertainCloseAndUnknownCloseFailClosed(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		g := newGate()
		if unknown {
			if g.beginClose(fileHandle, 99) != nil {
				t.Fatal("unknown close was delegated")
			}
		} else {
			g.beginOpen(fileHandle)(true, 1)
			g.beginClose(fileHandle, 1)(false)
			if g.status().OpenFiles != 1 {
				t.Fatal("uncertain descriptor discarded")
			}
		}
		if g.prepareUnmount() || g.beginOpen(fileHandle) != nil {
			t.Fatal("uncertain state allowed unmount/admission")
		}
		if s := g.status(); !s.Fault || s.CloseFailures != 1 {
			t.Fatal("close failure diagnostics missing", s)
		}
	}
}

func TestGateDiagnosticCountersAreBoundedAndDoNotClearFaults(t *testing.T) {
	g := newGate()
	if s := g.status(); s.Fault || s.CloseFailures != 0 {
		t.Fatal("clean gate reported failure", s)
	}
	g.closeFailures = 1000000
	g.beginClose(fileHandle, 77)
	if s := g.status(); !s.Fault || s.CloseFailures != 1000000 {
		t.Fatal("diagnostic counter was not bounded", s)
	}
	if g.prepareUnmount() || g.beginOperation() != nil {
		t.Fatal("diagnostics changed fail-closed behavior")
	}
}

func TestGateOpenVersusUnmountHasSingleAtomicWinner(t *testing.T) {
	for i := 0; i < 1000; i++ {
		g := newGate()
		start := make(chan struct{})
		var wg sync.WaitGroup
		var opened func(bool, uint64)
		var unmount bool
		wg.Add(2)
		go func() { defer wg.Done(); <-start; opened = g.beginOpen(fileHandle) }()
		go func() { defer wg.Done(); <-start; unmount = g.prepareUnmount() }()
		close(start)
		wg.Wait()
		if (opened != nil) == unmount {
			t.Fatal("both admission and unmount won, or neither won")
		}
		if opened != nil {
			opened(true, 1)
			closeHandleForTest(t, g, fileHandle, 1)
		}
	}
}
