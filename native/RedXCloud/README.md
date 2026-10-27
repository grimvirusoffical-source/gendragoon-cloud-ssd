# GenDragoon Red-XAI Receiver and subscriptions

The native app and REDXAI Auth-CLI share Red-XAI website approval through
macOS Keychain. The Receiver stores encrypted PNG objects on the main server,
with account and MachineNote metadata in a dedicated RedX database. The server
never receives the client storage secret or decrypts private file contents.

## MachineNote policy

- One MachineNote per account has its MachineNote fee waived indefinitely. It
  still requires a storage subscription and a performance selection.
- Additional MachineNotes cost $5/month each, plus their storage and performance.
- Free performance grants one worker. Lite, Boost, Turbo, Ultra and Max grant
  2, 4, 8, 12 and 20 workers respectively.
- Storage/performance can bill monthly or yearly. Additional MachineNotes use
  two Checkouts: the plans subscription, then the monthly MachineNote subscription.
  Both must be current before storage and workers are granted. Stripe Checkout
  cannot create mixed-interval subscriptions; see
  [Stripe documentation](https://docs.stripe.com/billing/subscriptions/mixed-interval?dashboard-or-api=api).
- The verified support@infected-nation.com account receives lifetime owner
  access without Checkout. Every owner MachineNote starts at 6 TB and Max.
- Deleting the fee-waived MachineNote transfers the waiver to the oldest
  remaining MachineNote. Deleting all MachineNotes allows a new fee-waived one.
- Default capacity is 10 MachineNote slots, or 20 when the same active MachineNote
  has at least 2 TB and Turbo. Owner accounts have 20 slots.

The control service verifies receipt customer, account/MachineNote metadata,
exact price IDs, quantities, amounts and subscription state. Startup verifies
all 31 paid live catalog prices. Reconciliation runs on authenticated requests;
canceled or unpaid plans stop granting writes and paid workers.

## Storage, transfers and deletion

The native worker handles files, folders and app bundles using encrypted
64 KiB plaintext chunks rendered with the pinned Red-SecretsXAI visual barcode
API, encrypted bounded manifest pages and verified restoration. The library
repository and pinned revision remain unchanged. Old compact PNG carriers
remain readable. Transfers
use a bounded worker pool with the allowance fetched from the authenticated
Receiver. Faster tiers increase concurrency; network, CPU, data-saver settings
and available disk space still determine actual throughput.

Visual barcode images use substantially more bytes than the original archive.
Quota accounting charges the actual stored PNG bytes. Image encoding and
decoding are bounded separately from parallel HTTP transfers.

The Receiver enforces per-MachineNote byte quotas and concurrent transfer limits
for scalable blobs and legacy small objects. Each PNG carrier is limited to
8 MiB; larger files are split by the client. Managed applications run locally
from the cache after restoration.

The app requires the exact MachineNote name before deletion. The control service
cancels subscriptions, expires open Checkouts and sends a timestamped HMAC proof
to the loopback Receiver. Direct customer Receiver deletion cannot bypass
billing. A durable journal and MachineNote tombstone permit retries after partial
failure and prevent stale entitlements from recreating deleted data.

Quota values are logical allowances, not disk provisioning. Operations must
monitor free server capacity and expand storage before selling more capacity
than the server can hold.

## MachineNotes access

`GET /v1/receivers/me/machine-notes` lists only the authenticated account's
notes, including pending plans. `GET /v1/receivers/admin/machine-notes` lists
metadata across accounts and requires a fresh verified owner email for every
request. It queries only the dedicated Receiver database and accepts bounded
`limit` (1–20 accounts) and numeric keyset `cursor` parameters. The response
contains note names, quotas, usage, cached entitlement-check timestamps and
up to 50 library item metadata records per note. It excludes encryption
secrets, Stripe customers and encrypted file payloads. It does not grant
cross-account archive download or decryption.

Control routes use `/v2/machinenotes`, with the previous `/v2/projects` routes
and JSON fields retained as compatibility aliases. Existing note IDs, crypto
associated data, storage paths and billing metadata are unchanged.

## Services and configuration

The main host runs gendragoon-control.service on 127.0.0.1:17778 and
gendragoon-receiver.service on 127.0.0.1:17779. External clients use
https://api.red-xai.com/gendragoon/ for billing and the existing Receiver routes
on https://api.red-xai.com. Deployment paths are:

- /usr/local/lib/gendragoon-control/current
- /usr/local/lib/gendragoon-receiver/current
- /srv/red-xai/gendragoon-receivers

Keep the shared REDX_RECEIVERS_KEY in service configuration. It authenticates
RedX access and internal deletion proofs. Production startup requires
REDXAI_RECEIVER_PRODUCTION_READY=1, REDXAI_AUTH_PROVIDER=redx-site-session and
REDX_ENTITLEMENT_URL pointing to the Receiver-entitlement endpoint. No secrets
belong in source, CLI arguments, logs or app resources.

Deploy immutable release directories and preserve previous current targets for
rollback. Restart the Receiver before the control service when upgrading the
signed deletion protocol. Graceful shutdown drains requests and removes the
single-writer lock; never remove an active writer lock. Verify health,
authenticated owner entitlements and an isolated transfer/deletion round trip.

## Verification

Fast tests use temporary account state and fake billing without customer charges:

    node --test native/RedXCloud/test/control-server.test.cjs native/RedXCloud/test/workspace-lifecycle.test.cjs native/RedXCloud/test/control-receiver.integration.test.cjs native/RedXCloud/test/machine-notes.test.cjs
    python3 -B -m unittest discover -s native/Tests -p 'test_redx_*.py'

Real integration tests require local redxd, redxai-accounts, librsx and a Python
environment with Pillow under REDX_INTEGRATION_ROOT/tools:

    REDX_INTEGRATION_ROOT=/absolute/path/to/integration node --test native/RedXCloud/test/roundtrip.test.cjs native/RedXCloud/test/blob-library.test.cjs

The site-session-receiver suite additionally requires the sibling
red-xai-accounts and red-xai-installers source repositories.

Fixtures bind IPv4 loopback and use temporary accounts/files. They must never
use the production account database. Native CI also runs isolated billing and
Receiver tests and compiles all Swift sources. Compilation, local installation,
Developer ID signing and notarization are separate verification gates.
