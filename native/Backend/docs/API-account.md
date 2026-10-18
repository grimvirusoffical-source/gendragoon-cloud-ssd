# Account deletion API

In-app account deletion for GenDragoon Cloud SSD. This is the server half of Apple App Store guideline 5.1.1(v): the app must offer account deletion, and the request must actually delete the account rather than only hide it.

No Stripe secret, Firebase private key, customer payload, or user identifier belongs in this document or in source. Runtime credentials stay in Secret Manager or the process environment.

## Authentication

`DELETE /v2/account` requires a Firebase ID token (`Authorization: Bearer <Firebase ID token>`, Google provider). It uses the production login chain with Terms acceptance turned off. Deleting the account removes `accepted_terms/{uid}`, so a Terms check on this route would reject the caller before the job could be polled. `GET /v2/account/deletions/:jobId` and `POST /v2/support/deletion-request` also skip Terms. The support route does not use a Firebase ID token at all. Other `/v2` routes still require current Terms.

Checks run in this order. A later check is not used to explain an earlier failure.

1. A missing uid, or a token whose signature or claims do not verify, returns `401 {"error":"invalid_token"}`.
2. Once the token verifies, the server looks up the deletion record by `accountHash` before it consults the Firebase user record. A tombstone (`account_deletions/{accountHash}` with `status: "done"`) returns `410 {"error":"account_deleted","jobId":"<id>","statusToken":"<token>"}`. That `410` is returned even when `deleteUser` has already removed the Firebase user.
3. `401 {"error":"invalid_token"}` for a deleted, disabled, or revoked user is returned only when no deletion record exists.
4. Only a token that is still valid, for a Firebase user that still exists, with no tombstone, is checked for freshness. `auth_time` (seconds) is compared with the server clock:

| Age of `auth_time` | Result |
| --- | --- |
| 5 minutes or less | Deletion may start |
| Older than 5 minutes, missing, or not a number | `401 {"error":"reauth_required"}` and no job |

Every `401` from these routes is JSON with one of two machine-readable codes. Clients must not treat a bare `401` as proof that the account was deleted.

| `error` | Meaning |
| --- | --- |
| `reauth_required` | The token is valid, the Firebase user still exists, no deletion tombstone exists, and `auth_time` is stale or missing. Sign in again. Nothing was deleted. |
| `invalid_token` | The token is missing or rejected, or the Firebase user is already gone and there is no deletion record. |

A repeat `DELETE` after the job is `done` is `410 {"error":"account_deleted","jobId":"<id>","statusToken":"<token>"}` when the verified token belongs to that account. The Firebase user record can already be gone. The `statusToken` on that `410` is a new token for the same `jobId`. That repeat is never `reauth_required`, never `401`, and never `500`. It does not cancel billing, delete objects, or call `deleteUser` again. A stale token on an account that has not been deleted does not create a job. An upstream auth middleware that would have returned a prose `401` is rewritten to `{"error":"invalid_token"}` on these routes.

When the client sends a JSON body, it must be exactly a confirmation object:

```json
{"confirm":"DELETE"}
```

Any other JSON body returns `400 {"error":"confirm_required"}` and does not start a job. A request with no body is accepted so the mounted route can be called by a client that only presents the fresh token. The Mac and mobile clients should send the confirmation body.

## Start deletion

```http
DELETE /v2/account
Authorization: Bearer <fresh Firebase ID token>
Content-Type: application/json

{"confirm":"DELETE"}
```

```http
HTTP/1.1 202 Accepted
Cache-Control: private, no-store

{"status":"deleting","jobId":"<uuid>","statusToken":"<base64url>"}
```

`jobId` and `statusToken` are opaque non-empty strings. Clients must not check them for length or shape. `statusToken` is 32 random bytes encoded as base64url. The raw token is returned once in this response and is never written to logs or to Firestore. The job stores `statusTokens`, an array of `{hash, expiresAtMs}` where `hash` is `sha256(statusToken)`. Each `202` and each `410` appends one hash inside the job-document transaction, before the response is sent. Expired hashes are dropped. The array keeps the five newest unexpired hashes; a sixth drops the oldest. Any listed, unexpired hash polls this `jobId`. Each hash expires seven days after it was issued, on its own clock, so a newer token outlives an older one.

