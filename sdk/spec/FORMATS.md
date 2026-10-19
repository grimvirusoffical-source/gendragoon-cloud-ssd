# Formats, version 1

Every SDK reads and writes these formats byte for byte; [`vectors/v1.json`](vectors/v1.json) pins them.
Notation: `‖` is concatenation, `hex` is lowercase hexadecimal, `b64u` is base64url without padding.

## Key derivation

```
SubKey(ikm, purpose) = HKDF-SHA256(ikm, salt = none, info = "gendragoon-sdk/v1/" ‖ purpose, length = 32)
```

Purposes: `manifest-name`, `manifest-enc` (from the master key), `chunk-id`, `chunk-enc` (from a file key),
`share` (see Shares). All encryption is AES-256-GCM with a 12-byte random nonce and a 16-byte tag.

## Key envelope

The master key (32 random bytes) is stored only wrapped, as the binding's key envelope (the G9 record on the
server):

```json
{"version":1,"kdf":{"alg":"scrypt","N":32768,"r":8,"p":1},"salt":"<b64u 16>","iv":"<b64u 12>","wrappedKey":"<b64u 48>"}
```

* `KEK = scrypt(passphrase, salt, N, r, p, 32)` or, for `"alg":"argon2id"` with `memoryKiB`, `iterations`
  and `parallelism`, `KEK = Argon2id(passphrase, salt, iterations, memoryKiB, parallelism, 32)`.
* `wrappedKey = AES-256-GCM(KEK, iv, masterKey, aad = none)`.
* Accepted ranges: scrypt `N` a power of two from 2^14 to 2^20, `r = 8`, `p` 1–4; argon2id `memoryKiB`
  19456–1048576, `iterations` 1–10, `parallelism` 1–4; salt 16–64 bytes, iv 12–32 bytes. Anything else is
  refused before deriving.
* New envelopes use scrypt with N = 2^15, r = 8, p = 1. Passphrases are at least 8 bytes.
* `version` increases by one on every passphrase change; the server accepts a replacement only with
  `If-Match` on the current version. Creating a second envelope answers 409 `envelope_exists`, which the SDKs
  report as a precondition failure (412).

## Chunks

Files are split into chunks (4 MiB by default, below 16 MiB). Each file in an encrypted drive has its own
random 32-byte file key.

```
id   = HMAC-SHA256(SubKey(fileKey, "chunk-id"), plaintext)                   (blob id, hex)
blob = "GDC1" ‖ nonce ‖ AES-256-GCM(SubKey(fileKey, "chunk-enc"), nonce, plaintext, aad = "GDC1" ‖ id)
```

Opening checks the magic, decrypts, and recomputes the id. Identical chunks of one file share an id; chunks of
different files do not. Plain drives store chunks as they are, with `id = SHA-256(chunk)`.

## Drive manifests

A drive is one manifest. Its key is

```
encrypted: hex(HMAC-SHA256(SubKey(masterKey, "manifest-name"), "drive:" ‖ name))
plain:     hex(SHA-256("gendragoon-sdk/v1/drive:" ‖ name))
```

Its stored bytes are

```
encrypted: "GDM1" ‖ nonce ‖ AES-256-GCM(SubKey(masterKey, "manifest-enc"), nonce, document, aad = "GDM1" ‖ raw key bytes)
plain:     "GDM0" ‖ document
```

The document is UTF-8 JSON with exactly this key order and no insignificant whitespace:

```json
{"v":1,"encrypted":true,"files":{"<path>":{"size":17,"mtime":1800000000000,"sha256":"<hex>","chunks":["<id>"],"key":"<b64u file key>"}},"folders":["<path>"],"updatedAt":1800000000000}
```

* `files` keys are sorted by byte value. `folders` lists, sorted, the folders created explicitly (parents of
  files exist implicitly); it is `null` when there are none. `key` is present only in encrypted drives.
* `mtime` and `updatedAt` are milliseconds since the Unix epoch. `sha256` is of the whole plaintext file.
* Paths are slash-separated UTF-8, relative, at most 1024 bytes, with no leading or trailing slash, no empty,
  `.` or `..` segment, and no backslash or control character.
* Writers commit with `If-Match: <generation>` (or `If-None-Match: *` for a new drive). On 412 they re-read
  the document, apply their change again and retry, up to 12 times with a short random back-off.

## Shares

A recipient identity is a P-256 key pair; its public id is `"gdid1_" ‖ b64u(uncompressed point)`. A share is

```json
{"v":1,"alg":"ECDH-P256+HKDF-SHA256+A256GCM","recipient":"<tag>","epk":"<b64u>","nonce":"<b64u 12>","ct":"<b64u>"}
```

* `shared = ECDH(ephemeral private, recipient public)`.
* `key = HKDF-SHA256(shared, salt = epk ‖ rpk, info = "gendragoon-sdk/v1/share", 32)`, with `epk` and `rpk`
  the uncompressed points.
* `ct = AES-256-GCM(key, nonce, payload, aad = "gd-share-v1")`.
* `recipient = b64u(SHA-256(rpk)[0:8])` lets a recipient skip shares meant for someone else.
* `payload` is `{"v":1,"path":"<path>","entry":<file entry as in the drive document>}`. The recipient uses a
  read-only key (`blobs:r`) for the sender's binding to download the chunks.

## Connect

* Connect code: `gdpg_` ‖ 43 base64url characters. Authorization code: `gdpc_` ‖ 43. API key:
  `gdpk_` ‖ 16 hex ‖ `_` ‖ 43 base64url.
* PKCE: S256 only; verifier 43 base64url characters; `challenge = b64u(SHA-256(verifier))`.
* Connect link: `gendragoon://connect?client=<name>&host=<host>&scope=blobs:rw&code_challenge=<c>&code_challenge_method=S256&redirect_uri=<loopback>&state=<s>`.
  The redirect must be `http://127.0.0.1:<port>/…` or `http://[::1]:<port>/…`.
