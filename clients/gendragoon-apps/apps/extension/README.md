# GenDragoon browser extension

One MV3 codebase that builds for Chrome, Edge, Opera and Firefox.

## What it does

- Shows whether the GenDragoon Cloud SSD service is reachable.
- Previews which folder a file name will be sorted into (shared sort map from `packages/core`).
- Dark theme by default, with Light and System options that are remembered. Settings live on a full options page.

## Permissions

| Permission | Why |
| --- | --- |
| none (`permissions: []`) | The extension does not use tabs, history, cookies, storage APIs or page access. |
| host: the service API origin | One health-check request so the popup can show Online/Offline. |

The Firefox manifest declares `data_collection_permissions: { required: ["none"] }`. The theme choice is kept in the popup's own local storage.

## Build

```sh
pnpm install
pnpm --filter @gendragoon/extension build      # dist/<browser>/
pnpm --filter @gendragoon/extension package    # dist-zips/GenDragoon-Extension-<browser>-<version>.zip
pnpm --filter @gendragoon/extension lint:firefox
pnpm --filter @gendragoon/extension test
pnpm --filter @gendragoon/extension test:load  # headless Chromium load test (needs CHROME_PATH)
```

Set `GENDRAGOON_API_BASE` at build time to point at a different service. Set the real support and privacy URLs in `src/config.ts` before publishing.

## Layout

- `scripts/manifests.mjs`: per-browser manifests.
- `src/_locales/en`: name and description strings.
- `src/popup.*`, `src/options.*`: UI. `icons/`: PNGs from 16 to 512 px.
