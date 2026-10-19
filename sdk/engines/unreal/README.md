# GenDragoon Cloud Save for Unreal Engine

An Unreal Engine 5 plugin for encrypted cloud save slots. It loads `libgendragoon`, a C library built from the Go
SDK (`sdk/go/cabi`), at runtime.

## Install

1. Build the library for each platform you ship: `GenDragoon/Tools/build_library.sh` (Go 1.22+ and a C compiler).
   It writes to `Source/ThirdParty/GenDragoonLib/lib/<Platform>/`.
2. Copy `GenDragoon` into your project's `Plugins` folder and enable it.

Supported platforms: Win64, Mac, Linux.

## Quick start

`UGenDragoonCloudSave` is a game instance subsystem, so it is available from C++ and Blueprints:

```cpp
auto* Save = GetGameInstance()->GetSubsystem<UGenDragoonCloudSave>();
Save->Connect(ProviderUrl, ConnectCode, TEXT("My Game"), OnConnected);   // once; store the returned API key
FString Error;
Save->Open(ProviderUrl, ApiKey, Error);                                   // on later runs
Save->Unlock(Passphrase, /*bCreateIfMissing*/ true, OnUnlocked);
Save->SaveGameObject(MySaveGame, TEXT("slot1"), OnSaved);
Save->LoadGameObject(TEXT("slot1"), OnLoaded);
```

Calls run on a worker thread and invoke their delegate on the game thread.

## API

| Member | Description |
|---|---|
| `Connect` | Redeems a connect code; returns the API key. |
| `Open` | Opens a client with a stored API key. |
| `Unlock`, `IsUnlocked`, `Close` | Unlocks the master key and opens the save drive. |
| `SaveSlot`, `LoadSlot` | Raw bytes. |
| `SaveGameObject`, `LoadGameObject` | `USaveGame` objects. |
| `ListSlots`, `DeleteSlot`, `Usage` | Slot management and quota. |
| `MaxLevel` (2), `DriveName` (`cloud-save`), `SlotFolder` (`saves`) | Settings. |

The C header, `Source/ThirdParty/GenDragoonLib/include/gendragoon.h`, also exposes drive listing, mkdir, move and
player Teams calls (`gd_teams_*`) for use from your own code.

## Tests

```sh
test/build.sh && test/build/cabi_test                 # C ABI checks without a server
```

The plugin itself is exercised through the C ABI tests and the cross-language interop check in `sdk/contract`.

## Limitations

- The plugin has not been compiled against an engine build yet.
- It covers save slots only; calls cannot be cancelled once started.
