# Server API fixtures

Vendored from `grimvirusoffical-source/gendragoon-cloud-ssd`. Policy fixtures are commit `da3927627fee76103981714f9f8ffa954843b74b`. Account deletion and `errors/payload-too-large` are `fff0a84b6d75acb3a79cff7f146450c486efbe56`. Storage URLs are `8267784a790bbe8418b3cbe36e8a4b91849b0e81`. Key envelopes are `ee4f76f07bc798635002ae2c272fb47d83db7698`. The client wire shape for the key envelope is `{version, kdf, salt, iv, wrappedKey}`.

The source files live at `fixtures/<area>/<case>.json` in that repo (not under `native/Backend/fixtures`). Each file is `{ request, response: { status, body } }`. Error codes are in `error`. There is no `code` field.

Areas: `workspace-lock`, `workspaces`, `merge`, `byo`, `ownership`, `account-deletion`, `errors`, `storage-urls`, and `key-envelope`. Each area is copied from the commit recorded in `SOURCE.json`.

Do not edit the JSON by hand. Re-sync from the backend repo:

```
pnpm --filter @gendragoon/core sync-fixtures
```

Pass a commit to pin a different revision:

```
pnpm --filter @gendragoon/core sync-fixtures -- da3927627fee76103981714f9f8ffa954843b74b
```
