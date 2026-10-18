# API service

Riley's service is the existing Express app at `gendragoon-cloud-ssd/native/Backend` on `codex/native-integration-20261017` (tag `v0.18.0-rc.2`, commit `4cb71b5`). `free_server.js` is the deployed entry. This monorepo does not reimplement it.

`docs/API.md` lists the live routes the client already calls and the additions this client is waiting on:

- Recurring $5/month workspace fee, with `FREE_WORKSPACES` (default 1, 0 allowed).
- `feeIsOneTime=true` grandfathering that never lapses.
- Lapse at Stripe `current_period_end` plus 3 days.
- Cap 10, or 20 under the existing 2 TB + Turbo rule, rechecked on login and plan change.
- Login lock (readable and downloadable, uploads blocked) for over-cap or unpaid accounts.
- `POST /v2/workspaces/merge` and lock-resolution delete.
- BYO challenge/proof. Store only provider type, endpoint, and bucket fingerprint.
- Foreign workspace lookups return 404, including the case that is 403 `PROJECT_FORBIDDEN` today.

Do not put Stripe keys, Firebase private keys, or bucket credentials in this repo.
