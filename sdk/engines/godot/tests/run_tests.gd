extends SceneTree
## Test runner for the GenDragoon addon:
##   godot --headless --path . --script res://tests/run_tests.gd
## Unit tests use sdk/spec/vectors/v1.json. The contract subset needs GD_SDK_BASE (a running provider dev server)
## and the Teams subset needs GD_TEAMS_ORIGIN (contract/teams_dev_server.cjs); otherwise they are skipped.

const B := preload("res://addons/gendragoon/bytes.gd")
const C := preload("res://addons/gendragoon/crypto.gd")
const Gate := preload("res://addons/gendragoon/gate.gd")
const OPS := preload("res://addons/gendragoon/operations.gd")
const Connect := preload("res://addons/gendragoon/connect.gd")

var _pass := 0
var _fail := 0
var _skip := 0
var _failures := []


func _initialize() -> void:
	_run()


func _ok(cond: bool, what: String) -> void:
	if not cond:
		_failures.append(what)


func _case(name: String, fn: Callable) -> void:
	_failures = []
	var t := Time.get_ticks_msec()
	await fn.call()
	if _failures.is_empty():
		_pass += 1
		print("PASS %s (%d ms)" % [name, Time.get_ticks_msec() - t])
	else:
		_fail += 1
		print("FAIL %s: %s" % [name, ", ".join(_failures)])


func _skip_case(name: String, why: String) -> void:
	_skip += 1
	print("SKIP %s (%s)" % [name, why])


func _vectors() -> Dictionary:
	var path := ProjectSettings.globalize_path("res://").path_join("../../spec/vectors/v1.json").simplify_path()
	return JSON.parse_string(FileAccess.get_file_as_string(path))


func _run() -> void:
	await process_frame
	var v := _vectors()
	await _case("Unit.Hkdf", func(): _t_hkdf(v))
	await _case("Unit.Chunk", func(): _t_chunk(v))
	await _case("Unit.Manifest", func(): _t_manifest(v))
	await _case("Unit.ScryptEnvelope", func(): _t_envelope(v))
	await _case("Unit.Pkce", func(): _t_pkce(v))
	await _case("Unit.Gate", func(): _t_gate())
	await _case("Unit.Paths", func(): _t_paths())
	var base := OS.get_environment("GD_SDK_BASE")
	if base.is_empty():
		_skip_case("Contract.C01_C04_Subset", "set GD_SDK_BASE")
	else:
		await _case("Contract.C01_C04_Subset", func(): await _t_contract(base))
	var origin := OS.get_environment("GD_TEAMS_ORIGIN")
	if origin.is_empty():
		_skip_case("Teams.Subset", "set GD_TEAMS_ORIGIN")
	else:
		await _case("Teams.Subset", func(): await _t_teams(origin))
	print("%d passed, %d failed, %d skipped" % [_pass, _fail, _skip])
	quit(0 if _fail == 0 else 1)


func _t_hkdf(v: Dictionary) -> void:
	for h in v["hkdf"]:
		_ok(B.hex(C.sub_key(B.from_hex(h["ikm"]), h["purpose"])) == h["out"], "hkdf " + h["purpose"])


func _t_chunk(v: Dictionary) -> void:
	var c: Dictionary = v["chunk"]
	var sealed: Array = C.seal_chunk(B.from_hex(c["fileKey"]), B.from_hex(c["plaintext"]), B.from_hex(c["nonce"]))
	_ok(sealed[0] == c["id"] and B.hex(sealed[1]) == c["blob"], "seal_chunk matches the vector")
	var opened = C.open_chunk(B.from_hex(c["fileKey"]), c["id"], B.from_hex(c["blob"]))
	_ok(opened != null and B.hex(opened) == c["plaintext"], "open_chunk")
	var bad := B.from_hex(c["blob"])
	bad[bad.size() - 1] ^= 1
	_ok(C.open_chunk(B.from_hex(c["fileKey"]), c["id"], bad) == null, "tampered chunk refused")


