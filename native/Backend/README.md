# GenDragoon Cloud SSD backend

`npm start` runs `free_server.js`, the native and mobile service entry point. The separate historical `server.js` remains for backward-compatibility tests; it is not deployed by `deploy_free.py`.

## Identity, storage, and owner access

Firebase Google authentication and Terms acceptance are verified on the server. The authentication project is `gendragoonssd`; storage and backend resources belong to the separate `gendragood-ssd` project. Do not substitute one project ID for the other.

The `CUSTOMER_BUCKET` environment variable identifies the private multi-tenant customer bucket. The owner's personal `gen-dragoon-ssd` bucket is deliberately rejected as a customer storage target. The runtime identity receives narrowly scoped access to its customer bucket and metadata database. Individual customers receive logical workspaces, not provider credentials.

Owner complimentary storage, performance, BYO, and ad-free access are resolved from the verified Google identity and the server's `system/owner-benefits-v1` policy. Client labels, request-body `ownerBenefits`, and claimed email addresses never confer owner access. The existing `gdsk_` keys support only `files:read` and/or `files:write` for an owned workspace. They do not authorize billing, administrator operations, IAM changes, or credential retrieval.

## Billing contract

The established live catalog contains 55 legacy price keys: monthly and annual workspace fees; ten standard and ten bundled storage plans in both intervals; five independent performance tiers in both intervals; monthly/annual BYO; and one-time ad removal. The workspace-fee, BYO-fee and one-time $5 project activation prices are retired for new charges and only reconcile in-flight legacy records; workspace plans need no new price. `billing_bootstrap.js` verifies the configured Stripe account, active products, exact USD prices, intervals, webhook destination, and runtime storage before enabling Checkout. Missing new-project pricing does not invalidate existing subscriptions; additional paid project creation remains disabled until its own price and event coverage are ready.

The workspace fee is included in the storage plans; there is no separate fee. The first hosted workspace is free (2 GB storage + the free performance plan, one worker). Every additional workspace must buy a storage plan **and** a performance plan, billed together on one subscription (`kind: workspace_plans`, billing version 3) using the existing `storage|standard|<tier>|<interval>` and `performance|<tier>|<interval>` prices. A custom-storage workspace (own S3/VPS/cloud) skips the storage plan but still needs a paid performance plan. The server enforces this (`PLANS_REQUIRED`, `PERFORMANCE_PLAN_REQUIRED`); see `docs/API-workspace-policy.md`. Active plus payment-pending projects count against a transaction-enforced10-project limit. The limit becomes20 when the same active, provisioned project has **at least2TB storage and Turbo performance (8 workers)**, or an equivalent2TB-or-larger bundle. This is the sixth of the ten storage capacities and the third of the five independent performance tiers. Intentions saved by a client never qualify an account; only verified entitlements do. A downgrade retains existing projects and data but blocks new reservations or restores above the applicable cap. If a paid activation settles after capacity is reduced, its payment is retained and access waits in `payment_confirmed_pending_capacity` until a slot is available; it is not charged a second time.

