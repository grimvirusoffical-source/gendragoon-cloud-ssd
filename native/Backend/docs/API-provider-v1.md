# Storage provider API v1 (`/provider/v1`)

Status: **implemented on branch `feature/provider-v1`, tested with in-memory fakes only. Not deployed.** Mounted only when `PROVIDER_V1_ENABLED=true`; `provider_v1.js` and `provider_blobstore.js` are deliberately not in `deploy_free.py`'s runtime allow-list yet. The GCS store (`gcsBlobStore`) has not been run against a real bucket or the Storage emulator.

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
| `GET /blobs?cursor=&limit=` | `{ids, next}` sorted, ≤ 1000 per page |
| `POST /blobs/batch-has` | `{ids:[≤1000]}` → `{present:[…]}` |

## Manifests (ManifestStore)

`GET/PUT/DELETE /manifests/:key`, `GET /manifests`. `PUT` is atomic. Preconditions: `If-None-Match: *` (create only) or `If-Match: "<etag>"` (compare-and-swap on the storage generation); neither = atomic overwrite. Losing a race is `412 precondition_failed`. Max 4 MiB.

## Usage, health, capabilities

`GET /usage` → `{usedBytes, quotaBytes, objectCount, workspaceId}`; `GET /health`; `GET /capabilities` (no auth).

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

- `provider_v1.test.js` (11 tests, `node --test`): both connect legs, replay and expiry, checksums, quota and refunds, 16 MiB cap, manifest CAS with 8 racing writers, pagination, scopes, tenant isolation, rotation grace, revoke and purge, rate limit, reconcile, no secrets in audit rows.
- `contract/redxpack` (Go): a client with RedX's exact `ChunkStore`/`ManifestStore` method set, contract tests against the Node server (`scripts/provider_contract_server.js`, memory fakes), and with `-tags redx` (`REDX_DIR=… contract/redxpack/run_redx.sh`) RedX's real `pack.New(...)` doing put/get/verify/list/delete over this API.

## Not done yet (see `/workspace/gd/RARXAI_AND_PROVIDER_PLAN.md` B.3)

Per-binding key envelope (G9), account deletion and merge covering bindings (G7), Firestore sharded counters for very hot bindings, Storage-emulator test of `gcsBlobStore`, Gendragoon client UI, deploy (G12, needs Josh).
