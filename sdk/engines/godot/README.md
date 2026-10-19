# GenDragoon Cloud SSD for Godot

A GDScript addon for Godot 4.3+ with no native code: encrypted files and folders, the connect handshake, change
polling and player-side Teams calls.

## Install

Copy `addons/gendragoon` into your project and enable **GenDragoon Cloud SSD** under **Project > Project Settings
> Plugins**.

## Quick start

```gdscript
var client := GendragoonClient.new(base_url)
add_child(client)

# Once: redeem the connect code and store r.value.apiKey.
var r: GendragoonResult = await GendragoonConnect.redeem_grant(client, code, "My Game")
client.api_key = r.value.apiKey

var keys := GendragoonKeyring.new(client)
r = await keys.unlock(passphrase)           # keys.create(passphrase) the first time
var drive := GendragoonDrive.new(client, "saves", keys)
r = await drive.write_file("slots/slot1.sav", data)
r = await drive.read_file("slots/slot1.sav")
if r.ok:
    data = r.value
```

Every network call is a coroutine that returns a `GendragoonResult` with `ok`, `value`, `status`, `error` (a stable
code such as `not_found`, `precondition_failed`, `quota_exceeded`, `level`, `locked`, `wrong_passphrase` or
`network`) and `message`.

## API

| Class | Calls |
|---|---|
| `GendragoonClient` (Node) | `capabilities`, `health`, `usage`, `put_blob`, `put_sealed_blob`, `get_blob`, `delete_blob`, `has_blobs`, `all_blobs`, `all_manifests`, `get_manifest`, `put_manifest`, `delete_manifest`, `get_key_envelope`, `rotate_api_key`; exports `base_url`, `max_level`, `timeout_seconds` |
| `GendragoonConnect` | `redeem_grant`, `exchange_code` |
| `GendragoonKeyring` | `unlock`, `create`, `change_passphrase`, `import_master_key`, `export_master_key`, `lock`, `is_unlocked` |
| `GendragoonDrive` | `snapshot`, `list`, `stat`, `write_file`, `read_file`, `mkdir`, `move`, `delete`, `delete_slot`, `delete_folder`; `slot_path` |
| `GendragoonWatcher` (Node) | `start`, `stop`; signal `changed` |
| `GendragoonTeams` (Node) | `catalog`, `list_teams`, `get_team`, `preview_invite`, `join`, `update_me`, `leave`, `workspaces`, `messages`, `post`, `report`, `watch_chat`, `stop_watching`; signals `message_received`, `team_lost` |

`GendragoonTeams` authenticates with the player's Firebase ID token (`id_token`). Billing, invite management and
owner moderation are left to the GenDragoon app.

## Tests

```sh
godot --headless --editor --quit --path .                            # once, to register the class names
godot --headless --path . --script res://tests/run_tests.gd           # unit tests
GD_SDK_BASE=<provider url> godot --headless --path . --script res://tests/run_tests.gd    # + contract subset
GD_TEAMS_ORIGIN=<teams url> godot --headless --path . --script res://tests/run_tests.gd   # + Teams subset
```

## Limitations

- No sharing, folder sync or account calls.
- scrypt runs in GDScript and takes several seconds per unlock; argon2id envelopes are not supported.