func _t_manifest(v: Dictionary) -> void:
	var m: Dictionary = v["manifest"]
	var mk := B.from_hex(m["masterKey"])
	_ok(C.drive_manifest_key(mk, m["driveName"]) == m["manifestKey"], "encrypted manifest key")
	_ok(C.drive_manifest_key(null, m["driveName"]) == m["plainManifestKey"], "plain manifest key")


func _t_envelope(v: Dictionary) -> void:
	var e: Dictionary = v["envelopeScrypt"]
	_ok(C.validate_envelope(e["envelope"]).is_empty(), "envelope validates")
	var mk = C.unwrap_master_key(e["envelope"], e["passphrase"])
	_ok(mk != null and B.hex(mk) == e["masterKey"], "scrypt envelope opens")
	_ok(C.unwrap_master_key(e["envelope"], "wrong passphrase") == null, "wrong passphrase refused")
	_ok(not C.validate_envelope(v["envelopeArgon2id"]["envelope"]).is_empty(), "argon2id reported as unsupported")


func _t_pkce(v: Dictionary) -> void:
	_ok(C.pkce_challenge(v["pkce"]["verifier"]) == v["pkce"]["challenge"], "pkce challenge")
	var p := Connect.new_pkce()
	_ok(String(p["verifier"]).length() == 43 and C.pkce_challenge(p["verifier"]) == p["challenge"], "new pkce")
	_ok(Connect.is_loopback("http://127.0.0.1:8123/cb") and not Connect.is_loopback("http://example.com/cb"), "loopback")


func _t_gate() -> void:
	_ok(Gate.parse_level("L3") == 3 and Gate.parse_level("x") == -1, "parse_level")
	_ok(Gate.check("files.read", 2).is_empty(), "L2 reads files")
	_ok(not Gate.check("crypto.exportMasterKey", 3).is_empty(), "L3 cannot export the master key")
	_ok(not Gate.check("teams.delete", 3).is_empty(), "L3 cannot delete a team")
	_ok(not Gate.check("teams.join", 2).is_empty(), "L2 cannot join a team")
	_ok(not Gate.check("no.such.op", 4).is_empty(), "unknown operation refused")
	_ok(OPS.ALL.has("teams.chat.watch") and OPS.ALL["teams.create"]["risk"] == "billing", "operation table has Teams")


func _t_paths() -> void:
	_ok(GendragoonDrive.check_path("saves/slot1.sav").is_empty(), "valid path")
	for bad in ["", "/abs", "a//b", "../x", "a/./b", "trail/"]:
		_ok(not GendragoonDrive.check_path(bad).is_empty(), "invalid path " + bad)


func _post_json(url: String, body: Dictionary, auth := "") -> Dictionary:
	var c := GendragoonClient.new()
	root.add_child(c)
	var r := await c.send("POST", url, B.json(body).to_utf8_buffer(), {"Content-Type": "application/json"}, auth)
	c.queue_free()
	return B.parse_object(r.value["body"]) if r.ok else {"error": r.error, "status": r.status}


