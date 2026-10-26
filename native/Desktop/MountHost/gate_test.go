package main

import (
	"sync"
	"testing"
)

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
