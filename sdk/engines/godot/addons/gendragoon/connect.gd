class_name GendragoonConnect
extends RefCounted
## App-side connect: a one-time connect code (gdpg_) the player copies from GenDragoon, or a connect link with PKCE
## and a loopback redirect (desktop).

const B := preload("res://addons/gendragoon/bytes.gd")
const C := preload("res://addons/gendragoon/crypto.gd")
const Result := preload("res://addons/gendragoon/result.gd")


static func _matches(pattern: String, s: String) -> bool:
	return RegEx.create_from_string(pattern).search(s) != null


static func _connection(client: GendragoonClient, r: GendragoonResult) -> GendragoonResult:
	if not r.ok:
		return r
	var d = B.parse_object(r.value["body"])
	if d == null or not GendragoonClient.is_api_key(String(d.get("apiKey", ""))):
		return Result.failure("corrupt", "unexpected connect response")
	client.api_key = d["apiKey"]
	return Result.success(d)


## Exchanges a one-time connect code for an API key, which is set on the client. Value: {bindingId, apiKey,
## keyExpiresAt, scopes, workspaceId, quotaBytes}; store apiKey for the next session. Level L2, risk credential.
static func redeem_grant(client: GendragoonClient, grant: String, app_name: String, host := "") -> GendragoonResult:
	var why := client.check("connect.redeemGrant")
	if not why.is_empty():
		return Result.failure("level", why)
	grant = grant.strip_edges()
	if not _matches("^gdpg_[A-Za-z0-9_-]{43}$", grant):
		return Result.failure("invalid", "that is not a GenDragoon connect code")
	var info := {"name": app_name}
	if not host.is_empty():
		info["host"] = host
	var r := await client.send("POST", client.base_url + "/connect/redeem", B.json({"grant": grant, "client": info}).to_utf8_buffer(), {"Content-Type": "application/json"})
	return _connection(client, r)


## Exchanges an authorization code and the PKCE verifier for an API key. Level L2, risk credential.
static func exchange_code(client: GendragoonClient, code: String, verifier: String) -> GendragoonResult:
	var why := client.check("connect.exchangeCode")
	if not why.is_empty():
		return Result.failure("level", why)
	if not _matches("^gdpc_[A-Za-z0-9_-]{43}$", code):
		return Result.failure("invalid", "that is not a GenDragoon authorization code")
	var r := await client.send("POST", client.base_url + "/connect/token", B.json({"code": code, "codeVerifier": verifier}).to_utf8_buffer(), {"Content-Type": "application/json"})
	return _connection(client, r)


## {verifier, challenge, state}
static func new_pkce() -> Dictionary:
	var v := B.b64u(B.random(32))
	return {"verifier": v, "challenge": C.pkce_challenge(v), "state": B.b64u(B.random(16))}


static func is_loopback(redirect: String) -> bool:
	return _matches("^http://(127\\.0\\.0\\.1|\\[::1\\]):[0-9]{1,5}(/[^?#]*)?$", redirect)


static func _esc(s: String) -> String:
	return s.uri_encode().replace("%20", "+")


## The gendragoon://connect link to open with OS.shell_open. Empty when redirect is not a loopback URL.
static func connect_link(app_name: String, pkce: Dictionary, redirect: String, scopes := ["blobs:rw"], host := "") -> String:
	if not is_loopback(redirect):
		return ""
	var q := {"client": app_name, "scope": " ".join(PackedStringArray(scopes)), "code_challenge": pkce["challenge"], "code_challenge_method": "S256", "redirect_uri": redirect, "state": pkce["state"]}
	if not host.is_empty():
		q["host"] = host
	var keys := q.keys()
	keys.sort()
	var parts := PackedStringArray()
	for k in keys:
		parts.append(_esc(k) + "=" + _esc(q[k]))
	return "gendragoon://connect?" + "&".join(parts)


## Listens on 127.0.0.1 for the connect redirect. Value of wait(): the authorization code.
class Loopback:
	extends RefCounted
	var redirect_uri := ""
	var _server := TCPServer.new()
	var _state := PackedByteArray()

	func _init(pkce: Dictionary) -> void:
		_state = String(pkce["state"]).to_utf8_buffer()
		if _server.listen(0, "127.0.0.1") == OK:
			redirect_uri = "http://127.0.0.1:%d/gendragoon/callback" % _server.get_local_port()

	static func _query(q: String, name: String) -> String:
		for part in q.split("&"):
			var kv := part.split("=", true, 1)
			if kv[0].replace("+", " ").uri_decode() == name:
				return kv[1].replace("+", " ").uri_decode() if kv.size() > 1 else ""
		return ""

	func wait(tree: SceneTree, timeout_seconds := 300.0) -> GendragoonResult:
		var deadline := Time.get_ticks_msec() + int(timeout_seconds * 1000)
		while Time.get_ticks_msec() < deadline:
			if not _server.is_connection_available():
				await tree.process_frame
				continue
			var peer := _server.take_connection()
			var text := ""
			var until := Time.get_ticks_msec() + 5000
			while not text.contains("\r\n\r\n") and Time.get_ticks_msec() < until and text.length() < 8192:
				peer.poll()
				var n := peer.get_available_bytes()
				if n > 0:
					text += peer.get_utf8_string(n)
				else:
					await tree.process_frame
			var line := text.split("\r\n")[0].split(" ")
			var target := line[1] if line.size() >= 2 and line[0] == "GET" else ""
			var qi := target.find("?")
			var path := target if qi < 0 else target.substr(0, qi)
			var q := "" if qi < 0 else target.substr(qi + 1)
			var code := _query(q, "code")
			var good := path == "/gendragoon/callback" and B.equal(_query(q, "state").to_utf8_buffer(), _state) and GendragoonConnect._matches("^gdpc_[A-Za-z0-9_-]{43}$", code)
			var msg := "Connected. You can close this window and return to the game.\n" if good else "This link is not for this app.\n"
			peer.put_data(("HTTP/1.1 %s\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s" % ["200 OK" if good else "400 Bad Request", msg.to_utf8_buffer().size(), msg]).to_utf8_buffer())
			peer.disconnect_from_host()
			if good:
				_server.stop()
				return Result.success(code)
		_server.stop()
		return Result.failure("timeout", "timed out waiting for the connect redirect")
