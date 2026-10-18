# API fixtures

These files are generated. Do not edit them by hand.

From `native/Backend`:

```
npm run fixtures
```

The script starts the app with test doubles for Firestore and Stripe, sends real requests, and writes one JSON file per case as `fixtures/<area>/<case>.json`. Each file is `{request, response}`. Tokens in request headers are `<redacted>`.

Error codes are in `error` (never `code`).

Request bodies use only the fields listed for that route under Request fields in `native/Backend/docs/API-workspace-policy.md`. `byo/verify-missing-url` sends an empty body. Every other `byo/verify-*` request sends `{presignedUrl}`.

Workspace list items and create responses include `isFree` and `monthlyPriceCents` (`0` or `500`).