The service method `deleteAccount(req)` returns `{status:202, jobId, statusToken}`. The HTTP body uses `status:"deleting"` plus the same `jobId` and `statusToken`.

The job is keyed by `accountHash` (`sha256("gd-v1:"+uid)` in the running service). Repeating `DELETE` while the job is `queued` or `running` returns the same `jobId` and does not start a second runner while the lease is held.

A repeat `DELETE` with `{"confirm":"DELETE"}` on a `failed` job depends on `retryable`:

- `retryable: true` returns `202 {"status":"queued","jobId":"<same>","statusToken":"<new>"}`. The new token's hash joins `statusTokens`. The set still holds at most five hashes; a sixth drops the oldest. The job goes back to `queued`, takes a new lease, and keeps the per-step completion markers already on the job document. Finished steps are not run again. Two such retries in flight keep that one `jobId` and start one runner: the request that claims the lease schedules it, and the other only appends a token. If that other request reads the job after it is already `queued` or `running`, its `202` body uses `status:"deleting"`, the same as any repeat while the job is in progress.
- `retryable: false` returns `409 {"error":"deletion_not_retryable","jobId":"<same>"}`. No new `statusToken` is issued and the job document is left as it was.

`retryable` becomes false in two ways. The job document counts `attempts`. Each failed run adds one. A transient failure stays `retryable: true` through the fourth attempt. The fifth failed attempt sets `retryable: false`. These errors stay transient: HTTP 5xx, network errors, timeouts, and HTTP 429. The job document stores `failureReason` as `upstream_unavailable`, `network`, `timeout`, or `rate_limited`. On the fifth attempt `failureReason` stays that code and `attempts` is 5.

Some errors cannot succeed on another try, so the first failure sets `retryable: false` and `attempts` is 1:

- A GCS 403 or permission-denied while deleting this account's own `customer/{accountHash}/` or `tenants/{accountHash}/` prefix. `failureReason` is `gcs_permission_denied`.
- A Stripe `authentication_error`. `failureReason` is `stripe_authentication_error`.
- A Stripe `permission_error`. `failureReason` is `stripe_permission_error`.
- A Stripe `invalid_request_error` other than `resource_missing`. `failureReason` is `stripe_invalid_request`.

A Stripe `resource_missing` error is success. A missing subscription is already canceled, and a missing customer has nothing to cancel. It does not increment `attempts`. Any other failure stores `failureReason` `deletion_step_failed` and stays retryable until the fifth attempt.

`failureReason` and `attempts` are stored on the job document only. `GET /v2/account/deletions/:jobId` does not return them. Its body stays `jobId`, `status`, and `retryable`. A permanent failure polls as `200 {"jobId","status":"failed","retryable":false}`.

## Job status

```http
GET /v2/account/deletions/:jobId
Authorization: Bearer <Firebase ID token>
```

The same URL also accepts the job's status token:

```http
GET /v2/account/deletions/:jobId
Authorization: Bearer <statusToken>
```

```json
{"jobId":"<uuid>","status":"running","retryable":true}
```

`status` is one of `queued`, `running`, `done`, `failed`. The body stays those three fields. It does not include `statusToken`, `accountHash`, or the token hash.

A newly accepted job is stored as `queued`, with the lease already written. The runner sets `running` when it renews that lease and starts a batch. A poll that arrives before the renewal observes `queued`.

This is the only status route. `GET /v2/account/deletion/:jobId` (singular) is not registered. Every unmatched `/v2/*` path, including that singular path, returns `404 {"error":"not_found"}` as JSON. There is no HTML body and no `Deprecation` header. An unexpected failure under `/v2` returns `500 {"error":"internal"}` with no stack trace. A body larger than the `/v2` JSON limit returns `413 {"error":"payload_too_large"}`. A body that is not JSON returns `400 {"error":"invalid_json"}`.

