package main

import (
	"path"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"
)

type handleKind uint8

const (
	fileHandle handleKind = iota
	directoryHandle
)

type handleKey struct {
	kind handleKind
	fh   uint64
}

type handlePath struct {
	handleKey
	path string
}

const maxCacheTrimPaths = 1024

func cacheTrimPath(value string) bool {
	return len(value) > 1 && len(value) <= 4096 && value[0] == '/' &&
		utf8.ValidString(value) && !strings.ContainsAny(value, "\x00\\") && path.Clean(value) == value
}

// admissionGate owns the decision, rather than taking a snapshot of another
// process's handles. A pending open is reserved before calling the filesystem.
// A successful descriptor stays reserved until the native Close callback.
type admissionGate struct {
	mu            sync.Mutex
	state         string
	pending       int
	inflight      int
	handles       map[handleKey]int
	closing       map[handleKey]int
	paths         map[handlePath]int
	fault         bool
	closeFailures int
}

type gateStatus struct {
	Schema          int    `json:"schema"`
	State           string `json:"state"`
	OpenFiles       int    `json:"openFiles"`
	OpenDirectories int    `json:"openDirectories"`
	Pending         int    `json:"pending"`
	Inflight        int    `json:"inflight"`
	Fault           bool   `json:"fault"`
	CloseFailures   int    `json:"closeFailures"`
}

func newGate() *admissionGate {
	return &admissionGate{state: "mounted", handles: map[handleKey]int{}, closing: map[handleKey]int{}, paths: map[handlePath]int{}}
}

func (g *admissionGate) status() gateStatus {
	g.mu.Lock()
	defer g.mu.Unlock()
	s := gateStatus{Schema: 1, State: g.state, Pending: g.pending, Inflight: g.inflight, Fault: g.fault, CloseFailures: g.closeFailures}
	for k, n := range g.handles {
		if k.kind == fileHandle {
			s.OpenFiles += n
		} else {
			s.OpenDirectories += n
		}
	}
	return s
}

func (g *admissionGate) beginOpen(kind handleKind, openedPath ...string) func(bool, uint64) {
	name := ""
	if kind == fileHandle && len(openedPath) == 1 && cacheTrimPath(openedPath[0]) {
		name = openedPath[0]
	}
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
				key := handleKey{kind, fh}
				g.handles[key]++
				// Paths are private maintenance hints, never a second lifetime
				// authority. An oversized/untracked path keeps trim unavailable
				// while its native handle remains reserved.
				p := handlePath{key, name}
				if name != "" && (g.paths[p] != 0 || len(g.paths) < maxCacheTrimPaths) {
					g.paths[p]++
				}
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
func (g *admissionGate) beginClose(kind handleKind, fh uint64, closedPath ...string) func(bool) {
	k := handleKey{kind, fh}
	name := ""
	if len(closedPath) == 1 {
		name = closedPath[0]
	}
	g.mu.Lock()
	if g.handles[k] <= g.closing[k] {
		g.fault = true
		if g.closeFailures < 1000000 {
			g.closeFailures++
		}
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
				p := handlePath{k, name}
				if g.paths[p] > 1 {
					g.paths[p]--
				} else {
					delete(g.paths, p)
				}
				if g.handles[k] == 0 {
					delete(g.handles, k)
					delete(g.closing, k)
					// Native Close proved the last reservation for this handle
					// ended, including any path whose hint was not retained.
					for p := range g.paths {
						if p.handleKey == k {
							delete(g.paths, p)
						}
					}
				}
			} else {
				g.fault = true
				if g.closeFailures < 1000000 {
					g.closeFailures++
				}
			}
		})
	}
}

// cachePaths returns a bounded snapshot only when every current file lifetime
// has a matching path hint. Callers MUST release the gate lock before Notify:
// native cache invalidation can itself deliver Close callbacks into this gate.
// The snapshot does not reserve, release, or close admission for any handle.
func (g *admissionGate) cachePaths() ([]string, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.state != "mounted" || g.fault {
		return nil, false
	}
	tracked := map[handleKey]int{}
	unique := map[string]bool{}
	for p, count := range g.paths {
		tracked[p.handleKey] += count
		unique[p.path] = true
	}
	for key, count := range g.handles {
		if key.kind == fileHandle && count != tracked[key] {
			return nil, false
		}
	}
	paths := make([]string, 0, len(unique))
	for name := range unique {
		paths = append(paths, name)
	}
	sort.Strings(paths)
	return paths, true
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
