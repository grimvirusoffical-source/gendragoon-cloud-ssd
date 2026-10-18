# GenDragoon API contract

Live service: `native/Backend` in `grimvirusoffical-source/gendragoon-cloud-ssd` at tag `v0.18.0-rc.2` (`4cb71b5`). The deployed entry is `free_server.js`. Base URL is the Cloud Run service the Mac app already uses. Clients send `Authorization: Bearer <Firebase Google ID token>` after Terms acceptance. File routes also accept a `gdsk_` key limited to `files:read` and/or `files:write` for the workspace stamped on that key.

`packages/core` `GenDragoonClient` calls the live routes below. Proposed routes are typed and will 404 until Riley ships them. Stripe webhooks stay server-only.

## Ownership

Paid and BYO documents store `accountHash`. The legacy free project stores `accountKey`. Both are `sha256("gd-v1:" + verified Firebase uid)`, computed on the server. Clients never send a hash to claim a workspace. There is no `ownerUid` and there are no shared members at launch.

`GET /v2/workspaces` and `GET /v2/projects` return only the caller's rows. `GET /v2/projects/:id` (and the workspace equivalent) for an id this account does not own is **404** with a not-found message. Do not answer 403 for that case: 403 reveals that the row exists. Today's `projects.js` still throws 403 `PROJECT_FORBIDDEN` when the document exists and `owned()` fails. Change that to 404. 403 remains correct for Terms rejection, an API key pointed at a different workspace than the one in the URL, a missing scope, and an inactive project the caller does own.

Customers have logical workspaces inside one shared `CUSTOMER_BUCKET`. They do not receive a GCP project. `gen-dragoon-ssd` is not a customer bucket.

## Billing constants

| Constant | Value |
| --- | --- |
| `FREE_WORKSPACES` | `1` by default. `0` is the only other legal value. Grim has not decided. |
| Workspace fee | $5 per month (`500` cents) for every workspace outside the free allowance that is not grandfathered. |
| `feeIsOneTime` | `true` on a one-time $5 activation. Those workspaces never lapse. |
| Lapse | Stripe `current_period_end` + 3 days. The server is the source of truth. |
| `MAX_WORKSPACES_BASE` | 10 |
| `MAX_WORKSPACES_HIGH` | 20 when one active project has at least 2 TB and Turbo (8 workers), or an equivalent bundle. Same rule as `qualifiesForHigherLimit` in `projects.js`. |
| Performance | Add-on on top of the workspace fee. The free workspace cannot buy one. |
| BYO | Same $5/month, same cap, same lapse, same lock, same `accountHash`. |

The live catalog still reports `feeIsOneTime: true` and `additionalOneTimeCents: 500` for a new project, and `workspaceFeeMonthlyCents: 0` on billing version 2 storage quotes (the old recurring $5 line remains only on legacy storage subscriptions, `legacyWorkspaceFeeMonthlyCents: 500`). New recurring workspace-fee checkout is an addition. Until it exists, the client keeps calling `POST /v2/projects` and `POST /v2/projects/:id/checkout` for the one-time activation.

Recompute the cap on every login and whenever storage or performance changes. If a downgrade drops the account from 20 to 10 and more than 10 workspaces are still active, lock the account. Do not leave the extra workspaces usable.

## Lock

When the account is over the cap or has an unpaid workspace (not free, not `feeIsOneTime`, not owner-complimentary, and past grace if it has `currentPeriodEnd`):

- Cloud data stays readable and downloadable.
- Uploads, new backups, and the rest of normal use return 403 with a stable code such as `ACCOUNT_LOCKED`.
- The user deletes or merges until they are inside the cap and nothing unpaid remains.

Proposed `GET /v2/access` (also fine as fields on `GET /v2/workspaces`):

```json
{
  "locked": true,
  "cap": 10,
  "activeCount": 11,
  "overCap": true,
  "unpaidIds": ["workspace-id"],
  "lapsedIds": ["workspace-id"],
  "readable": true,
  "downloadsAllowed": true,
  "uploadsBlocked": true,
  "normalUseBlocked": true,
  "highTier": false,
  "freeWorkspaces": 1
}
```

