# GenDragoon SDKs

Client libraries for GenDragoon Cloud SSD: the storage provider API (`/provider/v1`), encrypted files and
folders, folder sync, sharing, quotas, change events, the connect handshake, and the Teams and team-workspace
API (`/v2/teams`).

| Directory | Platform | Package |
|---|---|---|
| [`go/`](go/README.md) | Go 1.22+ | `github.com/grimvirusoffical-source/gendragoon-apps/sdk/go` |
| [`js/`](js/README.md) | Node 20+, browsers, Deno, Bun | `@gendragoon/sdk` |
| [`python/`](python/README.md) | Python 3.10+ | `gendragoon` |
| [`swift/`](swift/README.md) | Swift 5.9+ (Apple platforms, Linux) | `Gendragoon` |
| [`csharp/`](csharp/README.md) | .NET 8, .NET Standard 2.1 | `Gendragoon.Sdk` |
| [`engines/unity/`](engines/unity/README.md) | Unity 2021.3+ | `com.gendragoon.sdk` |
| [`engines/godot/`](engines/godot/README.md) | Godot 4.3+ (GDScript) | `addons/gendragoon` |
| [`engines/unreal/`](engines/unreal/README.md) | Unreal Engine 5 (C++ and Blueprint), any C caller | `GenDragoon` plugin, `libgendragoon` |

Shared material:

| Path | Contents |
|---|---|
| [`spec/operations.json`](spec/operations.json) | Every operation with its level, risk and HTTP route. The SDK tables are generated from it. |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | The same table, for reading. |
| [`docs/LEVELS.md`](docs/LEVELS.md) | How Rotten Apple levels gate the SDK calls. |
| [`spec/FORMATS.md`](spec/FORMATS.md) | Encryption, drive and share formats. |
| [`spec/vectors/v1.json`](spec/vectors/v1.json) | Test vectors every SDK checks. |
| [`spec/CONTRACT.md`](spec/CONTRACT.md) | The contract suite every SDK runs against a local backend. |
| [`contract/`](contract/) | `run.sh` (cross-language interop) and `teams_dev_server.cjs` (local Teams backend). |
| [`tools/gen_ops.py`](tools/gen_ops.py) | Regenerates the operation tables; `--check` fails when one is stale. |

## Concepts

**Binding.** An app connects to one GenDragoon workspace and receives a binding: an API key (`gdpk_…`), a
scope (`blobs:rw` or `blobs:r`) and a quota. The person approves the connection in GenDragoon. Two handshakes
are supported:

* *Connect code.* The person copies a one-time code (`gdpg_…`) from GenDragoon into the app, which redeems it.
* *Authorization code with PKCE.* The app opens a `gendragoon://connect` link and listens on a loopback
  address (`http://127.0.0.1:<port>`); GenDragoon redirects there with a code (`gdpc_…`) that the app exchanges
  together with its PKCE verifier.

**Storage.** A binding holds content-addressed blobs and named manifests. The SDKs build files and folders on
top: a *drive* is a tree stored in one manifest and committed with compare-and-swap, so concurrent writers on
several devices never lose each other's changes.

**Encryption.** Encrypted drives are sealed on the device with AES-256-GCM under keys derived from a 32-byte
master key. The master key is stored only wrapped under the person's recovery passphrase (scrypt, or argon2id
where available), in the binding's key envelope. GenDragoon never sees file contents, names or keys. Plain
drives are available for data that does not need it.

**Sharing.** A file of an encrypted drive can be sealed to a recipient's P-256 identity. A read-only key
(`blobs:r`) lets the recipient fetch the chunks without being able to write.

**Events.** The server has no webhook or stream for bindings. `watch` polls `/usage` and lists manifests only
when the change sequence moved.

**Teams.** A signed-in GenDragoon account can create teams, invite members, chat, moderate, and create team
workspaces. These calls use the person's Firebase ID token on the API origin; the server refuses `gdpk_` and
`gdsk_` keys for them. Calls that need payment return a Stripe Checkout URL for the person to open; the SDKs
never complete a payment. Team chat is polled (`watchChat`); the server's Server-Sent Events endpoint is
documented but not used by the SDKs.

## Levels

Every call names an operation from `spec/operations.json`. Each SDK checks the operation's Rotten Apple level
against the client's cap before sending anything. The default cap is L3; calls at L4 (exporting the master key,
wiping a binding, deleting an app's data, transferring or deleting a team) need an explicit L4 cap. A host such
as the Rotten Apple launcher sets `GENDRAGOON_SDK_MAX_LEVEL`, which can only lower the cap; an unreadable value
locks the client to L0. See [`docs/LEVELS.md`](docs/LEVELS.md).

## Development

```sh
python3 tools/gen_ops.py --check                      # generated tables are current

# Local backends (from a gendragoon-cloud-ssd checkout)
export GD_DEV_SERVER=<cloud-ssd>/native/Backend/scripts/provider_dev_server.js    # feature/sdk-backend
export GD_TEAMS_BACKEND=<cloud-ssd>/native/Backend                                 # feature/teams
export GD_TEAMS_SERVER=$PWD/contract/teams_dev_server.cjs

(cd go && go test ./...)
(cd js && npm test)
(cd python && python -m pytest)
(cd swift && swift test)
(cd csharp && dotnet run --project tests/Gendragoon.Sdk.Tests)
(cd engines/godot && godot --headless --editor --quit --path . && godot --headless --path . --script res://tests/run_tests.gd)
(cd engines/unreal && test/build.sh && test/build/cabi_test)

contract/run.sh                                       # every SDK reads every other SDK's files
```

Both dev servers run entirely in memory on `127.0.0.1` and accept `Authorization: Bearer dev-user:<uid>` in
place of a Firebase token. Nothing they do leaves the machine; the Teams server uses a local Stripe double with
placeholder price ids.

## Known limitations

* The Unity and .NET Standard builds use managed AES-GCM and P-256 implementations (Unity has no platform
  AES-GCM on every target). They are tested against the platform implementations but are not constant-time.
* argon2id envelopes: Go and Python open them; JS and C# accept a plug-in KDF; Swift and Godot report them as
  unsupported. New envelopes use scrypt, so this only matters for envelopes created elsewhere.
* Godot: no sharing, folder sync or account calls, and scrypt runs in GDScript (about 3.5 s per unlock on a
  laptop, on a worker thread). Teams covers the player-facing calls only.
* Unreal: the plugin covers cloud save slots; Teams, sharing and sync are available through the C ABI or not at
  all. The plugin has not been compiled against an engine build in this repository's CI.
* Team-workspace files use the `/v3/cloud` and `/v2/workspaces/:id/cloud` signed-URL routes. The SDKs list team
  workspaces and their routes but do not wrap file transfer for them.
* Bindings have no push notifications; `watch` polls.
