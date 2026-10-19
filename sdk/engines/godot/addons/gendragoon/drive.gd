class_name GendragoonDrive
extends RefCounted
## A named tree of files and folders stored in one manifest, committed with compare-and-swap so concurrent writers
## never lose each other's changes. Paths are slash-separated ("saves/slot1.sav").

const B := preload("res://addons/gendragoon/bytes.gd")
const C := preload("res://addons/gendragoon/crypto.gd")
const Result := preload("res://addons/gendragoon/result.gd")
const DEFAULT_CHUNK_SIZE := 4 << 20

var name := ""
var manifest_key := ""
var encrypted := false
var _client: GendragoonClient
var _keys: GendragoonKeyring
var _chunk := DEFAULT_CHUNK_SIZE


## Opens the drive called drive_name. Pass keys = null for an unencrypted drive. Check is_valid() afterwards.
func _init(client: GendragoonClient, drive_name: String, keys: GendragoonKeyring = null, chunk_size := DEFAULT_CHUNK_SIZE) -> void:
	_client = client
	_keys = keys
	_chunk = chunk_size
	name = drive_name
	encrypted = keys != null
	if encrypted and keys.master() == null:
		return
	manifest_key = C.drive_manifest_key(keys.master() if encrypted else null, drive_name)


## False when the name is invalid or an encrypted drive was opened with a locked keyring.
func is_valid() -> bool:
	return not manifest_key.is_empty() and not name.is_empty() and name.to_utf8_buffer().size() <= 128


static func _dir(p: String) -> String:
	var i := p.rfind("/")
	return "" if i < 0 else p.substr(0, i)


static func _base(p: String) -> String:
	return p.substr(p.rfind("/") + 1)


## "" for a valid drive path, otherwise the reason. No leading or trailing slash, no empty, "." or ".." segments,
## no backslash or control characters, at most 1024 bytes.
static func check_path(p: String) -> String:
	if p.is_empty() or p.to_utf8_buffer().size() > 1024 or p.begins_with("/") or p.ends_with("/") or p.contains("\\"):
		return "invalid path \"%s\"" % p
	for seg in p.split("/"):
		if seg.is_empty() or seg == "." or seg == "..":
			return "invalid path \"%s\"" % p
		for i in seg.length():
			var c := seg.unicode_at(i)
			if c < 0x20 or c == 0x7f:
				return "invalid path \"%s\"" % p
	return ""


func _mk():
	return _keys.master() if encrypted else null


static func _sorted(keys: Array) -> Array:
	var a := keys.duplicate()
	a.sort_custom(func(x, y): return String(x).to_utf8_buffer().hex_encode() < String(y).to_utf8_buffer().hex_encode())
	return a


func _encode(doc: Dictionary) -> PackedByteArray:
	var files := {}
	for p in _sorted(doc["files"].keys()):
		var e: Dictionary = doc["files"][p]
		var o := {"size": int(e["size"]), "mtime": int(e["mtime"]), "sha256": e["sha256"], "chunks": e["chunks"]}
		if e.get("key", "") != "" and e.get("key") != null:
			o["key"] = e["key"]
		files[p] = o
	var folders := _sorted(doc["folders"])
	return B.json({"v": 1, "encrypted": doc["encrypted"], "files": files, "folders": folders if not folders.is_empty() else null, "updatedAt": int(doc["updatedAt"])}).to_utf8_buffer()


## Value: [document, generation]. The document is {encrypted, files: {path: entry}, folders: [..], updatedAt}.
func _load() -> GendragoonResult:
	if not is_valid():
		return Result.failure("locked" if encrypted else "invalid", "drive is not open")
	var r := await _client.get_manifest(manifest_key)
	if not r.ok:
		if r.is_not_found():
			return Result.success([{"encrypted": encrypted, "files": {}, "folders": [], "updatedAt": 0}, ""])
		return r
	var o := C.open_manifest(_mk(), manifest_key, r.value["data"])
	if o.has("error"):
		return Result.failure(o["error"], "drive manifest could not be opened")
	var d = B.parse_object(o["ok"])
	if d == null or int(d.get("v", 0)) != 1:
		return Result.failure("corrupt", "not a drive document")
	var doc := {"encrypted": bool(d.get("encrypted", false)), "files": d.get("files", {}), "folders": d.get("folders") if d.get("folders") != null else [], "updatedAt": int(d.get("updatedAt", 0))}
	return Result.success([doc, r.value["generation"]])


static func _folder_set(doc: Dictionary) -> Dictionary:
	var s := {}
	for f in doc["folders"]:
		s[f] = true
	for p in doc["files"]:
		var d := _dir(p)
		while not d.is_empty():
			s[d] = true
			d = _dir(d)
	return s