Native and mobile clients use the existing versioned endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /v2/billing/status` | Availability, Stripe environment, webhook and storage readiness |
| `GET /v2/pricing` | Server-owned display prices, fee breakdown, capacities, and worker limits |
| `GET /v2/projects?includeArchived=true` | Owned active, pending and archived projects, verified entitlements, intended selections and current account policy |
| `POST /v2/projects` | `{name,intentId}`; reserves one project atomically and returns its free/owner activation or one-time Checkout URL |
| `POST /v2/projects/:id/checkout` | Resume or start the reserved project's one-time activation Checkout |
| `PUT /v2/projects/:id/selection` | Persist validated intended storage/performance tier, mode and interval without granting entitlement |
| `POST /v2/projects/:id/archive` | Exact `{confirmName}` plus `acknowledgeBillingContinues:true` when applicable; preserves cloud data |
| `POST /v2/projects/:id/restore` | Restore the same retained project with a fresh cap check and no new-project fee |
| `GET /v2/workspaces` | Current account's workspaces and server-verified owner benefits |
| `POST /v2/workspaces/draft` | Compatibility adapter into the same project policy; optional UUIDv4 `intentId` deduplicates retries |
| `POST /v2/workspaces/:id/checkout/storage` | `{tier,interval,mode}` applies the chosen subscription to this existing project |
| `POST /v2/workspaces/:id/manual-provider` | Register local BYO connection verification without transmitting provider credentials |
| `POST /v2/workspaces/:id/checkout/byo` | Checkout for the configured BYO workspace |
| `POST /v2/workspaces/:id/checkout/performance` | Exact selected performance tier/interval for an eligible workspace |
| `POST /v2/remove-ads/checkout` | One-time ad removal for the authenticated account |
| `GET /v2/account/entitlements` | Verified owner and ad-free access |
| `POST /billing/customer-portal` | Customer-owned Stripe billing management |
| `POST /billing/stripe-webhook` | Raw-body signature-verified fulfillment and subscription reconciliation |

New version2 storage subscriptions contain only their storage or bundle Price. Existing subscriptions retain their original recurring workspace-fee item and billing interval. The one-time activation is a separate payment and is never represented by the old recurring $5 Price. Do not infer prices from the historical `commercial/pricing.json` proposal or from native UI constants. Live readiness is reported by the service, not by the `checkoutEnabled` field in an archived catalog snapshot.

Repeated creation requests carrying the same intent ID and exact selection return the same project. Reusing an intent for a different creation selection fails with HTTP409. Changing an unpaid open storage/performance selection expires only the owned previous Checkout; the new session uses the selected exact Price. Completed payments must reconcile before another plan can be chosen. An existing active subscription is not duplicated by the purchase button; the current billing portal supports review and cancellation. Customer tier-change acceptance/configuration for an existing active subscription remains a separate billing-management gate. Checkout URLs and success redirects do not grant access.

Archiving is the application's safe removal operation. It removes the logical project from the active list and denies transfers, while preserving its records, objects, Google Cloud project and bucket. Exact-name confirmation is required. Reserved bytes, active/assembling uploads, a Checkout preparation lease, or an unsettled payment block archiving. Existing subscriptions continue; the user must acknowledge that fact and use Manage Billing to cancel if desired. Restoring the same project never consumes a new free allowance or charges the project fee again. No endpoint in this lifecycle deletes a GCP project or bulk-deletes its cloud data.

The historical free project's identifier is `free` and its records remain under `tenants/{accountHash}/workspaces/free`. New projects have UUIDs under `gd_accounts/{accountHash}/workspaces/{UUID}` and use `kind:paid` even at basic2GB. Both can receive verified upgrades. New `projectStatus:active` plus `projectFeeStatus:free|paid|owner` and `provisioned:true` grant the basic quota. Archived, pending and revoked states grant no storage access. Storage and performance entitlements are persisted separately from `intendedSelection`; the native picker also saves drafts per account, project and purchase section.

Webhook processing retrieves current Stripe objects, verifies ownership, exact price IDs and quantities, and reconciles storage provisioning and performance limits. One-time project activation additionally verifies `payment_status:paid`, the stored Checkout binding, exact USD500-cent payment, current charge/refund/dispute state, and an idempotent payment ledger in the same account-cap transaction. Asynchronous success and failure are handled, and a refund/dispute arriving before completion cannot be undone by a later paid-event replay. Permanent ad removal retains its separate499-cent contract.

The runtime pins Stripe Node23.0.0 and API `2026-09-30.endive`, verified on2026-10-17 from the [official versioning page](https://docs.stripe.com/api/versioning) and [Stripe Node releases](https://github.com/stripe/stripe-node/releases). Both normal and Secret Manager bootstrap constructors use the same pin. Checkout uses dynamic payment methods and omits the parameter removed in Endive. Signed snapshot webhooks from the previous Basil version are re-fetched before reconciliation; local tests cover that compatibility. Source changes do not change the live account's default version or webhook destination/version. A sandbox payment and delivery regression against the new API remains required before payment acceptance can be claimed. API and webhook credentials stay in Secret Manager or runtime configuration, never in clients, source or log output.

Stripe Tax requires actual active registrations before enabling `automatic_tax`; this release does not silently enable tax or claim registration coverage. See [Stripe recurring tax setup](https://docs.stripe.com/billing/taxes/collect-taxes) and [webhook fulfillment](https://docs.stripe.com/checkout/fulfillment).

### Archiving retired Prices and adding team Prices (live bootstrap)

The live bootstrap lists **all** Prices, including archived ones. The retired keys (`workspace|month`, `workspace|year`, `byo|month`, `byo|year`, `one_time|project_creation`) may be archived in Stripe. The bootstrap still resolves their IDs (exactly one per key; an active Price wins) so legacy subscriptions and payments keep reconciling, and an archived project Price never sets `STRIPE_PROJECT_CHECKOUT_READY=true`. Every other key must stay active. Team tier Prices (`team|<tier>|<interval>`, metadata `service:GenDragoonSSD`, lookup key `gdssd_team_<tier>_<interval>_v1`) are optional: they join `STRIPE_PRICE_CATALOG_JSON` automatically once they exist and are exact, and teams stay unpurchasable until then. With `STRIPE_VAULT_BOOTSTRAP=live` the catalog is built from Stripe on activation, so no Price IDs are set by hand. `scripts/stripe_prices_to_create.js --dry-run --live` / `--apply --live --confirm-live` creates the 19 approved Prices idempotently by lookup key.

## Transfers

The service retains v1 free-workspace and v2 paid-workspace routes for existing clients. Version 3 transfers add account-scoped manifests, resumable chunks, verified range downloads, quota reservation, and entitlement-controlled concurrency. A free workspace contains 2,000,000,000 bytes and one transfer worker. Performance tiers grant actual concurrency limits enforced by the transfer governor; they do not guarantee internet bandwidth or disk speed.

## Configuration and deployment

Required runtime settings:

- `CUSTOMER_BUCKET`: the separate private customer storage bucket.
- `STORAGE_PROJECT_ID`: `gendragood-ssd`.
- `STRIPE_VAULT_BOOTSTRAP=live`: enables the existing account-specific Secret Manager bootstrap when configured.

The live bootstrap uses the existing `gendragoon-stripe-live-api` and `gendragoon-stripe-live-webhook` secret resources. Direct test configuration supports `STRIPE_ENVIRONMENT`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_CATALOG_JSON`, `PUBLIC_URL`, and `STRIPE_CHECKOUT_ENABLED`. Production also requires `PAID_STORAGE_READY=approved`; runtime probing uses `STRIPE_RUNTIME_PROBE=true`. Never place values of API/webhook secrets in checked-in environment files. Prefer a restricted API key with the minimum verified server permissions.

