# API service

Riley's service is the existing Express app at `gendragoon-cloud-ssd/native/Backend` on `codex/native-integration-20261017` (tag `v0.18.0-rc.2`, commit `4cb71b5`). `free_server.js` is the deployed entry. This monorepo does not reimplement it.

`docs/API.md` lists the live routes the client already calls and the additions this client is waiting on:

- Billing, cap, and lapse stay on the server. The client renders `paidThroughMs`, `renewsAtMs`, `lifetime`, and HTTP 423. It does not model `feeIsOneTime`.
- Login lock (readable and downloadable, uploads blocked) when the server says the account is locked.
- `POST /v2/workspaces/merge` and lock-resolution delete.
- BYO challenge/proof for S3-compatible buckets only, including Google Cloud Storage via S3 HMAC keys. The client writes `.gendragoon-challenge/<nonce>` and sends a device-signed presigned GET. Store only provider type, endpoint, and bucket fingerprint. SFTP, Azure, and WebDAV return 422 `byo_provider_unsupported`.
- Foreign workspace lookups return 404, including the case that is 403 `PROJECT_FORBIDDEN` today.
- Workspace routes are `/v2/workspaces/...`, including `POST /v2/workspaces/:id/storage-urls` (15-minute prefix-scoped links; locked accounts are download-only).
- Writes while the server reports a lock return HTTP 423 `{ "code": "workspace_lock" }`. Reads and deletes still succeed.
- `DELETE /v2/account` sends `{ "confirm": "DELETE" }`. The 5-minute check uses the ID token `auth_time` (401 `reauth_required` sends the user to sign in again; 401 `invalid_token` signs out). Neither 401 wipes local keys. A 202 is `{ "jobId" }`. A repeat delete may return 410 `account_deleted` with a `jobId`; the client polls that job and does not wipe on the 410. `GET /v2/account/deletions/:jobId` is polled until `done` or `failed`. BYO buckets stay. Local keys are wiped only after `done`.
- `GET`/`PUT /v2/workspaces/:id/key-envelope` stores the wrapped workspace key. The passphrase and the raw key stay on the device.

Do not put Stripe keys, Firebase private keys, or bucket credentials in this repo.
