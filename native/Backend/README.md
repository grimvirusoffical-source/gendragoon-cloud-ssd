# GenDragoon Cloud SSD backend

`npm start` runs `free_server.js`, the native and mobile service entry point. The separate historical `server.js` remains for backward-compatibility tests; it is not deployed by `deploy_free.py`.

## Identity, storage, and owner access

Firebase Google authentication and Terms acceptance are verified on the server. The authentication project is `gendragoonssd`; storage and backend resources belong to the separate `gendragood-ssd` project. Do not substitute one project ID for the other.

The `CUSTOMER_BUCKET` environment variable identifies the private multi-tenant customer bucket. The owner's personal `gen-dragoon-ssd` bucket is deliberately rejected as a customer storage target. The runtime identity receives narrowly scoped access to its customer bucket and metadata database. Individual customers receive logical workspaces, not provider credentials.

Owner complimentary storage, performance, BYO, and ad-free access are resolved from the verified Google identity and the server's `system/owner-benefits-v1` policy. Client labels, request-body `ownerBenefits`, and claimed email addresses never confer owner access. The existing `gdsk_` keys support only `files:read` and/or `files:write` for an owned workspace. They do not authorize billing, administrator operations, IAM changes, or credential retrieval.

## Billing contract

The established live catalog contains 55 price keys: monthly and annual workspace fees; ten standard and ten bundled storage plans in both intervals; five independent performance tiers in both intervals; monthly/annual BYO; and one-time ad removal. `billing_bootstrap.js` verifies the configured Stripe account, active products, exact USD prices, intervals, webhook destination, and runtime storage before enabling Checkout. The bundled tier's worker entitlement follows storage capacity; independent performance subscriptions can be added to managed storage or an active BYO workspace.

Native and mobile clients use the existing versioned endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /v2/billing/status` | Availability, Stripe environment, webhook and storage readiness |
| `GET /v2/pricing` | Server-owned display prices, fee breakdown, capacities, and worker limits |
| `GET /v2/workspaces` | Current account's workspaces and server-verified owner benefits |
| `POST /v2/workspaces/draft` | Create a selected storage/BYO draft; optional UUIDv4 `intentId` safely deduplicates retries |
| `POST /v2/workspaces/:id/checkout/storage` | Checkout for the exact tier, interval, and standard/bundle selection stored on that draft |
| `POST /v2/workspaces/:id/manual-provider` | Register local BYO connection verification without transmitting provider credentials |
| `POST /v2/workspaces/:id/checkout/byo` | Checkout for the configured BYO workspace |
| `POST /v2/workspaces/:id/checkout/performance` | Exact selected performance tier/interval for an eligible workspace |
| `POST /v2/remove-ads/checkout` | One-time ad removal for the authenticated account |
| `GET /v2/account/entitlements` | Verified owner and ad-free access |
| `POST /billing/customer-portal` | Customer-owned Stripe billing management |
| `POST /billing/stripe-webhook` | Raw-body signature-verified fulfillment and subscription reconciliation |

Storage totals include the existing workspace fee. Do not infer prices from the historical `commercial/pricing.json` proposal or from native UI constants. Live readiness is reported by the service, not by the `checkoutEnabled` field in the archived catalog snapshot.

Repeated draft requests carrying the same intent ID and exact selection return the same workspace. Reusing an intent with a different plan fails with HTTP 409. Changing a performance selection expires only the account's previous unpaid open checkout; the new session then uses the newly selected price. Completed payments must reconcile before another plan can be chosen. Checkout URLs and success redirects do not themselves grant access.

Webhook processing retrieves current Stripe objects, verifies ownership, exact price IDs and quantities, and reconciles storage provisioning and performance limits. Permanent ad removal additionally checks successful payment and refund/dispute state. API and webhook credentials remain in Secret Manager or runtime environment configuration, never in the native app, mobile assets, repository, or log output. Existing live Stripe API compatibility is pinned to `2025-06-30.basil`; upgrading that boundary and webhook version is a separate migration requiring regression validation.

Stripe Tax requires actual active registrations before enabling `automatic_tax`; this release does not silently enable tax or claim registration coverage. See [Stripe recurring tax setup](https://docs.stripe.com/billing/taxes/collect-taxes) and [webhook fulfillment](https://docs.stripe.com/checkout/fulfillment).

## Transfers

The service retains v1 free-workspace and v2 paid-workspace routes for existing clients. Version 3 transfers add account-scoped manifests, resumable chunks, verified range downloads, quota reservation, and entitlement-controlled concurrency. A free workspace contains 2,000,000,000 bytes and one transfer worker. Performance tiers grant actual concurrency limits enforced by the transfer governor; they do not guarantee internet bandwidth or disk speed.

## Configuration and deployment

Required runtime settings:

- `CUSTOMER_BUCKET`: the separate private customer storage bucket.
- `STORAGE_PROJECT_ID`: `gendragood-ssd`.
- `STRIPE_VAULT_BOOTSTRAP=live`: enables the existing account-specific Secret Manager bootstrap when configured.

The live bootstrap uses the existing `gendragoon-stripe-live-api` and `gendragoon-stripe-live-webhook` secret resources. Direct test configuration supports `STRIPE_ENVIRONMENT`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_CATALOG_JSON`, `PUBLIC_URL`, and `STRIPE_CHECKOUT_ENABLED`. Production also requires `PAID_STORAGE_READY=approved`; runtime probing uses `STRIPE_RUNTIME_PROBE=true`. Never place values of API/webhook secrets in checked-in environment files. Prefer a restricted API key with the minimum verified server permissions.

`deploy_free.py` now builds from the directory containing the script, not a Downloads path or stale `deploy-free` snapshot. Its allowlist contains runtime modules, the exact lockfile, and current mobile assets. It excludes local storage configuration, tests, dependencies, and credentials. Existing Cloud Run environment variables, service identity, scaling settings, and Secret Manager bindings are retained unless explicitly overridden.

```sh
python3 native/Backend/deploy_free.py --dry-run
python3 native/Backend/deploy_free.py --project gendragood-ssd --region us-central1 --service gendragoon-free
```

The deployment command uses the active Google application-default account through a temporary file readable only by the current user. No credential value is printed. Use `--customer-bucket` or `--service-account` only when intentionally configuring or changing those service properties. Keep real `customer-storage.json` outside version control; `customer-storage.example.json` documents its purpose without a production customer bucket name.

## Validation

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
