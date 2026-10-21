class_name GendragoonGate
extends RefCounted
## Rotten Apple developer unlock levels (docs/SDK_LEVELS.md): L0 Applicant, L1 Starter, L2 Established, L3 Trusted,
## L4 By approval. Every call names its operation and is refused when the operation's level is above the cap.

const OPS := preload("res://addons/gendragoon/operations.gd")
const DEFAULT_MAX_LEVEL := 3
## A host (the Rotten Apple launcher) sets this to cap the level. It can only lower the cap.
const MAX_LEVEL_ENV := "GENDRAGOON_SDK_MAX_LEVEL"


static func parse_level(s: String) -> int:
	var t := s.strip_edges().to_upper().trim_prefix("L")
	if t.length() == 1 and t >= "0" and t <= "4":
		return int(t)
	return -1


## The effective cap: max_level lowered by GENDRAGOON_SDK_MAX_LEVEL. A set but unreadable value, including an empty
## one, locks to L0, as in the other SDKs.
static func effective(max_level: int) -> int:
	if not OS.has_environment(MAX_LEVEL_ENV):
		return max_level
	return effective_for(OS.get_environment(MAX_LEVEL_ENV), max_level)


## The cap for a GENDRAGOON_SDK_MAX_LEVEL value that is set (possibly to "").
static func effective_for(env: String, max_level: int) -> int:
	var l := parse_level(env)
	return 0 if l < 0 else mini(l, max_level)


## "" when allowed, otherwise the reason.
static func check(op: String, cap: int) -> String:
	if not OPS.ALL.has(op):
		return "unknown operation " + op
	var o: Dictionary = OPS.ALL[op]
	if int(o["level"]) > cap:
		return "%s needs L%d (%s); this client allows up to L%d" % [op, o["level"], o["risk"], cap]
	return ""
