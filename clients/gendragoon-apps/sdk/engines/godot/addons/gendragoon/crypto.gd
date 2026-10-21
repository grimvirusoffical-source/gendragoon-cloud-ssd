class_name GendragoonCrypto
extends RefCounted
## Encryption formats (sdk/spec/FORMATS.md): AES-256-GCM with HKDF-SHA256 subkeys of a 32-byte master key.
##
## Godot has AES in ECB mode but not GCM, so counter mode and GHASH are built on AESContext here. scrypt runs in
## GDScript and takes several seconds; argon2id envelopes and P-256 sharing are not available in this addon.

const B := preload("res://addons/gendragoon/bytes.gd")
const KEY_BYTES := 32
const NONCE_BYTES := 12
const INFO := "gendragoon-sdk/v1/"
const M32 := 0xFFFFFFFF
const R_HI := 0xE1 << 56


# ---- HKDF-SHA256 ----

static func hkdf(ikm: PackedByteArray, salt: PackedByteArray, info: String, length: int = 32) -> PackedByteArray:
	var s := salt if not salt.is_empty() else PackedByteArray()
	if s.is_empty():
		s.resize(32)
	var prk := B.hmac(s, ikm)
	var out := PackedByteArray()
	var t := PackedByteArray()
	var i := 1
	while out.size() < length:
		var m := t.duplicate()
		m.append_array(info.to_utf8_buffer())
		m.append(i)
		t = B.hmac(prk, m)
		out.append_array(t)
		i += 1
	return out.slice(0, length)


## HKDF-SHA256(ikm, no salt, info = "gendragoon-sdk/v1/" + purpose).
static func sub_key(ikm: PackedByteArray, purpose: String) -> PackedByteArray:
	return hkdf(ikm, PackedByteArray(), INFO + purpose)


# ---- AES-256-GCM (12-byte nonces) ----

static func _ecb(key: PackedByteArray, data: PackedByteArray) -> PackedByteArray:
	var a := AESContext.new()
	a.start(AESContext.MODE_ECB_ENCRYPT, key)
	var o := a.update(data)
	a.finish()
	return o


static func _u64(b: PackedByteArray, o: int) -> int:
	var v := 0
	for i in 8:
		v = (v << 8) | b[o + i]
	return v


static func _put64(b: PackedByteArray, o: int, v: int) -> void:
	for i in range(7, -1, -1):
		b[o + i] = v & 0xFF
		v = v >> 8


## Table of the 16 multiples of H by 4-bit values (Shoup's method), as [hi, lo] pairs.
static func _table(hh: int, hl: int) -> Array:
	var t := []
	t.resize(16)
	t[0] = [0, 0]
	t[8] = [hh, hl]
	var vh := hh
	var vl := hl
	for i in [4, 2, 1]:
		var lsb := vl & 1
		vl = ((vl >> 1) & 0x7FFFFFFFFFFFFFFF) | ((vh & 1) << 63)
		vh = (vh >> 1) & 0x7FFFFFFFFFFFFFFF
		if lsb:
			vh ^= R_HI
		t[i] = [vh, vl]
	for i in [2, 4, 8]:
		for j in range(1, i):
			t[i + j] = [t[i][0] ^ t[j][0], t[i][1] ^ t[j][1]]
	return t


const _REDUCE := [0x0000, 0x1C20, 0x3840, 0x2460, 0x7080, 0x6CA0, 0x48C0, 0x54E0, 0xE100, 0xFD20, 0xD940, 0xC560, 0x9180, 0x8DA0, 0xA9C0, 0xB5E0]


