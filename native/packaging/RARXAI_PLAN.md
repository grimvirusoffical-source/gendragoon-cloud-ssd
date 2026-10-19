# Gendragoon: `.rarxai` macOS package plan and `/provider/v1` implementation plan

Written by Gendragoon Dev, 2026-10-19. Sources read: `/workspace/rotten-apple/docs/CONNECT.md` §3 and §5, `rarxai/manifest.go`, `cmd/ql/main.go`, `quicklaunch`, `launcher/host.go`, `launcher/library.go`, `services/services.go`, `scripts/package-services.sh`; Gendragoon `integrate/backend-all` (`native/build_macos.py`, `native/Sources/*`, `native/Resources/*`, `native/MAS/*`); `/workspace/gd/mac-signing`; RedX `engine/pack/backend.go`; the joint design `/workspace/integration/GENDRAGOON-REDX.md` (sections 1.4, 10).

Status labels: **VERIFIED** (read in code), **NEEDS MAC** (only checkable on Josh's Mac), **PROPOSED**.

---

## Part A: macOS build packable as `.rarxai`

### A.1 What the contract requires (VERIFIED)

| Contract item | Source | Gendragoon today |
|---|---|---|
| `entry.type` must be `app-bundle`; one payload per package; `platforms[].os` `macos` | `rarxai/manifest.go` `Validate()` | The SwiftUI `GenDragoon Cloud SSD.app` (bundle `app.gendragoon.cloudssd`) fits |
| The app "may not require anything not in the bundle" | SPEC 8.6, `runtime.bundled` | **Fails today for Python** (A.2) |
| Launcher installs to `<Dir>/apps/<appId>/builds/<build>/` and keeps one previous build | `launcher/library.go` | **Fails today**: helpers hard-code `~/Applications/GenDragoon Cloud SSD.app/...` (A.3) |
| Launched apps get `RA_LAUNCHER_SOCK`, `RA_LAUNCH_TOKEN` and **`ROTTEN_APPLE_LAUNCHER=1`** | `launcher/host.go` `Env()`, CONNECT.md §5 | **Matches.** Swift `GDDistribution.current` and Python `distribution()` both turn `direct` into `rotten-apple` when `ROTTEN_APPLE_LAUNCHER=="1"`; covered by `native/Tests/test_distribution_channels.py` |
| Optional `data`/`links` blocks; `storage.kind` never required; needs `data.storage` service; ≤ 4 links | CONNECT.md §3, `manifest.go` | Gendragoon declares no database of its own (decision 10-a in the joint doc) |
| Signature: Ed25519 over manifest + Merkle root, chain to a pinned root; TEST roots refused by `--production` | `rarxai/pki.go`, `ql verify` | Only a TEST CA exists; production root is Josh's |

**Channel detection, confirmed with one caveat.** The marker string and value match the launcher exactly. Precedence is: Mac App Store receipt → bundled `gendragoon_distribution.json` → launcher marker. So a store package must **not** ship a `gendragoon_distribution.json` with a value other than `direct`/`rotten-apple`, otherwise the marker is ignored. Recommendation: in the Rotten Apple build, write `{"distribution":"rotten-apple"}` into the bundle as well (belt and braces), so a manual double-click of the installed copy also refuses to self-update. The env var alone is lost if the person opens the app from Finder instead of the launcher. A second safety check (PROPOSED): refuse self-update when the bundle path contains `/apps/app.gendragoon.cloudssd/builds/`.

### A.2 Python runtime: bundled, not system

`GDRuntime.pythonURL` (`native/Sources/GDNativeWorkspace.swift`) tries `Contents/Resources/gendragoon_python` first, then python.org framework paths 3.10–3.13 and Homebrew. Helpers called through it include upload, reset, library, stream, connect, cleanup and auto-update. The base bundle that `build_macos.py` clones (Josh's pinned `~/Applications/GenDragoon Cloud SSD.app`, not in git) carries `rclone` and `gendragoon_node`; **whether it carries `gendragoon_python` is unknown (NEEDS MAC)**.

Plan:
1. Bundle a relocatable CPython 3.12 (python-build-standalone `install_only` arm64 build, about 45 MB uncompressed, or python.org's framework copied with `Python.framework` under `Contents/Frameworks`) as `Contents/Resources/gendragoon_python` (a small launcher script or the real binary plus `lib/python3.12`). Helpers use only the standard library; confirm with `python3 -X importtime` and an import scan (`scripts/scan_imports.py`, new, runs on Linux too).
2. Sign every Mach-O inside it with the Developer ID identity, hardened runtime, timestamp (inside-out, before the outer bundle).
3. In the Rotten Apple build, **remove the system fallbacks** at runtime (`GD_REQUIRE_BUNDLED_PYTHON` flag set by the distribution file), so a missing runtime fails visibly instead of silently using `/opt/homebrew`. Manifest: `runtime.kind=native`, `languages=["swift","python"]`, `bundled=true`.

### A.3 Running from the launcher's install directory

Four helper modules hard-code the bundle location (`gendragoon_connect.py:43`, `gendragoon_library.py:18,183`, `gendragoon_stream.py:14`). Under the launcher, the bundle lives at `<launcher dir>/apps/app.gendragoon.cloudssd/builds/<build>/GenDragoon Cloud SSD.app`, and the path changes on every update.

Fix (small, Gendragoon-side): resolve `APP = Path(__file__).resolve().parents[2]` (helpers live in `Contents/Resources`), or have Swift pass `GD_APP_BUNDLE=Bundle.main.bundlePath` in the helper environment; keep the old path only as a last fallback. Also: the protected-path lists in `gendragoon_library.py` must include the actual bundle path, and the "managed app copy" cache must not live inside the bundle (it is replaced on update). The guard that refuses to overwrite `~/Applications/GenDragoon Cloud SSD.app` stays correct: the launcher never writes there. Tests: run the Python suite with the bundle staged at a temporary `apps/<id>/builds/22/` path.

### A.4 Entitlements and signing order

The Developer ID build (not sandboxed; the MAS entitlements in `native/MAS/` are not used here):
- outer app: hardened runtime, no extra entitlements beyond what `build_macos.py` uses today;
- `gendragoon_node`: `com.apple.security.cs.allow-jit` (as `build_macos.py` writes it);
- `rclone`, bundled Python binaries and `.dylib`/`.so` files: hardened runtime, no entitlements; if a Python extension module fails to load under library validation, add `com.apple.security.cs.disable-library-validation` **to the Python binary only** (NEEDS MAC check).

Order (updated 2026-10-19: **no Apple Developer ID required**). Rotten Apple's own signing is the primary trust; Apple signing is optional:

1. `build_macos.py --identity - --distribution rotten-apple` → **ad-hoc** codesign of the vendor helpers and the app (no hardened runtime, no timestamp: ad-hoc code has no Team ID, so library validation under the hardened runtime would refuse the other ad-hoc binaries, and ad-hoc builds cannot be notarized anyway). The `rotten-apple` marker is written into `Contents/Resources` **before** signing. Apple silicon refuses unsigned arm64 code, so ad-hoc is the minimum.
2. *Optional* `--apple-sign`: the same build with the pinned Developer ID (hardened runtime, timestamp, node JIT entitlements). *Optional* `--notarize`: notarytool submit, staple, `spctl` check.
3. **Rotten Apple layer on the signed bundle, unmodified:** `ql inspect` → `ql pack` (Ed25519 manifest signature + Merkle root; TEST CA now, Josh's production root later) → `ql verify` (`--production` refuses test certs). The launcher never re-signs, so the payload root covers the final code-signed bytes.

Gatekeeper, honestly: inside ra-launcher the app is not quarantined (the launcher downloads with its own HTTP client and verifies the `.rarxai` chain), so an ad-hoc app runs. A copy that leaves the launcher (browser download, AirDrop, copy from another Mac) is quarantined and blocked until the person chooses System Settings → Privacy & Security → Open Anyway; only a notarized build opens normally there. Ad-hoc signatures change every build, so Keychain-access and privacy-permission (Files and Folders, Full Disk Access) prompts may reappear after each update; a stable Developer ID avoids that. All of this depends on Apple keeping today's quarantine behaviour for non-browser downloaders (Rotten Apple SPEC 7.3).

### A.5 Payload layout and manifest

```
Payload/GenDragoon Cloud SSD.app/
  Contents/Info.plist                    CFBundleIdentifier app.gendragoon.cloudssd, CFBundleVersion = manifest.build
  Contents/MacOS/GenDragoon Cloud SSD
  Contents/Resources/gendragoon_python/  bundled CPython (A.2)
  Contents/Resources/rclone, gendragoon_node, *.py, gendragoon_distribution.json {"distribution":"rotten-apple"}
  Contents/_CodeSignature/, CodeResources
```

Declared services (each needs a reason; effective set is what Josh's team has unlocked): `launcher.settings`, `launcher.window` (clean exit before an update), `store.listing`, `crash`, `updates`, `data.storage` (Gendragoon can be a storage provider; L2 in the catalog, so it may start as *pending*). No `data` database block (decision 10-a); link: `com.redxai.redx:storage:provides` only (a `db:uses` link is refused by `ql` unless `data.database.kind=redx`, and Gendragoon declares no database) (RedX's id is `com.redxai.redx` per CONNECT.md §3). `network.declaredHosts` from a real scan (Cloud Run host, `storage.googleapis.com`, Firebase/Google sign-in hosts). `update.sources=[{"kind":"redx"}]` only.

**`ql pack --storage` for a provider:** Rotten Apple main (`9019e9c`) already accepts `--storage gendragoon --storage-purpose …` for a package with a `storage:provides` link and no RedX database. Older `ql` builds refuse it; `pack-rarxai.sh --storage auto` tries it and falls back to the link only (and drops `--service data.storage`). TODO: remove the fallback once every packer is on the new `ql`.

### A.6 Updates owned by the launcher

Channel `rotten-apple` → the in-app updater is disabled (`self_update_allowed()` is false; UI shows "Updates are handled by the rotten-apple distribution"), and "Check for updates" should call the launcher's `updates.status` over the services socket. `updates.apply {relaunch}` is a launcher change (joint doc 10.4) not built yet; until then the person updates from the launcher's Library. `manifest.build` = `CFBundleVersion`, monotonic across channels.

### A.7 Steps on Josh's Mac (once it is connected)

All dry-run by default; nothing uploads to a store or publishes. Script: `/workspace/gd/mac-signing/scripts/mac/pack-rarxai.sh` (branch copy `native/packaging/mac/pack-rarxai.sh` on `feature/rarxai-pack`; needs that branch's `build_macos.py --identity/--distribution`).

```sh
export GD_REPO=~/src/gd-rarxai RA_REPO=~/src/rotten-apple GD_BASE_APP="$HOME/Applications/GenDragoon Cloud SSD.app"
scripts/mac/pack-rarxai.sh                     # dry run: prints every step
scripts/mac/pack-rarxai.sh --run               # ad-hoc build + TEST-CA package (no Apple account needed)
scripts/mac/pack-rarxai.sh --run --apple-sign --notarize   # optional, needs GD_DEVID_APP_IDENTITY + GD_NOTARY_PROFILE
scripts/mac/pack-rarxai.sh --run --ca-dir ~/ra-ca-prod --production --team <RA team>   # once a production root exists
```

Then install the `.test.rarxai` with an ra-launcher that pins the same TEST root and check: Settings says updates are handled by rotten-apple, helpers run, upload/reset work. Prerequisites: `mac-signing/README.md` (Xcode, python3, base app), Go ≥ 1.22. The ql part was exercised on Linux with a stub bundle (`--app … --allow-non-mac`) against both the new and the pre-relaxation `ql`; the build and codesign steps have **not** run on a Mac yet.

### A.8 Part A work list (Gendragoon side)

| # | Task | Size | Where |
|---|---|---|---|
| A-1 | Helpers resolve bundle path at runtime (A.3) + tests | S | box |
| A-2 | Bundled Python: fetch/pin script, signing inside-out, `GD_REQUIRE_BUNDLED_PYTHON` | M | box (script), Mac (sign, run) |
| A-3 | `build_macos.py --distribution rotten-apple --identity -` (marker before signing, ad-hoc mode) | **done** on `feature/rarxai-pack` | box |
| A-4 | `pack-rarxai.sh` in `mac-signing` (dry-run default, TEST/prod CA, Apple signing optional) | **done** (ql steps tested on Linux) | box, Mac |
| A-5 | Self-update refusal by install path (extra guard) | S | box |
| A-6 | First real build + pack + launcher install on the Mac | M | Mac |

---

## Part B: `/provider/v1` storage-provider API

### B.1 Target interface (RedX `engine/pack/backend.go`, VERIFIED)

`ChunkStore{PutChunk(id,data), GetChunk(id) (ErrChunkNotFound), HasChunk, DeleteChunk (no-op if absent), ListChunks}` and `ManifestStore{LoadManifest(key) (ErrManifestNotFound), SaveManifest(key,data) atomic, DeleteManifest, ListManifests}`. Ids and keys are 64 lower-case hex. **A chunk id is the SHA-256 of the stored bytes** (`ChunkID(data)`, re-checked by `fsck` and on read), so the provider can verify every put (`X-Id-Mode: content`). Manifests are keyed by `FolderKey`, not by content, and the interface only asks for atomic overwrite; the API also offers CAS (`If-Match` / `If-None-Match: *`) for multi-writer safety.

### B.2 Mapping

| RedX call | HTTP | Behaviour |
|---|---|---|
| `PutChunk` | `PUT /provider/v1/blobs/{id}` + `X-Content-SHA256` | 201/200; 422 `checksum_mismatch` if `sha256(body)≠id` (content mode) or ≠ header; 507 `quota_exceeded`; 413 `blob_too_large` (> 16 MiB); idempotent |
| `GetChunk` | `GET /blobs/{id}` | 200 bytes + `X-Content-SHA256`; 404 `not_found` → `ErrChunkNotFound` |
| `HasChunk` | `HEAD /blobs/{id}`; batch `POST /blobs:batchHas` | 200/404 |
| `DeleteChunk` | `DELETE /blobs/{id}` | 204 even if absent |
| `ListChunks` | `GET /blobs?cursor=&limit=` | ids, sorted, paginated |
| `LoadManifest` | `GET /manifests/{key}` | 200 + `ETag: "<generation>"`; 404 → `ErrManifestNotFound` |
| `SaveManifest` | `PUT /manifests/{key}` [+ `If-Match`/`If-None-Match: *`] | atomic; 412 `precondition_failed` on CAS loss; 428 if `X-Require-Precondition` policy is on |
| `DeleteManifest` | `DELETE /manifests/{key}` [+ `If-Match`] | 204 |
| `ListManifests` | `GET /manifests` | keys |
| (health/usage) | `GET /usage`, `GET /health`, `GET /capabilities` | for RedX `Health()`/`Usage()` |

Auth: `Authorization: Bearer gdpk_…` (binding key), from the connect legs (grant → redeem → token). Scopes `blobs:rw`, `blobs:r`.

### B.3 Order, sizes and ETA (agent on this box, working hours)

| Prio | Gap | Work | ETA |
|---|---|---|---|
| 1 | G3 | Blob routes with streaming SHA-256 verify, HEAD, list, batchHas, 16 MiB cap (G11) | 4 h |
| 1 | G4 | Manifest routes: atomic put, CAS via generation, list, delete | 2 h |
| 1 | G2 | `gdpk_` keys: format, hash at rest, scopes, binding, expiry, rotate with overlap, revoke | 3 h |
| 1 | G5 | Quota: transactional reservation per binding/workspace, 507, reconcile; shard counter later | 3 h |
| 2 | G1 | Connect: `POST /connect/grants` (Firebase user), `POST /connect/redeem` (one-time grant → `gdpk_`), `POST /connect/token` (code + PKCE S256), `POST /connect/rotate` | 5 h |
| 2 | G8 | Bindings list/revoke for the user (`lastUsedAt`, `lastError`) | 1.5 h |
| 2 | G6 | Per-binding rate limit (token bucket), 429 + `Retry-After` | 1.5 h |
| 2 | G10 | Audit events (no secrets) | 1.5 h |
| 2 | G13 | JSON fixtures + **Go contract test** running RedX's interface semantics against the server | 3 h |
| 3 | G9 | Per-binding key-envelope route (reuse `key_envelope.js` validation) | 1.5 h |
| 3 | G7 | Account deletion/merge cover binding namespaces | 3 h |
| 3 | — | GCS-backed blob store adapter (`ifGenerationMatch` for CAS) + Firestore meta, wired into `free_server.js` behind `PROVIDER_V1_ENABLED` (default off) | 4 h |
| — | G12 | Live deploy | **not done; Josh approves separately** |

Total ≈ **33 agent-hours ≈ 4–5 working days**, plus review. Priority-1 + G1/G8/G6/G10/G13 core (≈ 24 h) is the first mergeable slice. Everything is tested with in-memory fakes (`test_firestore.js` `memoryFirestore` + an in-memory blob store) and, for GCS behaviour, the Storage emulator later.

### B.4 Design decisions for the implementation

- New module `native/Backend/provider_v1.js` exporting `registerProviderV1({app, db, blobs, now, …})`; storage access through a small `BlobStore` interface (`put/get/head/delete/list` with generation preconditions) so it runs against memory in tests and GCS in production. Object prefix: `customer/<accountHash>/provider/<bindingId>/{blobs,manifests}/`.
- Firestore: `gd_provider_grants/{sha256(grant)}`, `gd_provider_keys/{keyId}` (digest only), `gd_provider_bindings/{bindingId}` (owner hash, workspace id, scopes, usage counters, `lastUsedAt`, `revokedAt`).
- Not mounted in `free_server.js` by default; `PROVIDER_V1_ENABLED=true` required. Not added to `deploy_free.py`'s runtime allow-list in this branch, so a deploy cannot pick it up by accident.
- RedX's remote `ChunkStore`/`ManifestStore` adapter is RedX Dev's; a **proposal** file lives at `native/Backend/docs/provider-v1-redx-adapter.go.txt` in this branch only.
