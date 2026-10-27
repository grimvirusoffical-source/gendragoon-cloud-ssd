# GenDragoon integrations and BYO RedX storage

This implementation changes GenDragoon only. The external RedX, RottenApple, QuickLaunch, Red-XAI Host, RottenCore, PoisonApple and pinned Red-SecretsXAI repositories are not modified.

## Verified external contracts

| Product | Reviewed revision | Supported contract and present limit |
| --- | --- | --- |
| Red-XAI-DB is the RedX repository | `aaafbe1585ce08bb76b433a1b2c1dba47bfc7dee` | Actual v1 pack file REST and GenDragoon S256 connect. The external RedX implementation records a provider grant as pending; it does not redeem that grant into an external provider backend. |
| RottenApple | `5b91d5e258d5aa44e76e4a032ba1580eb844e251` | Documents RedX connect and the GenDragoon provider contract. Its L3 storage binding is explicitly unimplemented. GenDragoon can issue scoped credentials; this does not add the missing feature to the store. |
| Quick Launcher | `9d245d5054165726dba51ff2bca20be48d3de0d7` | Its existing client POSTs `grant` and `client_instance` to `/provider/v1/connect/redeem`, expects `key` beginning `gdpk_`, `keyId`, `binding.id`, `binding.workspaceName`, then GETs `/provider/v1/health`. Those exact fields/routes are supported here. |
| Red-XAI Host | `2708f563453c039c6350c7394f41f8e6351927f5` | No documented scoped file storage/connect contract was found; catalog says contract required. |
| RottenCore | `cc77747ee763c24f497583648c3a0e033cc2ecfe` | Installer/manifest example only; no supported file storage API is advertised. |
| PoisonApple | No owned repository/contract located | Catalog says contract required. |

Primary contract sources are RedX `docs/api.md`, `docs/connect.md`, `docs/security.md`, `host/extras_api.go`, `host/ui.go`; RottenApple `docs/CONNECT.md`, `docs/PUBLIC_API.md`, `docs/QUICKLAUNCH_API.md`; QuickLaunch `docs/STORE_CONTRACT.md`, `internal/engine/connect.go`; RottenCore `examples/redx/README.md`.

The old Firebase `native/Backend/provider_v1.js` is not mounted into the Receiver and does not grant free hosted storage. Its legacy 64-hex blob/manifests/CAS API remains unavailable. `/provider/v1/health` and redemption explicitly advertise `legacyBlobAPI:false` and `manifestCas:false`. New integrations use scoped Receiver files, or the separate BYO pack adapter below. A successful connect/health call must not be reported as a working legacy external storage backend.

## Storage only API keys

The authenticated account endpoints are:

| Method | Path | Result |
| --- | --- | --- |
| GET | `/v1/integrations/services` | Service catalog, capabilities and honest implementation limits |
| GET | `/v1/integrations/keys` | Key summaries, never their secrets or hashes |
| POST | `/v1/integrations/keys` | Creation-only `apiKey`/`key`, `keyId`, summary |
| DELETE | `/v1/integrations/keys/{16hex}` | Immediate revocation |
| GET / POST | `/v1/integrations/byo` | Own external workspace metadata / register metadata |
| DELETE | `/v1/integrations/byo/{byo_32hex}` | Disconnect metadata; external data and recovery credentials retained |

Key creation accepts `{name,service,workspaceId,scopes}`. Available service IDs are `redxai-db`, `rottenapple-store`, `quick-launcher`; other catalog entries cannot receive a key. `workspaceId` is exactly one owned 32-hex paid Receiver MachineNote. Scopes are `files:read`, `files:write`; upload permission is explicit. Twenty active keys per account and a 90-day maximum lifetime apply. A key is `gdpk_<16hex>_<43base64url>` with 256 random secret bits. Only SHA-256 of the complete token is stored in a separate Integration metadata table; summaries and account metadata contain no raw key, session bearer or refresh credential.

