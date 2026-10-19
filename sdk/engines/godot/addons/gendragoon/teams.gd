class_name GendragoonTeams
extends Node
## Teams for a signed-in GenDragoon player: the teams they belong to, joining with an invite code, team chat and the
## team's workspaces. Authenticates with the player's Firebase ID token (set id_token before each session; the
## server refuses gdsk_ API keys here). Billing, invites and owner moderation stay in the GenDragoon app and are not
## part of this addon. Every call is a coroutine that returns a GendragoonResult.

signal message_received(message: Dictionary)
## The player can no longer read this team (left, removed or signed out); chat polling has stopped.
signal team_lost(team_id: String)

const B := preload("res://addons/gendragoon/bytes.gd")
const Result := preload("res://addons/gendragoon/result.gd")
const Gate := preload("res://addons/gendragoon/gate.gd")

## GenDragoon API origin, for example https://api.gendragoon.com
@export var origin := ""
@export_range(0, 4) var max_level := Gate.DEFAULT_MAX_LEVEL
var id_token := ""

var _http: GendragoonClient
var _watching := {}


func _ready() -> void:
	_http = GendragoonClient.new()
	_http.max_level = max_level
	add_child(_http)


static func _seg(v) -> String:
	var s := str(v)
	if s.is_empty() or s.length() > 128 or s.contains("/") or s.contains("?") or s.contains("#"):
		return ""
	return s.uri_encode()


func _call(op: String, method: String, path: String, body = null) -> GendragoonResult:
	if _http == null:
		return Result.failure("not_ready", "add GendragoonTeams to the scene tree first")
	if id_token.is_empty():
		return Result.failure("unauthorized", "set id_token first")
	_http.max_level = max_level
	var why := _http.check(op)
	if not why.is_empty():
		return Result.failure("level", why)
	var data := PackedByteArray() if body == null else B.utf8(B.json(body))
	var headers := {} if body == null else {"Content-Type": "application/json"}
	var r := await _http.send(method, origin.rstrip("/") + "/v2/teams" + path, data, headers, "Bearer " + id_token)
	if not r.ok:
		return r
	var o = B.parse_object(r.value["body"])
	return Result.success(o if o != null else {})


func _team(team_id: String) -> String:
	var s := _seg(team_id)
	return "" if s.is_empty() else "/" + s


## Team tiers, the Enterprise contact and the color palette. Level L2, risk read.
func catalog() -> GendragoonResult:
	return await _call("teams.catalog", "GET", "/catalog")


## Teams the player belongs to (Array of team dictionaries). Level L2, risk read.
func list_teams() -> GendragoonResult:
	var r := await _call("teams.list", "GET", "")
	return Result.success(r.value.get("teams", [])) if r.ok else r


## {team, colors} with the members and member colors. Level L2, risk read.
func get_team(team_id: String) -> GendragoonResult:
	if _team(team_id).is_empty():
		return Result.failure("invalid", "invalid team id")
	return await _call("teams.get", "GET", _team(team_id))


## Team name, size and free colors for an invite code. Level L2, risk read.
func preview_invite(code: String) -> GendragoonResult:
	return await _call("teams.previewInvite", "POST", "/join/preview", {"code": code})


## Joins a team with an invite code and a free member color ({teamId, alreadyMember}). Level L3, risk sharing.
func join(code: String, color: String, display_name := "") -> GendragoonResult:
	var body := {"code": code, "color": color}
	if not display_name.is_empty():
		body["displayName"] = display_name
	return await _call("teams.join", "POST", "/join", body)


## Changes the player's display name or color in a team (empty strings leave a field as it is). Level L2, risk write.
func update_me(team_id: String, display_name := "", color := "") -> GendragoonResult:
	var body := {}
	if not display_name.is_empty():
		body["displayName"] = display_name
	if not color.is_empty():
		body["color"] = color
	return await _call("teams.updateMe", "PATCH", _team(team_id) + "/me", body)


## Leaves a team. Level L3, risk destructive.
func leave(team_id: String) -> GendragoonResult:
	return await _call("teams.leave", "POST", _team(team_id) + "/leave", {})


## {teamWorkspaces, sharedWorkspaces, subscriptionActive}. Level L2, risk read.
func workspaces(team_id: String) -> GendragoonResult:
	return await _call("teams.workspaces", "GET", _team(team_id) + "/workspaces")


## {messages, latestSeq, pollAfterMs} with messages above after. Level L2, risk read.
func messages(team_id: String, after := 0, limit := 0) -> GendragoonResult:
	var q := "?after=%d" % after + ("&limit=%d" % limit if limit > 0 else "")
	return await _call("teams.chat.list", "GET", _team(team_id) + "/chat" + q)


## Posts a text message. Level L2, risk write.
func post(team_id: String, text: String) -> GendragoonResult:
	var r := await _call("teams.chat.post", "POST", _team(team_id) + "/chat", {"text": text})
	return Result.success(r.value.get("message", {})) if r.ok else r


## Reports a message (spam, abuse, harassment, illegal or other). Level L2, risk write.
func report(team_id: String, seq: int, category: String, note := "") -> GendragoonResult:
	return await _call("teams.chat.report", "POST", _team(team_id) + "/chat/%d/report" % seq, {"category": category, "note": note})


## Polls the team chat and emits message_received for each new message (polling every pollAfterMs; the server's
## Server-Sent Events stream is not used). Stops with team_lost when the player loses access. Level L2, risk read.
func watch_chat(team_id: String, after := 0) -> GendragoonResult:
	var why := Gate.check("teams.chat.watch", Gate.effective(max_level))
	if not why.is_empty():
		return Result.failure("level", why)
	if _watching.has(team_id):
		return Result.success()
	_watching[team_id] = true
	_watch_loop(team_id, after)
	return Result.success()


func stop_watching(team_id: String) -> void:
	_watching.erase(team_id)


func _watch_loop(team_id: String, after: int) -> void:
	var wait := 3.0
	while _watching.has(team_id) and is_inside_tree():
		var r := await messages(team_id, after, 100)
		if not r.ok and r.status in [401, 403, 404]:
			_watching.erase(team_id)
			team_lost.emit(team_id)
			return
		if r.ok:
			for m in r.value.get("messages", []):
				var seq := int(m.get("seq", 0))
				if seq > after:
					after = seq
					message_received.emit(m)
			if r.value.get("pollAfterMs", 0) > 0:
				wait = float(r.value["pollAfterMs"]) / 1000.0
		if not is_inside_tree():
			return
		await get_tree().create_timer(wait).timeout
