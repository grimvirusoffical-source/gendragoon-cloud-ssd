# Storage provider API v1 (`/provider/v1`)

Status: **implemented on branch `feature/provider-v1`, tested with in-memory fakes only. Not deployed.** Mounted only when `PROVIDER_V1_ENABLED=true`; `provider_v1.js` and `provider_blobstore.js` are deliberately not in `deploy_free.py`'s runtime allow-list yet. The GCS store (`gcsBlobStore`) is tested with the real `@google-cloud/storage` client against `fake-gcs-server`; it has not run against a real bucket.

Design: `/workspace/integration/GENDRAGOON-REDX.md` section 1.4 (joint design with RedX). It maps RedX's `engine/pack` `ChunkStore` and `ManifestStore` onto HTTP.

## Connect

| Route | Auth | Body | Result |
|---|---|---|---|
| `POST /connect/grants` | Firebase (Gendragoon user) | `{workspaceId, scopes?, requester:{name,host}}` | `201 {grant:"gdpg_…", expiresAt, ttlSeconds:300}`; one use |
| `POST /connect/redeem` | the grant | `{grant, client:{name,host}}` | `201 {bindingId, apiKey:"gdpk_…", keyExpiresAt, scopes, workspaceId, quotaBytes, capabilities}` |
| `POST /connect/authorize` | Firebase | `{workspaceId, scopes?, requester, codeChallenge, codeChallengeMethod:"S256"}` | `201 {code:"gdpc_…", expiresAt}` (5 min) |
| `POST /connect/token` | code + verifier | `{code, codeVerifier}` | same as redeem; a wrong verifier does not burn the code |
| `POST /connect/rotate` | `gdpk_` | | `201 {apiKey, keyExpiresAt, previousKeyValidUntil}`; old key valid 10 min |
| `GET /bindings` | Firebase | | the user's bindings with usage, `lastUsedAt`, `lastError` (never keys) |
| `DELETE /bindings/:id[?deleteData=true]` | Firebase, owner only | | revokes binding and keys; optional purge of its objects |

Any grant/code failure is `400 invalid_grant` (unknown, used, expired, wrong kind, PKCE). Grants and codes are stored as SHA-256 only. Keys are `gdpk_<16 hex id>_<43 base64url secret>`; the secret is stored as SHA-256 and compared in constant time. Scopes: `blobs:rw`, `blobs:r`. Keys live 90 days.

## Blobs (ChunkStore)

| Route | Notes |
|---|---|
| `PUT /blobs/:id` | `:id` 64 lower-case hex. `X-Id-Mode: content` (default) requires `sha256(body) == id`; `sealed` requires `X-Content-SHA256`. Optional `X-Content-SHA256` must match. `201` new, `200` same bytes already stored (no quota charge). Max 16 MiB |
| `HEAD /blobs/:id` | `200` with `Content-Length`, `ETag`, `X-Content-SHA256`; `404` |
| `GET /blobs/:id` | bytes + `X-Content-SHA256`; `404 not_found` |
| `DELETE /blobs/:id` | `204`, also when absent |
| `GET /blobs?cursor=&limit=` | `{ids, items:[{id,size,generation}], next}` sorted, ≤ 1000 per page |
| `POST /blobs/batch-has` | `{ids:[≤1000]}` → `{present:[…]}` |

## Manifests (ManifestStore)

`GET/PUT/DELETE /manifests/:key`, `GET /manifests` (`{ids, items:[{id,size,generation}], next}`). `PUT` is atomic. Preconditions: `If-None-Match: *` (create only) or `If-Match: "<etag>"` (compare-and-swap on the storage generation); neither = atomic overwrite. Losing a race is `412 precondition_failed`. Max 4 MiB.

## Key envelope (per binding)

`GET /key-envelope` (`blobs:r`) and `PUT /key-envelope` (`blobs:rw`): RedX's master key wrapped with a recovery passphrase on the RedX host. Same record, KDF bounds, forbidden-field check and version rules as `/v2/workspaces/:id/key-envelope` (shared `parseEnvelope`/`precondition` from `key_envelope.js`): `If-None-Match: *` creates (`409 envelope_exists` if present), `If-Match: "<n>"` replaces with version `n+1` (`412 version_mismatch` otherwise), neither is `428 precondition_required`. Removed when the binding is purged.

## Usage, health, capabilities

`GET /usage` → `{usedBytes, quotaBytes, objectCount, workspaceId, changeSeq, lastChangeAt}`; `GET /health`; `GET /capabilities` (no auth; includes `events`).

## Change events (polling)

There is no webhook or stream. A client watches a binding by polling:

1. `GET /usage` and compare `changeSeq`. It increases by one after every manifest write or delete that took effect (a failed precondition or deleting an absent manifest does not count). Blob writes do not change it, because a blob is not visible to a reader until a manifest references it.
2. When `changeSeq` moved, `GET /manifests` and compare each item's `generation` with the last seen one: new id = created, different generation = updated, missing id = deleted.
3. `401` on a key that worked before means the binding was revoked or the key expired.

