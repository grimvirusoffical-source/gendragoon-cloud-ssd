# Workspace policy API

Server-side rules for GenDragoon workspaces. This note is the source Avery can fold into `gendragoon-apps/docs/API.md`. It describes the behavior implemented in `workspace_policy.js` and the routes that call it. No live Stripe price ids, secrets, or customer data belong in this document or in source.

## Constants

| Constant | Value | Meaning |
| --- | --- | --- |
| `FREE_WORKSPACES` | `1` | One hosted free workspace per account: 2 GB storage plus the free performance plan (1 worker). Custom storage never fills the slot. |
| Workspace fee | `0` | There is no separate workspace fee. It is included in the storage plan. `workspaceMonthlyCents` and `newProjectOneTimeCents` are `0`; `workspaceFeeIncluded` is `true`. |
| `PLANS_BILLING_VERSION` | `3` | `projectBillingVersion` of a workspace whose access comes from its storage + performance plans. |
| `BASE_CAP` | `10` | Owned active + pending workspaces (archived and merged do not count). |
| `RAISED_CAP` | `20` | Cap when one owned active workspace has at least 2 TB storage and Turbo (8 workers), or an equivalent 2 TB-or-larger bundle. |
| Lapse grace | 3 days | Legacy monthly-fee workspaces only. Added to `paidThroughMs`, the last **paid** invoice period end. |
| BYO challenge TTL | 10 minutes | Nonce expiry. Single use. |

Raised-cap qualification lives in one function, `qualifiesForRaisedCap` (exported from `projects.js` as `qualifiesForHigherLimit`). Client-saved intentions do not qualify. Owner complimentary access does not bypass the cap.

## Workspace plans

| Workspace | Must buy | Gets |
| --- | --- | --- |
| First hosted workspace | nothing | 2 GB storage, free performance plan, no checkout |
| Every additional workspace | a storage plan **and** a performance plan | the chosen storage tier and workers |
| Custom storage (own S3 / VPS / cloud) | a paid performance plan only | the chosen workers; storage is the user's provider |

`POST /v2/projects` body: `{name, intentId, storage?, plans?}`.

- `storage` is `"managed"` (default) or `"custom"`.
- `plans` is `{storageTier, performanceTier, interval}` for managed storage, or `{performanceTier, interval}` for custom storage. `interval` is `month` (default) or `year` and is shared by both plans. Bundles are not sold for new workspaces.
- The free slot ignores `plans`. Any other create without both plans is **400** `PLANS_REQUIRED`; custom storage without a paid performance tier is **400** `PERFORMANCE_PLAN_REQUIRED`; a storage tier on custom storage, an unknown tier, `free` as a paid tier, or mixed intervals is **400** `INVALID_SELECTION`.
- A paid create stores `requiredPlans`, sets `projectStatus: "pending_payment"`, and opens **one** subscription Checkout (`mode: subscription`) with exactly the storage price (`storage|standard|<tier>|<interval>`) and the performance price (`performance|<tier>|<interval>`). No workspace-fee item is ever added. The response has `oneTimeCents: 0`, `monthlyPriceCents: 0`, `totalCents` (sum of the plan prices) and `url`.
- When Checkout is disabled the create is **503** `PLANS_CHECKOUT_UNAVAILABLE` and nothing is written. When a plan price id is not configured, opening Checkout is **503** `PLANS_PRICE_UNCONFIGURED`; the workspace stays `pending_payment` with no storage or workers.
- `POST /v2/projects/:id/checkout` resumes the open session, or with `{plans}` replaces the selection (the old session is expired first), so a change never stacks two charges.
- While a workspace is on the plans model, `checkout/storage` and `checkout/performance` are **409** `PLANS_MANAGED_TOGETHER`. `checkout/byo` is **410** `CUSTOM_STORAGE_FEE_RETIRED` for everyone except the legacy owner path.

Subscription metadata is `kind: workspace_plans`, plus `accountHash` and `workspaceId`. The signature-verified webhook re-fetches the subscription and activates the workspace only when its items are exactly the required prices, once each (otherwise `plansStatus: "mismatch"`). `active`, `trialing` and `past_due` keep access (Stripe dunning). `unpaid`, `canceled`, `incomplete_expired` and `paused` remove storage and workers and lock the account (**423**, `reason: "lapsed"`, the id in `unpaidWorkspaceIds`). Replays of an `evt_` id are no-ops.

Account policy from `GET /v2/projects` and `GET /v2/workspaces` includes `workspaceFeeIncluded: true`, `newProjectOneTimeCents: 0`, `workspaceMonthlyCents: 0`, `firstWorkspaceIncludes {storageGB, performanceTier, workers}`, `additionalWorkspaceRequires: ["storage","performance"]`, `customStorageRequires: ["performance"]`, `freeWorkspaces`, `freeWorkspaceId`, `projectLimit`, `usedProjectSlots`, `locked`, `uploadsBlocked`, `reason`, `overBy`, `unpaidWorkspaceIds` and `grandfatheredProjects`. Workspace items add `billingModel` (`"plans"`), `customStorage`, `requiredPlans`, `plansStatus` and `workspaceFeeIncluded`.

`reason` is `over_cap`, `lapsed`, `over_cap_and_lapsed`, `scope_unavailable`, `merge_in_progress`, or `null`.

## Free workspace

`freeWorkspaceId(account)` is the one hosted workspace that needs no plan purchase. The choice is made inside the Firestore transaction on create, delete and merge, so two simultaneous creates cannot both be free; the loser needs plans.