Keys cannot create keys/grants, manage billing, use team APIs, create/delete MachineNotes, access account/admin inventory or see another MachineNote. They are never forwarded to site-session userinfo or the ordinary user-bearer billing path. The Receiver checks the key before session identification, forces `ownerAdmin:false`, filters `/v1/receivers/me` to the bound note, rejects cross-note routes, checks parsed library operation bodies and existing item ownership, and applies fresh proof to the existing bound note only. Updating one proof never deactivates other notes or creates a new note.

Every use needs trusted current workspace proof `{id,active,readOnly,quotaBytes,workers,checkedAtMs}` from the loopback internal entitlement service. Missing/invalid/stale proof fails closed. Writes require active storage, no read-only flag, positive quota and at least one worker. Already stored data remains readable for recovery when the note is lapsed, subject to key scope and current proof. The callback derives owner from the stored issuer/subject and uses an independently authenticated internal credential, never the customer's `gdpk_` token.

These keys are **up to 90-day storage delegations, separate from administrator login sessions**. Current paid allowances are reconciled through the trusted control ledger. An existing lifetime owner note can be delegated only while its bound stored note is already marked owner and the existing account ledger grants owner benefits; a storage key cannot create either flag or become an owner/admin session. A fresh native authenticated sign-in continues to update owner benefits. There is no service-only subject-to-current-verified-email endpoint in the reviewed Accounts contract, and no user refresh credential is persisted to simulate one. Consequently immediate account ban/deletion or changed owner-email propagation requires configured Accounts status/events integration; without it, the documented storage delegation can remain usable until ledger synchronization, explicit key revocation or expiry. Do not describe this as real-time administrator identity verification.

Integration metadata uses independent RedX records and revision CAS, never the paid Receiver account ledger or team-membership rows. It verifies record identity to fail closed on a hashed record-address collision. Global key lookup pointers alone never authorize a request: the owner account must still contain the live key digest.

## Existing client pairing wire

An account session may POST `/provider/v1/connect/grants` with the same explicit service, MachineNote and scopes. It receives a 5-minute one-use `gdpg_` grant. The native Integrations page exposes **Create Connection Grant** for clients such as QuickLaunch. Ten grant creations per ten minutes per account apply.

For S256, the authenticated `/provider/v1/connect/authorize` accepts `codeChallengeMethod:"S256"` and `codeChallenge`, and returns a 5-minute `gdpc_` code. Public POST `/provider/v1/connect/token` accepts `{code,codeVerifier}`. Public POST `/provider/v1/connect/redeem` accepts `{grant,client_instance}`. Redemption atomically consumes the stored hashed grant/code, rechecks current entitlement and issues the same scoped key registry; a replay or concurrent second redemption is refused. Returned compatibility aliases are `{key,apiKey,keyId,bindingId,binding:{id,workspaceId,workspaceName},workspaceId,keyExpiresAt,capabilities}`. No client can expand the account-approved scope, service or note during exchange.

The unchanged RottenApple client uses a different, concrete S256 wire. Its `gendragoon://connect?v=1&provider=rottenapple&state=…&pkce_challenge=…&callback=rottenapple://gendragoon-callback` link only opens an explicit native consent request. The person chooses one owned MachineNote and read/write permission before GenDragoon issues a state-bound code. The callback is exact-allowlisted, names the configured GenDragoon API host, and contains no API key or app session. Public `/v1/connect/exchange` accepts `{code,pkce_verifier,state,device_label}` and returns the existing RedX-shaped `connection_id,workspace:{db,name},key,key_id,scope,prefix,endpoints,storage`. State is hashed at rest and enforced for a state-bound code through every exchange alias. `/v1/connect/revoke` authenticates and revokes only the presented key, even when paid entitlement proof is temporarily unavailable; self-revocation is the sole key-management exception for a delegated key. This pairs with the current launcher but cannot implement its local, unconditional `data.storageBind` unavailable branch. Neither the current store nor QuickLaunch calls Receiver files or legacy provider blob/manifests for file transfer.

The small Node SDK is `integration-sdk.cjs`. Supply an in-memory native credential callback; the SDK refuses redirected requests and never persists keys:

```js
const {IntegrationClient, pkce} = require('./integration-sdk.cjs');
const account = new IntegrationClient({
  baseURL: 'https://api.red-xai.com',
  token: () => nativeSession.currentAccessToken(),
});
// Only an authenticated account creates grants/keys. Store creation responses
// directly in the caller's native vault, rather than logs or config files.
const verifier = pkce();
```

