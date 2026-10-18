# Workspace policy API

Server-side rules for GenDragoon workspaces. This note is the source Avery can fold into `gendragoon-apps/docs/API.md`. It describes the behavior implemented in `workspace_policy.js` and the routes that call it. No live Stripe price ids, secrets, or customer data belong in this document or in source.

## Constants

| Constant | Value | Meaning |
| --- | --- | --- |
| `FREE_WORKSPACES` | `1` | Lifetime free workspaces per account. The legacy `free` project counts. |
| `WORKSPACE_FEE_USD_MONTHLY` | `5` | Recurring fee for each workspace beyond `FREE_WORKSPACES`. |
| `workspaceMonthlyCents` | `500` | Same fee in USD cents. |
| `BASE_CAP` | `10` | Owned active + pending workspaces (archived and merged do not count). |
| `RAISED_CAP` | `20` | Cap when one owned active workspace has at least 2 TB storage and Turbo (8 workers), or an equivalent 2 TB-or-larger bundle. |
| Lapse grace | 3 days | Added to `paidThroughMs`, the last **paid** invoice period end. A failed renewal does not move this clock. |
| BYO challenge TTL | 10 minutes | Nonce expiry. Single use. |

Raised-cap qualification lives in one function, `qualifiesForRaisedCap` (exported from `projects.js` as `qualifiesForHigherLimit`). Client-saved intentions do not qualify. Owner complimentary access does not bypass the cap.

## Workspace fee

New workspaces after the free allowance use a **recurring** $5/month Stripe Price. The server looks it up. It never creates a Price and never embeds a live id.

Lookup order:

1. `STRIPE_WORKSPACE_MONTHLY_PRICE_ID` (must match `price_` + alphanumeric).
2. Catalog entry whose key is the lookup key `gdssd_workspace_monthly_v3`.

The monthly path is enabled only when `STRIPE_CHECKOUT_ENABLED=true` and `STRIPE_WORKSPACE_MONTHLY_READY=true` and a price id is present. Checkout then verifies the retrieved Price is active, USD, `unit_amount` 500, `billing_scheme` `per_unit`, `type` `recurring`, interval `month`, and in the configured Stripe environment.

If that price is not configured, **new paid workspace creation stays disabled** (`503 PROJECT_PAYMENT_UNAVAILABLE`) when the monthly id is set but not ready. Existing workspaces keep working.

Compatibility: when the monthly price id is **not** set, the existing one-time $5 project Checkout (`STRIPE_PROJECT_CREATION_PRICE_ID` / `one_time|project_creation`, mode `payment`) remains so current v0.18 clients and suites keep working. `GET /v2/pricing` still reports `additionalOneTimeCents: 500` for that legacy path and now also reports `workspaceMonthlyCents: 500` and `feeIsOneTime: false`.

Account policy from `GET /v2/projects` and `GET /v2/workspaces` includes:

- `feeIsOneTime: false`
- `workspaceMonthlyCents: 500`
- `freeWorkspaces: 1`
- `projectLimit`, `usedProjectSlots`, `locked`, `uploadsBlocked`, `reason`, `overBy`, `unpaidWorkspaceIds`
- `grandfatheredProjects`

`reason` is `over_cap`, `lapsed`, `over_cap_and_lapsed`, `scope_unavailable`, `merge_in_progress`, or `null`.

## Grandfathering

These workspaces keep one-time semantics. They never lapse and are never rewritten or charged the new monthly fee:

- `kind: "free"` (legacy free project, matched by `accountKey`)
- `feeIsOneTime: true`
- `projectBillingVersion: 2` with `projectFeeStatus` of `paid`, `free`, or `owner`, and no `workspaceFeeModel: "monthly"`

A new monthly workspace is stored with `workspaceFeeModel: "monthly"` so it is not treated as grandfathered. Existing rows are not migrated.

Grandfathering also requires a creation time before `GRANDFATHER_CUTOFF_MS` (environment override, default `2026-10-17T00:00:00Z`). A missing `createdAt` is a legacy row and stays grandfathered. A numeric `createdAt` below `1e12` is Unix seconds. An unresolved server-timestamp object with no `toMillis` is treated as now, so a brand-new row is not grandfathered. `workspaceFeeModel: "monthly"` is never grandfathered.

## Lapse

For a monthly workspace that is unpaid (`past_due`, `unpaid`, `canceled`, and the other non-active fee statuses), uploads lapse at `paidThroughMs + 3 days`. `paidThroughMs` is the period end of the last **paid** invoice (`invoice.lines[].period.end`, else `invoice.period_end`). It is not Stripe's `current_period_end`: a failed renewal advances that field, and using it would grant about a month of extra grace. One millisecond before `paidThroughMs + 3 days` the workspace is still inside grace. An active or paid monthly workspace does not lapse when the period ends. Grandfathered workspaces skip this clock.