### One-time project payment setup and rollout

1. Use an isolated Stripe sandbox with a separate test database/bucket for real payment, asynchronous outcome, refund, replay and cap/downgrade acceptance. The local suites use deterministic fixtures and do not submit a real payment. A working live key or owner complimentary access does not substitute for this sandbox test.
2. On the intended account, configure a distinct Price with `currency:usd`, `unit_amount:500`, `billing_scheme:per_unit`, active product, and **no recurring interval**. Identify it with `STRIPE_PROJECT_CREATION_PRICE_ID`, or metadata `service:GenDragoonSSD`, `catalogKey:one_time|project_creation` and lookup key `gdssd_one_time_project_creation_v2`. The existing recurring workspace Price must stay unchanged. No project Price is created automatically by this source.
3. Retain existing webhook subscriptions and include `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `charge.refunded`, and `charge.dispute.created`. The handler also accepts `checkout.session.expired`. The live bootstrap checks this event coverage and derives `STRIPE_PROJECT_CHECKOUT_READY`; direct sandbox/runtime configuration requires `STRIPE_PROJECT_CHECKOUT_READY=true` only after the Price and signed webhook delivery are verified.
4. Deploy the current source as a unique no-traffic candidate using the staging commands below. Perform the read-only verifier first. Do not open project Checkout on the tagged candidate: existing live webhooks still target the serving revision, which may not understand project activation yet.
5. A controlled candidate `GET /v2/billing/status` can then validate the existing vault bindings and account configuration. It is stateful: the existing bootstrap can create/update readiness records and create/expire unpaid validation Checkout sessions. Inspect readiness and `projectCreationEnabled`; no candidate Checkout or card submission is necessary for that configuration check.
6. Record the serving revision and its source mapping before promotion. Verify that the canonical webhook reaches the reviewed handler before enabling customer project payments. Do not split traffic across pre-v0.18 and v0.18 policy implementations. Remove obsolete public revision tags on promotion: a tagged revision remains directly callable at zero production traffic. Keep its revision/image as evidence, not as an active alternate API. If signed sandbox delivery acceptance is unavailable, record that limitation explicitly; unpaid template validation is not paid purchase acceptance.

An unmodified pre-v0.18 revision is not a safe rollback after v2 project records or payments exist. Its webhook can ignore and mark project payment events processed, revoke new one-item storage contracts, ignore archive state, and bypass new project limits. After adoption, recovery must preserve the new billing-version, project-state, event-ledger and transfer-authorization semantics through a compatibility-aware correction. Existing legacy drafts can still resume with their exact old selection; unsupported old-client project creation is rejected before any new project or payment is created.

Tax collection remains a separate merchant configuration. Do not enable `automatic_tax` without appropriate active registrations; this source keeps the catalog's exact amounts and does not silently add tax settings.

`deploy_free.py` now builds from the directory containing the script, not a Downloads path or stale `deploy-free` snapshot. Its allowlist contains runtime modules, the exact lockfile, and current mobile assets. It excludes local storage configuration, tests, dependencies, and credentials. Existing Cloud Run environment variables, service identity, scaling settings, and Secret Manager bindings are retained unless explicitly overridden.

```sh
python3 native/Backend/deploy_free.py --dry-run
python3 native/Backend/deploy_free.py --project gendragood-ssd --region us-central1 --service gendragoon-free
```

The deployment command uses the active Google application-default account through a temporary file readable only by the current user. No credential value is printed. Use `--customer-bucket` or `--service-account` only when intentionally configuring or changing those service properties. Keep real `customer-storage.json` outside version control; `customer-storage.example.json` documents its purpose without a production customer bucket name.

`SUPPORT_DISCORD_WEBHOOK_URL` is loaded from Secret Manager in production and is never written in this repo. `free_server.js` exits before it listens if that variable is missing or is not an `https://discord.com/api/webhooks/` URL when `NODE_ENV=production`. Whenever Cloud Run sets `K_SERVICE`, that gate stays on even if `NODE_ENV` is `development`, `dev`, or `test`. `deploy_free.py` sets `NODE_ENV=production` on every Cloud Run deploy. The error names the variable and does not print the value, so Cloud Run keeps serving the previous revision. `npm run predeploy:check` is an optional extra that confirms the secret exists (`gcloud secrets versions describe`) without printing it. It is not the promotion gate.

