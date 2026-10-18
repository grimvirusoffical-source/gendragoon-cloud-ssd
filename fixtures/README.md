# API fixtures

These files are generated. Do not edit them by hand.

From `native/Backend`:

```
npm run fixtures
```

The script starts the app with test doubles for Firestore, Stripe, and Firebase, sends real requests, and writes one JSON file per case as `fixtures/<area>/<case>.json`. Each file is `{request, response}`. Tokens in request headers and response bodies are `<redacted>`.

Error codes are in `error` (never `code`).

Workspace, lock, merge, ownership, and BYO request bodies use only the fields listed for that route under Request fields in `native/Backend/docs/API-workspace-policy.md`. `byo/verify-missing-url` sends an empty body. Every other `byo/verify-*` request sends `{presignedUrl}`.
