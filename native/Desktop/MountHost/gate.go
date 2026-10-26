package main

import "sync"

type handleKind uint8

const (
	fileHandle handleKind = iota
	directoryHandle
)

type handleKey struct {
	kind handleKind
	fh   uint64
}

// admissionGate owns the decision, rather than taking a snapshot of another
// process's handles. A pending open is reserved before calling the filesystem.
// A successful descriptor stays reserved until the native Close callback.
type admissionGate struct {
	mu       sync.Mutex
	state    string
	pending  int
	inflight int
	handles  map[handleKey]int
	closing  map[handleKey]int
	fault    bool
}

type gateStatus struct {
	Schema          int    `json:"schema"`
	State           string `json:"state"`
	OpenFiles       int    `json:"openFiles"`
	OpenDirectories int    `json:"openDirectories"`
	Pending         int    `json:"pending"`
	Inflight        int    `json:"inflight"`
}

func newGate() *admissionGate {
	return &admissionGate{state: "mounted", handles: map[handleKey]int{}, closing: map[handleKey]int{}}
}

func (g *admissionGate) status() gateStatus {
	g.mu.Lock()
	defer g.mu.Unlock()
	s := gateStatus{Schema: 1, State: g.state, Pending: g.pending, Inflight: g.inflight}
	for k, n := range g.handles {
		if k.kind == fileHandle {
			s.OpenFiles += n
		} else {
			s.OpenDirectories += n
		}
	}
	return s
}

func (g *admissionGate) beginOpen(kind handleKind) func(bool, uint64) {
	g.mu.Lock()
	if g.state != "mounted" || g.fault {
		g.mu.Unlock()
		return nil
	}
	g.pending++
	g.mu.Unlock()
	var once sync.Once
	return func(success bool, fh uint64) {
		once.Do(func() {
			g.mu.Lock()
			defer g.mu.Unlock()
			g.pending--
			if success {
				if fh == ^uint64(0) {
					g.fault = true
					return
				}
				g.handles[handleKey{kind, fh}]++
			}
		})
	}
}

func (g *admissionGate) beginOperation() func() {
	g.mu.Lock()
	if g.state != "mounted" || g.fault {
		g.mu.Unlock()
		return nil
	}
	g.inflight++
	g.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			g.mu.Lock()
			g.inflight--
			g.mu.Unlock()
		})
	}
}

// Close errors keep the reservation and poison admission. Reporting idle after
// an uncertain close would silently weaken the lifetime guarantee.
func (g *admissionGate) beginClose(kind handleKind, fh uint64) func(bool) {
	k := handleKey{kind, fh}
	g.mu.Lock()
	if g.handles[k] <= g.closing[k] {
		g.fault = true
		g.mu.Unlock()
		return nil
	}
	g.closing[k]++
	g.inflight++
	g.mu.Unlock()
	var once sync.Once
	return func(success bool) {
		once.Do(func() {
			g.mu.Lock()
			defer g.mu.Unlock()
			g.inflight--
			g.closing[k]--
			if success {
				g.handles[k]--
				if g.handles[k] == 0 {
					delete(g.handles, k)
					delete(g.closing, k)
				}
			} else {
				g.fault = true
			}
		})
	}
}

func (g *admissionGate) prepareUnmount() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.state != "mounted" || g.fault || g.pending != 0 || g.inflight != 0 || len(g.handles) != 0 {
		return false
	}
	g.state = "quiescing"
	return true
}

func (g *admissionGate) rollbackUnmount() {
	g.mu.Lock()
	if g.state == "quiescing" {
		g.state = "mounted"
	}
	g.mu.Unlock()
}

func (g *admissionGate) markUnmounted() {
	g.mu.Lock()
	g.state = "unmounted"
	g.mu.Unlock()
}

func (g *admissionGate) poison() {
	g.mu.Lock()
	g.fault = true
	g.mu.Unlock()
}