## Validation

### Release blocker

Deploy the Firestore indexes before this revision takes production traffic: run `firebase deploy --only firestore:indexes` from the repo root (it reads `firebase.json` and `firestore.indexes.json`) and wait until every index is Enabled. Without them the support sweep queries fail and the server logs `support_sweep_query_failed`. This is a release blocker.

Do not send this revision production traffic until Cloud Scheduler calls `POST /internal/support-notifications/sweep` every minute with `Authorization: Bearer <SUPPORT_SWEEP_TOKEN>`. The token is at least 16 characters and is not stored in this repo. The once-a-minute timer inside the process is not a substitute: Cloud Run can scale the instance away. This is a release blocker, not an optional follow-up.

### Release checklist

- `NODE_ENV=production` is set on the Cloud Run service. `deploy_free.py` writes it. `K_SERVICE` arms the Discord webhook gate on every Cloud Run instance. `NODE_ENV=development`, `dev`, or `test` does not turn that gate off. A missing or invalid `SUPPORT_DISCORD_WEBHOOK_URL` then exits before listen and names the variable without printing the value.
- The Firestore indexes used by the support sweep exist: `supportRequests` `notify.state` + `notify.nextAttemptAt`, `supportRequests` `notify.state` + `notify.staleDueAt`, `deletion_jobs.namesExpireAt`, and `supportRequests.expireAt`. A TTL policy may watch `supportRequests.expireAt`. Do not attach one to `deletion_jobs`.

### Review a candidate before promoting production traffic

Use a new, unique tag for each review. These commands stage the current checkout without changing production traffic; the helper refuses a tag that already exists, and `--tag` requires `--no-traffic`.

```sh
python3 native/Backend/deploy_free.py --no-traffic --tag review-0180-20261017a --dry-run
python3 native/Backend/deploy_free.py --project gendragood-ssd --region us-central1 --service gendragoon-free --no-traffic --tag review-0180-20261017a
```

