# GenDragoon Android MachineNotes candidate

Version 0.22.0 (36) targets Android 9 or later on arm64-v8a and x86_64. This is a maintained Red-XAI client, replacing the former Firebase/v3 prototype. No Google/Firebase sign-in or Google Cloud storage SDK is active. Existing inactive `google-services.json` configuration files are not read by the build. `create_project.py` only validates maintained inputs; it does not regenerate or overwrite source.

## Implemented flow

1. Connect Red-XAI. Approve the displayed code on the official browser page. Credentials use the existing PKCE approval protocol, access tokens stay in memory, and the refresh token is encrypted using Android Keystore. No password is entered in the app.
2. Refresh MachineNotes and select an existing note. This Android interface consumes existing server entitlements; it has no purchase, Stripe checkout, MachineNote creation or external-payment-link button. Active paid storage is required for uploads. Existing read-only notes retain the server's restore policy.
3. Import the encrypted portable vault exported by your other GenDragoon device. It must match the same account. The envelope uses the shared AES-256-GCM/PBKDF2-HMAC-SHA256 v1 format and authenticates the encrypted KXAI keymap with the pinned core before installation. Different existing keys are never replaced. Hardware-bound KXAI v4 and unsupported Argon2 costs are refused. If the server verifies a completely empty account, explicit initialization can create its first vault. Export it before connecting another device. Signing in cannot recreate lost client encryption keys.
4. Select files or a complete folder using Android's document picker. Only the local owner can grant these read permissions. WorkManager prepares private staging, creates deterministic folder archives, encodes encrypted barcode PNGs using the pinned library, and uploads the existing MachineNotes graph protocol. The client then downloads and verifies the complete archive/content before reporting Succeeded. Android always retains originals.
5. Restore an item. Download and decrypt into private storage, verify the complete graph/archive against the encrypted manifest, then explicitly export the verified bytes with Android's save picker. Folder and macOS application backups remain intact ZIP archives; Android does not execute macOS apps or recreate a macOS installation. Private verified copies are retained.
6. Developer Teams opens the shared packaged Teams interface in an isolated WebView with a metadata-only native bridge. Team peers never acquire upload, download, decryption-key, billing or administration access. No peer-issued file command is exposed. Team membership revocation is enforced by the backend. Group chat retention is seven days; direct WebRTC availability depends on actual network/device support.

10 GiB free is a recommendation, not a fixed admission requirement. Each operation checks its measured file/archive preparation and readback space plus a 64 MiB working margin. The image carrier expands network/storage use substantially. Worker counts bound network concurrency; they do not mean that every encoder or CPU stage runs in parallel. Progress remains below 100 until verified success. A failed/interrupted job retains its local preparation and any already stored encrypted server chunks; those chunks are not a completed backup. Re-selecting unchanged input can reuse immutable chunks, but metadata/readback must still succeed. This candidate does not expose a cancel-running UI, server garbage collection, server storage deletion, or automatic removal of original files.

Disconnect revokes/clears the account session where available and retains vault keys, local records, and server content. Avoid switching accounts during transfers. Android Keystore protects credentials on this device; portable vault export is the explicit migration mechanism and contains encryption material only, never auth refresh/access credentials. Keep its passphrase separately.

## Pinned compiled runtime and private-source boundary

The public repository includes `runtime/gendragoon-android-runtime-9235941b431b.zip`: two compiled `librsx.so` files, Python 3.13 bytecode, Apache and official NDK/LLVM license/notice files and a per-file SHA manifest. It contains no private C++ or Python source. Exact SHA-256:

```
47883fd5535bae569c7fe7bb9cfac2092fa8ab2ec83c4c39e4fd5e9c363ffa2f
```

`sync_runtime.py` binds that input to superproject vendor gitlink `9235941b431bc1c23c34286b82052f845121592f`, ABI 2, Python 3.13 bytecode magic, both ELF architectures, 16 KiB load alignment, per-member hashes and a strict compiled-only path allowlist. It never fetches or rewrites the private encryption source. Raw private source must not be added to this public repository, CI artifacts or archives. A manually substituted runtime requires both `GENDRAGOON_ANDROID_RUNTIME` and `GENDRAGOON_ANDROID_RUNTIME_SHA256`; a missing/mismatched pin fails closed.

