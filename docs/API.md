# GenDragoon API contract

Live service: `native/Backend` in `grimvirusoffical-source/gendragoon-cloud-ssd` at tag `v0.18.0-rc.2` (`4cb71b5`). The deployed entry is `free_server.js`. Base URL is the Cloud Run service the Mac app already uses. Clients send `Authorization: Bearer <Firebase Google ID token>` after Terms acceptance. File routes also accept a `gdsk_` key limited to `files:read` and/or `files:write` for the workspace stamped on that key.

`packages/core` `GenDragoonClient` calls the live routes below. Proposed routes are typed and will 404 until Riley ships them. Stripe webhooks stay server-only.

## Ownership

Paid and BYO documents store `accountHash`. The legacy free project stores `accountKey`. Both are `sha256("gd-v1:" + verified Firebase uid)`, computed on the server. Clients never send a hash to claim a workspace. There is no `ownerUid` and there are no shared members at launch.

`GET /v2/workspaces` and `GET /v2/projects` return only the caller's rows. `GET /v2/projects/:id` (and the workspace equivalent) for an id this account does not own is **404** with a not-found message. Do not answer 403 for that case: 403 reveals that the row exists. Today's `projects.js` still throws 403 `PROJECT_FORBIDDEN` when the document exists and `owned()` fails. Change that to 404. 403 remains correct for Terms rejection, an API key pointed at a different workspace than the one in the URL, a missing scope, and an inactive project the caller does own.

Customers have logical workspaces inside one shared `CUSTOMER_BUCKET`. They do not receive a GCP project. `gen-dragoon-ssd` is not a customer bucket.

## Billing

Caps, the monthly fee, grandfathering, and lapse are decided on the server. `packages/core` does not recompute them and does not include `feeIsOneTime` on client types. The client renders `GET /v2/access` and HTTP 423.

`planSummary(access)` copies `activeCount` to `used`, `cap` to `limit`, and `locked`. It copies `paidThroughMs`, `renewsAtMs`, and `lifetime` only when the server sent them. It does not invent a grace period or a lifetime rule.

The live catalog still sells an extra project as a one-time activation (`additionalOneTimeCents: 500`, `workspaceFeeMonthlyCents: 0` on billing version 2 storage quotes). Recurring workspace-fee checkout is an addition for Riley. Until it exists, the client keeps calling `POST /v2/projects` and `POST /v2/projects/:id/checkout`.

## Lock

When `GET /v2/access` says the account is locked:

- Cloud data stays readable and downloadable. Deletes still succeed.
- Writes return **HTTP 423** `{ "error": "workspace_lock", "reason", "overBy", "unpaidWorkspaceIds" }`. `reason` is `over_cap`, `lapsed`, `over_cap_and_lapsed`, `scope_unavailable`, or `merge_in_progress`. The client throws `WorkspaceLockedError` with those fields and the account state machine moves to delete-or-merge. The lock screen renders the fixture fields. It does not show that payload as a generic error.
- The user deletes or merges until the next access payload is unlocked.

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
  "freeWorkspaces": 1,
  "paidThroughMs": 1800000000000,
  "renewsAtMs": 1800000000000,
  "lifetime": false
}
```

Archived projects already drop out of `usedProjectSlots`. A lock-resolution delete is still a separate route because archive keeps the objects. `POST /v2/projects/:id/archive` remains the non-destructive removal and already needs the exact name plus `acknowledgeBillingContinues` when a subscription is still running.

## Merge (new)

`POST /v2/workspaces/:sourceId/merge`

```json
{ "targetId": "…", "confirmName": "<source workspace name>" }
```

A wrong `confirmName` is **400** `{ "error": "CONFIRM_NAME_REQUIRED" }`. `POST /v2/workspaces/:sourceId/merge/preview` returns the renamed incoming paths before the copy. The completed merge body is `{ copied, idempotent, merged, sourceDeleted, sourceId, workspaceId }`.

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

This client calls workspace routes on `/v2` only. Chunk size is 8,388,608 bytes. Managed-bucket bytes are ciphertext (see `docs/SECURITY.md`) uploaded through signed links, not with a GCP credential. Folders and `.app` bundles use `kind: "folder"` or `"app"` plus `archiveFormat: "gendragoon-package-v1"` and `manifestSHA256`. A bare file omits the package fields.

| Method | Path |
| --- | --- |
| GET | `/v2/workspaces/:id/cloud/files` |
| POST | `/v2/workspaces/:id/cloud/uploads` |
| GET | `/v2/workspaces/:id/cloud/uploads/:uploadId` |
| PUT | `/v2/workspaces/:id/cloud/uploads/:uploadId/chunks/:index` |
| POST | `/v2/workspaces/:id/cloud/uploads/:uploadId/finalize` |
| DELETE | `/v2/workspaces/:id/cloud/uploads/:uploadId` |
| GET | `/v2/workspaces/:id/cloud/files/:fileId/download` |
| DELETE | `/v2/workspaces/:id/cloud/files/:fileId` |
| POST | `/v2/workspaces/:id/storage-urls` |

`GET /v3/capabilities` stays a catalog route. It is not a workspace route. Older `/v1/files` and `/v3/cloud/:workspaceId` mounts are not called by this client.

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

Subscription mode, metadata `{kind:"workspace_fee", accountHash, workspaceId}`. The price, the free slot, and whether a workspace is already paid are server decisions. The client does not send `feeIsOneTime` and does not decide the quote.

### BYO challenge

Launch `provider` values: `aws`, `r2`, `b2`, `wasabi`, `minio`, `gcs-s3` (Google Cloud Storage via its S3 HMAC keys, not the native GCS API). SFTP, Azure Blob, and WebDAV are coming soon. They are disabled in Connect Storage. Registering one of them, including SFTP, returns **422** `{ "error": "byo_provider_unsupported", "provider": "sftp" }`. The client shows that as “not supported yet / coming soon”.

The server does not send **409** `byo_unverifiable`. The client still maps that code to a verification message as a fallback. Riley's BYO fixtures do not include it.

`POST /v2/workspaces/:id/byo/register`

```json
{ "provider": "s3", "endpoint": "https://bucket.s3.us-east-1.amazonaws.com", "bucketFingerprint": "<hex>" }
```

`POST /v2/workspaces/:id/byo/challenge` has no body. Response:

```json
{ "nonce": "…", "expiresAtMs": 1700000600000, "ttlMs": 600000 }
```

The client writes `nonce` to `.gendragoon-challenge/<nonce>` with credentials that never leave the device. It then generates, on the device, a short-lived presigned GET for exactly that object (https, no userinfo, expiry at most 15 minutes) and sends:

`POST /v2/workspaces/:id/byo/verify`

```json
{ "presignedUrl": "https://…" }
```

Do not send stored credentials, access keys, or `readBack`. A body without `presignedUrl` is **400** `{ "error": "presigned_url_required" }` (`byo/verify-missing-url`). Registering the same storage again runs a new challenge. The previous proof is not reused. Activate the workspace only when the server can GET that URL and the challenge has not expired. Persist `provider`, `endpoint`, and `bucketFingerprint` only. Reject any body that contains credential fields (`secretAccessKey`, `password`, `privateKey`, `token`, and the rest listed in `assertNoCredentialFields`).

`POST /v2/workspaces/:id/manual-provider` can stay as a label, but `connectionTested: true` is not this proof.

### Delete

`DELETE /v2/workspaces/:id` removes a workspace for lock resolution after the caller confirms the exact name. Foreign id: 404. This is not archive. Archive stays available when the user wants to keep the bytes and free a slot without a merge.

## Connect-your-own-storage flow

1. The user picks a launch provider and types an https endpoint plus bucket. SFTP, Azure, and WebDAV stay disabled. The secret stays in the OS keychain.
2. The client hashes `provider + endpoint + bucket` into `bucketFingerprint` and calls `POST .../byo/register`. The bucket name itself is not stored on the server. A provider the server will not register returns 422 `byo_provider_unsupported`.
3. `POST .../byo/challenge` returns `{ nonce, expiresAtMs, ttlMs }`. The client writes `.gendragoon-challenge/<nonce>` and creates a short-lived presigned GET on the device.
4. `POST .../byo/verify` sends `{ presignedUrl }`. The workspace stays inactive on failure. Connecting the storage again repeats steps 2–4.
5. The workspace fee and any performance add-on are whatever `GET /v2/access` reports. The provider's own permissions are only the challenge. Ownership of the GenDragoon workspace remains `accountHash`.

## Managed bucket links

Clients never hold GCP credentials. After Firebase sign-in the backend checks the ID token and `accountHash`, then:

`POST /v2/workspaces/:id/storage-urls`

```json
{ "operations": [{ "op": "upload", "oid": "<opaque>", "sizeBytes": 1024 }] }
```

`op` is `upload`, `resumable`, `download`, or `delete`. The response is workspace-prefix scoped and expires in at most 15 minutes:

```json
{
  "prefix": "customers/<accountHash>/workspaces/<id>/",
  "expiresAt": "<iso, <= 15 min>",
  "access": "read-write",
  "links": [{ "op": "upload", "oid": "<opaque>", "method": "PUT", "url": "https://storage.googleapis.com/...", "expiresAt": "<iso>" }]
}
```

A locked workspace (over cap or unpaid) gets `access: "read-only"` and download links only. An upload or resumable request in that state is a write and returns HTTP 423 `workspace_lock`. The signed URL itself must be `https`, must not carry userinfo, and must contain `prefix`. The client then PUTs ciphertext to that URL with no `Authorization` header.

Object ids are random. Filenames live only in an AES-256-GCM manifest sealed with the per-workspace key. See `docs/SECURITY.md`.

## Delete account

`DELETE /v2/account`

Body, exactly:

```json
{ "confirm": "DELETE" }
```

The client does not send `reauthenticatedAt` or the ID token in that body. It still requires a Firebase sign-in whose `auth_time` claim is newer than 5 minutes. A refreshed token's `iat` does not count. If the last sign-in is older, the server returns **401** `{ "code": "reauth_required" }`. The client sends the user to sign in again and retries. It does not wipe local keys. A **401** with no error code follows that same path: the user goes to sign-in, any saved job id and status token stay in SecureStore, and local keys stay.

A session that cannot be used returns **401** `{ "code": "invalid_token" }`. The client signs out and leaves local keys in place.

Response **202**:

```json
{ "status": "deleting", "jobId": "<id>", "statusToken": "<token>" }
```

A repeat delete returns **410** `{ "error": "account_deleted", "jobId": "<id>", "statusToken": "<token>" }`. It does not return 401. The client polls that job id with the status token from the 410. It does not wipe local data because of the 410 itself.

`GET /v2/account/deletions/:jobId` is the plural path. The client sends `Authorization: Bearer <statusToken>` and does not send the Firebase ID token on that poll. The job id and status token are stored in the injected SecureStore as soon as the 202 or 410 is accepted. A later launch calls `resumeAccountDeletion` and polls the saved job. It sends DELETE again only when SecureStore has no saved job id and status token. The client polls with backoff until the status is `done` or `failed`, or until a two-minute timeout. `queued` and `running` keep polling. `done` cancels every Stripe subscription, deletes managed-bucket objects, deletes the Firebase user and account records, and leaves BYO buckets untouched. The client wipes local workspace keys and BYO secrets only after `done`, then clears the saved job id and status token and signs out. `failed` stops without a wipe and clears the saved job. A **404** `{ "error": "not_found" }` while polling is a retryable error (`DeletionNotFoundError`). The saved job id and status token stay. They are cleared after `done` (which also wipes local keys) or when the user dismisses the job with `dismissAccountDeletion`. Settings uses a two-step confirm before this call.

## Workspace key envelope

`GET /v2/workspaces/:id/key-envelope` and `PUT /v2/workspaces/:id/key-envelope`.

The device that creates the workspace generates one random 256-bit workspace key. It derives a KEK from a recovery passphrase with Argon2id (scrypt if Argon2id throws) and wraps the key with AES-256-GCM. The envelope stores `version`, `kdf`, `salt`, `opsLimit`, `memLimit`, `iv`, and `wrappedKey`. The passphrase and the raw key stay off the server. A new device asks for the passphrase once, unwraps the key, and caches it in the OS keychain. Losing the passphrase loses the files. Per-file keys are wrapped by the workspace key. Filenames, wrapped keys, and sizes live in a sealed manifest. File bytes use chunked AES-GCM with one random nonce per chunk and the chunk index as additional data.

## What the Windows client does not send

No Stripe secret, no Firebase private key, no `gdsk_` key baked into the app, no BYO secret, no GitHub token. Update tokens are read from the OS keychain by `@gendragoon/updater` and are not part of this API.