- The slot is hosted storage only. A custom-storage workspace is never free, even when it is the account's only workspace, and it does not use up the slot.
- The slot is the oldest active hosted workspace. Delete of that workspace assigns the oldest remaining hosted workspace inside the same transaction. If none remain, the next hosted workspace created becomes free.
- Archive does not release the slot.
- Custom storage is chosen when the workspace is created. Registering a provider on an existing hosted workspace is **409** `CUSTOM_STORAGE_NEW_WORKSPACE`.

## Legacy workspace fee (in-flight records only)

Workspaces created before this change may carry the retired $5 fee: `workspaceFeeModel: "monthly"` (`kind: workspace_fee` subscriptions), the one-time `project_creation` Checkout, or the monthly BYO fee. Those records are still reconciled, revoked on refund, and lapse at `paidThroughMs + 3 days` exactly as before, so nobody loses access or is charged twice. No new fee Checkout is ever opened. A legacy `pending_payment` workspace moves to the plans model on its next `POST /v2/projects/:id/checkout` with `{plans}`. Grandfathered rows (`kind: "free"`, `feeIsOneTime: true`, or billing version 2 with `projectFeeStatus` `paid`/`free`/`owner`) are never rewritten.

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

Custom storage (BYO) is created with `storage: "custom"` and a paid performance plan. There is no storage plan and no extra fee. `POST /v2/workspaces/:id/byo/register` is **402** `PERFORMANCE_PLAN_REQUIRED` until that plan is paid. Apps then run the setup wizard: provider type → endpoint + credentials (kept on the device) → challenge write and verify (the connection test) → finish.

Launch providers are S3-compatible only, stored as `providerType: "s3"`: AWS, Cloudflare R2, Backblaze B2, Wasabi, MinIO, and GCS via S3 keys. Aliases `aws`, `r2`, `cloudflare`, `backblaze`, `b2`, `wasabi`, `minio`, `gcs`, and `google` normalize to `s3`. SFTP, Azure, and WebDAV are not launch providers. `POST /v2/workspaces/:id/byo/register` with one of those returns **422** `{error: "byo_provider_unsupported", provider}`. Error codes are the `error` string. Responses do not include a `code` field. Secret fields are rejected first, so a body that also contains a password still returns **400** `BYO_SECRET_REJECTED`.

The server stores `providerType`, `endpoint`, and `bucketFingerprint`. Credentials never reach the server. A body that contains `accessKey`, `secretAccessKey`, `password`, `privateKey`, `private_key`, `serviceAccount`, `keyFile`, `pem`, a `BEGIN PRIVATE KEY` block, or pasted service-account JSON returns **400** `BYO_SECRET_REJECTED`. The value is not written to Firestore and is not logged.

`GET /v2/pricing` reports `customStorage {storagePlanRequired: false, performancePlanRequired: true, extraFeeCents: 0}`. Workers and storage are not granted unless `byoChallengeVerified` is true, including owner complimentary checkout (**409** `BYO_CHALLENGE_REQUIRED`) and subscription reconciliation. `byoActive` plus `manualProviderConfigured` alone leaves `projectStatus` at `pending_activation` and `effectiveWorkers` at 0. Re-registering or changing the endpoint clears `byoChallengeVerified`, `byoActive`, and `manualProviderConfigured`.

| Route | Body | Result |
| --- | --- | --- |
| `POST /v2/workspaces/:id/byo/register` | `{provider, endpoint, bucketFingerprint}` | Stores the public S3 registration. Does not activate. Unsupported providers are 422. |
| `POST /v2/workspaces/:id/byo/challenge` | none | `{nonce, expiresAtMs, ttlMs}`. Replaces any previous unused nonce. The client writes that nonce to `.gendragoon-challenge/<nonce>` in its bucket. |
| `POST /v2/workspaces/:id/byo/verify` | `{presignedUrl}` | The server GETs the presigned URL. A missing `presignedUrl`, or a legacy field such as `readBack` or `proofUrl`, is **400** `{error: "presigned_url_required"}`. |

The presigned URL must be `https`, must not carry userinfo, and its host must equal the registered endpoint host exactly (**400** `BYO_ENDPOINT_HOST_MISMATCH`, before any fetch). The path must contain `/.gendragoon-challenge/<nonce>`. The server resolves DNS and rejects private, loopback, and link-local addresses, refuses redirects, limits the response to 1024 bytes, and times out at 3 seconds. The body must equal the nonce. The bucket fingerprint is derived from the object ETag (or a SHA-256 of the body). The nonce is single-use for 10 minutes.

Challenge errors: `presigned_url_required`, `BYO_CHALLENGE_MISMATCH`, `BYO_CHALLENGE_EXPIRED`, `BYO_CHALLENGE_USED` (all 400). `BYO_NOT_REGISTERED` is 409. Someone else's workspace is 404.

## Request fields

A fixture request body may contain only the fields listed for its route. Fields marked `?` are optional; the rest are required. `byo/verify-missing-url` is the empty-body verify case. Every other verify request is exactly `{presignedUrl}`.

| Route | Body |
| --- | --- |
| `POST /v2/projects` | `{name, intentId, storage?, plans?}` |
| `GET /v2/workspaces` | none |
| `GET /v2/projects/:id` | none |
| `DELETE /v2/projects/:id` | none |
| `POST /v2/workspaces/:id/cloud/uploads` | `{name, sizeBytes}` |
| `GET /v2/workspaces/:id/cloud/files` | none |
| `POST /v2/workspaces/:sourceId/merge` | `{targetId, confirmName}` |
| `POST /v2/workspaces/:sourceId/merge/preview` | `{targetId, confirmName}` |
| `POST /v2/workspaces/:id/byo/register` | `{provider, endpoint, bucketFingerprint}` |
| `POST /v2/workspaces/:id/byo/challenge` | none |
| `POST /v2/workspaces/:id/byo/verify` | `{presignedUrl}` |

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