Before promotion, use the existing delegated Google application-default credentials to read the service's `status.traffic` and the tagged revision's `status.conditions`. Verify that the tag resolves to the intended new revision, that `Ready` is true, and that the sum of production traffic percentages for that revision is zero. Use the tag URL returned by Cloud Run; do not construct its hostname. Record the currently serving revision and percentage as the pre-adoption baseline. Promote the reviewed revision by its exact revision name and retire incompatible public tags. Apply the compatibility boundary above to any later recovery.

`GET /health?deep=1`, `GET /v3/capabilities`, and `GET /v2/pricing` are read-only HTTP smoke checks against the tag URL. The existing service's health endpoints are public; do not send an ADC access token to the application URL. ADC authenticates the Cloud Run control-plane reads. The deploy helper neither grants public invocation nor changes the service's IAM policy.

Run the bounded candidate verifier after staging:

```sh
python3 native/Backend/verify_candidate.py --project gendragood-ssd --region us-central1 --service gendragoon-free --tag review-0180-20261017a --report /tmp/GenDragoon-Candidate-Verification-v0.18.0.json
```

The verifier obtains the tag URL and revisions from the Cloud Run v2 API using the existing application-default credentials. It refuses non-HTTPS or non-`.run.app` targets and redirects, requires a Ready candidate with zero production traffic, and compares literal environment settings, secret bindings, container count, and service identity with every currently serving revision. Configuration values stay in memory; the JSON report contains comparison booleans only. Certificate and hostname checks remain enabled. On macOS, `/etc/ssl/cert.pem` supplies the trusted CA bundle when present; `--ca-file` can select another trusted bundle.

The application requests carry no bearer token. After the three smoke checks, five protected GET routes must reject anonymous access with HTTP 401 or 403. A separate process then sends at most 256 requests with 16 workers across `/health`, `/v3/capabilities`, and `/v2/pricing`. Defaults are a five-second request timeout, a 45-second load deadline, and a 180-second overall deadline, with at most two seconds to terminate the load process. The report gives attempted/completed/success counts, HTTP/error counts, and p50/p95 latency over completed attempts, including failures. A final control-plane read confirms that the same tagged revision still receives zero production traffic. Exit code 0 means all required checks passed; exit code 2 means a check failed or did not complete. These limits are a bounded regression check, not sustained saturation testing or a penetration test.

Load diagnostics also separate each public path and record response-header, body-read, and JSON-decode timing. Header timing includes DNS, connection setup, TLS, and waiting for response headers; it is not a measurement of backend handler time alone. The transport opens a fresh HTTPS connection for every request and performs no retries. Up to 32 failed-request samples include the request index, start offset, body byte counts, and failure phase. HTTP 200 headers received after the total request budget still count as a timeout; `request_deadline_before_body` distinguishes that case from a timeout during `response_body`. Do not change timeouts or concurrency merely to turn a failed report into a passing one.

No-traffic staging provides **traffic isolation, not data isolation**. The tagged candidate retains the existing database, bucket, runtime identity, and live secrets. `GET /v2/billing/status` deliberately triggers the existing live bootstrap and is therefore a controlled activation check, not a strictly read-only check: it can create a missing portal configuration, create/expire unpaid validation Checkout sessions when catalog verification changes, and write/delete readiness markers. Existing Stripe webhooks and Checkout return URLs remain bound to the canonical service URL until promotion, so a tagged Checkout test alone does not verify delivery to the candidate's webhook handler.

Run the deployment-helper and verifier tests locally; they mock external process and HTTP calls and never authenticate, deploy, or contact the candidate:

```sh
cd native/Backend
python3 -m unittest -v test_deploy_free.py test_verify_candidate.py
```

### Runtime tests

```sh
cd native/Backend
npm ci --ignore-scripts
npm run check
npm test
npm run test:stress
npm audit --omit=dev
```

Tests use local HTTP servers and mocked storage/Stripe objects. They cover tenant isolation, authentication, invalid API-key scopes, checksum corruption, quota races, resumable transfers, exact selected Checkout prices, duplicate intent requests, lifecycle events, signatures, owner-bypass rejection, and concurrency limits under simulated latency. They do not constitute a real-card purchase, production load test, physical-device test, or independent penetration test.

The lockfile overrides the transitive `uuid` dependency to the patched CommonJS-compatible 11.1.1 line, resolving the identified buffer-bounds advisory without forcing an unrelated Firebase major-version migration.
