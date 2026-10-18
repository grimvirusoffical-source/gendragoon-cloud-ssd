# Mobile

iOS and Android share one React Native or Expo app in this directory. It is not scaffolded yet.

Use `@gendragoon/core` types and load `packages/core/data/sort-map.json` as the default type map. Do not fork the category table. Render ownership, cap, lapse, and the login lock from the API. The server enforces them. See `docs/API.md` and `docs/ARCHITECTURE.md`.

BYO credentials stay in the platform keychain. The ownership proof is the same as on Windows: write `.gendragoon-challenge/<nonce>`, then send a short-lived presigned GET created on the device. SFTP, Azure, and WebDAV are coming soon.