A Firebase ID token is accepted when it verifies for the account that owns the job. Terms acceptance is not checked, so polling still works after `accepted_terms/{uid}` is deleted. The five-minute `auth_time` window is enforced on `DELETE` only. After `deleteUser`, the deleted owner's Firebase ID token still reads that owner's job with `200` until that token itself expires. The client can also poll with any unexpired `statusToken` issued for the job. A status token is compared with `sha256` of the bearer against each hash in `statusTokens`. A bad, expired, unknown, or other-job `statusToken`, and an unknown `jobId`, return `404 {"error":"not_found"}`. When a status-token poll gets that 404, the client keeps the job and shows Retry. Retry means the owner signs in and sends `DELETE /v2/account` again, which returns `410` with a new `statusToken`. `401 {"error":"invalid_token"}` is only for a bearer that looks like a Firebase ID token (a JWT) but fails verification. A missing `Authorization` header returns `401 {"error":"unauthorized"}`. Responses are `Cache-Control: private, no-store`.

`jobStatus(jobId)` on the service returns `{status}` (plus `accountHash`, `retryable`, `failure`, and `statusTokens`) or `null`. The HTTP body does not include `accountHash` or the hashes.

## Lease

The job document carries `lease: {owner, expiresAtMs}`. `owner` identifies the server instance and `expiresAtMs` is 60 seconds after the claim. The claim is written in the same transaction that appends a status-token hash or saves a checkpoint.

A runner claims the job only when the lease is absent or `expiresAtMs` is in the past. It renews the lease at the start of every batch. One batch is one Stripe subscription cancellation, or one `deletePrefix` folder. `customer/{accountHash}/` and `tenants/{accountHash}/` are separate batches. The metadata step and the Firebase step are batches too. Before the runner writes that batch's checkpoint it reads the lease again. If the lease has expired or another instance owns it, the runner stops. It does not write the checkpoint and it does not start another batch.

The next instance that handles the job resumes from the last committed checkpoint. Completed batches are not repeated. A batch that was interrupted is run again; deletes treat a missing object, subscription, or document as success.

An expired lease is reclaimed by whichever instance next handles either of these for that job:

- `DELETE /v2/account` for the owning account
- `GET /v2/account/deletions/:jobId`

Clients keep polling and do not have to send `DELETE` again. A status poll restarts a `queued` or `running` job whose lease has expired. A poll does not take a lease that is still held, and it does not retry a `failed` job; a fresh `DELETE` does that. A `done` job stays `done`.

## What the job does

Steps are idempotent and stored on the job. A failed step stops the job in `failed`. Transient failures stay `retryable: true` until `attempts` reaches 5. A GCS permission error on this account's own prefix, a Stripe `authentication_error` or `permission_error`, and a Stripe `invalid_request_error` other than `resource_missing` set `retryable: false` on that first failure. A later `DELETE` with a still-fresh Firebase ID token returns a retryable job to `queued` and resumes at the first unfinished step. Completed steps stay marked on the job and are skipped. A Stripe cancel error does not delete objects or the Firebase user. A `failed` job with `retryable: false` is `409 {"error":"deletion_not_retryable","jobId"}` and issues no token.

1. **Stripe.** List the account's subscriptions (`customer` = the stored `stripeCustomerId`, status `all`, paged) and cancel every subscription id found there or on the account's workspace records, including storage, performance, BYO workspace-fee, and any other `*SubscriptionId`. Cancellation is immediate: `invoice_now: false`, `prorate: false`. Unused time is not refunded. The customer portal's `at_period_end` setting applies to self-serve cancel, not to account deletion. No invoice and no PaymentIntent is created. Already-canceled or missing subscriptions are skipped.
2. **Managed objects.** Delete every object under `customer/{accountHash}/` and `tenants/{accountHash}/` in the configured `CUSTOMER_BUCKET`. Another account's prefix is not listed or deleted.
3. **Metadata.** Delete workspace, file, and upload documents for `gd_accounts/{accountHash}` and the legacy `tenants/{accountHash}` free project, plus `ad_purchases/{uid}`, API keys for that `accountHash`, and `project_payments` rows for that account. **BYO:** provider clients are never called. The server only drops its record of the customer-owned bucket (provider name and endpoint). It does not send a delete to S3, R2, GCS, SFTP, or any other customer endpoint.
4. **Receipt retention.** Before those rows are removed, the server writes `billing_receipts/{anonymizedId}` where `anonymizedId` is `sha256("gd-receipt-v1:"+accountHash)`. The receipt keeps the Stripe customer id, subscription ids, and payment ids required for tax and payment records. It does not keep the Firebase uid.
5. **Firebase last.** `revokeRefreshTokens(uid)`, then `deleteUser(uid)`. A missing user on resume is treated as already deleted. The finished job record is the deletion tombstone. A later `DELETE` looks up that tombstone before it treats a missing Firebase user as `invalid_token`, as described under Authentication.