func _t_contract(base: String) -> void:
	var uid := "godot" + B.hex(B.random(4))
	var g := await _post_json(base + "/connect/grants", {"workspaceId": "ws", "scopes": ["blobs:rw"], "requester": {"name": "Godot contract"}}, "Bearer dev-user:" + uid)
	_ok(g.has("grant"), "grant issued")
	var c := GendragoonClient.new(base)
	root.add_child(c)
	var conn := await Connect.redeem_grant(c, String(g.get("grant", "")), "Godot contract")
	_ok(conn.ok and GendragoonClient.is_api_key(c.api_key), "C01 redeem grant")
	var bad := await Connect.redeem_grant(c, "gdpg_" + "A".repeat(43), "x")
	_ok(not bad.ok and bad.error == "invalid_grant", "C01 bad grant refused")
	_ok((await c.health()).ok, "C01 health")
	var keys := GendragoonKeyring.new(c)
	_ok((await keys.create("contract passphrase")).ok, "C03 create master key")
	var again := await keys.create("contract passphrase")
	_ok(not again.ok and again.status == 412, "C03 second create is 412")
	keys.lock()
	_ok(not (await keys.unlock("wrong passphrase")).ok, "C03 wrong passphrase")
	_ok((await keys.unlock("contract passphrase")).ok, "C03 unlock")
	var d := GendragoonDrive.new(c, "saves", keys)
	_ok((await d.write_file("slots/one.sav", "level 3".to_utf8_buffer())).ok, "C04 write")
	_ok((await d.mkdir("empty")).ok, "C04 mkdir")
	var l := await d.list("")
	_ok(l.ok and l.value.size() == 2 and l.value[0]["folder"], "C04 list")
	var got := await d.read_file("slots/one.sav")
	_ok(got.ok and (got.value as PackedByteArray).get_string_from_utf8() == "level 3", "C04 read")
	_ok((await d.move("slots/one.sav", "slots/two.sav")).ok, "C04 move")
	_ok((await d.delete("slots/two.sav")).ok, "C04 delete")
	_ok((await d.read_file("slots/two.sav")).is_not_found(), "C04 deleted file is gone")
	var u := await c.usage()
	_ok(u.ok and int(u.value["quotaBytes"]) > 0, "C07 usage")
	var locked := GendragoonClient.new(base, c.api_key)
	locked.max_level = 2
	root.add_child(locked)
	var k2 := GendragoonKeyring.new(locked)
	_ok(not (await k2.export_master_key()).ok, "C08 L4 export refused")
	locked.queue_free()
	c.queue_free()


func _pay(origin: String, url: String) -> void:
	var r := await _post_json(origin + "/__dev/pay", {"url": url})
	_ok(not r.has("error") or r.get("error") == null, "dev pay")


func _t_teams(origin: String) -> void:
	var owner := "Bearer dev-user:gdowner" + B.hex(B.random(4))
	var created := await _post_json(origin + "/v2/teams", {"intentId": _uuid(), "name": "Godot Studio", "tier": "team", "interval": "month"}, owner)
	_ok(created.has("url"), "owner created a team")
	await _pay(origin, String(created.get("url", "")))
	var team_id := String(created.get("team", {}).get("id", ""))
	var inv := await _post_json(origin + "/v2/teams/%s/invites" % team_id, {}, owner)
	var t := GendragoonTeams.new()
	t.origin = origin
	t.id_token = "dev-user:gdplayer" + B.hex(B.random(4))
	root.add_child(t)
	_ok((await t.catalog()).ok, "catalog")
	var p := await t.preview_invite(String(inv.get("code", "")))
	_ok(p.ok and p.value["teamName"] == "Godot Studio", "preview invite")
	var color := ""
	for col in p.value["colors"]["memberColors"]:
		if not col["taken"]:
			color = col["id"]
			break
	var j := await t.join(String(inv["code"]), color, "Player")
	_ok(j.ok and j.value["teamId"] == team_id, "join")
	var teams := await t.list_teams()
	_ok(teams.ok and teams.value.size() == 1, "list teams")
	_ok((await t.update_me(team_id, "Player One")).ok, "update me")
	var got := []
	t.message_received.connect(func(m): got.append(m))
	_ok((await t.watch_chat(team_id)).ok, "watch chat")
	var m := await t.post(team_id, "gg")
	_ok(m.ok and int(m.value["seq"]) > 0, "post")
	var waited := 0
	while got.is_empty() and waited < 100:
		await process_frame
		await create_timer(0.1).timeout
		waited += 1
	_ok(got.size() == 1 and got[0]["text"] == "gg", "watched message")
	t.stop_watching(team_id)
	var ws := await t.workspaces(team_id)
	_ok(ws.ok and ws.value["subscriptionActive"], "workspaces")
	t.max_level = 2
	var refused := await t.leave(team_id)
	_ok(not refused.ok and refused.error == "level", "L2 cannot leave (L3)")
	t.max_level = 3
	_ok((await t.leave(team_id)).ok, "leave")
	var after := await t.get_team(team_id)
	_ok(not after.ok and after.status in [403, 404], "left team is gone")
	t.queue_free()


func _uuid() -> String:
	var b := B.random(16)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	var h := B.hex(b)
	return "%s-%s-%s-%s-%s" % [h.substr(0, 8), h.substr(8, 4), h.substr(12, 4), h.substr(16, 4), h.substr(20)]