Archived projects already drop out of `usedProjectSlots`. A lock-resolution delete is still a separate route because archive keeps the objects. `POST /v2/projects/:id/archive` remains the non-destructive removal and already needs the exact name plus `acknowledgeBillingContinues` when a subscription is still running.

## Merge (new)

`POST /v2/workspaces/merge`

```json
{ "sourceId": "…", "targetId": "…" }
```

Move each object into the target workspace. If the relative path already exists, rename the **incoming** copy to `name (from <source workspace>)`. If that path also exists, use `name (from <source workspace>) 2`, then 3, and so on. Never overwrite the target's file. After every copied object has been read back and matched, delete the source workspace. If any copy fails verification, leave the source in place.

Both ids must belong to the caller. A foreign id is 404. The pure planner lives in `packages/core` (`planMerge`, `sourceDeletionAllowed`) so every client shows the same names the server will write.

## Live routes

### Session and catalog

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | Public. `?deep=1` probes dependencies. |
| GET | `/v1/me` | Signed-in account and free workspace, if any. |
| POST | `/v1/free` | Create the lifetime free project when the policy still allows it. |
| GET | `/v2/billing/status` | Checkout and project-creation readiness. |
| GET | `/v2/pricing` | Server prices. Do not hard-code the commercial JSON. |
| GET | `/v2/account/entitlements` | `adFree`, `ownerBenefits`. |
| POST | `/billing/customer-portal` | Stripe portal URL. |
| POST | `/v2/remove-ads/checkout` | One-time ad removal. |
| GET | `/v3/capabilities` | Protocol 3, 8 MiB chunks. |

### Workspaces and projects

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/v2/workspaces` | Active workspaces plus `policy`. |
| GET | `/v2/workspaces/:id` | One workspace. 404 if it is not yours. |
| POST | `/v2/workspaces/free` | Compatibility free-project create. |
| POST | `/v2/workspaces/draft` | Old clients get 426 `CLIENT_UPDATE_REQUIRED` unless the intent already exists. |
| GET | `/v2/projects?includeArchived=true` | Inventory. |
| POST | `/v2/projects` | `{name, intentId}`. Reserves a project. One-time checkout URL when the fee is pending. |
| GET | `/v2/projects/:id` | |
| POST | `/v2/projects/:id/checkout` | Resume the one-time $5 activation. |
| PUT | `/v2/projects/:id/selection` | Intended storage/performance only. Does not grant entitlement. |
| POST | `/v2/projects/:id/archive` | `{confirmName, acknowledgeBillingContinues?}`. Keeps objects. |
| POST | `/v2/projects/:id/restore` | Same project, no new free slot and no second fee. |
| POST | `/v2/workspaces/:id/checkout/storage` | `{tier, interval, mode}`. |
| POST | `/v2/workspaces/:id/checkout/performance` | `{tier, interval}`. Refused until storage is active. Free tier: do not offer this. |
| POST | `/v2/workspaces/:id/checkout/byo` | BYO subscription interval. Same dollars as any other workspace fee once recurring billing lands. Today this is the separate BYO price in the catalog. |
| POST | `/v2/workspaces/:id/manual-provider` | `{provider, label, connectionTested:true}`. Must not accept credentials. Not sufficient to activate. See the challenge flow. |

### Transfers

Protocol 3 is the client path. Chunk size is 8,388,608 bytes. Each chunk sends `x-chunk-sha256`. Folders and `.app` bundles use `kind: "folder"` or `"app"` plus `archiveFormat: "gendragoon-package-v1"` and `manifestSHA256`. A bare file omits the package fields.

| Method | Path |
| --- | --- |
| GET | `/v3/cloud/:workspaceId/config` |
| GET | `/v3/cloud/:workspaceId/files` |
| POST | `/v3/cloud/:workspaceId/uploads` |
| GET | `/v3/cloud/:workspaceId/uploads/:id` |
| PUT | `/v3/cloud/:workspaceId/uploads/:id/chunks/:index` |
| POST | `/v3/cloud/:workspaceId/uploads/:id/finalize` |
| DELETE | `/v3/cloud/:workspaceId/uploads/:id` |
| GET | `/v3/cloud/:workspaceId/files/:id/download` |
| DELETE | `/v3/cloud/:workspaceId/files/:id` |

v1 (`/v1/files`, `/v1/uploads/...`) remains for the legacy free workspace. v2 paid cloud remains at `/v2/workspaces/:workspaceId/cloud/...` (`files`, `uploads`, chunks, finalize, download, delete). New clients use v3.

### API keys

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/v1/keys` | Metadata only. |
| POST | `/v1/keys` | Returns the `gdsk_` secret once. |
| DELETE | `/v1/keys/:id` | Revoke. |

