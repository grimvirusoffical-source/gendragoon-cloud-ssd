# GenDragoon SDK for Go

```sh
go get github.com/grimvirusoffical-source/gendragoon-apps/sdk/go
```

```go
ctx := context.Background()

// Once: redeem the connect code the person copied from GenDragoon, and store conn.APIKey securely.
conn, err := gendragoon.NewConnector(base, nil).RedeemGrant(ctx, code, gendragoon.ClientInfo{Name: "My Game"})

c, err := gendragoon.NewClient(base, conn.APIKey, nil)
keys := c.NewKeyring()
err = c.Unlock(ctx, keys, passphrase)          // c.CreateMasterKey(ctx, keys, passphrase) the first time

d, err := c.OpenDrive("saves", keys, nil)
_, err = d.WriteFile(ctx, "slots/slot1.sav", data, nil)
data, err = d.ReadFile(ctx, "slots/slot1.sav")
```

`base` is the provider URL, for example `https://api.gendragoon.com/provider/v1`.

## API

| Area | Calls |
|---|---|
| Connect | `NewConnector`, `Connector.RedeemGrant`, `Connector.ExchangeCode`, `NewPKCE`, `ConnectLink`, `ListenLoopback`, `Loopback.Wait` |
| Provider | `NewClient`, `Capabilities`, `Health`, `Usage`, `PutBlob`, `PutSealedBlob`, `GetBlob`, `HeadBlob`, `DeleteBlob`, `ListBlobs`, `AllBlobs`, `HasBlobs`, `GetManifest`, `PutManifest`, `DeleteManifest`, `ListManifests`, `AllManifests`, `GetKeyEnvelope`, `RotateAPIKey`, `Wipe` |
| Keys | `NewKeyring`, `Unlock`, `CreateMasterKey`, `ChangePassphrase`, `Keyring.ImportMasterKey`, `Keyring.ExportMasterKey`, `Keyring.Lock`, `WrapMasterKey`, `UnwrapMasterKey` |
| Files and folders | `OpenDrive`, `Drive.List`, `Stat`, `WriteFile`, `ReadFile`, `Mkdir`, `Move`, `Delete`, `DeleteSlot`, `DeleteFolder`, `Snapshot`, `CleanPath`, `SlotPath`, `Client.CollectGarbage` |
| Sync | `Drive.Push`, `Drive.Pull`, `Drive.Mirror` |
| Sharing | `NewIdentity`, `IdentityFromPrivate`, `Drive.ExportShare`, `OpenShareEnvelope`, `Client.OpenShare`, `CreateReadKey`, `ListReadKeys`, `RevokeReadKey` |
| Events | `Client.Watch` (polling) |
| Account | `NewAccountClient`, `CreateGrant`, `ParseConnectLink`, `Authorize`, `ListBindings`, `RevokeBinding`, `RevokeAndDelete` |
| Teams | `NewTeamsClient`, `Catalog`, `List`, `Create`, `Get`, `Checkout`, `CreateInvite`, `RevokeInvite`, `PreviewInvite`, `Join`, `UpdateMe`, `Leave`, `Workspaces`, `CreateWorkspace`, `CheckoutWorkspace`, `Share`, `Unshare`, `Messages`, `WatchChat`, `Post`, `PostCard`, `Report`, `DeleteMessage`, `Mute`, `Unmute`, `Kick`, `Ban`, `SetRole`, `Audit`, `VerifyAuditChain`, `Transfer`, `Delete` |
| Levels | `Operations`, `LevelGate`, `ParseLevel`, `LevelError`, `Options.Gate` |
| C ABI | [`cabi/`](cabi/main.go): `go build -buildmode=c-shared ./cabi` (see `engines/unreal`) |

Folder sync never writes outside the local folder: pull refuses drive paths that are not valid drive paths
and any target whose path goes through a symbolic link or a non-folder in the local folder, and push skips
symbolic links.

Errors match with `errors.Is`: `ErrNotFound`, `ErrPreconditionFailed`, `ErrQuotaExceeded`, `ErrUnauthorized`,
`ErrRateLimited`, `ErrChecksum`, `ErrLocked`, `ErrWrongPassphrase`, `ErrCorrupt`. `*APIError` carries the
status, server code and `Retry-After`; `*LevelError` names the refused operation.

## Tests

```sh
go test ./...                                                     # unit tests and vectors
GD_DEV_SERVER=<provider_dev_server.js> go test ./...              # + contract C01-C14
GD_TEAMS_SERVER=../contract/teams_dev_server.cjs GD_TEAMS_BACKEND=<cloud-ssd>/native/Backend go test -run Teams ./...
```
