# GenDragoon Cloud SSD for Unity

Encrypted cloud save slots for Unity 2021.3+, built on the GenDragoon .NET SDK (`netstandard2.1`).

## Install

1. Build the SDK assembly into the package: `Tools~/build.sh` (needs the .NET 8 SDK). It writes
   `Runtime/Plugins/Gendragoon.Sdk.dll`.
2. In Unity, open **Window > Package Manager > + > Add package from disk** and select `package.json`.

## Quick start

Add **GenDragoon > Cloud Save** to a GameObject, set **App Name**, then:

```csharp
var save = GetComponent<GendragoonCloudSave>();
await save.ConnectAsync(connectCode);           // once; the API key is kept by Credentials
await save.UnlockAsync(recoveryPassphrase);     // or UnlockWithKey(masterKey) from the host launcher
await save.SaveJsonAsync("slot1", state);
var loaded = await save.LoadJsonAsync<GameState>("slot1");
```

The **Cloud save** sample in the Package Manager shows the full flow.

## API

| Member | Description |
|---|---|
| `ConnectAsync(code)` | Redeems a connect code and stores the API key. |
| `ConnectWithBrowserAsync(timeout)` | Opens the connect page and waits on a loopback redirect (PKCE). Desktop only. |
| `Disconnect()` | Forgets the API key and the unlocked key. |
| `UnlockAsync(passphrase)` | Unlocks the master key, creating it on first use (L2; the first key only, it never replaces one). |
| `UnlockWithKey(masterKey)` | Uses a master key supplied by the host. |
| `SaveAsync`, `SaveJsonAsync<T>` | Writes a slot. |
| `LoadAsync`, `LoadJsonAsync<T>` | Reads a slot; returns `null` when it does not exist. |
| `ListSlotsAsync()` | Lists slots with sizes and modification times. |
| `DeleteSlotAsync(slot)` | Deletes one slot: a single file directly inside `slotFolder` (`files.deleteSlot`, L2). Folders and nested paths are refused. |
| `UsageAsync()` | Bytes used and quota. |
| `Connected`, `Unlocked` | State. |
| `Credentials` | `ICredentialStore`; defaults to `FileCredentialStore` under `Application.persistentDataPath`. |

Inspector fields: `baseUrl`, `appName`, `driveName` (default `saves`), `slotFolder` (default `slots`) and
`maxLevel` (default L2, which covers every call above; see [LEVELS.md](../../docs/LEVELS.md)). For files, folders, sync, sharing or Teams, use the
SDK types in `Gendragoon.Sdk` directly; see [`sdk/csharp`](../../csharp/README.md).

## Limitations

- On `netstandard2.1` the SDK uses managed AES-GCM and HKDF, which are not constant-time.
- WebGL has not been tested. `ConnectWithBrowserAsync` needs a desktop platform; use `ConnectAsync` elsewhere.
