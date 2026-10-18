# Account deletion API

In-app account deletion for GenDragoon Cloud SSD. This is the server half of Apple App Store guideline 5.1.1(v): the app must offer account deletion, and the request must actually delete the account rather than only hide it.

No Stripe secret, Firebase private key, customer payload, or user identifier belongs in this document or in source. Runtime credentials stay in Secret Manager or the process environment.

## Authentication

`DELETE /v2/account` uses the same Firebase ID token middleware as the rest of `/v2` (`Authorization: Bearer <Firebase ID token>`, Google provider, current Terms acceptance).

The token must be fresh. `auth_time` (seconds) is compared with the server clock:

| Age of `auth_time` | Result |
| --- | --- |
| 5 minutes or less | Deletion may start |
| Older than 5 minutes, missing, or not a number | `401 {"error":"reauth_required"}` and no job |

A stale token does not create a job and does not cancel billing, delete objects, or touch Firebase.

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
Cache-Control: no-store

{"status":"deleting","jobId":"<uuid>"}
```

The service method `deleteAccount(req)` returns `{status:202, jobId}`. The HTTP body uses `status:"deleting"` plus the same `jobId`.

The job is keyed by `accountHash` (`sha256("gd-v1:"+uid)` in the running service). Repeating `DELETE` while the job is `queued`, `running`, or `failed` returns the same `jobId` and resumes incomplete steps. It does not start a second cancellation pass.

## Job status

```http
GET /v2/account/deletion/:jobId
```

```json
{"jobId":"<uuid>","status":"running","retryable":true}
```

`status` is one of `queued`, `running`, `done`, `failed`.

`GET` is authorized by the unguessable job id, not by the Firebase user. The user record is removed at the end of a successful job, so the client must be able to observe `done` after the ID token stops working. Treat `jobId` as a secret. Responses are `Cache-Control: private, no-store`. Unknown ids return `404 {"error":"not_found"}`.

`jobStatus(jobId)` on the service returns `{status}` (plus `retryable` and `failure` when set) or `null`.

## What the job does

Steps are idempotent and stored on the job. A failed step stops the job in `failed` with `retryable: true`. A later `DELETE` with a still-fresh token resumes at the first unfinished step. A Stripe cancel error does not delete objects or the Firebase user.

1. **Stripe.** List the account's subscriptions (`customer` = the stored `stripeCustomerId`, status `all`, paged) and cancel every subscription id found there or on the account's workspace records, including storage, performance, BYO workspace-fee, and any other `*SubscriptionId`. Cancellation is immediate: `invoice_now: false`, `prorate: false`. Unused time is not refunded. The customer portal's `at_period_end` setting applies to self-serve cancel, not to account deletion. No invoice and no PaymentIntent is created. Already-canceled or missing subscriptions are skipped.
2. **Managed objects.** Delete every object under `customer/{accountHash}/` and `tenants/{accountHash}/` in the configured `CUSTOMER_BUCKET`. Another account's prefix is not listed or deleted.
3. **Metadata.** Delete workspace, file, and upload documents for `gd_accounts/{accountHash}` and the legacy `tenants/{accountHash}` free project, plus `ad_purchases/{uid}`, API keys for that `accountHash`, and `project_payments` rows for that account. **BYO:** provider clients are never called. The server only drops its record of the customer-owned bucket (provider name and endpoint). It does not send a delete to S3, R2, GCS, SFTP, or any other customer endpoint.
4. **Receipt retention.** Before those rows are removed, the server writes `billing_receipts/{anonymizedId}` where `anonymizedId` is `sha256("gd-receipt-v1:"+accountHash)`. The receipt keeps the Stripe customer id, subscription ids, and payment ids required for tax and payment records. It does not keep the Firebase uid.
5. **Firebase last.** `revokeRefreshTokens(uid)`, then `deleteUser(uid)`. A missing user on resume is treated as already deleted. After `done`, another `DELETE` returns `401` (`reauth_required`) and does not cancel subscriptions again or call `deleteUser` again.

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

`registerAccountDeletion` mounts `DELETE /v2/account` and `GET /v2/account/deletion/:jobId`. The running service registers it from `installedBilling` so the same Stripe client used for Checkout performs the cancellations. `auth` is Firebase Admin Auth (`deleteUser`, `revokeRefreshTokens`).