The signature-verified `POST /billing/stripe-webhook` handles, idempotently through `stripe_webhook_events`:

| Event | Effect on a monthly workspace |
| --- | --- |
| `invoice.payment_failed` | Fee status comes only from the retrieved Subscription (`past_due` when that status is past due). Does not move `paidThroughMs`. |
| `invoice.paid` | Fee status comes from the retrieved Subscription. `paidThroughMs` becomes `max(stored, paid invoice period end)` and is mirrored to `workspaceFeePeriodEndMs`. A late paid event cannot move the clock backward or mark a now past-due subscription paid. |
| `customer.subscription.updated` | Fee status comes from the retrieved Subscription only. |
| `customer.subscription.deleted` | Retrieved status `canceled` sets `workspaceFeeStatus: canceled` and unpaid. Lapse still waits for `paidThroughMs` + grace. |

The handler re-fetches the Subscription and ignores the event type when choosing status. It ignores the event for a grandfathered workspace and does not write that record. A repeated `evt_` id returns `{received: true, replayed: true}` and does not retrieve Stripe again.

Subscription metadata for the fee is `kind: workspace_fee`, plus `accountHash` and `workspaceId`.

## Cap lock

`locked` / `uploadsBlocked` is true when `usedProjectSlots > projectLimit` or any workspace is lapsed. Downgrading the qualifying plan keeps every workspace and its files, but the account lock applies to all of them (including workspaces 11–20).

Writes on workspace, file, and transfer routes return:

```json
HTTP 423
{"error":"workspace_lock","reason":"over_cap","overBy":5,"unpaidWorkspaceIds":[]}
```

`overBy` is how many active+pending workspaces exceed the cap. `unpaidWorkspaceIds` lists lapsed workspace ids.

Still allowed while locked: listing, downloads and other reads, delete, merge, archive, restore, and billing routes (Checkout, portal, pricing, entitlements). `effectiveStorageQuota` stays positive for an active basic or upgraded workspace so reads are not turned into an empty quota.

`scopeFromWorkspace` keeps returning a storage scope for an owned, provisioned paid workspace that is only over the account cap. The scope sets `uploadsBlocked: true` and `lock` to the 423 body. A missing or unlistable account project list is fail-closed: the same scope is returned with `uploadsBlocked: true` and `reason: "scope_unavailable"` (HTTP 423 on writes). An empty list means the account has no other workspaces, which is not the same as a missing list. A foreign or zero-quota workspace still yields `null` (404 when the account hash does not match, 403 when the owned project is inactive). An active merge lock blocks uploads with `reason: "merge_in_progress"`.

## Ownership

Ownership is `accountHash` on UUID workspaces and `accountKey` on the legacy free project. There are no member roles. A different account, including a row whose stored hash does not match the caller, gets **404** `PROJECT_NOT_FOUND`. The response does not use 403, so existence is not revealed.

## Bring-your-own storage

BYO uses the same $5/month workspace fee, the same cap, and the same lapse and lock rules. Performance tiers stay separate paid add-ons.

Launch providers are S3-compatible only, stored as `providerType: "s3"`: AWS, Cloudflare R2, Backblaze B2, Wasabi, MinIO, and GCS via S3 keys. Aliases `aws`, `r2`, `cloudflare`, `backblaze`, `b2`, `wasabi`, `minio`, `gcs`, and `google` normalize to `s3`. SFTP, Azure, and WebDAV are not launch providers. `POST /v2/workspaces/:id/byo/register` with one of those returns **422** `{error: "byo_provider_unsupported", provider}`. Error codes are the `error` string. Responses do not include a `code` field. Secret fields are rejected first, so a body that also contains a password still returns **400** `BYO_SECRET_REJECTED`.

The server stores `providerType`, `endpoint`, and `bucketFingerprint`. Credentials never reach the server. A body that contains `accessKey`, `secretAccessKey`, `password`, `privateKey`, `private_key`, `serviceAccount`, `keyFile`, `pem`, a `BEGIN PRIVATE KEY` block, or pasted service-account JSON returns **400** `BYO_SECRET_REJECTED`. The value is not written to Firestore and is not logged.

`GET /v2/pricing` reports BYO `monthlyCents: 500` and `yearlyCents: 5000` (the year factor stays 10). Workers and storage are not granted unless `byoChallengeVerified` is true, including owner complimentary checkout (**409** `BYO_CHALLENGE_REQUIRED`) and subscription reconciliation. `byoActive` plus `manualProviderConfigured` alone leaves `projectStatus` at `pending_activation` and `effectiveWorkers` at 0. Re-registering or changing the endpoint clears `byoChallengeVerified`, `byoActive`, and `manualProviderConfigured`.

