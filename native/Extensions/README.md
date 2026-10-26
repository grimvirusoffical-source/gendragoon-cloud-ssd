# GenDragoon browser and VS Code clients

These clients use the **installed, running GenDragoon companion**. They do not contain account passwords, session tokens, Stripe keys, integration keys, or encryption keys. A companion-enabled build from the same source revision is required. Installing an extension by itself does not provide storage, connect an account, or start a working upload service.

The four browser packages target Chrome, Edge, Firefox, and Opera. The desktop VS Code package runs in the local UI extension host. Windows uses a real console PE native host, private named pipes, current-user SID checks and protected ACLs. Linux uses a private Unix socket and can install either the Python host or a standalone ELF host. macOS Unix transport tests pass; Windows/Linux runtime candidates are gated by their own CI, including the real native codec and private local IPC. Opera's documented Linux host path is system-wide, so the installer refuses a user-level Opera installation there and does not write to `/etc`.

## What the clients do

- Show the current companion connection and your own MachineNotes.
- List completed file metadata for a selected MachineNote. Restore, offload, organize, and storage deletion remain in native GenDragoon.
- Browser: ask GenDragoon to open its own file or folder picker. The browser cannot submit arbitrary local paths.
- VS Code: send only paths that you explicitly select through its local file/folder dialog. The native companion checks the current account, destination, entitlement, and selection again before accepting a job. Offload remains off.
- Open developer Teams, including a required username, single-use invitations, group chat, presence, and WebRTC signaling. Peers receive no file, upload, download, billing, admin, or encryption-key rights. Direct peer chat is conditional on client/network support and must be runtime tested separately from signaling.

Queued is not completed. Follow the native upload job until **Succeeded** after full verification before removing an original. An unavailable companion, denied approval, expired login, or rejected entitlement produces an error, never a simulated success.

## Build the packages

Run from the repository root with Python 3.13 and Node 22 or later:

```sh
python3.13 -B -m unittest discover -s native/Tests -p test_native_bridge.py
node --test native/Extensions/tests/*.test.cjs
python3.13 -B native/Extensions/package_extensions.py --output /tmp/gendragoon-extensions-review
```

The output path must be new. The packager preserves existing releases. It produces four browser ZIP files, one VSIX, a source ZIP, and `SHA256SUMS`. ZIPs contain only local scripts, styles, icons, and Teams assets. Building and packaging do not submit anything to a browser store or the VS Code Marketplace. The current publisher/name is `redxai.gendragoon`; marketplace ownership and submission are separate release steps.

## Load a browser package for testing

1. Install and open a companion-enabled GenDragoon build. Connect your own Red-XAI account in the app.
2. Extract the correct browser ZIP to a stable local directory.
3. Open the browser extension manager: `chrome://extensions`, `edge://extensions`, or `opera://extensions`. Enable Developer mode and choose **Load unpacked**. Select the extracted directory containing `manifest.json`.
4. Copy the **actual extension ID** shown by that browser. Chromium IDs contain exactly 32 letters from `a` through `p`. An unpacked extension ID can change when its directory changes. A published store ID can differ from its development ID.
5. Firefox development testing uses `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → the extracted `manifest.json`. The explicit Firefox add-on ID is `gendragoon@redxai.local`. Temporary installation ends when Firefox restarts. Signed distribution requires the separate Mozilla submission/signing process.
6. Install the native host for exactly the browser IDs you loaded, as described below. Open the extension, approve that client in GenDragoon, then choose **Refresh connection**.

The extensions request `nativeMessaging` only. They have no host permissions, content scripts, page injection, external messaging interface, or remote JavaScript. They cannot read arbitrary websites, page passwords, browsing history, or local files. Teams pages use their own packaged UI and native metadata RPC.

## Install the native host for exact client IDs

On macOS, the helper defaults to:

`/Applications/GenDragoon Cloud SSD.app/Contents/Resources/gendragoon_native_bridge.py`

Run the installer with Python 3.13. Replace each uppercase ID placeholder with the actual ID copied from that browser. Supply only flags for the clients you want to enable. There are no wildcard origins and no automatic trust for an arbitrary extension.

```sh
python3.13 -B native/Extensions/install_native_host.py \
  --chrome-id ACTUAL_CHROME_32_LETTER_ID \
  --edge-id ACTUAL_EDGE_32_LETTER_ID \
  --opera-id ACTUAL_OPERA_32_LETTER_ID \
  --firefox --vscode
