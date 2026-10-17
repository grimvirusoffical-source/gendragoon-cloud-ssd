# Plan selection integration

`PlanSelectionSection.swift` is source for a macOS 14+ native Account/billing
view. It has **not** been added to the absent native Swift project, compiled,
signed, published or installed. This Linux checkout has no Swift/AppKit SDK.

Add the source to the actual native target. The existing billing model must
adapt its authenticated server responses into `ServerPlanOffer` values and
validate the complete response with `ServerPlanCatalog(offers:)`. Category,
tier ID, name, integer price cents, currency, month/year interval, availability
and unavailable reason come from the server. Duplicate offers and malformed
prices/identifiers are rejected. The adapter must reject a response whose
account or workspace no longer matches the current session.

Create one `PlanSelectionModel` with a stable, nonsecret UserDefaults key scoped
to the authenticated account and billing workspace. Hold it in the containing
view/model across catalog refreshes. Recreate that scoped model when the account
or workspace changes; never reuse one account's model for another account.
Pass the model, the current `ServerPlanCatalog`, and an async checkout closure
to `PlanSelectionSection`. Key the containing view's identity to that account
and workspace as well. The component cancels pending checkout on disappearance
or replacement of its selection model and ignores a cancelled task's returned
URL. The adapter must also verify its captured account/workspace after the
network response before returning. Clear authoritative offers or set them unavailable
while refreshing after an authentication/workspace change or service failure.
Do not leave a previous account's purchasable offers visible during that change.

Every tier card can be selected, including an unavailable plan. Selection and
the billing interval persist immediately. No initial first-plan selection occurs.
Refresh and monthly/yearly changes preserve chosen tier IDs. If an explicit
choice disappears, the UI retains it and explains why purchasing is disabled;
it never silently substitutes another tier. The selected card has a checkmark
and a **Selected** label. Each category's Buy button uses that category's
selected offer and is enabled only for a current server-available offer.

Use the existing Firebase authentication/billing adapter inside the injected
checkout closure. Obtain a fresh Firebase ID token through that adapter, invoke
the existing authenticated server checkout endpoint, and return its URL. No
owner/service key belongs in the UI, UserDefaults, logs or client source. The
request contains only the chosen category, tier ID and interval; the server must
authorize tenant/workspace ownership and resolve its own Stripe Price ID and
amount. A client-supplied amount or availability flag must never authorize a
purchase. The component opens only an HTTPS `checkout.stripe.com` hosted payment
URL returned by the closure. Selection alone never creates a payment.

Do not grant an entitlement when the browser opens or a redirect returns. The
server must verify Stripe webhook signatures, deduplicate/reconcile events and
apply subscription state, cancellation and payment failures. Refresh the real
billing model after returning from checkout or foregrounding the app.

## What is available now

`commercial/pricing.json` remains `proposed-prelaunch` and is the source for
`commercial/catalog.js`. Catalog prices and nested plans are immutable.
Storage/performance/workspace quotes remain unavailable until actual service
provisioning and checkout are ready. The storage manifest says its subscription
includes the workspace fee; storage-only quotes do not add another $5.

The existing documented GPU triple bundle separately sums standard storage +
$5 workspace + performance + GPU, applies a single 10% discount rounded upward
to whole cents, and bills ten discounted months for annual payment. This
preserves the documented 1 TB/Boost/Spark example: $68.40 monthly or $684 yearly.
There is no extra storage/performance discount or second annual discount.
The catalog deliberately exposes the undiscounted `STORAGE[id].standard` and
`PERFORMANCE[id].cents` fields required by that calculator. Product/billing
owners must reconcile any future change to the workspace-fee contract on the
server before publishing prices.

`GPU_READY` remains false. GPU workers, metering, quotas and billing entitlement
infrastructure have not been established. A storage/performance purchase does
not supply GPU capacity. Do not publish GPU Stripe products or label the plans
buyable until those requirements in `commercial/cloud-gpu-plans.md` pass.
The previously observed API response was HTTP 503, `API key verification
unavailable`; the owner credential's validity and server checkout readiness have
not been established. This component does not repair that backend or turn the
proposal catalog into a payment service.

## Validation

Run `node --test commercial/catalog.test.js` for actual catalog/GPU quotation
behavior. The suite covers all current tier combinations, exact monthly/annual
totals, no discount stacking, cent rounding that preserves the price floor,
immutable prices, invalid/prototype tier names, and unavailable/provisioning
gates. It does not establish Stripe integration or native UI readiness.

Before release, compile the actual macOS target with its pinned Xcode version.
Test card selection, restart persistence, separate account/workspace scopes,
catalog reorder/removal/replacement, both intervals, and unavailable offers.
Check concurrent checkout protection, backend failure, malicious checkout URLs,
browser failure, authentication expiry and account/workspace changes during an
in-flight checkout. In Stripe test mode, validate successful and failed payment,
cancelled checkout, duplicated/replayed/out-of-order webhooks, cancellation,
refunds, and server-side entitlement reconciliation. None of those native or
server end-to-end checks have been run here.
