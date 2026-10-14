# GenDragoon Cloud GPU & Triple Bundles — prelaunch specification

**Status: PREVIEW. Do not sell yet.** This feature is not backed by GPU workers or a scheduler, and customers have **zero GPU entitlement** regardless of previous storage/performance purchases.

## Proposed plans

| Name | Monthly | Annual | GPU minutes per month | Maximum session |
|---|---:|---:|---:|---:|
| Spark | $29 | $290 | 120 | 30 minutes |
| Volt | $79 | $790 | 360 | 60 minutes |
| Storm | $189 | $1,890 | 900 | 120 minutes |
| Titan | $369 | $3,690 | 1,800 | 240 minutes |

Prices are provisional; do not create live Stripe prices until hardware and cloud operation costs are validated against the required target margin. Annual purchases grant **monthly refreshing credits**, not 12 months of credits at once. No credits roll over. These entitlements represent **GPU-accelerated remote workloads**, not remote execution of arbitrary iOS/Android/macOS/Windows apps, which would require a separate container/VM streaming infrastructure and OS licensing.

## Triple bundle

Storage workspace management ($5) + standard managed storage + one performance tier + one Cloud GPU tier, discounted **10%** on the combined monthly total. Annual = 10 × discounted monthly payment. Do not stack triple-bundle discount with the existing storage/performance bundle to avoid double discounting.

Example: 1 TB standard storage ($36) + $5 workspace + Boost performance ($6) + Spark GPU ($29) = $76 monthly before discount, **$68.40 monthly** or **$684 yearly**. Provisional only.

## Operational hard requirements (must ship before Stripe GPU checkout)

- Provision real isolated GPU runtime per signed-in tenant, behind an authenticated scheduling API; define supported compute types and hardware.
- Exact provider billing estimates, GPU models, regions, image/driver, boot latency and cap on idle resources.
- Meter GPU allocation in integer milliseconds, server-authoritative, with transactional usage ledger, session cap, concurrent session limit and quota expiration.
- Terminate sessions on entitlement cancellation, quota exhaustion, payment failure, abuse or lease expiry; reconcile with provider job states even on crashes.
- No direct credentials to tenants. Jobs/outputs stored per tenant with strict IAM, encryption and retention controls.
- Decide whether jobs are inference/video rendering/transcoding only or remote workstation streaming, and price accordingly.
- Verify successful jobs, cancellation, replayed webhooks, refunds, concurrency, quota abuse, cold starts, memory limits, provider failures and billing correctness in Stripe test mode.
- Separate transfer-worker upgrades from GPU job performance. Existing transfer workers do **not** create GPU capacity.
- The GPU billing endpoint currently returns HTTP 503 intentionally. No GPU checkout/entitlement granting is enabled.

## Current implementation

In Mac backend sources: `gpu_catalog.js` and `gpu_catalog.test.js` plus additions to `billing_v2.js`. Purchase safety gate is `GPU_READY=false`. Quote and checkout routes are declared in the local paid billing module and will not become live until the complete paid billing backend is deployed.

Do not put cloud-provider credentials or Stripe secrets in this public repository.