Increments are best effort: if the counter update fails after a commit, the commit still stands, so clients also do a full list on a slow timer (the SDKs use 10 minutes). `capabilities.events` is `{poll:true, changeSeq:true, webhook:false, stream:false}`.

## Errors

| Status | `error` |
|---|---|
| 400 | `bad_id`, `bad_key`, `bad_id_mode`, `checksum_required`, `bad_checksum_header`, `bad_precondition`, `bad_ids`, `invalid_grant`, `invalid_pkce`, `invalid_scope`, `bad_request` |
| 401 | `invalid_key`, `binding_revoked` |
| 403 | `insufficient_scope` |
| 404 | `not_found`, `workspace_not_found` |
| 409 | `conflict`, `already_rotated` |
| 412 | `precondition_failed` |
| 413 | `blob_too_large`, `manifest_too_large` (with `maxBytes`) |
| 422 | `checksum_mismatch` (nothing stored) |
| 429 | `rate_limited` + `Retry-After` (per binding token bucket, per instance) |
| 503 | `storage_unavailable`, `provider_unavailable` |
| 507 | `quota_exceeded` (with `usedBytes`, `quotaBytes`) |

## Quota

Each binding has `quotaBytes` (snapshot of the workspace quota at connect time) and `usedBytes`. Bytes are reserved in a Firestore transaction before the object write and refunded if the write fails; overwrites charge only the size difference, and writes use generation preconditions so concurrent writers cannot double-count. A crash between reservation and write over-counts; `reconcileBinding(id)` recomputes from the bucket. Charging RedX data against the workspace's own `usedBytes` is the open pricing decision (joint design 13.2).

## Storage layout

`customer/<accountHash>/provider/<bindingId>/b/<id>` and `…/m/<key>` in the existing private customer bucket. A binding is its own namespace; no route can address another binding or account.

## Tests

- `provider_v1.test.js` (12 tests, `node --test`, including G9): both connect legs, replay and expiry, checksums, quota and refunds, 16 MiB cap, manifest CAS with 8 racing writers, pagination, scopes, tenant isolation, rotation grace, revoke and purge, rate limit, reconcile, no secrets in audit rows.
- `provider_blobstore.test.js`: BlobStore contract on the memory fake and, with `GD_FAKE_GCS_BIN=/path/fake-gcs-server` (or `STORAGE_EMULATOR_HOST`), on `gcsBlobStore` via the real client, plus an end-to-end run of the routes on it. Skipped otherwise.
- `provider_v1_deletion.test.js`: G7.
- `provider_v1_events.test.js`: `changeSeq`, list generations, notices on connect and revoke.
- `scripts/provider_dev_server.js`: the routes on memory stores for SDK tests (`PROVIDER_V1_ENABLED=true` required; development tokens `Bearer dev-user:<uid>` for signed-in calls; loopback only).
- `contract/redxpack` (Go): a client with RedX's exact `ChunkStore`/`ManifestStore` method set, contract tests against the Node server (`scripts/provider_contract_server.js`, memory fakes), and with `-tags redx` (`REDX_DIR=… contract/redxpack/run_redx.sh`) RedX's real `pack.New(...)` doing put/get/verify/list/delete over this API.

## Account notices

With `SUPPORT_EMAIL_ENABLED=true`, connecting and revoking an app send a notice to the account's address (resolved through Firebase Auth at send time; no address is stored). Notices never contain keys, grants or codes, and a mail failure never fails the request. See `docs/SUPPORT_EMAIL.md`.

## Account deletion

`account_delete.js` (metadata step) calls `deleteAccountProviderData(db, accountHash)`: bindings are revoked, then bindings, keys, key envelopes, grants and provider audit rows of that account are deleted. Objects live under `customer/<accountHash>/provider/`, inside the `customer/<accountHash>/` prefix the deletion job already removes. Tested in `provider_v1_deletion.test.js` (including a full deletion job). Workspace merge/archive flows do not touch bindings yet: a binding keeps its own namespace and quota snapshot.

## Pricing decision needed (not invented here)

Today a binding's quota is a **snapshot of the workspace's quota at connect time**, counted separately from the workspace's own files. Whether RedX data should count against the workspace's `usedBytes` (proposal P1 in the joint design 13.2), occupy a workspace slot (P2), be a separate add-on (P3), be metered (P4) or get a separate free allowance (P5) is **Josh's decision**. No price or allowance is set in code. Once decided, the change is confined to `adjust()` in `provider_v1.js` (charge the workspace document in the same transaction) and `resolveWorkspace` in `free_server.js`.

## Not done yet (see `/workspace/gd/RARXAI_AND_PROVIDER_PLAN.md` B.3)

Pricing decision above; merge/archive handling of bindings; sharded counters for very hot bindings; verifying DELETE preconditions on real GCS (the emulator ignores them); deploy (G12, needs Josh). Client UI: see the gendragoon-apps branch `feature/redx-connections`.
