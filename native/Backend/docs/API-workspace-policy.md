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
| Lapse grace | 3 days | Added to Stripe `current_period_end` while Stripe retries a failed invoice. |
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

`reason` is `over_cap`, `lapsed`, `over_cap_and_lapsed`, or `null`.

## Grandfathering

These workspaces keep one-time semantics. They never lapse and are never rewritten or charged the new monthly fee:

- `kind: "free"` (legacy free project, matched by `accountKey`)
- `feeIsOneTime: true`
- `projectBillingVersion: 2` with `projectFeeStatus` of `paid`, `free`, or `owner`, and no `workspaceFeeModel: "monthly"`

A new monthly workspace is stored with `workspaceFeeModel: "monthly"` so it is not treated as grandfathered. Existing rows are not migrated.

## Lapse

For a monthly workspace that is unpaid (`past_due`, `unpaid`, `canceled`, and the other non-active fee statuses), access for uploads lapses at `current_period_end + 3 days`. One second (and one millisecond) before that instant the workspace is still inside grace. Grandfathered workspaces skip this clock.

The signature-verified `POST /billing/stripe-webhook` handles, idempotently through `stripe_webhook_events`:

| Event | Effect on a monthly workspace |
| --- | --- |
| `invoice.payment_failed` | `workspaceFeeStatus: past_due`, `workspaceFeePaid: false`, store `current_period_end`. Does not lapse before grace ends. |
| `invoice.paid` | `workspaceFeeStatus: active`, `workspaceFeePaid: true`, refresh period end. |
| `customer.subscription.updated` | Sync status and period end from the retrieved Subscription. |
| `customer.subscription.deleted` | `workspaceFeeStatus: canceled`, unpaid. Lapse still waits for period end + grace. |

The handler re-fetches the Subscription. It ignores the event for a grandfathered workspace and does not write that record. A repeated `evt_` id returns `{received: true, replayed: true}` and does not retrieve Stripe again.

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

`scopeFromWorkspace` keeps returning a storage scope for an owned, provisioned paid workspace that is only over the account cap. The scope sets `uploadsBlocked: true` and `lock` to the 423 body. A missing, foreign, or zero-quota workspace still yields `null` (404 when the account hash does not match, 403 when the owned project is inactive).

## Ownership

Ownership is `accountHash` on UUID workspaces and `accountKey` on the legacy free project. There are no member roles. A different account, including a row whose stored hash does not match the caller, gets **404** `PROJECT_NOT_FOUND`. The response does not use 403, so existence is not revealed.

## Bring-your-own storage

BYO uses the same $5/month workspace fee, the same cap, and the same lapse and lock rules. Performance tiers stay separate paid add-ons.

Launch providers, stored only as `providerType`:

- `s3` — S3-compatible: AWS, Cloudflare R2, Backblaze B2, Wasabi, MinIO, and GCS via S3 keys. Aliases `aws`, `r2`, `backblaze`, `b2`, `wasabi`, `minio`, `gcs` normalize to `s3`.
- `sftp`

The server stores `providerType`, `endpoint`, and `bucketFingerprint` (or `hostFingerprint` for SFTP). Credentials never reach the server. A body that contains `accessKey`, `secretAccessKey`, `password`, `privateKey`, or the other secret field names returns **400** `BYO_SECRET_REJECTED`. The value is not written to Firestore and is not logged.

Setting `byoActive` and `manualProviderConfigured` without a verified challenge does **not** activate the workspace. `projectStatus` stays `pending_activation` until `byoChallengeVerified` is true.

| Route | Body | Result |
| --- | --- | --- |
| `POST /v2/workspaces/:id/byo/register` | `{provider, endpoint, bucketFingerprint\|hostFingerprint}` | Stores the public registration. Does not activate. |
| `POST /v2/workspaces/:id/byo/challenge` | none | `{nonce, expiresAtMs, ttlMs}`. Replaces any previous unused nonce. |
| `POST /v2/workspaces/:id/byo/verify` | `{readBack}` (or `nonce`) | 200 when the read-back matches, is unexpired, and has not been used. Then `byoChallengeVerified`, `manualProviderConfigured`, and `byoActive` become true. |

Challenge errors: `BYO_CHALLENGE_MISMATCH`, `BYO_CHALLENGE_EXPIRED`, `BYO_CHALLENGE_USED` (all 400). `BYO_NOT_REGISTERED` is 409. Someone else's workspace is 404.

The legacy `POST /v2/workspaces/:id/manual-provider` route still records a local label, and it now rejects secret fields the same way. It does not by itself verify a challenge.

## Merge

`POST /v2/workspaces/:sourceId/merge`

```json
{"targetId":"<uuid-or-free>","confirmName":"<exact source name>"}
```

Both workspaces must belong to the caller (404 otherwise). `confirmName` must equal the source name (400 `CONFIRM_NAME_REQUIRED`). Merging a workspace into itself is 400 `INVALID_MERGE`.

The server copies every file into the target. On a name collision the incoming object is renamed to `name (from <sourceName>)`, then `name (from <sourceName>) 2`, `3`, and so on. Existing target bytes are never overwritten.

Each copy is checked for size and SHA-256 before the source is removed. Source objects and the source workspace document are deleted only after every copy verifies. A tombstone at `gd_accounts/{accountHash}/workspace_merges/{sourceId}` makes a retry idempotent (`idempotent: true`) without copying again.

A failure mid-copy leaves the source in place, keeps `mergeCopied` progress, and clears the lock expiry so the same request can resume. Two concurrent merges of the same pair, or a merge that touches a workspace already locked by a different pair, return 409 `MERGE_IN_PROGRESS`. The lock is a Firestore transaction covering both workspace documents.

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