```

For a different installed app path, pass `--helper` with the full helper path. `--python` can select an existing absolute interpreter path. The installer does not download a runtime. Re-run it after moving the app or changing browser IDs, supplying the complete set of clients you still want enabled. Its private configuration is replaced by that explicit set.

On Linux, supply the installed helper path explicitly, for example `--helper /absolute/path/to/gendragoon_native_bridge.py`, and omit `--opera-id`. A running compatible GenDragoon companion must publish the Unix endpoint; the Python shim alone does not supply the native account/selection service.

The user host wrapper is installed at:

- macOS: `~/Library/Application Support/GenDragoon/NativeMessaging/gendragoon-native-host`.
- Linux: `${XDG_STATE_HOME:-~/.local/state}/gendragoon/NativeMessaging/gendragoon-native-host`.

Browser manifests contain this absolute wrapper path and the exact allowed extension IDs. macOS Chrome and Opera share Opera's documented Chrome native-host directory; their exact IDs are merged into one manifest. Edge and Firefox use their own documented directories. The installer prints the exact files it wrote. It does not alter account credentials, storage, subscriptions, or other browser hosts.

The native host checks the browser's launch argument against its installed private allowlist. A caller-supplied JSON identity is discarded. VS Code uses a fixed `--vscode-bridge` mode and the configured `redxai.gendragoon` caller label. Extension IDs identify the requested client; they are not operating-system attestation against another process already running as the same local user. The native app also requires local owner approval and binds access to the currently connected account.

## Install the VS Code package

Use **Extensions: Install from VSIX…** and select `gendragoon-0.1.0.vsix`. Enable this editor in the native host installer with `--vscode`. Open the local Command Palette and use:

- **GenDragoon: Check Local Companion**.
- **GenDragoon: Browse My MachineNotes**.
- **GenDragoon: Select Files to Upload**.
- **GenDragoon: Select Folder to Upload**.
- **GenDragoon: Open Developer Teams**.

Uploads require a trusted local workspace and an explicit picker selection. Remote/virtual file URIs are rejected. No upload command is registered for a peer message or a WebRTC packet. The extension spawns only the fixed installed native-host path with `['--vscode-bridge']` and `shell:false`; it does not run workspace scripts or concatenate shell commands. It runs in the local UI host, not an SSH/container extension host or browser-based VS Code. Windows requires the packaged PE host and per-user allowlist; the native desktop app must be open and approve that editor for the current account.

## Companion protocol

Native stdio and Unix-socket messages are UTF-8 JSON preceded by a four-byte little-endian unsigned length. Frames are bounded to 256 KiB in both directions. Partial reads and writes are handled. Stdout contains protocol frames only.

An extension sends:

```json
{"id":"0123456789abcdef0123456789abcdef","method":"status","params":{}}
```

Other permitted methods are:

- `request`: `{path, method, body?}` for `GET /v1/receivers/me`, scoped library metadata listing, and explicit developer profile/team routes only. No blobs, stored-object payloads, key management, billing, owner admin, storage deletion, or external URLs are accepted. Team request bodies are validated again by the app and Receiver.
- `selectUpload`: `{workspaceId, kind:"file"|"folder"}`. The native picker controls the local selection.
- `uploadSelection`: `{workspaceId, selectedPaths:[absolutePath,...]}` for the configured VS Code client only. Maximum 64 explicitly selected paths, with native revalidation.

The shim reads a private locator:

- macOS: `~/Library/Application Support/GenDragoon/Companion/endpoint.json`.
- Linux: `${XDG_STATE_HOME:-~/.local/state}/gendragoon/Companion/endpoint.json`.

```json
{"schema":1,"protocol":"gendragoon-companion-v1","socketPath":"/absolute/private/rpc.sock"}
```

The locator and socket must be owned by the local user, with private file/socket modes and private leaf directories. Symlinks are rejected. The socket uses an envelope that the shim creates from validated launch arguments:

```json
{"schema":1,"client":{"kind":"vscode","id":"redxai.gendragoon"},"request":{"id":"0123456789abcdef0123456789abcdef","method":"status","params":{}}}
```

The native app verifies the connecting UID, client approval, and current account. A response is `{id,ok:true,result}` or `{id,ok:false,error:{code,message}}`. `status` returns `{connected,version?,accountLabel?}`; a metadata `request` returns the Receiver body; upload selection returns `{queued,cancelled?,message?}` after actual native handling. Neither side returns a bearer token or encryption material. Missing/stale endpoints return `companion_unavailable`.

Large unpaginated library responses can exceed the bounded native frame. Open native Files in that case; the extension does not truncate an inventory and present it as complete.

## Troubleshooting and release limits

**Host not found:** check that the ID in the installed manifest exactly matches the current browser extension ID and that the helper/interpreter paths still exist. Use the installer output to inspect paths. Do not add `*` or a broad origin rule.

**Approval denied or companion unavailable:** open GenDragoon, connect your account, and review its local client approval. Refresh after approval. The shim does not silently launch a second account service or bypass a denied client.

**Read-only MachineNote:** restore and account management stay in the native app. A collaboration role does not activate a subscription or grant write access.

**Direct chat cannot connect:** group chat and signaling are distinct from a successful direct WebRTC connection. No public TURN relay is embedded. NAT/firewall restrictions may prevent direct connections. Do not infer a working peer connection from a signaling response alone.

**Uninstall:** remove the extension in its client manager. Remove only the `com.redxai.gendragoon.json` files listed by this installer and the private GenDragoon `NativeMessaging` directory if no clients need it. Leave the app's account, keymap, upload, cache, and MachineNote data directories intact.

Automated protocol, isolation, packaging, and local Unix tests are release evidence. Actual browser/IDE runtime checks, cross-client P2P checks, marketplace ownership, signed store packages, submission, and store acceptance must be recorded separately. None is implied by the existence of a ZIP or VSIX.

Reference contracts: [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [Edge native messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging), [Firefox native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging), [Opera native messaging](https://help.opera.com/en/extensions/message-passing/), and [VS Code local/web extension differences](https://code.visualstudio.com/api/extension-guides/web-extensions).
