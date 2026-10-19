# GenDragoon apps

Shared client monorepo for GenDragoon Cloud SSD. The Mac app stays the SwiftUI client in [gendragoon-cloud-ssd](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd) (`native/`, tag `v0.18.0-rc.2`, commit `4cb71b5`). This repo holds the TypeScript core every other client reuses, the Windows Electron app, and Red-XAI Updater.

No secrets, credentials, or user data belong here.

## Layout

| Path | What it is |
| --- | --- |
| `packages/core` | API client, policy, sort map, merge, BYO. |
| `packages/ui` | Dark-purple React screens shared by the Windows client. |
| `packages/updater` | App-agnostic GitHub release updater. |
| `apps/desktop` | Windows Electron client and NSIS installer. Mac target is off. |
| `apps/red-xai-updater` | Mac menu-bar updater. Not bundled into the Windows installer. |
| `apps/mobile` | Placeholder for the shared iOS/Android app. |
| `apps/extension` | Placeholder for Chrome, Edge, Opera, and Firefox. |
| `services/api` | Notes for Riley's backend changes. |
| `docs/API.md` | Live routes plus additions. |
| `docs/ARCHITECTURE.md` | Who enforces what, and how Swift loads the sort map. |

## Scripts

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @gendragoon/desktop dist:win
```

The Windows installer is built on `windows-latest` and uploaded as the `gendragoon-cloud-ssd-windows-nsis` artifact. Signing is optional and reads certificate environment variables. See `docs/SIGNING.md`.