static func _ghash(h: PackedByteArray, aad: PackedByteArray, ct: PackedByteArray) -> PackedByteArray:
	var t := _table(_u64(h, 0), _u64(h, 8))
	var data := PackedByteArray()
	for part in [aad, ct]:
		data.append_array(part)
		var pad: int = (16 - part.size() % 16) % 16
		for i in pad:
			data.append(0)
	var lens := PackedByteArray()
	lens.resize(16)
	_put64(lens, 0, aad.size() * 8)
	_put64(lens, 8, ct.size() * 8)
	data.append_array(lens)
	var zh := 0
	var zl := 0
	var x := PackedByteArray()
	x.resize(16)
	for off in range(0, data.size(), 16):
		for i in 16:
			x[i] = data[off + i] ^ ((zh >> (56 - 8 * i)) & 0xFF if i < 8 else (zl >> (56 - 8 * (i - 8))) & 0xFF)
		zh = 0
		zl = 0
		for i in range(15, -1, -1):
			for nib in [x[i] & 0x0F, x[i] >> 4]:
				var rem: int = zl & 0x0F
				zl = ((zl >> 4) & 0x0FFFFFFFFFFFFFFF) | ((zh & 0x0F) << 60)
				zh = (zh >> 4) & 0x0FFFFFFFFFFFFFFF
				zh ^= _REDUCE[rem] << 48
				zh ^= t[nib][0]
				zl ^= t[nib][1]
	var o := PackedByteArray()
	o.resize(16)
	_put64(o, 0, zh)
	_put64(o, 8, zl)
	return o


static func _ctr(key: PackedByteArray, nonce: PackedByteArray, n: int) -> PackedByteArray:
	var blocks := (n + 15) / 16 + 1
	var ctr := PackedByteArray()
	ctr.resize(blocks * 16)
	for b in blocks:
		for i in 12:
			ctr[b * 16 + i] = nonce[i]
		var c := b + 1
		ctr[b * 16 + 12] = (c >> 24) & 0xFF
		ctr[b * 16 + 13] = (c >> 16) & 0xFF
		ctr[b * 16 + 14] = (c >> 8) & 0xFF
		ctr[b * 16 + 15] = c & 0xFF
	return _ecb(key, ctr)


static func seal(key: PackedByteArray, nonce: PackedByteArray, pt: PackedByteArray, aad := PackedByteArray()) -> PackedByteArray:
	var ks := _ctr(key, nonce, pt.size())
	var ct := pt.duplicate()
	for i in ct.size():
		ct[i] ^= ks[16 + i]
	var zero := PackedByteArray()
	zero.resize(16)
	var s := _ghash(_ecb(key, zero), aad, ct)
	for i in 16:
		s[i] ^= ks[i]
	ct.append_array(s)
	return ct


## Null when authentication fails.
static func open(key: PackedByteArray, nonce: PackedByteArray, sealed: PackedByteArray, aad := PackedByteArray()):
	if sealed.size() < 16 or nonce.size() != NONCE_BYTES:
		return null
	var ct := sealed.slice(0, sealed.size() - 16)
	var ks := _ctr(key, nonce, ct.size())
	var zero := PackedByteArray()
	zero.resize(16)
	var s := _ghash(_ecb(key, zero), aad, ct)
	for i in 16:
		s[i] ^= ks[i]
	if not B.equal(s, sealed.slice(sealed.size() - 16)):
		return null
	var pt := ct.duplicate()
	for i in pt.size():
		pt[i] ^= ks[16 + i]
	return pt


# ---- scrypt (RFC 7914) ----

static func _pbkdf2_1(pw: PackedByteArray, salt: PackedByteArray, length: int) -> PackedByteArray:
	var out := PackedByteArray()
	var i := 1
	while out.size() < length:
		var s := salt.duplicate()
		s.append_array(PackedByteArray([(i >> 24) & 0xFF, (i >> 16) & 0xFF, (i >> 8) & 0xFF, i & 0xFF]))
		out.append_array(B.hmac(pw, s))
		i += 1
	return out.slice(0, length)


