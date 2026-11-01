# Current MachineNotes account deletion

This is the current RedX Receiver and Control flow, independent of the legacy
Firebase deletion implementation. It never deletes an external Red-XAI identity,
other programs' accounts, BYO database bytes, or local originals. Deployment and
an actual in-app control are separate release prerequisites.

## Authenticated client contract

Use the current GenDragoon `rxca_` site-session bearer with the Control base URL.
Each request verifies the current external identity through userinfo. The
userinfo contract does not supply a recent-authentication timestamp; this flow
does not claim to enforce a fresh-password or recent-login interval.

```http
POST /v2/account/deletion
Authorization: Bearer <current-session>
Content-Type: application/json

{"confirmation":"DELETE GENDRAGOON","idempotencyKey":"<32 lowercase hex>"}
```

`DELETE /v2/account` is an alias with the same body. No caller-supplied owner,
receiver, email, or subject is accepted. The JSON body is limited to 4096 bytes
and parsed before the account lock. Origin-bearing browser API requests are
rejected; the public HTML instructions have no account mutation form.

Pending requests return HTTP 202. Repeating the same key returns the same opaque
32-hex receipt ID; a different key for an existing request returns HTTP 409
`idempotency_conflict`. An already completed same-key request returns HTTP 200.
The key is hashed in the durable record and never echoed in a response.

```http
GET /v2/account/deletion
Authorization: Bearer <current-session>
```

GET always uses HTTP 200 for a successfully authenticated status lookup, with
`{"schema":1,"deletion":null}` if there is no request. It never ensures or
recreates a Receiver/Control account. A fresh valid session for the same external
issuer and subject can poll after account deletion. An unavailable or inactive
external identity still fails authentication.

A receipt has this shape:

```json
{
  "schema": 1,
  "deletion": {
    "id": "<stable opaque32hex>",
    "status": "queued",
    "phase": "billing",
    "requestedAt": "<ISO8601 UTC>",
    "updatedAt": "<ISO8601 UTC>",
    "retryable": false,
    "counts": {"workspacesRemoved": 0, "metadataRemoved": 0},
    "cloudDataDeleted": false,
    "externalIdentityDeleted": false,
    "externalBYODataDeleted": false,
    "localOriginalsDeleted": false
  }
}
```

Status is `queued`, `running`, `failed`, or `completed`. Phase is `billing`,
`workspaces`, `metadata`, `storage`, or `complete`. `completedAt` is present only
after completion. All public timestamps are ISO8601 UTC strings. A failed receipt
has `retryable:true` and the allowlisted error `account_deletion_retry_required`
or `billing_review_required`. Counts record confirmed cleanup operations; an
interruption after physical deletion and before its checkpoint can undercount
metadata removals without preventing verification of final absence.

Only `completed` with `cloudDataDeleted:true` confirms active-service cleanup.
Clients must bind a pending idempotency key and received receipt ID to their
current issuer/subject/account, then validate that binding on every response.
Never clear local secrets or originals on HTTP acceptance, null status, a changed
receipt ID, a failed request, Disconnect, or an arbitrary account switch. Clear
only the client's intended private account/session/staging after a matching
verified completion. Reauthentication for a saved pending deletion must verify
the same identity without calling Receiver PUT/ensure, which tombstones deny.

## Durable execution and concurrency

Control first obtains a signed, loopback-only Receiver account barrier. An
observable active account request/upload/workspace mutation causes HTTP 409
`account_deletion_busy` before billing or the deletion tombstone changes. Native
clients must additionally guard their own active transfers, launch sessions and
mounts: offline mounts and clients are not server-observable and are never
force-stopped by this flow.

The barrier blocks new service access, key issuance, public grant redemption,
and account recreation. Public pairing bodies are parsed before acquiring an
owner-scoped operation lease. A stalled anonymous pairing request cannot block
other accounts' deletion; a verified active pairing mutation prevents deletion
only for its bound owner until it finishes.

The worker performs these resumable stages:

1. Verify ledger-referenced Stripe customer/owner/project bindings, close open
   Checkout sessions, recover subscriptions from a concurrent Checkout
   completion, and verify cancellation or terminal expiry. Cancellation requests
   explicitly disable final invoicing and prorations. Missing provider proof
   fails closed; this is not a scan of every Stripe customer or a refund flow.
2. Reuse signed durable per-workspace deletion, which bypasses the normal
   entitlement callback to avoid Control to Receiver to Control lock recursion.
3. Remove associated integration owner records, key pointers, and grants from
   the scoped GenDragoon database. Close owned Teams under their actual mutation
   lock before dependent scans. Index removed peer IDs temporarily, remove the
   account's memberships, username claims, profile, messages, presence and
   signals, then remove the temporary markers. Owned Team roots become anonymous
   closed records; peers' own independent messages/accounts/other Teams remain.
4. Verify metadata absence, remove and fsync the account's confined Receiver
   directory including unindexed owned payloads, and verify that directory is
   absent. Storage symlinks are refused. Finalize the minimal tombstone only
   after all checks succeed.

Cleanup scans use exact row CAS and bounded pages: 50 collaboration records or
2 integration records plus one lookahead. Smaller integration pages respect the
existing metadata response bound for the larger per-account ledgers. Each worker
turn handles at most 100 pages and then durably yields as `queued`. Status polling
or a same-key retry resumes it. The worker has no persisted bearer or refresh
credential; a service restart needs a newly authenticated request to resume. A
metadata or provider failure leaves a durable incomplete receipt, not a fake
success. No completion time is promised.

## Public resource and retention

Control serves unauthenticated script-free HTML at `/account-deletion`, including
the deployed `/gendragoon/account-deletion` prefix, and privacy at `/privacy` and
`/privacy.html`. The deletion page prominently offers a support email request
path without reinstalling the app. Ownership must be verified before fulfilling
a support request. An email link is not an automatic completed deletion receipt.

Completed service state retains only the account's pseudonymous owner/id,
revision/quota bookkeeping, and the receipt's ID, idempotency hash, timestamps,
status and counts. This tombstone currently has no automatic expiry, preventing
old credentials and late checkout results from silently recreating the account.
It contains no file names, payloads, session credentials, usernames, keymaps,
integration secrets, BYO connection metadata, or billing customer pointers.

Stripe historical financial records, external identity/BYO services, recipient
copies, and operator-managed independent backups/logs are outside the verified
active-service deletion receipt. The public pages disclose those limits; no
backup erasure schedule, refund, extra deletion fee, or completion SLA is invented.
An operator restoring an independent backup must preserve deletion tombstones.

The backend fixtures use only disposable HTTP services, generated files,
synthetic identity and billing responses, and a bounded CAS database fixture.
They make no production account, subscription, or data mutations.
