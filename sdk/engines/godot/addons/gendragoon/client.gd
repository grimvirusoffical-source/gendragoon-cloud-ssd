class_name GendragoonClient
extends Node
## One binding, authenticated with its gdpk_ API key. Add it to the scene tree before making calls; every call is a
## coroutine that returns a GendragoonResult.

const B := preload("res://addons/gendragoon/bytes.gd")
const Gate := preload("res://addons/gendragoon/gate.gd")
const Result := preload("res://addons/gendragoon/result.gd")
const VERSION := "0.1.0"

## Provider API base URL, for example https://api.gendragoon.com/provider/v1
@export var base_url := ""
## Highest operation level this client may use.
@export_range(0, 4) var max_level := Gate.DEFAULT_MAX_LEVEL
@export var timeout_seconds := 60.0

var api_key := ""

const _METHODS := {"GET": HTTPClient.METHOD_GET, "HEAD": HTTPClient.METHOD_HEAD, "POST": HTTPClient.METHOD_POST, "PUT": HTTPClient.METHOD_PUT, "PATCH": HTTPClient.METHOD_PATCH, "DELETE": HTTPClient.METHOD_DELETE}


static func is_api_key(k: String) -> bool:
	var re := RegEx.create_from_string("^gdpk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$")
	return re.search(k) != null


func _init(url := "", key := "") -> void:
	base_url = url.rstrip("/")
	api_key = key


func _to_string() -> String:
	return "GendragoonClient(%s)" % base_url


## "" when the gate allows op, otherwise the reason.
func check(op: String) -> String:
	return Gate.check(op, Gate.effective(max_level))


## Low-level HTTP call. auth: "key" (the API key), "" (none) or a full Authorization value.
func send(method: String, url: String, body := PackedByteArray(), headers := {}, authorization := "") -> GendragoonResult:
	var http := HTTPRequest.new()
	http.max_redirects = 0
	http.timeout = timeout_seconds
	http.accept_gzip = false
	add_child(http)
	var h := PackedStringArray(["User-Agent: gendragoon-sdk-godot/%s godot/%s" % [VERSION, Engine.get_version_info()["string"]]])
	if not authorization.is_empty():
		h.append("Authorization: " + authorization)
	for k in headers:
		h.append("%s: %s" % [k, headers[k]])
	var err := http.request_raw(url, h, _METHODS[method], body)
	if err != OK:
		http.queue_free()
		return Result.failure("network", "could not start the request (%d)" % err)
	var res: Array = await http.request_completed
	http.queue_free()
	if res[0] != HTTPRequest.RESULT_SUCCESS:
		return Result.failure("network", "%s %s failed (%d)" % [method, url.split("?")[0], res[0]])
	var code: int = res[1]
	var hdrs := {}
	for line in res[2]:
		var i: int = line.find(":")
		if i > 0:
			hdrs[line.substr(0, i).strip_edges().to_lower()] = line.substr(i + 1).strip_edges()
	var data: PackedByteArray = res[3]
	if code >= 300:
		var o = B.parse_object(data)
		var ecode: String = String(o.get("error", "")) if o != null else ""
		return Result.failure(ecode if not ecode.is_empty() else "http_%d" % code, "%d %s" % [code, ecode], code)
	return Result.success({"status": code, "headers": hdrs, "body": data})


func request(op: String, method: String, path: String, body := PackedByteArray(), headers := {}, auth := true) -> GendragoonResult:
	var why := check(op)
	if not why.is_empty():
		return Result.failure("level", why)
	return await send(method, base_url + path, body, headers, ("Bearer " + api_key) if auth else "")


func _json(r: GendragoonResult) -> GendragoonResult:
	if not r.ok:
		return r
	var o = B.parse_object(r.value["body"])
	return Result.failure("corrupt", "unexpected response") if o == null else Result.success(o)


static func _etag(r: GendragoonResult) -> String:
	return String(r.value["headers"].get("etag", "")).trim_prefix("\"").trim_suffix("\"")


func capabilities() -> GendragoonResult:
	return _json(await request("capabilities", "GET", "/capabilities", PackedByteArray(), {}, false))


func health() -> GendragoonResult:
	return await request("health", "GET", "/health")


## {usedBytes, quotaBytes, objectCount, changeSeq, workspaceId, lastChangeAt}
func usage() -> GendragoonResult:
	return _json(await request("usage", "GET", "/usage"))


# ---- blobs ----

## Stores data content-addressed (id = SHA-256); value is the id.
func put_blob(data: PackedByteArray) -> GendragoonResult:
	var id := B.hex(B.sha256(data))
	var r := await _put_blob(id, data, "content")
	return Result.success(id) if r.ok else r


## Stores data under an id the caller chose (for example an HMAC of the plaintext).
func put_sealed_blob(id: String, data: PackedByteArray) -> GendragoonResult:
	return await _put_blob(id, data, "sealed")