## Applies fn(doc) -> String ("" to commit, otherwise an error code and message "code:message") with retries.
func _update(fn: Callable) -> GendragoonResult:
	for attempt in 13:
		var r := await _load()
		if not r.ok:
			return r
		var doc: Dictionary = r.value[0]
		var gen: String = r.value[1]
		var err: String = fn.call(doc)
		if not err.is_empty():
			var i := err.find(":")
			return Result.failure(err.substr(0, i), err.substr(i + 1), 404 if err.begins_with("not_found") else 0)
		doc["updatedAt"] = int(Time.get_unix_time_from_system() * 1000)
		var w := await _client.put_manifest(manifest_key, C.seal_manifest(_mk(), manifest_key, _encode(doc)), gen.is_empty(), gen)
		if w.ok:
			return Result.success()
		if not w.is_precondition_failed() or attempt == 12:
			return w
		await _client.get_tree().create_timer((10 + randi() % (40 << mini(attempt, 4))) / 1000.0).timeout
	return Result.failure("precondition_failed", "too many concurrent writers")


func _gate(op: String) -> GendragoonResult:
	var why := _client.check(op)
	return null if why.is_empty() else Result.failure("level", why)


## Value: the drive document.
func snapshot() -> GendragoonResult:
	var g := _gate("files.list")
	if g:
		return g
	var r := await _load()
	return Result.success(r.value[0]) if r.ok else r


## Value: the direct children of folder ("" is the root), folders first, then by name. Each is
## {name, path, folder, size, mtime (unix seconds)}.
func list(folder := "") -> GendragoonResult:
	var g := _gate("files.list")
	if g:
		return g
	var r := await _load()
	if not r.ok:
		return r
	var doc: Dictionary = r.value[0]
	var dirs := []
	for f in _sorted(_folder_set(doc).keys()):
		if _dir(f) == folder:
			dirs.append({"name": _base(f), "path": f, "folder": true, "size": 0, "mtime": 0})
	var files := []
	for p in _sorted(doc["files"].keys()):
		if _dir(p) == folder:
			var e: Dictionary = doc["files"][p]
			files.append({"name": _base(p), "path": p, "folder": false, "size": int(e["size"]), "mtime": int(e["mtime"]) / 1000.0})
	var by_name := func(a, b): return String(a["name"]).to_utf8_buffer().hex_encode() < String(b["name"]).to_utf8_buffer().hex_encode()
	dirs.sort_custom(by_name)
	files.sort_custom(by_name)
	return Result.success(dirs + files)


## Value: {size, mtime, sha256, chunks, key?}.
func stat(p: String) -> GendragoonResult:
	var g := _gate("files.stat")
	if g:
		return g
	var r := await _load()
	if not r.ok:
		return r
	return Result.success(r.value[0]["files"][p]) if r.value[0]["files"].has(p) else Result.failure("not_found", p, 404)


## Creates or replaces a file. Unchanged chunks of an existing file are not uploaded again.
func write_file(p: String, data: PackedByteArray) -> GendragoonResult:
	var g := _gate("files.write")
	if g:
		return g
	var bad := check_path(p)
	if not bad.is_empty():
		return Result.failure("invalid", bad)
	var file_key = null
	if encrypted:
		var cur := await _load()
		if cur.ok and cur.value[0]["files"].has(p):
			var k := B.from_b64u(String(cur.value[0]["files"][p].get("key", "")))
			if k.size() == C.KEY_BYTES:
				file_key = k
		if file_key == null:
			file_key = B.random(C.KEY_BYTES)
	var entry := {"size": data.size(), "mtime": int(Time.get_unix_time_from_system() * 1000), "sha256": B.hex(B.sha256(data)), "chunks": []}
	if file_key != null:
		entry["key"] = B.b64u(file_key)
	var parts := []
	for off in range(0, data.size(), _chunk):
		var piece := data.slice(off, off + _chunk)
		parts.append(C.seal_chunk(file_key, piece) if file_key != null else [B.hex(B.sha256(piece)), piece])
	var ids := []
	for pt in parts:
		ids.append(pt[0])
	var has := await _client.has_blobs(ids)
	if not has.ok:
		return has
	var seen := {}
	for id in has.value:
		seen[id] = true
	for pt in parts:
		entry["chunks"].append(pt[0])
		if seen.has(pt[0]):
			continue
		seen[pt[0]] = true
		var w: GendragoonResult
		if file_key != null:
			w = await _client.put_sealed_blob(pt[0], pt[1])
		else:
			w = await _client.put_blob(pt[1])
		if not w.ok:
			return w
	var u := await _update(func(doc):
		if _folder_set(doc).has(p):
			return "invalid:\"%s\" is a folder" % p
		var d := _dir(p)
		while not d.is_empty():
			if doc["files"].has(d):
				return "invalid:\"%s\" is a file" % d
			d = _dir(d)
		doc["files"][p] = entry
		return "")
	return Result.success(entry) if u.ok else u