## Support request

A signed-out client that still has the job's `statusToken` can ask for help when deletion has failed.

```http
POST /v2/support/deletion-request
Authorization: Bearer <statusToken>
Content-Type: application/json

{"jobId":"<id>"}
```

The body has one field, `jobId`. Any other field, including `uid`, `email`, a file, or a key, is `400 {"error":"unknown_field"}`. A missing or empty `jobId` is `400 {"error":"invalid_body"}`. The server loads the account from the job document. It does not accept an account id from the client.

The bearer must be a `statusToken` for that `jobId`. A missing `Authorization` header is `401 {"error":"unauthorized"}`. A bad token, an expired token, an unknown token, or another job's token is `404 {"error":"not_found"}`, the same as a status poll. Terms are not checked.

The job must be `failed`. `retryable` may be true or false. Any other status is `409 {"error":"support_not_needed"}`.

```json
{"status":"received","requestId":"<id>"}
```

Success is `202`. `requestId` is an opaque non-empty string and is stable for that `jobId`. A repeat returns the same `requestId`. The server writes one `supportRequests/{jobId}` document and no other support document. The document contains only `accountHash`, `uid`, `jobId`, `failureReason`, `createdAt`, and `count`. It does not contain the raw `statusToken`, an email address, a file, or a key. `failureReason` is the code already stored on the job. The status poll still does not return it.

`count` is the number of calls in the current 24 hour window, and `createdAt` is the start of that window. The first call in a window notifies an operator. Later calls in that window do not. After 24 hours the next call opens a new window, resets `count` to 1, and notifies again. Call number 6 in a window is `429 {"error":"rate_limited","retryAfterSec":<seconds>}`. `retryAfterSec` is the whole seconds left in the window. The `requestId` does not change.

Notification goes through a notifier supplied to the server. When `SUPPORT_NOTIFY_WEBHOOK_URL` is set, the default notifier POSTs this JSON and nothing else:

```json
{"jobId":"<id>","accountId":"<accountHash>","failureReason":"<code>","createdAt":"<iso>"}
```

`accountId` is the account hash from the job, not an email and not a Firebase uid. The webhook URL is read from the environment. It is not written in the repo. If the variable is unset, or the POST fails, the support document stays saved, the response is still `202`, and the server logs a warning. The warning does not include the webhook URL or the request body.

The client also shows a fallback support email from its own config. The server does not choose or return that address. Show it when this request fails, when the client has no `statusToken`, and when the person would rather write.

## Environment

Uses the existing deployment environment. No new secret is introduced.

| Variable | Role |
| --- | --- |
| `CUSTOMER_BUCKET` | Managed bucket whose account prefixes are deleted |
| `STORAGE_PROJECT_ID` | `gendragood-ssd` |
| Stripe secret and webhook | Already required for billing. Deletion only calls subscription list and cancel |
| Firebase Admin credentials | Already required. Used to revoke refresh tokens and delete the user |

Do not put key values in the repo, in logs, or in the job status response. Failure logs record the job id and a step code only.

## Module

`native/Backend/account_delete.js`

```js
const {createAccountDeletion, registerAccountDeletion} = require("./account_delete");
const svc = createAccountDeletion({db, stripe, bucket, auth, byoProviders, hash, now});
await svc.deleteAccount(req); // {status:202, jobId}
await svc.jobStatus(jobId);   // {status:"queued"|"running"|"done"|"failed"}
registerAccountDeletion({app, firebaseAuth, db, stripe, bucket, auth, byoProviders, hash, now});
```

`registerAccountDeletion` mounts `DELETE /v2/account`, `GET /v2/account/deletions/:jobId`, and `POST /v2/support/deletion-request`. The running service registers it from `installedBilling` so the same Stripe client used for Checkout performs the cancellations. `auth` is Firebase Admin Auth (`deleteUser`, `revokeRefreshTokens`). Pass `notifier` to replace the webhook sender. The default reads `SUPPORT_NOTIFY_WEBHOOK_URL` from the environment.
