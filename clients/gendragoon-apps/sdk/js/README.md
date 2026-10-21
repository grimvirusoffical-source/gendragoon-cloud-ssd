# GenDragoon SDK for JavaScript and TypeScript

Runs on Node 20+, browsers, Deno and Bun (WebCrypto and `fetch`). Folder sync and the loopback listener for the
PKCE handshake are in `@gendragoon/sdk/node`.

```ts
import { Client, Connector, Drive, Keyring } from "@gendragoon/sdk";

const conn = await new Connector(base).redeemGrant(code, { name: "My Game" });   // once; store conn.apiKey
const c = new Client(base, conn.apiKey);
const keys = new Keyring(c);
await keys.unlock(passphrase);                         // keys.create(passphrase) the first time
const d = await Drive.open(c, "saves", keys);
await d.writeFile("slots/slot1.sav", data);
const back = await d.readFile("slots/slot1.sav");
```

## API

| Area | Calls |
|---|---|
| Connect | `Connector.redeemGrant`, `exchangeCode`, `newPKCE`, `pkceChallenge`, `connectLink`, `Loopback` (node) |
| Provider | `Client`: `capabilities`, `health`, `usage`, `putBlob`, `putSealedBlob`, `getBlob`, `headBlob`, `deleteBlob`, `listBlobs`, `allBlobs`, `hasBlobs`, `getManifest`, `putManifest`, `deleteManifest`, `listManifests`, `allManifests`, `getKeyEnvelope`, `rotateApiKey`, `wipe` |
| Keys | `Keyring`: `unlock`, `create`, `changePassphrase`, `importMasterKey`, `exportMasterKey`, `lock`; `wrapMasterKey`, `unwrapMasterKey` |
| Files and folders | `Drive.open`, `list`, `stat`, `writeFile`, `readFile`, `mkdir`, `move`, `delete`, `deleteSlot`, `deleteFolder`, `snapshot`; `cleanPath`, `slotPath`, `collectGarbage` |
| Sync (node) | `pushFolder`, `pullFolder`, `mirrorFolder` |
| Sharing | `Identity`, `exportShare`, `openShareEnvelope`, `openShare`, `createReadKey`, `listReadKeys`, `revokeReadKey` |
| Events | `watch` (async iterator, polling) |
| Account | `AccountClient`: `createGrant`, `authorize`, `listBindings`, `revokeBinding`, `revokeAndDelete`; `parseConnectLink` |
| Teams | `TeamsClient`: `catalog`, `list`, `create`, `get`, `checkout`, `createInvite`, `revokeInvite`, `previewInvite`, `join`, `updateMe`, `leave`, `workspaces`, `createWorkspace`, `checkoutWorkspace`, `share`, `unshare`, `messages`, `watchChat`, `post`, `postCard`, `report`, `deleteMessage`, `mute`, `unmute`, `kick`, `ban`, `setRole`, `audit`, `transfer`, `delete`; `verifyAuditChain` |
| Levels | `OPERATIONS`, `levelGate`, `parseLevel`, `LevelError`, `Options.gate` |

Folder sync never writes outside the local folder: pull refuses drive paths that are not valid drive paths
and any target whose path goes through a symbolic link or a non-folder in the local folder, and push skips
symbolic links.

Errors: `APIError` (`status`, `code`, `retryAfterSeconds`, and `notFound`, `preconditionFailed`, `quotaExceeded`,
`unauthorized`, `rateLimited`), `LevelError`, `ChecksumError`. argon2id is not in WebCrypto: to open argon2id
envelopes, register an implementation with `setArgon2id(fn)`.

## Tests

```sh
npm test                                                          # unit tests and vectors
GD_DEV_SERVER=<provider_dev_server.js> npm test                   # + contract C01-C14
GD_TEAMS_SERVER=../contract/teams_dev_server.cjs GD_TEAMS_BACKEND=<cloud-ssd>/native/Backend npm test
```
