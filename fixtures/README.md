# API fixtures

These files are generated. Do not edit them by hand.

From `native/Backend`:

```
npm run fixtures
```

The script starts the app with test doubles for Firestore and Stripe, sends real requests, and writes one JSON file per case as `fixtures/<area>/<case>.json`. Each file is `{request, response}`. Tokens in request headers are `<redacted>`.

Error codes are in `error` (never `code`).
