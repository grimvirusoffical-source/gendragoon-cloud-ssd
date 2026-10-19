class_name GendragoonBytes
extends RefCounted
## Encoding helpers and an order-preserving JSON writer (the SDKs compare documents byte for byte).

const MASK32 := 0xFFFFFFFF


static func hex(b: PackedByteArray) -> String:
	return b.hex_encode()


## Empty array (and ok == false through is_hex) for malformed input.
static func from_hex(s: String) -> PackedByteArray:
	if s.length() % 2 != 0 or not is_hex(s):
		return PackedByteArray()
	return s.hex_decode()


static func is_hex(s: String) -> bool:
	for c in s:
		if not ((c >= "0" and c <= "9") or (c >= "a" and c <= "f") or (c >= "A" and c <= "F")):
			return false
	return true


static func is_hex64(s: String) -> bool:
	return s.length() == 64 and s == s.to_lower() and is_hex(s)


static func b64u(b: PackedByteArray) -> String:
	if b.is_empty():
		return ""
	return Marshalls.raw_to_base64(b).replace("+", "-").replace("/", "_").replace("=", "")


static func from_b64u(s: String) -> PackedByteArray:
	if s.is_empty():
		return PackedByteArray()
	var t := s.replace("-", "+").replace("_", "/")
	while t.length() % 4 != 0:
		t += "="
	return Marshalls.base64_to_raw(t)


static func utf8(s: String) -> PackedByteArray:
	return s.to_utf8_buffer()


static func concat(parts: Array) -> PackedByteArray:
	var o := PackedByteArray()
	for p in parts:
		o.append_array(p)
	return o


static func random(n: int) -> PackedByteArray:
	return Crypto.new().generate_random_bytes(n)


static func sha256(b: PackedByteArray) -> PackedByteArray:
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	h.update(b)
	return h.finish()


static func hmac(key: PackedByteArray, msg: PackedByteArray) -> PackedByteArray:
	return Crypto.new().hmac_digest(HashingContext.HASH_SHA256, key, msg)


static func equal(a: PackedByteArray, b: PackedByteArray) -> bool:
	if a.size() != b.size():
		return false
	var x := 0
	for i in a.size():
		x |= a[i] ^ b[i]
	return x == 0


## Writes JSON keeping Dictionary insertion order. Whole-number floats are written as integers.
static func json(v) -> String:
	match typeof(v):
		TYPE_NIL:
			return "null"
		TYPE_BOOL:
			return "true" if v else "false"
		TYPE_INT:
			return str(v)
		TYPE_FLOAT:
			return str(int(v)) if v == floor(v) and abs(v) < 9.0e15 else str(v)
		TYPE_STRING, TYPE_STRING_NAME:
			return _quote(String(v))
		TYPE_ARRAY, TYPE_PACKED_STRING_ARRAY:
			var parts := PackedStringArray()
			for x in v:
				parts.append(json(x))
			return "[" + ",".join(parts) + "]"
		TYPE_DICTIONARY:
			var parts := PackedStringArray()
			for k in v:
				parts.append(_quote(String(k)) + ":" + json(v[k]))
			return "{" + ",".join(parts) + "}"
	return "null"


static func _quote(s: String) -> String:
	var o := "\""
	for i in s.length():
		var c := s.unicode_at(i)
		match c:
			0x22: o += "\\\""
			0x5c: o += "\\\\"
			0x0a: o += "\\n"
			0x0d: o += "\\r"
			0x09: o += "\\t"
			_:
				o += ("\\u%04x" % c) if c < 0x20 else String.chr(c)
	return o + "\""


## Parses a JSON object; null when the text is not one.
static func parse_object(b: PackedByteArray):
	var v = JSON.parse_string(b.get_string_from_utf8())
	return v if typeof(v) == TYPE_DICTIONARY else null
