# GenDragoon SDK for Python

```sh
pip install ./sdk/python             # Python 3.10+, depends on cryptography
pip install './sdk/python[argon2]'   # cryptography 44+, to open argon2id envelopes
```

```python
import gendragoon as gd

conn = gd.Connector(base).redeem_grant(code, "My Game")    # once; store conn["apiKey"] securely
c = gd.Client(base, conn["apiKey"])
keys = gd.Keyring(c)
keys.unlock(passphrase)                                     # keys.create(passphrase) the first time
d = gd.Drive(c, "saves", keys)
d.write_file("slots/slot1.sav", data)
data = d.read_file("slots/slot1.sav")
```

## API

| Area | Calls |
|---|---|
| Connect | `Connector.redeem_grant`, `Connector.exchange_code`, `new_pkce`, `pkce_challenge`, `connect_link`, `Loopback` |
| Provider | `Client`: `capabilities`, `health`, `usage`, `put_blob`, `put_sealed_blob`, `get_blob`, `head_blob`, `delete_blob`, `list_blobs`, `all_blobs`, `has_blobs`, `get_manifest`, `put_manifest`, `delete_manifest`, `list_manifests`, `all_manifests`, `get_key_envelope`, `rotate_api_key`, `wipe` |
| Keys | `Keyring`: `unlock`, `create`, `change_passphrase`, `import_master_key`, `export_master_key`, `lock`; `wrap_master_key`, `unwrap_master_key` |
| Files and folders | `Drive`: `list`, `stat`, `write_file`, `read_file`, `mkdir`, `move`, `delete`, `delete_slot`, `delete_folder`, `snapshot`; `clean_path`, `slot_path`, `collect_garbage` |
| Sync | `push`, `pull`, `mirror` (return `SyncReport`) |
| Sharing | `Identity`, `export_share`, `open_share_envelope`, `open_share`, `create_read_key`, `list_read_keys`, `revoke_read_key` |
| Events | `watch` (generator, polling; stop with a `threading.Event`) |
| Account | `AccountClient`: `create_grant`, `authorize`, `list_bindings`, `revoke_binding`, `revoke_and_delete`; `parse_connect_link` |
| Teams | `TeamsClient`: `catalog`, `list`, `create`, `get`, `checkout`, `create_invite`, `revoke_invite`, `preview_invite`, `join`, `update_me`, `leave`, `workspaces`, `create_workspace`, `checkout_workspace`, `share`, `unshare`, `messages`, `watch_chat`, `post`, `post_card`, `report`, `delete_message`, `mute`, `unmute`, `kick`, `ban`, `set_role`, `audit`, `transfer`, `delete`; `verify_audit_chain` |
| Levels | `OPERATIONS`, `level_gate`, `parse_level`, `LevelError`, the `gate=` argument |

Folder sync never writes outside the local folder: pull refuses drive paths that are not valid drive paths
and any target whose path goes through a symbolic link or a non-folder in the local folder, and push skips
symbolic links.

Errors: `APIError` (`status`, `code`, `retry_after`, and `not_found`, `precondition_failed`, `quota_exceeded`,
`unauthorized`, `rate_limited`), `LevelError` (a `PermissionError`), `WrongPassphraseError`, `LockedError`,
`ChecksumError`, `CorruptError`. Teams calls return the server's JSON as dictionaries.

## Tests

```sh
python -m pytest                                                  # unit tests and vectors
GD_DEV_SERVER=<provider_dev_server.js> python -m pytest           # + contract C01-C14
GD_TEAMS_SERVER=../contract/teams_dev_server.cjs GD_TEAMS_BACKEND=<cloud-ssd>/native/Backend python -m pytest
```