## Value: the file's bytes, verified against its SHA-256.
func read_file(p: String) -> GendragoonResult:
	var g := _gate("files.read")
	if g:
		return g
	var r := await _load()
	if not r.ok:
		return r
	if not r.value[0]["files"].has(p):
		return Result.failure("not_found", p, 404)
	return await read_entry(_client, r.value[0]["files"][p])


static func read_entry(client: GendragoonClient, e: Dictionary) -> GendragoonResult:
	var key := B.from_b64u(String(e.get("key", ""))) if e.get("key") != null else PackedByteArray()
	var buf := PackedByteArray()
	for id in e["chunks"]:
		var r := await client.get_blob(id)
		if not r.ok:
			return r
		var blob: PackedByteArray = r.value
		if not key.is_empty():
			var pt = C.open_chunk(key, id, blob)
			if pt == null:
				return Result.failure("corrupt", "chunk could not be decrypted")
			blob = pt
		buf.append_array(blob)
	if buf.size() != int(e["size"]) or B.hex(B.sha256(buf)) != e["sha256"]:
		return Result.failure("corrupt", "file content does not match its checksum")
	return Result.success(buf)


## Creates a folder and its parents. An existing folder is not an error.
func mkdir(p: String) -> GendragoonResult:
	var g := _gate("files.mkdir")
	if g:
		return g
	var bad := check_path(p)
	if not bad.is_empty():
		return Result.failure("invalid", bad)
	return await _update(func(doc):
		var s := _folder_set(doc)
		var d := p
		while not d.is_empty():
			if doc["files"].has(d):
				return "invalid:\"%s\" is a file" % d
			if not s.has(d):
				s[d] = true
				doc["folders"].append(d)
			d = _dir(d)
		return "")


## Renames a file or a folder with everything in it. The destination must not exist.
func move(from: String, to: String) -> GendragoonResult:
	var g := _gate("files.move")
	if g:
		return g
	for q in [from, to]:
		var bad := check_path(q)
		if not bad.is_empty():
			return Result.failure("invalid", bad)
	if to == from or to.begins_with(from + "/"):
		return Result.failure("invalid", "cannot move a folder into itself")
	return await _update(func(doc):
		var s := _folder_set(doc)
		if doc["files"].has(to) or s.has(to):
			return "invalid:\"%s\" already exists" % to
		if doc["files"].has(from):
			doc["files"][to] = doc["files"][from]
			doc["files"].erase(from)
			return ""
		if not s.has(from):
			return "not_found:" + from
		for q in doc["files"].keys():
			if q.begins_with(from + "/"):
				doc["files"][to + q.substr(from.length())] = doc["files"][q]
				doc["files"].erase(q)
		var fo := {}
		for f in doc["folders"]:
			fo[(to + f.substr(from.length())) if (f == from or f.begins_with(from + "/")) else f] = true
		fo[to] = true
		doc["folders"] = fo.keys()
		return "")


## Removes one file or one empty folder. Level L2, risk destructive.
func delete(p: String) -> GendragoonResult:
	var g := _gate("files.delete")
	if g:
		return g
	return await _update(func(doc):
		if doc["files"].has(p):
			doc["files"].erase(p)
			return ""
		var s := _folder_set(doc)
		if not s.has(p):
			return "not_found:" + p
		for q in s.keys() + doc["files"].keys():
			if q.begins_with(p + "/"):
				return "invalid:folder \"%s\" is not empty" % p
		doc["folders"].erase(p)
		return "")


## Removes a folder and everything in it; value is the number of files removed. Level L3, risk bulk-destructive.
func delete_folder(p: String) -> GendragoonResult:
	var g := _gate("files.deleteFolder")
	if g:
		return g
	var n := [0]
	var u := await _update(func(doc):
		n[0] = 0
		for q in doc["files"].keys():
			if q.begins_with(p + "/"):
				doc["files"].erase(q)
				n[0] += 1
		doc["folders"] = doc["folders"].filter(func(f): return f != p and not f.begins_with(p + "/"))
		return "")
	return Result.success(n[0]) if u.ok else u