| Route | Body | Result |
| --- | --- | --- |
| `POST /v2/workspaces/:id/byo/register` | `{provider, endpoint, bucketFingerprint}` | Stores the public S3 registration. Does not activate. Unsupported providers are 422. |
| `POST /v2/workspaces/:id/byo/challenge` | none | `{nonce, expiresAtMs, ttlMs}`. Replaces any previous unused nonce. The client writes that nonce to `.gendragoon-challenge/<nonce>` in its bucket. |
| `POST /v2/workspaces/:id/byo/verify` | `{presignedUrl}` | The server GETs the presigned URL. Echoing the nonce without a fetch is **400** `BYO_CHALLENGE_PROOF_REQUIRED`. |

The presigned URL must be `https`, must not carry userinfo, and its host must equal the registered endpoint host exactly (**400** `BYO_ENDPOINT_HOST_MISMATCH`, before any fetch). The path must contain `/.gendragoon-challenge/<nonce>`. The server resolves DNS and rejects private, loopback, and link-local addresses, refuses redirects, limits the response to 1024 bytes, and times out at 3 seconds. The body must equal the nonce. The bucket fingerprint is derived from the object ETag (or a SHA-256 of the body). The nonce is single-use for 10 minutes.

Challenge errors: `BYO_CHALLENGE_MISMATCH`, `BYO_CHALLENGE_EXPIRED`, `BYO_CHALLENGE_USED`, `BYO_CHALLENGE_PROOF_REQUIRED` (all 400). `BYO_NOT_REGISTERED` is 409. Someone else's workspace is 404.

The legacy `POST /v2/workspaces/:id/manual-provider` route still records a local label, and it now rejects secret fields the same way. It does not by itself verify a challenge.

## Merge

`POST /v2/workspaces/:sourceId/merge/preview` returns the same ownership and `confirmName` checks without copying. Its `files` list includes each source name and `renamedTo` (`name (from <sourceName>)`, then `2`, `3`, …) so a client can show the conflict rename before it commits.

`POST /v2/workspaces/:sourceId/merge`

```json
{"targetId":"<uuid-or-free>","confirmName":"<exact source name>"}
```

Both workspaces must belong to the caller (404 otherwise). `confirmName` must equal the source name (400 `CONFIRM_NAME_REQUIRED`). Merging a workspace into itself is 400 `INVALID_MERGE`.

The server copies every file into the target. On a name collision the incoming object is renamed to `name (from <sourceName>)`, then `name (from <sourceName>) 2`, `3`, and so on. Existing target bytes are never overwritten.

The server writes a tombstone at `gd_accounts/{accountHash}/workspace_merges/{sourceId}` with `phase: "copying"` before it deletes any source file. Copy verification compares stored `crc32c`, `md5`/`md5Hash`, or a real `sha256` on both objects. A same-size copy with a different checksum fails with **409** `MERGE_VERIFY_FAILED` and the source stays. If neither side has a checksum, both objects are streamed and compared with SHA-256. Size plus name is never hashed into a stand-in digest. Checksums that exist on the source record are copied onto the target record.

After the copies verify, the source workspace's Stripe subscriptions (`workspaceFee`, `storage`, `performance`, `byo`) are cancelled with idempotency keys `gd-merge-{sourceId}-cancel-{subscriptionId}`. A completed tombstone makes a retry idempotent (`idempotent: true`) and does not cancel again. If cancellation fails, the source is not deleted and the merge stays resumable. File and upload deletes run in batches of at most 399 writes. The copy job lists files outside the transaction; the final transaction reads files and uploads with `tx.get`.

A failure mid-copy leaves the source in place, keeps `mergeCopied` progress, and clears the lock expiry so the same request can resume. The lock heartbeat extends a 120 second TTL every 50 files. Two concurrent merges of the same pair, or a merge that touches a workspace already locked by a different pair, return 409 `MERGE_IN_PROGRESS`. The lock is a Firestore transaction covering both workspace documents. An in-progress tombstone is not treated as success.

Merge is allowed while the account lock is active.

## Other touched routes

| Route | Lock behavior |
| --- | --- |
| `GET /v2/projects`, `GET /v2/workspaces` | 200 with `policy.locked` and the fields above. |
| `GET` file list, download, upload status, `/config` | Allowed while locked. |
| `DELETE` file or upload | Allowed while locked. |
| `POST`/`PUT` uploads, chunks, finalize (v1, `/v2/workspaces/:id/cloud`, `/v3/cloud/:id`) | 423 `workspace_lock` when locked. |
| Checkout, portal, archive, restore | Allowed, so the account can get back under the cap or pay the invoice. |
| `POST /v2/projects` while over the cap | Still `409 PROJECT_LIMIT_REACHED` (unchanged). |