static func _salsa8(b: PackedInt64Array, off: int) -> void:
	var x0 := b[off]; var x1 := b[off + 1]; var x2 := b[off + 2]; var x3 := b[off + 3]
	var x4 := b[off + 4]; var x5 := b[off + 5]; var x6 := b[off + 6]; var x7 := b[off + 7]
	var x8 := b[off + 8]; var x9 := b[off + 9]; var x10 := b[off + 10]; var x11 := b[off + 11]
	var x12 := b[off + 12]; var x13 := b[off + 13]; var x14 := b[off + 14]; var x15 := b[off + 15]
	var u := 0
	for _r in 4:
		u = (x0 + x12) & M32; x4 ^= ((u << 7) | (u >> 25)) & M32
		u = (x4 + x0) & M32; x8 ^= ((u << 9) | (u >> 23)) & M32
		u = (x8 + x4) & M32; x12 ^= ((u << 13) | (u >> 19)) & M32
		u = (x12 + x8) & M32; x0 ^= ((u << 18) | (u >> 14)) & M32
		u = (x5 + x1) & M32; x9 ^= ((u << 7) | (u >> 25)) & M32
		u = (x9 + x5) & M32; x13 ^= ((u << 9) | (u >> 23)) & M32
		u = (x13 + x9) & M32; x1 ^= ((u << 13) | (u >> 19)) & M32
		u = (x1 + x13) & M32; x5 ^= ((u << 18) | (u >> 14)) & M32
		u = (x10 + x6) & M32; x14 ^= ((u << 7) | (u >> 25)) & M32
		u = (x14 + x10) & M32; x2 ^= ((u << 9) | (u >> 23)) & M32
		u = (x2 + x14) & M32; x6 ^= ((u << 13) | (u >> 19)) & M32
		u = (x6 + x2) & M32; x10 ^= ((u << 18) | (u >> 14)) & M32
		u = (x15 + x11) & M32; x3 ^= ((u << 7) | (u >> 25)) & M32
		u = (x3 + x15) & M32; x7 ^= ((u << 9) | (u >> 23)) & M32
		u = (x7 + x3) & M32; x11 ^= ((u << 13) | (u >> 19)) & M32
		u = (x11 + x7) & M32; x15 ^= ((u << 18) | (u >> 14)) & M32
		u = (x0 + x3) & M32; x1 ^= ((u << 7) | (u >> 25)) & M32
		u = (x1 + x0) & M32; x2 ^= ((u << 9) | (u >> 23)) & M32
		u = (x2 + x1) & M32; x3 ^= ((u << 13) | (u >> 19)) & M32
		u = (x3 + x2) & M32; x0 ^= ((u << 18) | (u >> 14)) & M32
		u = (x5 + x4) & M32; x6 ^= ((u << 7) | (u >> 25)) & M32
		u = (x6 + x5) & M32; x7 ^= ((u << 9) | (u >> 23)) & M32
		u = (x7 + x6) & M32; x4 ^= ((u << 13) | (u >> 19)) & M32
		u = (x4 + x7) & M32; x5 ^= ((u << 18) | (u >> 14)) & M32
		u = (x10 + x9) & M32; x11 ^= ((u << 7) | (u >> 25)) & M32
		u = (x11 + x10) & M32; x8 ^= ((u << 9) | (u >> 23)) & M32
		u = (x8 + x11) & M32; x9 ^= ((u << 13) | (u >> 19)) & M32
		u = (x9 + x8) & M32; x10 ^= ((u << 18) | (u >> 14)) & M32
		u = (x15 + x14) & M32; x12 ^= ((u << 7) | (u >> 25)) & M32
		u = (x12 + x15) & M32; x13 ^= ((u << 9) | (u >> 23)) & M32
		u = (x13 + x12) & M32; x14 ^= ((u << 13) | (u >> 19)) & M32
		u = (x14 + x13) & M32; x15 ^= ((u << 18) | (u >> 14)) & M32
	b[off] = (b[off] + x0) & M32; b[off + 1] = (b[off + 1] + x1) & M32; b[off + 2] = (b[off + 2] + x2) & M32; b[off + 3] = (b[off + 3] + x3) & M32
	b[off + 4] = (b[off + 4] + x4) & M32; b[off + 5] = (b[off + 5] + x5) & M32; b[off + 6] = (b[off + 6] + x6) & M32; b[off + 7] = (b[off + 7] + x7) & M32
	b[off + 8] = (b[off + 8] + x8) & M32; b[off + 9] = (b[off + 9] + x9) & M32; b[off + 10] = (b[off + 10] + x10) & M32; b[off + 11] = (b[off + 11] + x11) & M32
	b[off + 12] = (b[off + 12] + x12) & M32; b[off + 13] = (b[off + 13] + x13) & M32; b[off + 14] = (b[off + 14] + x14) & M32; b[off + 15] = (b[off + 15] + x15) & M32


