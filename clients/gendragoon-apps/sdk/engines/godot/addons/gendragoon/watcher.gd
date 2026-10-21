class_name GendragoonWatcher
extends Node
## Change events by polling. The server has no webhook or stream, so the watcher polls /usage for changeSeq and
## lists manifests only when it moved (or every resync_seconds). The first poll records the current state.
## Level L2, risk read.

signal changed(event: Dictionary)

const Result := preload("res://addons/gendragoon/result.gd")

@export var interval_seconds := 5.0
@export var resync_seconds := 600.0
## Only manifest events for these keys (for example one drive's manifest_key).
var keys: Array = []
var client: GendragoonClient

var _running := false


## Starts polling. Events: {type: "manifest.created" | "manifest.updated" | "manifest.deleted" | "usage.changed" |
## "binding.revoked", key?, generation?, usage?}. Polling stops after binding.revoked.
func start() -> GendragoonResult:
	var why := client.check("events.watch")
	if not why.is_empty():
		return Result.failure("level", why)
	if _running:
		return Result.success()
	_running = true
	_loop()
	return Result.success()


func stop() -> void:
	_running = false


func _loop() -> void:
	var seen = null
	var last = null
	var last_list := -1.0e12
	while _running and is_inside_tree():
		var u := await client.usage()
		if not u.ok and u.is_unauthorized():
			_running = false
			changed.emit({"type": "binding.revoked"})
			return
		if u.ok:
			var cur: Dictionary = u.value
			if last != null and (cur.get("usedBytes") != last.get("usedBytes") or cur.get("objectCount") != last.get("objectCount") or cur.get("quotaBytes") != last.get("quotaBytes")):
				changed.emit({"type": "usage.changed", "usage": cur})
			var now_s := Time.get_ticks_msec() / 1000.0
			if last == null or cur.get("changeSeq") != last.get("changeSeq") or now_s - last_list >= resync_seconds:
				var m := await client.all_manifests()
				if m.ok:
					last_list = now_s
					var now := {}
					for it in m.value:
						if keys.is_empty() or keys.has(it["id"]):
							now[it["id"]] = it["generation"]
					if seen != null:
						var ks := now.keys()
						ks.sort()
						for k in ks:
							if not seen.has(k):
								changed.emit({"type": "manifest.created", "key": k, "generation": now[k]})
							elif seen[k] != now[k]:
								changed.emit({"type": "manifest.updated", "key": k, "generation": now[k]})
						var old: Array = seen.keys()
						old.sort()
						for k in old:
							if not now.has(k):
								changed.emit({"type": "manifest.deleted", "key": k})
					seen = now
			last = cur
		await get_tree().create_timer(maxf(interval_seconds, 1.0)).timeout
