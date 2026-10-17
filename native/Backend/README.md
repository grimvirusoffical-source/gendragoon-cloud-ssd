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

### Review a candidate before promoting production traffic

Use a new, unique tag for each review. These commands stage the current checkout without changing production traffic; the helper refuses a tag that already exists, and `--tag` requires `--no-traffic`.

```sh
python3 native/Backend/deploy_free.py --no-traffic --tag review-0170-20261017a --dry-run
python3 native/Backend/deploy_free.py --project gendragood-ssd --region us-central1 --service gendragoon-free --no-traffic --tag review-0170-20261017a
```

Before promotion, use the existing delegated Google application-default credentials to read the service's `status.traffic` and the tagged revision's `status.conditions`. Verify that the tag resolves to the intended new revision, that `Ready` is true, and that the sum of production traffic percentages for that revision is zero. Use the tag URL returned by Cloud Run; do not construct its hostname. Record the currently serving revision and percentage for rollback. Promote a reviewed revision by its exact revision name, not a mutable `latest` alias.

`GET /health?deep=1`, `GET /v3/capabilities`, and `GET /v2/pricing` are read-only HTTP smoke checks against the tag URL. The existing service's health endpoints are public; do not send an ADC access token to the application URL. ADC authenticates the Cloud Run control-plane reads. The deploy helper neither grants public invocation nor changes the service's IAM policy.

Run the bounded candidate verifier after staging:

```sh
python3 native/Backend/verify_candidate.py --project gendragood-ssd --region us-central1 --service gendragoon-free --tag review-0170-20261017a --report /tmp/GenDragoon-Candidate-Verification-v0.17.0.json
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