## Y = BlockMix(B); B and Y have 32*r words.
static func _block_mix(b: PackedInt64Array, y: PackedInt64Array, r: int, x: PackedInt64Array) -> void:
	var n := 32 * r
	for j in 16:
		x[j] = b[n - 16 + j]
	for i in 2 * r:
		for j in 16:
			x[j] ^= b[i * 16 + j]
		_salsa8(x, 0)
		var dst := (i / 2 if i % 2 == 0 else r + i / 2) * 16
		for j in 16:
			y[dst + j] = x[j]


static func scrypt(pw: PackedByteArray, salt: PackedByteArray, n: int, r: int, p: int, length: int) -> PackedByteArray:
	var blen := 128 * r
	var bb := _pbkdf2_1(pw, salt, p * blen)
	var words := 32 * r
	var v := PackedInt64Array()
	v.resize(n * words)
	var xa := PackedInt64Array()
	xa.resize(words)
	var ya := PackedInt64Array()
	ya.resize(words)
	var tmp := PackedInt64Array()
	tmp.resize(16)
	for k in p:
		for i in words:
			var o := k * blen + i * 4
			xa[i] = bb[o] | (bb[o + 1] << 8) | (bb[o + 2] << 16) | (bb[o + 3] << 24)
		for i in n:
			var base := i * words
			for w in words:
				v[base + w] = xa[w]
			_block_mix(xa, ya, r, tmp)
			var sw := xa
			xa = ya
			ya = sw
		for _i in n:
			var j: int = xa[words - 16] & (n - 1)
			var base := j * words
			for w in words:
				xa[w] ^= v[base + w]
			_block_mix(xa, ya, r, tmp)
			var sw := xa
			xa = ya
			ya = sw
		for i in words:
			var o := k * blen + i * 4
			bb[o] = xa[i] & 0xFF
			bb[o + 1] = (xa[i] >> 8) & 0xFF
			bb[o + 2] = (xa[i] >> 16) & 0xFF
			bb[o + 3] = (xa[i] >> 24) & 0xFF
	return _pbkdf2_1(pw, bb, length)


# ---- key envelope ----

## Checks an envelope dictionary; returns "" when valid, otherwise the reason.
static func validate_envelope(env: Dictionary) -> String:
	var k: Dictionary = env.get("kdf", {})
	if int(env.get("version", 0)) < 1:
		return "bad version"
	match k.get("alg", ""):
		"scrypt":
			var n := int(k.get("N", 0))
			if n < (1 << 14) or n > (1 << 20) or (n & (n - 1)) != 0 or int(k.get("r", 0)) != 8 or int(k.get("p", 0)) < 1 or int(k.get("p", 0)) > 4:
				return "bad scrypt parameters"
		"argon2id":
			return "argon2id envelopes are not supported in Godot; unlock with the master key from the host instead"
		_:
			return "unknown kdf"
	var s := B.from_b64u(String(env.get("salt", "")))
	var iv := B.from_b64u(String(env.get("iv", "")))
	var w := B.from_b64u(String(env.get("wrappedKey", "")))
	if s.size() < 16 or s.size() > 64 or iv.size() < 12 or iv.size() > 32 or w.size() < 32:
		return "bad envelope fields"
	return ""


static func _kek(passphrase: String, k: Dictionary, salt: PackedByteArray) -> PackedByteArray:
	return scrypt(passphrase.to_utf8_buffer(), salt, int(k["N"]), int(k["r"]), int(k["p"]), KEY_BYTES)


