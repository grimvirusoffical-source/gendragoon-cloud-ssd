# GenDragoon Commercial Service — Development branch

**Status: PRE-PRODUCTION; not a live service, paid release, or customer-ready update.** The existing native Mac v0.5 app and personal GCS bucket remain unchanged. Nothing in this branch authorizes opening that bucket to customers.

Target architecture: Google sign-in in Chrome using Firebase Authentication, verified Firebase UID on Cloud Run; Stripe Checkout and signed webhooks for monthly/yearly plans; per-user object prefixes in a NEW private customer Cloud Storage bucket with short-lived signed access; server-validated quotas and transfer accounting. Owner-only admin operations must require an allowlisted immutable Firebase UID, not a user-entered email, and admin actions must be logged. Customer data must remain private absent narrowly disclosed abuse review processes.

`pricing.json` is **proposed**. Account for egress, operations, API calls, tax, processing fees, refunds, support, reserve capacity, and abuse before allowing live subscriptions. No unrestricted downloads are promised. Network-speed tiers require actual enforceable gateway bandwidth shaping; client UI labels aren't access control.

**Blocking tasks:** authorize Stripe; configure Firebase Google identity provider and Cloud Run; create isolated customer bucket and IAM; Cloud Scheduler cleanup and Stripe event reconciliation; payment/upgrade/cancel tests; secure desktop device code pairing; sign/notarize Mac and Windows builds; full cross-tenant authorization testing; legal/privacy and support policies.

Do not enable auto-deletion of local application originals without a verified complete cloud backup, successful restoration test, explicit consent and recoverable Trash/Recycle Bin path. Apps may not run directly from cloud mounts, so support local cache fallback and reserve at least 10 GiB of free SSD space.
