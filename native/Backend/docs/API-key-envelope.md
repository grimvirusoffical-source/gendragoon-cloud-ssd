# Workspace key envelope

Each workspace has one wrapped key envelope. The device wraps the workspace key before upload. The server stores that opaque value and a version. It does not store a passphrase, a raw key, or a filename.

What the server is allowed to see is described in [SECURITY.md](SECURITY.md) (`docs/SECURITY.md`). This page is only the envelope API.

No wrapped key, passphrase, or customer payload belongs in logs or in this repository.

## Record

```json
{"version":1,"wrappedKey":"<standard base64>"}
```

`version` is an integer greater than or equal to 1. `wrappedKey` is standard base64 of at least 32 bytes. Those are the only stored fields. The JSON document must be 4 KB or smaller (`413 {"error":"payload_too_large"}`).

A field named like a passphrase, plaintext, or key (`passphrase`, `password`, `plaintext`, `key`, `secret`, `privateKey`, and the same kind of name) is `400 {"error":"plaintext_rejected"}`. Nothing is written.

## Authentication

Firebase ID token, same Google login as the rest of `/v2`. The workspace is loaded only under the caller's `accountHash`. Another account's workspace is `404 {"error":"not_found"}`. The handler does not look up other accounts. A missing envelope for an owned workspace is the same `404`.

Error bodies use `error` only. They do not include a `code` field.

## `GET /v2/workspaces/:id/key-envelope`

```json
{"version":1,"wrappedKey":"<standard base64>"}
```

The response includes `ETag: "<version>"` and `Cache-Control: private, no-store`.

## `PUT /v2/workspaces/:id/key-envelope`

The first write sends `If-None-Match: *`. If an envelope already exists, the response is `409 {"error":"envelope_exists"}` and the stored key is unchanged. Success is `201` with the stored record.

A later write sends `If-Match` with the current version (`"1"` or `1`). The body version must be that version plus one. A missing envelope, a different version, or a body version that is not the next integer is `412 {"error":"version_mismatch"}`. The stored key stays as it was. Success is `200`.

A PUT with neither header is `428 {"error":"precondition_required"}`. Sending both headers is `400 {"error":"invalid_precondition"}`.

## Account deletion

`DELETE /v2/account` deletes every document in `gd_accounts/{accountHash}/key_envelopes`. Another account's envelopes are left in place. The receipt does not copy `wrappedKey`.

## Module

```javascript
const {registerKeyEnvelope, deleteAccountKeyEnvelopes} = require("./key_envelope");
registerKeyEnvelope({app, db, firebaseAuth, hash});
```

`deleteAccountKeyEnvelopes(db, accountHash)` is what the deletion job calls.
