# Server API fixtures

Vendored from `grimvirusoffical-source/gendragoon-cloud-ssd`. Policy fixtures are commit `0715b1a933a3ee3bb489e28a6122475403bb341d`. Account deletion and `errors/payload-too-large` are `d33970cbf0175a74898c37a8a624a92b1c1a5a94`. Storage URLs are `8267784a790bbe8418b3cbe36e8a4b91849b0e81`. Key envelopes are `ee4f76f07bc798635002ae2c272fb47d83db7698`. The client wire shape for the key envelope is `{version, kdf, salt, iv, wrappedKey}`. Workspace list items and create `project` objects carry `isFree`, `monthlyPriceCents`, `grandfathered`, and `feeWaived`. BYO register bodies may include `grandfatheringEnded`.

`account-deletion/support-unauthorized.json` is copied byte-for-byte from PR #6 at `048641275e717e00b4031cf76ccca57cc2e1dc35` (the other account-deletion files are unchanged there). `SOURCE.json` lists it under `files`. Until the sync source moves to that commit, re-add it after running the sync.

The source files live at `fixtures/<area>/<case>.json` in that repo (not under `native/Backend/fixtures`). Each file is `{ request, response: { status, body } }`. Error codes are in `error`. There is no `code` field.

Areas: `workspace-lock`, `workspaces`, `merge`, `byo`, `ownership`, `account-deletion`, `errors`, `storage-urls`, and `key-envelope`. Each area is copied from the commit recorded in `SOURCE.json`.

Do not edit the JSON by hand. Re-sync from the backend repo:

```
pnpm --filter @gendragoon/core sync-fixtures
```

Pass a commit to pin a different revision:

```
pnpm --filter @gendragoon/core sync-fixtures -- 0715b1a933a3ee3bb489e28a6122475403bb341d
```
