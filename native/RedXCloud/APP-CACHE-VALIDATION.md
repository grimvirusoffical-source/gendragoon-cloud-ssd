# GenDragoon app-cache integration: measured results and remaining gates

## Required behavior

GenDragoon is a cloud-backed app launcher, not just a file uploader. Keep the
cloud copy, preload startup data into a bounded local cache, fetch subsequent
ranges on demand, allow one managed app at a time, preserve app state, and
release only verified disposable cache after the app and its helpers exit.
The local disk must retain at least 10 GiB free beyond the immediate work.

## Implemented in this change

- `gendragoon_app_launch.py` now checks active sessions across **all**
  workspaces before staging, mounting, or starting another app. It does not
  terminate a running app or its helper to satisfy a second launch request.
  The shared maintenance lock covers the check and the preparing receipt.
- Complete-bundle fallback now accounts for existing managed cache and the
  candidate's verified size manifest. It refuses an unknown-size or over-budget
  download, and preserves the existing 10 GiB free-space reserve. Unreadable
  cache inventory fails closed. No existing cache is deleted to make room.
- `png_app_cache.py` supplies a separate client-side read-through cache:
  app-relative range reads fetch only referenced PNG objects, verify their
  integrity, use the existing Red-SecretsXAI decoder/crypto, and retain verified
  plaintext in a size-bounded least-recently-used cache. Cache construction
  downloads no file content. Startup preloading requests the first chunk of
  selected files, not the entire app. Edited or unexpected local data is retained.
- The new range-cache component is **not a filesystem driver or a completed
  native app integration**. Its index must be authenticated/decrypted by the
  caller first; schema validation does not authenticate an index.

## Tests actually executed

On the user's Apple Silicon Mac, with disposable test data:

| Suite | Passed | What it establishes |
|---|---:|---|
| `test_app_launch.py` | 44 | Existing lifecycle safety, single-active-app across workspaces, bounded full-copy fallback, free-space reserve, safe retention |
| `test_preload.py` | 8 | Existing bounded/startup-first preload behavior |
| `test_png_app_cache.py` | 14 | Range selection, no eager download, cache reuse/eviction limits, integrity rejection, no unexpected deletion (fixture transport/decoder) |
| `test_png_app_cache_real.py` | 1 | The new cache uses unchanged real C++ crypto and real PNG decoding for two tiny fixtures, reuses cached data, does not fetch an unrequested file, and rejects the wrong authenticated workspace context |

All 67 checks passed. These are **not** evidence of launching a real large
application through the new encrypted cloud backend. The real-codec test uses
128-byte fixtures; large-file checks below are separate measurements.

The old launch test fixture used a macOS temporary-directory symlink path,
which conflicted with production symlink protections. The fixture now resolves
its temporary root; the actual protection was not removed or bypassed.

## A real PNG transport mismatch discovered

The current Receiver accepts at most 8 MiB per PNG and 4,000,000 pixels. A real
64 KiB plaintext fixture encrypted successfully with existing librsx, but the
**default** image settings produced 17,174,585 PNG bytes (about 16.4 MiB).
That is over the Receiver limit. The earlier tiny-file roundtrip did not catch
this and cannot justify claiming that arbitrary 64 KiB files are supported.

Separate disposable experiments used options already supported by the existing
image library. No encryption algorithms or library source were modified:

| Plaintext | Existing PNG options | Encoded PNG bytes | Pixels | Decode result |
|---|---|---:|---:|---|
| 65,536 B | Defaults (module 5, bits 2, noise 30) | 17,174,585 | not recorded | Original sealed bytes recovered |
| 65,536 B | module 3, bits 2, noise 0 | 8,705,106 | 2,900,209 | Recovered, still over the byte limit |
| 65,536 B | module 3, bits 3, noise 0 | 5,833,001 | 1,943,236 | Recovered and accepted by the actual Receiver carrier validator |
| 32,768 B | module 3, bits 3, noise 0 | 2,972,097 | 990,025 | Recovered and accepted by the actual Receiver carrier validator |

These are individual fixture measurements, not a performance guarantee or a
storage expansion upper bound. The image carrier overhead is significant and
must be included in provisioning, bandwidth and cache accounting.

Applying the compact profile to `client-codec.py` and the CLI's vendored adapter
was blocked by the execution tool. **That adapter change was not applied**.
The measurements do not mean the live command now uses the compact profile.

## What is still not working for the user

- The default CLI connection has no configured production Accounts issuer or
  Receiver endpoint, so it still reports that production is not deployed.
- The responding VPS Receiver is a private development/demo service, not proof
  of persistent customer Accounts, verified email or a production deployment.
- The installed normal Mac app remains 0.18.0 build 29. Its app launch/preload
  path still uses its older cloud adapter. The Red-XAI UI is a separate small-file
  preview, not an integrated replacement for the application library.
- The new encrypted range cache still requires an authenticated app index,
  a virtual-filesystem adapter, native launch integration, signed/notarized build,
  and a real large-app acceptance test before it can run cloud apps.
- rclone VFS cache caps are targets rather than strict limits while files are
  open; the new full-copy preflight must not be described as fixing that behavior.

This change did not replace the installed app, remove user data, change
Kamatera, expose unfinished services, purchase infrastructure, or modify
Red-SecretsXAI's encryption/image source. Changes remain reviewable source.
