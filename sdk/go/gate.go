package gendragoon

import (
	"fmt"
	"os"
	"strings"
)

// Level is a Rotten Apple developer unlock level (SPEC §9.2). Every SDK operation carries one; see
// Operations and docs/LEVELS.md. L0 and L1 unlock nothing in this SDK: data.storage is an L2 service.
type Level int

const (
	L0 Level = iota
	L1
	L2
	L3
	L4
)

func (l Level) String() string { return fmt.Sprintf("L%d", int(l)) }

// ParseLevel accepts "L0".."L4" (case-insensitive) or "0".."4".
func ParseLevel(s string) (Level, error) {
	t := strings.TrimPrefix(strings.ToUpper(strings.TrimSpace(s)), "L")
	if len(t) == 1 && t[0] >= '0' && t[0] <= '4' {
		return Level(t[0] - '0'), nil
	}
	return 0, fmt.Errorf("gendragoon: unknown level %q", s)
}

// Risk says what kind of harm an operation can do.
type Risk string

const (
	RiskRead            Risk = "read"
	RiskWrite           Risk = "write"
	RiskCredential      Risk = "credential"
	RiskDestructive     Risk = "destructive"
	RiskBulkDestructive Risk = "bulk-destructive"
	RiskKey             Risk = "key"
	RiskKeyExport       Risk = "key-export"
	RiskSharing         Risk = "sharing"
)

// Operation is one entry of the shared operation table (spec/operations.json).
type Operation struct {
	ID      string
	Level   Level
	Risk    Risk
	Context string // "app" (API key), "user" (signed-in account) or "local" (no network)
	Method  string
	Path    string
	Scope   string
	Summary string
}

// Gate decides whether an operation may run. It is called before any network request or key use.
// Return nil to allow, or an error (normally *LevelError) to refuse.
type Gate func(op Operation) error

// LevelError is returned when the gate refuses an operation.
type LevelError struct {
	Op      Operation
	Allowed Level
}

func (e *LevelError) Error() string {
	return fmt.Sprintf("gendragoon: %s needs %s (%s); this client allows up to %s", e.Op.ID, e.Op.Level, e.Op.Risk, e.Allowed)
}

// MaxLevelEnv names the variable a host (the Rotten Apple launcher) sets to cap the level. The
// variable can only lower the cap a program chose, never raise it.
const MaxLevelEnv = "GENDRAGOON_SDK_MAX_LEVEL"

// DefaultMaxLevel lets everything except L4 (raw key export, wiping a whole binding) run.
const DefaultMaxLevel = L3

// LevelGate allows operations at or below max, lowered further by GENDRAGOON_SDK_MAX_LEVEL when set.
// An unreadable variable locks the client down to L0 rather than being ignored.
func LevelGate(max Level) Gate {
	eff := max
	if v, ok := os.LookupEnv(MaxLevelEnv); ok {
		if env, err := ParseLevel(v); err == nil {
			if env < eff {
				eff = env
			}
		} else {
			eff = L0
		}
	}
	return func(op Operation) error {
		if op.Level > eff {
			return &LevelError{Op: op, Allowed: eff}
		}
		return nil
	}
}

// Op returns the table entry for id. It panics on an unknown id, which is a programming error.
func Op(id string) Operation {
	for _, o := range Operations {
		if o.ID == id {
			return o
		}
	}
	panic("gendragoon: unknown operation " + id)
}

type gated struct{ gate Gate }

func (g gated) check(id string) error {
	if g.gate == nil {
		return nil
	}
	return g.gate(Op(id))
}
