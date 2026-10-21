class_name GendragoonResult
extends RefCounted
## Every asynchronous call returns a result. `ok` is false on failure; `status` is the HTTP status (0 when the call
## never reached the server), `error` a stable code such as "not_found", "precondition_failed", "quota_exceeded",
## "level", "locked", "corrupt", "wrong_passphrase" or "network", and `message` a readable explanation.

var ok := true
var value = null
var status := 0
var error := ""
var message := ""


static func success(v = null) -> GendragoonResult:
	var r := GendragoonResult.new()
	r.value = v
	return r


static func failure(code: String, msg := "", http_status := 0) -> GendragoonResult:
	var r := GendragoonResult.new()
	r.ok = false
	r.error = code
	r.message = msg if not msg.is_empty() else code
	r.status = http_status
	return r


func is_not_found() -> bool:
	return status == 404 or error == "not_found"


func is_precondition_failed() -> bool:
	return status == 412 or error == "precondition_failed" or error == "version_mismatch"


func is_quota_exceeded() -> bool:
	return status == 507 or error == "quota_exceeded"


func is_unauthorized() -> bool:
	return status == 401


func _to_string() -> String:
	return "ok" if ok else "gendragoon: %s (%d) %s" % [error, status, message]
