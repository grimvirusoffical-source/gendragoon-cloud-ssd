# API fixtures

These files are generated. Do not edit them by hand.

From `native/Backend`:

```
npm run fixtures
```

The script starts the app with test doubles for Firestore and Stripe, sends real requests, and writes one JSON file per case as `fixtures/<area>/<case>.json`. Each file is `{request, response}`. Tokens in request headers are `<redacted>`.

Error codes are in `error` (never `code`).

Request bodies use only the fields listed for that route under Request fields in `native/Backend/docs/API-workspace-policy.md`. `byo/verify-missing-url` sends an empty body. Every other `byo/verify-*` request sends `{presignedUrl}`.

Workspace list items and create responses include `isFree`, `monthlyPriceCents`, `grandfathered`, and `feeWaived`. `feeWaived` is always boolean: `true` only for an owner benefit, `false` on every other priced response. `monthlyPriceCents` is `0` exactly when `isFree` or `grandfathered` or `feeWaived` is true, and `500` otherwise. A grandfathered one-time workspace does not take the free slot (`workspaces/grandfathered-plus-new.json`). Registering BYO on a grandfathered workspace ends grandfathering (`workspaces/byo-register-ends-grandfathered.json`). An owner benefit that is not the free slot is `workspaces/owner-fee-waived.json`. An unpaid BYO workspace is in grace for 3 days and then locks only itself.