## The master key, or null for a wrong passphrase. Check validate_envelope first.
static func unwrap_master_key(env: Dictionary, passphrase: String):
	var kek := _kek(passphrase, env["kdf"], B.from_b64u(env["salt"]))
	var mk = open(kek, B.from_b64u(env["iv"]), B.from_b64u(env["wrappedKey"]))
	return mk if mk != null and mk.size() == KEY_BYTES else null


static func wrap_master_key(mk: PackedByteArray, passphrase: String, version := 1, salt := PackedByteArray(), iv := PackedByteArray()) -> Dictionary:
	var kdf := {"alg": "scrypt", "N": 1 << 15, "r": 8, "p": 1}
	if salt.is_empty():
		salt = B.random(16)
	if iv.is_empty():
		iv = B.random(NONCE_BYTES)
	var kek := _kek(passphrase, kdf, salt)
	return {"version": version, "kdf": kdf, "salt": B.b64u(salt), "iv": B.b64u(iv), "wrappedKey": B.b64u(seal(kek, iv, mk))}


# ---- chunks and manifests ----

## [blob id, stored bytes]. The id is an HMAC of the plaintext under the file's id key.
static func seal_chunk(file_key: PackedByteArray, pt: PackedByteArray, nonce := PackedByteArray()) -> Array:
	if nonce.is_empty():
		nonce = B.random(NONCE_BYTES)
	var raw_id := B.hmac(sub_key(file_key, "chunk-id"), pt)
	var magic := "GDC1".to_ascii_buffer()
	var ct := seal(sub_key(file_key, "chunk-enc"), nonce, pt, B.concat([magic, raw_id]))
	return [B.hex(raw_id), B.concat([magic, nonce, ct])]


## Null when the blob is corrupt or was sealed with another key.
static func open_chunk(file_key: PackedByteArray, id: String, blob: PackedByteArray):
	var raw_id := B.from_hex(id)
	var magic := "GDC1".to_ascii_buffer()
	if raw_id.size() != 32 or blob.size() < 32 or blob.slice(0, 4) != magic:
		return null
	var pt = open(sub_key(file_key, "chunk-enc"), blob.slice(4, 16), blob.slice(16), B.concat([magic, raw_id]))
	if pt == null or not B.equal(B.hmac(sub_key(file_key, "chunk-id"), pt), raw_id):
		return null
	return pt


static func drive_manifest_key(mk, name: String) -> String:
	if mk == null:
		return B.hex(B.sha256((INFO + "drive:" + name).to_utf8_buffer()))
	return B.hex(B.hmac(sub_key(mk, "manifest-name"), ("drive:" + name).to_utf8_buffer()))


static func seal_manifest(mk, key: String, pt: PackedByteArray, nonce := PackedByteArray()) -> PackedByteArray:
	if mk == null:
		return B.concat(["GDM0".to_ascii_buffer(), pt])
	if nonce.is_empty():
		nonce = B.random(NONCE_BYTES)
	var magic := "GDM1".to_ascii_buffer()
	return B.concat([magic, nonce, seal(sub_key(mk, "manifest-enc"), nonce, pt, B.concat([magic, B.from_hex(key)]))])


## {"ok": bytes} or {"error": "corrupt" | "locked"}.
static func open_manifest(mk, key: String, data: PackedByteArray) -> Dictionary:
	if data.size() >= 4 and data.slice(0, 4) == "GDM0".to_ascii_buffer():
		return {"ok": data.slice(4)}
	var magic := "GDM1".to_ascii_buffer()
	if data.size() < 32 or data.slice(0, 4) != magic:
		return {"error": "corrupt"}
	if mk == null:
		return {"error": "locked"}
	var pt = open(sub_key(mk, "manifest-enc"), data.slice(4, 16), data.slice(16), B.concat([magic, B.from_hex(key)]))
	return {"error": "corrupt"} if pt == null else {"ok": pt}


static func pkce_challenge(verifier: String) -> String:
	return B.b64u(B.sha256(verifier.to_ascii_buffer()))