func _put_blob(id: String, data: PackedByteArray, mode: String) -> GendragoonResult:
	if not B.is_hex64(id):
		return Result.failure("invalid", "blob id must be 64 lower-case hex characters")
	return await request("blobs.put", "PUT", "/blobs/" + id, data, {"Content-Type": "application/octet-stream", "X-Id-Mode": mode, "X-Content-SHA256": B.hex(B.sha256(data))})


## A blob's bytes, verified against the server's checksum.
func get_blob(id: String) -> GendragoonResult:
	if not B.is_hex64(id):
		return Result.failure("invalid", "blob id must be 64 lower-case hex characters")
	var r := await request("blobs.get", "GET", "/blobs/" + id)
	if not r.ok:
		return r
	var body: PackedByteArray = r.value["body"]
	var want: String = r.value["headers"].get("x-content-sha256", "")
	if not want.is_empty() and want != B.hex(B.sha256(body)):
		return Result.failure("checksum", "checksum mismatch")
	return Result.success(body)


## Level L2, risk destructive.
func delete_blob(id: String) -> GendragoonResult:
	if not B.is_hex64(id):
		return Result.failure("invalid", "blob id must be 64 lower-case hex characters")
	return await request("blobs.delete", "DELETE", "/blobs/" + id)


## Value: the subset of ids that exist.
func has_blobs(ids: Array) -> GendragoonResult:
	var present := []
	for i in range(0, ids.size(), 1000):
		var r := _json(await request("blobs.batchHas", "POST", "/blobs/batch-has", B.json({"ids": ids.slice(i, i + 1000)}).to_utf8_buffer(), {"Content-Type": "application/json"}))
		if not r.ok:
			return r
		present.append_array(r.value.get("present", []))
	return Result.success(present)


func _all(op: String, path: String) -> GendragoonResult:
	var items := []
	var cursor := ""
	while true:
		var r := _json(await request(op, "GET", path + ("?cursor=" + cursor.uri_encode() if not cursor.is_empty() else "")))
		if not r.ok:
			return r
		if r.value.has("items"):
			for it in r.value["items"]:
				items.append({"id": it.get("id", ""), "size": int(it.get("size", 0)), "generation": it.get("generation")})
		else:
			for id in r.value.get("ids", []):
				items.append({"id": id, "size": 0, "generation": null})
		var nxt = r.value.get("next")
		if nxt == null or String(nxt).is_empty():
			break
		cursor = String(nxt)
	return Result.success(items)


func all_blobs() -> GendragoonResult:
	return await _all("blobs.list", "/blobs")


func all_manifests() -> GendragoonResult:
	return await _all("manifests.list", "/manifests")


# ---- manifests ----

## Value: {data, generation}.
func get_manifest(key: String) -> GendragoonResult:
	if not B.is_hex64(key):
		return Result.failure("invalid", "manifest key must be 64 lower-case hex characters")
	var r := await request("manifests.get", "GET", "/manifests/" + key)
	return Result.success({"data": r.value["body"], "generation": _etag(r)}) if r.ok else r


## Create-only when if_absent, compare-and-swap when if_generation is set. A lost race fails with precondition_failed.
func put_manifest(key: String, data: PackedByteArray, if_absent := false, if_generation := "") -> GendragoonResult:
	if not B.is_hex64(key):
		return Result.failure("invalid", "manifest key must be 64 lower-case hex characters")
	var h := {"Content-Type": "application/octet-stream", "X-Content-SHA256": B.hex(B.sha256(data))}
	if if_absent:
		h["If-None-Match"] = "*"
	elif not if_generation.is_empty():
		h["If-Match"] = "\"%s\"" % if_generation
	var r := await request("manifests.put", "PUT", "/manifests/" + key, data, h)
	return Result.success({"created": r.value["status"] == 201, "generation": _etag(r)}) if r.ok else r


## Level L2, risk destructive.
func delete_manifest(key: String) -> GendragoonResult:
	if not B.is_hex64(key):
		return Result.failure("invalid", "manifest key must be 64 lower-case hex characters")
	return await request("manifests.delete", "DELETE", "/manifests/" + key)


# ---- key envelope and credentials ----

func get_key_envelope() -> GendragoonResult:
	return _json(await request("keyEnvelope.get", "GET", "/key-envelope"))


func put_key_envelope(op: String, env: Dictionary, precondition: Dictionary) -> GendragoonResult:
	var h := precondition.duplicate()
	h["Content-Type"] = "application/json"
	return await request(op, "PUT", "/key-envelope", B.json(env).to_utf8_buffer(), h)


## Replaces the API key (the old one keeps working for ten minutes); value is the new key, which the game must store.
func rotate_api_key() -> GendragoonResult:
	var r := _json(await request("apiKey.rotate", "POST", "/connect/rotate"))
	if not r.ok:
		return r
	var k := String(r.value.get("apiKey", ""))
	if not is_api_key(k):
		return Result.failure("corrupt", "unexpected rotate response")
	api_key = k
	return Result.success(k)
