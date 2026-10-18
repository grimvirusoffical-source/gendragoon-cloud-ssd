# API fixtures

These files are generated. Do not edit them by hand.

From `native/Backend`:

```
npm run fixtures
```

The script starts the app with test doubles for Firestore, Stripe, and Firebase, sends real requests, and writes one JSON file per case as `fixtures/<area>/<case>.json`. Each file is `{request, response}`. Tokens in request headers and response bodies are `<redacted>`.

Error codes are in `error` (never `code`).