The default build uses this compiled input and needs no private submodule checkout, CMake, or NDK. The isolated private builder is `build_private_runtime.py`: Python 3.13 bytecode compilation plus NDK 28.2.13676358, CMake and Ninja builds of the exact clean pinned checkout. `--compiled-python` accepts an already compiled private input only after provenance/magic/hash verification. This private rebuild tooling is for authorized environments, not public CI source access.

## Build and verification

Use JDK 17, Python 3.13, Gradle 8.13, Android platform 36 and build tools 35.0.0. SDK licenses must be accepted by the build operator. Chaquopy 17.1.0 provides the Python 3.13 Android runtime; NumPy 2.5.4 and Pillow 11.0.0 plus reviewed FreeType/JPEG runtimes are exact hash-locked offline wheel dependencies in `runtime/wheels`; no expiring CI artifact download is required. All helper/Teams assets are copied from current reviewed GenDragoon sources into generated output during preBuild.

From this directory:

```sh
python3.13 -B sync_runtime.py
python3.13 -B -m unittest discover -s tests -p 'test_*.py' -v
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lint --no-daemon --console=plain --stacktrace
./gradlew :app:assembleRelease :app:bundleRelease --no-daemon --console=plain
```

Public CI runs the same trusted input checks, adapter tests, lint, JVM unit tests and debug/release APK/AAB compilation. Release outputs are unsigned candidates. It does not upload private source trees, tokens, vault keys or generated Python trees as artifacts. No store upload or signing identity is configured here.

For a connected arm64/x86_64 Android device or emulator:

```sh
./gradlew :app:connectedDebugAndroidTest --no-daemon --console=plain --stacktrace
```

Instrumented fixtures exercise the actual embedded Python/native codec, a five-PNG encrypted graph through the production transport functions against a disposable in-memory Receiver, cross-workspace AAD rejection, and the shared Mac/JCE portable vault vector with pinned-core read-only keymap validation. They require no user credentials, live subscription or production data. They do not claim live HTTP or a production account restore.

Verified outside Android as of October 26, 2026: both NDK-built ABI libraries and their 16 KiB ELF load segments; compiled-only import/runtime validation; actual existing ABI 2 core codec/graph roundtrip; deterministic archive, corruption/traversal and 400-event concurrent progress tests; shared Mac/JCE Unicode vault vector and five negative cases. Android APK compilation, lint and device instrumentation must be judged by the resulting CI/device evidence, not those host-side passes.

## Release gates

This is not yet a store-ready declaration. In addition to successful Android builds and real device transfer/restore tests, verify background/foreground-service behavior across Android versions, physical storage pressure, process interruption, credential renewal, app signing, license notices, current dependency security and Play policy/data-safety/account-deletion requirements. The Android UI intentionally has no external Stripe purchase flow; adding purchases requires a separate Google Play billing/policy decision.

The complete reviewed candidate passed six actual API 36 tests on both 4 KiB and 16 KiB x86_64 emulator images at source `f59f7c72ae992dac121cdd34d96cf327c3a58d4e` (workflow `40287386074`). All 190 APK native libraries passed the strict 16 KiB load audit, including both packaged ABIs. The full 64 KiB visual chunk roundtrip, legacy 2 MiB compact read/authentication negatives, encrypted graph, Mac carrier, vault, numerical/JPEG/font tests passed. The 16 KiB fixture uses 4 GiB RAM; physical ARM, constrained-device and normal application-ID acceptance are separate gates. No plaintext fallback, private-source change or weakened alignment audit was used.

The Android account screen now exposes the current MachineNotes deletion request at `POST /gendragoon/v2/account/deletion`, not the legacy Firebase flow. It requires `DELETE GENDRAGOON`, refuses queued/active local transfers, and saves its same-account idempotency key and receipt binding encrypted by the device Keystore. Queued, running, failed, mismatched or incomplete receipts never authorize local cleanup. Only a matching completed receipt with `cloudDataDeleted: true` allows removal of that receiver's private vault, session and attributable prepared job copies. Other account vaults, local originals and external Red-XAI identity/BYO data are retained; unattributed historical private jobs are retained rather than guessing their owner. Pending requests survive disconnect/relaunch; same-account approval can recover the receipt without provisioning a deleted Receiver. Server requests require network and the deployed current deletion API. No live deletion is performed by tests.

A visible [Privacy notice](https://api.red-xai.com/gendragoon/privacy) links to current service data-use/deletion information. Public distribution still requires reviewed store declarations, signing, the deployed backend deletion flow and actual normal-profile/device verification. This client does not fabricate Google/Firebase consent records or claim that sign-in recovers private client keys.
