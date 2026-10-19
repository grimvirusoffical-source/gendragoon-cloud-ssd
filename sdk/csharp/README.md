# GenDragoon SDK for C# and .NET

Targets `netstandard2.1` (Unity 2021.2+) and `net8.0`. No third-party dependencies. On `net8.0` encryption uses
the platform AES-GCM and HKDF; on `netstandard2.1` it uses a managed implementation (see Limitations).

```sh
dotnet add reference sdk/csharp/src/Gendragoon.Sdk/Gendragoon.Sdk.csproj
```

```csharp
using Gendragoon;

var conn = await new Connector(baseUrl).RedeemGrantAsync(code, new ClientInfo { Name = "My Game" }); // once; store conn.ApiKey
var c = new Client(baseUrl, conn.ApiKey);
var keys = new Keyring(c);
await keys.UnlockAsync(passphrase);              // keys.CreateAsync(passphrase) the first time
var d = new Drive(c, "saves", keys);
await d.WriteFileAsync("slots/slot1.sav", data);
byte[] back = await d.ReadFileAsync("slots/slot1.sav");
```

## API

| Area | Calls |
|---|---|
| Connect | `Connector.RedeemGrantAsync`, `ExchangeCodeAsync`, `Pkce.Create`, `Connector.ConnectLink`, `Loopback.Listen`, `Loopback.WaitAsync` |
| Provider | `Client`: `CapabilitiesAsync`, `HealthAsync`, `UsageAsync`, `PutBlobAsync`, `PutSealedBlobAsync`, `GetBlobAsync`, `DeleteBlobAsync`, `ListBlobsAsync`, `AllBlobsAsync`, `HasBlobsAsync`, `GetManifestAsync`, `PutManifestAsync`, `DeleteManifestAsync`, `ListManifestsAsync`, `AllManifestsAsync`, `GetKeyEnvelopeAsync`, `RotateApiKeyAsync`, `WipeAsync` |
| Keys | `Keyring`: `UnlockAsync`, `CreateAsync`, `ChangePassphraseAsync`, `ImportMasterKey`, `ExportMasterKey`, `Lock` |
| Files and folders | `Drive`: `ListAsync`, `StatAsync`, `WriteFileAsync`, `ReadFileAsync`, `MkdirAsync`, `MoveAsync`, `DeleteAsync`, `DeleteSlotAsync`, `DeleteFolderAsync`, `SnapshotAsync`, `CollectGarbageAsync`; `Drive.CleanPath`, `Drive.SlotPath` |
| Sync | `Sync.PushAsync`, `Sync.PullAsync`, `Sync.MirrorAsync` |
| Sharing | `Identity.Create`, `Identity.FromPrivate`, `Sharing.ExportAsync`, `Sharing.OpenEnvelope`, `Sharing.OpenAsync`, `Sharing.CreateReadKeyAsync`, `Sharing.ListReadKeysAsync`, `Sharing.RevokeReadKeyAsync` |
| Events | `Events.WatchAsync` (`IAsyncEnumerable`, polling) |
| Account | `AccountClient`: `CreateGrantAsync`, `AuthorizeAsync`, `ListBindingsAsync`, `RevokeBindingAsync`, `RevokeAndDeleteAsync`; `AccountClient.ParseConnectLink` |
| Teams | `TeamsClient`: `CatalogAsync`, `ListAsync`, `CreateAsync`, `GetAsync`, `CheckoutAsync`, `CreateInviteAsync`, `RevokeInviteAsync`, `PreviewInviteAsync`, `JoinAsync`, `UpdateMeAsync`, `LeaveAsync`, `WorkspacesAsync`, `CreateWorkspaceAsync`, `CheckoutWorkspaceAsync`, `ShareAsync`, `UnshareAsync`, `MessagesAsync`, `WatchChatAsync`, `PostAsync`, `PostCardAsync`, `ReportAsync`, `DeleteMessageAsync`, `MuteAsync`, `UnmuteAsync`, `KickAsync`, `BanAsync`, `SetRoleAsync`, `AuditAsync`, `TransferAsync`, `DeleteAsync`; `TeamsClient.VerifyAuditChain` |
| Levels | `Operations.All`, `Operations.LevelGate`, `Operations.ParseLevel`, `Level`, `LevelException`, `ClientOptions.Gate` |

Folder sync never writes outside the local folder: pull refuses drive paths that are not valid drive paths
and any target whose path goes through a symbolic link or a non-folder in the local folder, and push skips
symbolic links.

Every network call takes an optional `CancellationToken`. Errors: `ApiException` (`Status`, `Code`,
`RetryAfterSeconds`, and `NotFound`, `PreconditionFailed`, `QuotaExceeded`, `Unauthorized`, `RateLimited`),
`LevelException`, `WrongPassphraseException`, `LockedException`, `ChecksumException`, `CorruptException`.
To open argon2id envelopes, set `Crypto.Argon2id` to an implementation.

## Tests

```sh
dotnet run -c Release --project sdk/csharp/tests/Gendragoon.Sdk.Tests     # add -p:SdkTfm=netstandard2.1 for the managed crypto path
GD_DEV_SERVER=<provider_dev_server.js> dotnet run -c Release --project sdk/csharp/tests/Gendragoon.Sdk.Tests
GD_TEAMS_SERVER=../contract/teams_dev_server.cjs GD_TEAMS_BACKEND=<cloud-ssd>/native/Backend dotnet run -c Release --project sdk/csharp/tests/Gendragoon.Sdk.Tests
```

## Limitations

The managed AES-GCM and HKDF used on `netstandard2.1` are not constant-time. Prefer `net8.0` where the platform
allows it.
