# Architecture

The product split is deliberate.

- **Mac** stays the SwiftUI app and Python helpers in `gendragoon-cloud-ssd` (`codex/native-integration-20261017`, tag `v0.18.0-rc.2`, commit `4cb71b5`). This repo does not rewrite it in Electron.
- **Windows** is `apps/desktop`, an Electron client shared only with Windows. The electron-builder Mac target is omitted.
- **iOS and Android** will be one React Native or Expo app under `apps/mobile`.
- **Browser extensions** (Chrome, Edge, Opera, Firefox) will live under `apps/extension`.
- **Backend** remains `native/Backend` (Express, Firebase, Stripe, Firestore). Riley owns new routes. `services/api` points at the contract.

## Shared sort map

`packages/core/data/sort-map.json` is the only default extension/MIME map. Mac, iOS, Android, Windows, and the extensions all load that file. TypeScript helpers in `packages/core/src/sorting.ts` are a reader, not a second copy of the table. A user's edits are stored as overrides in Settings on that device and are layered on top of the JSON.

## Server is the source of truth

Ownership, the workspace cap, lapse, and the login lock are enforced on the server on every request. Clients render the payload. A function in `packages/core` that returns `locked: false` is a render helper for tests and for painting the shell when the server has already returned the inputs. It is not permission to upload.

- **Ownership.** Paid and BYO workspaces use the existing `accountHash` (`sha256("gd-v1:" + Firebase uid)`). The legacy free project uses `accountKey` with the same hash. There is no `ownerUid` field and there are no member roles at launch. Another account that asks for a workspace id gets **404**, so the response does not reveal that the workspace exists. The deployed code still returns 403 `PROJECT_FORBIDDEN` when the document exists and the hash does not match. Riley should collapse that to 404. The client already presents both as "Not found".
- **Customers do not get a GCP project.** Logical workspaces share one private bucket (`CUSTOMER_BUCKET`). The personal bucket `gen-dragoon-ssd` is rejected by the server. A GCP Owner role is not how a customer owns a GenDragoon workspace.
- **Plan.** Cap, lapse, grandfathering, and price are server decisions. The client does not compute them and does not carry `feeIsOneTime`. List and create items expose required `isFree`, `monthlyPriceCents`, `grandfathered`, and `feeWaived`. The label is `Free` when `isFree`, `Included` when `grandfathered` or `feeWaived`, and otherwise the formatted cents. A BYO register body may include `grandfatheringEnded`, which the client copies through. `planSummary` formats `used`, `limit`, `locked`, and the server's `paidThroughMs`, `renewsAtMs`, and `lifetime` when those fields are present. HTTP 423 `reason: "lapsed"` is `WorkspaceLockedError`.
- **Lock.** When the server reports an account-wide lock, cloud data stays readable and downloadable, and deletes still succeed. Writes return HTTP 423 `{ "error": "workspace_lock", "reason", "overBy", "unpaidWorkspaceIds" }`. `GenDragoonClient` throws `WorkspaceLockedError` with those fields. `over_cap`, `over_cap_and_lapsed`, `scope_unavailable`, and `merge_in_progress` move the account to `delete_or_merge`, and `AccountSurface` shows the lock screen from that body. A **423** `reason: "lapsed"` applies only to `unpaidWorkspaceIds`. The account stays `ready`, and writes to every other workspace stay allowed.
- **Merge.** New endpoint for Riley. Files move into the target. On a path collision the incoming copy is renamed to `name (from <source>)`, then `name (from <source>) 2`, and so on. The target file is never overwritten. The source workspace is deleted only after every copy verifies.

## Bring your own storage

Launch providers are S3-compatible only: AWS, Cloudflare R2, Backblaze B2, Wasabi, MinIO, and Google Cloud Storage through its S3 HMAC keys. There is no native GCS adapter. SFTP, Azure Blob, and WebDAV are disabled “Coming soon” options. Registering one of them returns HTTP 422 `byo_provider_unsupported`.

Credentials stay on the user's device (OS keychain or secure storage). They are never sent to the API, never logged, and never committed. The server stores provider type, endpoint, and a bucket fingerprint. Before the workspace activates, the client writes `.gendragoon-challenge/<nonce>` and sends a short-lived presigned GET for that object, generated on the device. Registering the storage again runs a new challenge. That proves the user controls the bucket. It does not replace `accountHash` as the ownership rule.

The Windows shell includes that setup inside Workspaces. The request bodies are described in `docs/API.md`.

## Managed bucket

