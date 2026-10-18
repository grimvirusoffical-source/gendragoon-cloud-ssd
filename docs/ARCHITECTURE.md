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
- **Cap.** 10 workspaces on the base account (`MAX_WORKSPACES_BASE`). 20 (`MAX_WORKSPACES_HIGH`) when one active project meets the backend's existing high-tier rule: at least 2 TB and Turbo (8 workers), or an equivalent bundle. The cap is recomputed on every login and plan change. A downgrade that leaves the account over the new cap opens the delete/merge lock. It does not keep silent access.
- **Lapse.** Recurring workspace subscriptions lapse at Stripe `current_period_end` plus a 3-day grace. Grandfathered one-time buyers keep `feeIsOneTime=true` and never lapse. `FREE_WORKSPACES` is 1 by default and may be 0. Grim has not closed that question. The free workspace has no performance add-on.
- **Lock.** Over cap or unpaid: cloud data stays readable and downloadable, and deletes still succeed. Writes return HTTP 423 `{ "code": "workspace_lock" }`. `GenDragoonClient` throws `WorkspaceLockedError`. `reduceAccount` moves the account to `delete_or_merge`. `AccountSurface` shows the lock screen instead of a generic error.
- **Merge.** New endpoint for Riley. Files move into the target. On a path collision the incoming copy is renamed to `name (from <source>)`, then `name (from <source>) 2`, and so on. The target file is never overwritten. The source workspace is deleted only after every copy verifies.
- **Price.** A workspace that is not inside the free allowance and is not a grandfathered one-time purchase is $5 per month (`WORKSPACE_MONTHLY_CENTS = 500`). BYO pays that same fee. Performance tiers (Lite through Max, including Turbo) are add-ons on top. The live server still sells the extra project as a one-time $5 activation; the recurring fee is an addition.

## Bring your own storage

Launch providers are S3-compatible (AWS, Cloudflare R2, Backblaze B2, Wasabi, MinIO), Google Cloud Storage through its S3-interop HMAC keys (there is no native GCS adapter), and SFTP for a VPS. Azure Blob, WebDAV, and native GCS are later.

Credentials stay on the user's device (OS keychain or secure storage). They are never sent to the API, never logged, and never committed. The server stores provider type, endpoint, and a bucket fingerprint. Before the workspace activates, the client writes a server-generated challenge object, reads it back, and deletes it. The server compares the read-back to the nonce it generated. That proves the user controls the bucket. It does not replace `accountHash` as the ownership rule. The provider's own IAM or filesystem permissions are only this setup check.

The Windows shell includes that setup inside Workspaces. The request bodies are described in `docs/API.md`.

## Managed bucket

The device does not hold a GCP credential. Firebase sign-in, an `accountHash` check, and `POST /v2/workspaces/:id/storage-urls` produce V4 or resumable URLs of at most 15 minutes, scoped to that workspace prefix. File bytes and names are AES-256-GCM on the device before upload. The per-file key is random and wrapped by a per-workspace key that lives in the OS keychain. See `docs/SECURITY.md`.

## Updater

`packages/updater` is the shared cycle: GitHub releases feed, stable/beta selection (stable means non-prerelease), SHA-256 check, install, relaunch, post-launch health check, and rollback. Red-XAI Updater, the Windows app, and later apps such as LumiAI import it. The interchange manifest is exactly `{version, url, sha256, notes}` plus an optional `channel`. See `packages/updater/README.md`.

The public feed is the existing `grimvirusoffical-source/gendragoon-cloud-ssd` GitHub Releases list. Do not add a binaries-only repository. A token for a private repository is read from the OS keychain at runtime and is never bundled.
