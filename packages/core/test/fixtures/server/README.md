# Server API fixtures

Vendored from `grimvirusoffical-source/gendragoon-cloud-ssd`, branch `fix/backend-workspace-policy`, commit `4dfde4b7e8d3e7860f2200898dff4ac8670657b6`.

The source files live at `fixtures/<area>/<case>.json` in that repo (not under `native/Backend/fixtures`). Each file is `{ request, response: { status, body } }`. Error codes are in `error`. There is no `code` field.

Areas in this export: `workspace-lock`, `workspaces`, `merge`, `byo`, `ownership`.

Account deletion, storage-urls, and key-envelope are not in this export. Those tests keep the real response shapes from Morgan's `test/deletion-contract` and Casey's `test/real-server-probe` until PR #6 and PR #7 publish fixtures.

Do not edit the JSON by hand. Re-sync from the backend repo:

```
pnpm --filter @gendragoon/core sync-fixtures
```

Pass a commit to pin a different revision:

```
pnpm --filter @gendragoon/core sync-fixtures -- 4dfde4b7e8d3e7860f2200898dff4ac8670657b6
```