The device does not hold a GCP credential. Firebase sign-in, an `accountHash` check, and `POST /v2/workspaces/:id/storage-urls` produce V4 URLs of at most 15 minutes, scoped to that workspace prefix. The request is `{op, objects}` and the response is `{mode, urls:[{object, url, method}]}` for upload, download, and delete. File bytes and names are AES-256-GCM on the device before upload. The creating device generates one 256-bit workspace key, wraps it with a recovery passphrase (Argon2id; scrypt only when requested), and stores it in SecureStore only after the envelope PUT returns 201. HTTP 409 adopts the server key. HTTP 412 refetches and re-wraps that same key. A failed attempt does not leave the generated key on the device. Argon2id `memoryKiB` must be from 19456 through 1048576, and iterations are capped at 10. A new device unwraps the envelope once and caches the key in the OS keychain. Per-file keys are wrapped by that workspace key. Chunk indexes and a final-chunk flag are bound as GCM additional data. The library object id is `manifest`, uploaded with compare-and-swap. See `docs/SECURITY.md`.

## Library manifest merge

Swift, iOS, Android, and this TypeScript client share one merge. `mergeSealedManifest` in `packages/core/src/manifest-cas.ts` is the TypeScript copy. The vectors in `packages/core/test/vectors/manifest-merge/*.json` are the contract. Each file is `{local, remote, lastSyncedVersion, nowMs, expected}`. Other platforms load those files unchanged and compare their merge result to `expected`.

A manifest is `{version, prunedThroughVersion, files, tombstones}`. A file is `{fileId, path, writtenAtVersion}` plus any platform fields, which pass through. A tombstone is `{fileId, deletedAtVersion, deletedAtMs}`. `version` is the sealed monotonic counter. It advances by one on every successful `ifGeneration` put. Higher version is newer. Wall clocks are not an order.

Merge rules:

- Union files by `fileId`. The higher `writtenAtVersion` wins.
- Union tombstones by `fileId`. The higher `deletedAtVersion` wins.
- Drop a file when a tombstone for that `fileId` has `deletedAtVersion` greater than the file's `writtenAtVersion`.
- A re-add uses a new `fileId`, so the old tombstone and the new file both remain, including when the path is the same.
- `nowMs - deletedAtMs >= 30 days` makes a tombstone eligible to prune. Pruning raises `prunedThroughVersion` to the highest pruned `deletedAtVersion`. A device clock that is behind does not prune, so it cannot resurrect or drop a delete.
- An empty remote with a higher `version` is not replaced by older local files. Only a local file or tombstone whose version is greater than that remote version is applied.
- When `lastSyncedVersion < remote.prunedThroughVersion`, the device adopts the remote manifest and re-applies only local files and tombstones with a version greater than `lastSyncedVersion`. Those re-applied files are stamped with the new manifest version. Each device stores `lastSyncedVersion` in SecureStore after a successful put.
- `expected.version` is `max(local.version, remote.version) + 1`. Files and tombstones are sorted by `fileId`.

`packages/core/test/manifest-merge.test.ts` runs every vector through `mergeSealedManifest`.

`DELETE /v2/account` sends `{ "confirm": "DELETE" }` and polls `GET /v2/account/deletions/:jobId`. Local keys are wiped only after `done`. `failed` keeps the saved job. `retryable: false` shows the support contact and Dismiss, with no Retry. A status GET that returns `unauthorized`, `reauth_required`, no error code, or a status-token `invalid_token` calls `onAuthFailure("reauth_required", error)`, stops polling, keeps the job, and wipes nothing. Only a Firebase-token `invalid_token` calls `onAuthFailure("signed_out", error)`, clears the session, keeps the job, and continues with the saved status token. DELETE is sent again only by `retryDeletion` and after sign-in when the status token was rejected or the poll returned 404. HTTP 409 `deletion_not_retryable` is `DeletionNotRetryableError`. The job is cleared by `done` or `dismissDeletion`. A 410 `account_deleted` is polled by its `jobId` and does not wipe by itself. `requestDeletionSupport(jobId, { client, secureStore })` posts to `/v2/account/deletions/:jobId/support-request` with the saved status token and no Firebase token. **202** is `received`, **429** is `already_sent`, and **409** `support_not_needed` refreshes deletion status with that token. **401** `unauthorized`, a bare **401**, **404**, a network error, and **5xx** return `fallback` with `SUPPORT_CONTACT` and do not call `onAuthFailure` or `clearSession`.

## Updater

`packages/updater` is the shared cycle: GitHub releases feed, stable/beta selection (stable means non-prerelease), SHA-256 check, install, relaunch, post-launch health check, and rollback. Red-XAI Updater, the Windows app, and later apps such as LumiAI import it. The interchange manifest is exactly `{version, url, sha256, notes}` plus an optional `channel`. See `packages/updater/README.md`.

The public feed is the existing `grimvirusoffical-source/gendragoon-cloud-ssd` GitHub Releases list. Do not add a binaries-only repository. A token for a private repository is read from the OS keychain at runtime and is never bundled.
