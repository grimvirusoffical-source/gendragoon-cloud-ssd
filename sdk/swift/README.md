# GenDragoon SDK for Swift

Swift 5.9+ on Apple platforms and Linux. Depends on [swift-crypto](https://github.com/apple/swift-crypto) 3.x.

```swift
.package(path: "sdk/swift")      // or the repository URL; product "Gendragoon"
```

```swift
import Gendragoon

let conn = try await Connector(base: base).redeemGrant(code, client: ClientInfo(name: "My Game"))  // once; store conn.apiKey
let c = try Client(base: base, apiKey: conn.apiKey)
let keys = Keyring(c)
try await keys.unlock(passphrase)                 // keys.create(passphrase) the first time
let d = try Drive(c, name: "saves", keys: keys)
_ = try await d.writeFile("slots/slot1.sav", data)
let back = try await d.readFile("slots/slot1.sav")
```

## API

| Area | Calls |
|---|---|
| Connect | `Connector.redeemGrant`, `exchangeCode`, `PKCE.create`, `Connector.connectLink`, `Loopback.wait` |
| Provider | `Client`: `capabilities`, `health`, `usage`, `putBlob`, `putSealedBlob`, `getBlob`, `deleteBlob`, `listBlobs`, `allBlobs`, `hasBlobs`, `getManifest`, `putManifest`, `deleteManifest`, `listManifests`, `allManifests`, `getKeyEnvelope`, `rotateApiKey`, `wipe` |
| Keys | `Keyring`: `unlock`, `create`, `changePassphrase`, `importMasterKey`, `exportMasterKey`, `lockKey` |
| Files and folders | `Drive`: `list`, `stat`, `writeFile`, `readFile`, `mkdir`, `move`, `delete`, `deleteFolder`, `snapshot`; `Drive.cleanPath`, `collectGarbage` |
| Sync | `Sync.push`, `Sync.pull`, `Sync.mirror` |
| Sharing | `Identity.create`, `Sharing.export`, `Sharing.openEnvelope`, `Sharing.open`, `Sharing.createReadKey`, `Sharing.listReadKeys`, `Sharing.revokeReadKey` |
| Events | `Events.watch` (`AsyncStream`, polling) |
| Account | `AccountClient`: `createGrant`, `parseConnectLink`, `authorize`, `listBindings`, `revokeBinding`, `revokeAndDelete` |
| Teams | `TeamsClient`: `catalog`, `list`, `create`, `get`, `checkout`, `createInvite`, `revokeInvite`, `previewInvite`, `join`, `updateMe`, `leave`, `workspaces`, `createWorkspace`, `checkoutWorkspace`, `share`, `unshare`, `messages`, `watchChat`, `post`, `postCard`, `report`, `deleteMessage`, `mute`, `unmute`, `kick`, `ban`, `setRole`, `audit`, `transfer`, `delete`; `TeamsClient.verifyAuditChain` |
| Levels | `Operation`, `Gating.levelGate`, `Level`, `LevelError`, `ClientOptions(gate:)` |

Errors: `APIError` (`status`, `code`, `retryAfter`, and `notFound`, `preconditionFailed`, `quotaExceeded`,
`unauthorized`), `LevelError`, `GendragoonError` (`checksum`, `corrupt`, `wrongPassphrase`, `locked`,
`invalid`, `unsupported`). argon2id envelopes are reported as unsupported.

## Tests

```sh
swift test                                                        # unit tests and vectors
GD_DEV_SERVER=<provider_dev_server.js> swift test                 # + contract C01-C14
GD_TEAMS_SERVER=../contract/teams_dev_server.cjs GD_TEAMS_BACKEND=<cloud-ssd>/native/Backend swift test
```

On Linux, building swift-crypto needs the C++ standard library headers (`libstdc++-<n>-dev`).
