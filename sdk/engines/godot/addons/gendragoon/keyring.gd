class_name GendragoonKeyring
extends RefCounted
## The unlocked master key, held in memory only. Unlocking runs scrypt on a worker thread (a few seconds).

const B := preload("res://addons/gendragoon/bytes.gd")
const C := preload("res://addons/gendragoon/crypto.gd")
const Result := preload("res://addons/gendragoon/result.gd")

var _client: GendragoonClient
var _mk = null


func _init(client: GendragoonClient) -> void:
	_client = client


func _to_string() -> String:
	return "GendragoonKeyring(unlocked=%s)" % is_unlocked()


func is_unlocked() -> bool:
	return _mk != null


## Drops the master key from memory.
func lock() -> void:
	if _mk != null:
		_mk.fill(0)
	_mk = null


## The master key for internal use; null when locked.
func master():
	return _mk


func _off_thread(fn: Callable):
	var t := Thread.new()
	t.start(fn)
	while t.is_alive():
		await _client.get_tree().process_frame
	return t.wait_to_finish()


## Reads the binding's key envelope and opens it. Level L2, risk key.
func unlock(passphrase: String) -> GendragoonResult:
	var why := _client.check("crypto.unlock")
	if not why.is_empty():
		return Result.failure("level", why)
	if passphrase.to_utf8_buffer().size() < 8:
		return Result.failure("invalid", "recovery passphrase must be at least 8 characters")
	var r := await _client.get_key_envelope()
	if not r.ok:
		return r
	var env: Dictionary = r.value
	var bad := C.validate_envelope(env)
	if not bad.is_empty():
		return Result.failure("unsupported" if bad.begins_with("argon2id") else "corrupt", bad)
	var mk = await _off_thread(func(): return C.unwrap_master_key(env, passphrase))
	if mk == null:
		return Result.failure("wrong_passphrase", "the recovery passphrase did not unlock this key")
	lock()
	_mk = mk
	return Result.success()


## Generates a master key and stores its first recovery envelope. Create-only: it fails with status 412
## (precondition_failed) when an envelope already exists, so it can never replace one. Level L2, risk key.
func create(passphrase: String) -> GendragoonResult:
	var why := _client.check("keyEnvelope.create")
	if not why.is_empty():
		return Result.failure("level", why)
	if passphrase.to_utf8_buffer().size() < 8:
		return Result.failure("invalid", "recovery passphrase must be at least 8 characters")
	var mk := B.random(C.KEY_BYTES)
	var env: Dictionary = await _off_thread(func(): return C.wrap_master_key(mk, passphrase))
	var r := await _client.put_key_envelope("keyEnvelope.create", env, {"If-None-Match": "*"})
	if not r.ok:
		mk.fill(0)
		# The server answers 409 envelope_exists; every SDK reports it as a lost compare-and-swap.
		return Result.failure("precondition_failed", "a master key already exists", 412) if r.error == "envelope_exists" else r
	lock()
	_mk = mk
	return Result.success()


## Re-wraps the master key under a new passphrase. Level L3, risk key.
func change_passphrase(new_passphrase: String) -> GendragoonResult:
	var why := _client.check("keyEnvelope.replace")
	if not why.is_empty():
		return Result.failure("level", why)
	if _mk == null:
		return Result.failure("locked", "master key not unlocked")
	var cur := await _client.get_key_envelope()
	if not cur.ok:
		return cur
	var version := int(cur.value.get("version", 0))
	var mk: PackedByteArray = _mk
	var env: Dictionary = await _off_thread(func(): return C.wrap_master_key(mk, new_passphrase, version + 1))
	return await _client.put_key_envelope("keyEnvelope.replace", env, {"If-Match": "\"%d\"" % version})


## Loads a master key handed over by the host (for example the Rotten Apple launcher). Level L2, risk key.
func import_master_key(key: PackedByteArray) -> GendragoonResult:
	var why := _client.check("crypto.importMasterKey")
	if not why.is_empty():
		return Result.failure("level", why)
	if key.size() != C.KEY_BYTES:
		return Result.failure("invalid", "master key must be 32 bytes")
	lock()
	_mk = key.duplicate()
	return Result.success()


## A copy of the raw master key. Level L4, risk key-export: the default gate refuses it.
func export_master_key() -> GendragoonResult:
	var why := _client.check("crypto.exportMasterKey")
	if not why.is_empty():
		return Result.failure("level", why)
	if _mk == null:
		return Result.failure("locked", "master key not unlocked")
	return Result.success(_mk.duplicate())