The SDK supports management, actual one-use provider pairing, health, scoped Receiver library listing and bounded PNG GET/PUT with SHA-256 checks. It intentionally provides no generic arbitrary URL proxy or admin method. A scoped storage key transports encrypted carriers; possessing it does not supply the client encryption secret/keymap.

## Free BYO RedX workspace

BYO metadata is `{id,kind:"redx-db-byo",name,origin,database,pack,hostingFeeCents:0,billingRequired:false,storageLocation:"external-redx-pack",createdAtMs}`. A registration accepts only `{name,origin,database,pack}` and rejects credential fields. The Receiver never fetches the user-supplied host URL. It is not a paid MachineNote and cannot authorize paid hosted bytes, billing changes or team file access. Your RedX operator's own plan, storage, traffic and upload limits continue to apply.

The native helper is `native/Resources/gendragoon_redx_pack.py`. The native UI is `GDIntegrationsView` / retained `GDIntegrationsModel` in `GDIntegrations.swift`.

All helper actions take a single action argument; private JSON arrives on stdin, never shell arguments or URLs. Help reads no stdin and causes no side effects. Ordinary errors contain fixed safe messages, not remote bodies/headers, exception text or keys. Actions:

| Action | Extra input | Result |
| --- | --- | --- |
| `context` | `origin,database,pack,accountId` | `receiverId,workspaceId,keymapPath` derived from the complete canonical connection/account context |
| `probe` | connection/key | Real `/v1/ui/whoami` plus pack list; requires non-admin read/write key scoped to this database; permits a genuinely new empty pack |
| `list` / `tree` | optional `path` | Actual pack file/folder entries; bounded tree 10000 entries and 32 levels |
| `mkdir` | `path` | Real hidden `.gendragoon-folder.json` marker preserves an empty folder; no invented RedX mkdir endpoint |
| `put` | `path,source` regular file | Streamed bytes with host-verified `X-Redx-SHA256`; retains local source |
| `get` | `path,destination` new file | Streamed full download, size/ETag/hash checked, exclusive publication; existing targets retained |
| `delete` | regular-file `path` | Deletes only that pack file index; physical chunks remain until host-admin GC |
| `archives` | connection/account | Published encrypted GenDragoon archive descriptors, at most 1000 entries |
| `upload-source` | `source,path` logical parent, `offload:false` | Complete encrypted app/file/folder archive, remote readback and full metadata restore comparison; original retained by default |
| `restore-source` | descriptor `path`, existing parent `destination` | Authenticated decrypt, safe archive extraction, full metadata compare, atomic no-replace restore |
| `connect-begin` | host/database | Actual RedX `provider=gendragoon` S256 link plus memory-only verifier/state |
| `connect-exchange` | `code,state,pkceVerifier` | Actual RedX one-time code exchange; creation-only external key response |
| `revoke` | connected external key | Actual RedX self-revoke; files retained |

Connection input is `{origin,database,pack,key,accountId}`. HTTPS is required; explicit `development:true` permits literal local loopback HTTP only. Userinfo/path/query/fragment are forbidden in origins; redirects are refused, so credentials cannot follow a host-selected redirect. Pack paths reject traversal, ambiguous separators, controls, Windows device names and reserved marker names. Raw listing/download reflects existing files without encrypting, converting or decoding other programs' data. Host Encrypt-policy packs expose ciphertext size/hash for decrypted bytes and cannot currently be verified by this raw adapter; they are rejected explicitly.

Encrypted archive input additionally needs `storageSecret` (32–128 base64url characters) and the exact `keymapPath` returned by `context`. The native app keeps external key and independent random encryption secret in **ThisDeviceOnly macOS Keychain**, scoped to the authenticated account plus derived connection ID. The private keymap lives under `~/Library/Application Support/GenDragoon Cloud SSD/BYOKeymaps/<receiverId>.rsxkeymap`, owned by the current user with private permissions. Both secret and keymap are required for recovery on another Mac. A missing local secret with an existing keymap or existing cloud encrypted archives fails closed, rather than creating a new incompatible encryption identity. Disconnect deliberately retains recovery material. The native S256 exchange uses an ephemeral URLSession so its creation-only key response never enters the generic helper's temporary output collector.