Keys do not grant billing, merge, or BYO setup.

## Additions for Riley

### Recurring workspace fee

`POST /v2/workspaces/:id/checkout/workspace-fee`

Subscription mode, 500 cents per month, metadata `{kind:"workspace_fee", accountHash, workspaceId}`. Do not reuse the one-time project Price. A workspace with `feeIsOneTime: true` gets `{alreadyActivated:true}` and no new Checkout. The free slot (when `FREE_WORKSPACES` is 1 and unclaimed) is created without this fee and without a performance add-on.

Public workspace objects should grow `feeIsOneTime`, `workspaceSubscriptionId`, `currentPeriodEnd`, and server-computed `graceEndsAt` / `lapsed`. Clients render those fields.

### BYO challenge

Launch `provider` values: `aws`, `r2`, `b2`, `wasabi`, `minio`, `gcs-s3` (Google Cloud Storage via S3-interop HMAC keys, not the native GCS API), `sftp`. Reject `azure-blob`, `webdav`, and `gcs-native` until a later launch.

`POST /v2/workspaces/:id/byo/challenge`

```json
{ "provider": "r2", "endpoint": "https://example.r2.cloudflarestorage.com", "bucketFingerprint": "<sha256 hex>" }
```

The endpoint must be `https` for S3-compatible providers and `sftp` for SFTP, with no userinfo. Response:

```json
{
  "challengeId": "…",
  "objectKey": ".gendragoon-verify/<challengeId>",
  "nonce": "…",
  "expiresAt": "…"
}
```

The client writes `nonce` to `objectKey` with credentials that never leave the device, reads the object back, deletes it, then:

`POST /v2/workspaces/:id/byo/proof`

```json
{ "challengeId": "…", "readBack": "…" }
```

Activate the workspace only when `readBack` equals the stored nonce and the challenge has not expired. Persist `provider`, `endpoint`, and `bucketFingerprint` only. Reject any body that contains credential fields (`secretAccessKey`, `password`, `privateKey`, `token`, and the rest listed in `assertNoCredentialFields`).

`POST /v2/workspaces/:id/manual-provider` can stay as a label, but `connectionTested: true` is not this proof.

### Delete

`DELETE /v2/workspaces/:id` removes a workspace for lock resolution after the caller confirms the exact name. Foreign id: 404. This is not archive. Archive stays available when the user wants to keep the bytes and free a slot without a merge.

## Connect-your-own-storage flow

1. The user picks a launch provider and types an endpoint plus bucket or directory. The secret stays in the OS keychain.
2. The client hashes `provider + endpoint + bucket` into `bucketFingerprint` and calls `POST .../byo/challenge`. The bucket name itself is not stored on the server.
3. The client writes, reads, and deletes the challenge object.
4. `POST .../byo/proof`. The workspace stays inactive on failure.
5. Billing is the same $5/month workspace fee, plus an optional performance add-on if this workspace is not the free one. The provider's own permissions are only the challenge. Ownership of the GenDragoon workspace remains `accountHash`.

## What the Windows client does not send

No Stripe secret, no Firebase private key, no `gdsk_` key baked into the app, no BYO secret, no GitHub token. Update tokens are read from the OS keychain by `@gendragoon/updater` and are not part of this API.