## Actual RedX pack layout and encryption boundary

RedX bytes are PUT/GET `/v1/db/{database}/pack/{pack}/file/{path}`, folder entries come from `/ls[/folder]`, metadata from `/stat/{path}`. The host stores these in `dbs/<database>/<pack>.red-xai-pack/chunks/<prefix>/<hash>` and `manifests/<folderhash>.manifest`. Binary files do not become arbitrary BoxQL database fields. The external RedX API has no mkdir, recursive directory delete, rename/move, resumable upload or manifest CAS; the adapter does not invent those capabilities.

New GenDragoon encrypted objects are real visual PNGs under `GenDragoon/<workspaceId>/blobs/<transportId>/<objectId>.png`. The published discovery descriptor is `GenDragoon/<workspaceId>/archives/<transportId>/.gendragoon-entry.json`. The descriptor contains only discovery metadata, root manifest ID and hashes; the original snapshot manifest, content and metadata streams are encrypted through the existing pinned C++ AEAD and public visual codec. The adapter reuses `gendragoon_redx_storage.upload_archive/download_archive` through an optional client factory. Existing Receiver defaults, IDs, AAD and old carrier decoding are preserved. No encryption library repository code is changed and no independent security proof is claimed for the visual carrier.

RedX pack PUT is mutable and lacks CAS. A fresh random `transportId` namespace for every archive prevents two devices encrypting the same content from overwriting another archive's random nonce/carrier hash. Failed uploads retain their incomplete carrier files without publishing a verified backup descriptor. No automatic garbage collection or destructive cleanup is attempted. Free BYO uses a bounded serial transfer profile; it does not manufacture paid Receiver worker entitlements.

App/folder/file archives reuse the existing metadata-preserving ZIP builder, source snapshots, archive traversal/link validation and full restore comparison. Publish occurs only after downloading, decrypting, hashing and restoring the complete archive successfully. Source identity is checked again before return and before any explicit optional Finder Trash action. The native UI always sends `offload:false`. Existing targets are never overwritten. The common activity/maintenance gate covers the entire operation across sidebar navigation and account-switch checks discard stale results.

10 GB of free local space is a recommendation. Actual staging needs plus a bounded filesystem margin determine admission; work that fits below 10 GiB is allowed. Insufficient measured operation capacity retains originals and cloud data. No fixed 10 GiB hard threshold is added by this adapter.

## Validation

`node --test test/integrations.test.cjs test/integration-sdk.test.cjs test/integration-receiver.test.cjs` covers hashed creation-only keys, grant replay/S256, revocation, expiry, fresh proof failures, scopes, service/workspace isolation, no admin/team access, cross-note library guards, preserved other notes and exact SDK HTTP wire.

`python3.13 -B -m unittest discover -s native/Tests -p test_redx_pack.py` covers URL/context binding, path restrictions, truncated/corrupt download cleanup, destination retention, redirects, S256 verifier secrecy, cross-context archive rejection, source mutation retention and low-disk operation capacity.

The opt-in `REDX_INTEGRATION_ROOT=<reviewed integration parent> node --test native/RedXCloud/test/redx-pack.test.cjs` starts a disposable real RedX host only. It proves actual pack filesystem placement, streamed file bytes, prefix/read/revoked key isolation, independent metadata CAS, real RedX S256 exchange/self-revoke, and genuine C++/visual PNG app upload/readback/restore including executable bits and safe symlinks. It never uses production credentials, offloads user items, installs or restarts the app, patches external programs or runs a host-admin GC.

`external-connect-contract.test.cjs` additionally compiles the original reviewed RottenApple `connect/client.go` from an external runtime fixture after verifying Git blob `148f4f220d55c5a3554f9a41bd21922780ee0c42`. It proves that the unchanged Go client exchanges a real GenDragoon S256 code, reads the exact response, refuses replay and self-revokes. The test requires an explicitly supplied external source path and pinned blob; no private external program source is embedded in this public repository or source artifacts.
