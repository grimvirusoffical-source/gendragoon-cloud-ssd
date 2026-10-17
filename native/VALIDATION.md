# Validation record — 2026-10-17

This engineering record separates the current Mac test candidate, historical
observations, and broader production acceptance. Source and fixture-test passes
do not stand in for an observed installation, successful payment, or permission
to delete user originals.

## Current Mac test candidate — build 22

The current candidate's production source is
`9214bdcdc3c953c39c5015177dc6185cfc61e95d`, built as **0.17.0 (22)**.
The subsequent head `950191aa36880b551bca8804dcf6ad545db57133` changes only two
test fixtures; it does not change the production bundle. Real Mac compilation,
focused tests, metadata smoke and a lifecycle retry have completed, and both
source-linked CI runs passed. After an initial cloud attempt stopped at the
unchanged disk reserve, a separate cloud retry passed all three tiny fixture
uploads and six full readbacks. Build 22 is now Apple-notarized, stapled and
accepted by Gatekeeper. Its verified package is published as GitHub prerelease
`v0.17.0-rc.1`, and the freshly downloaded generated installer has installed
**0.17.0 (22)** at `~/Applications/GenDragoon Cloud SSD.app`. The app relaunched
as PID 22611, matched to that installed bundle, and remains responsive with one
native accessibility window observed. Post-launch Apple trust checks passed.
The earlier space block is historical; installation passed its preflight at
10.777 GiB free without reducing the 10 GiB reserve. Temporary backup cleanup
and detailed native-window labels remain pending. This authorized Mac test
installation is separate from public production acceptance.

| Current check | Observed result | Scope / remaining work |
|---|---|---|
| Apple notarization authentication | Resolved | Existing credentials validated and stored in the Mac Keychain profile `GenDragoonNotary`; credentials are not included in this repository |
| Integrated local native tests | 161 passed | Integration fixtures; actual Mac and cloud observations are recorded separately below |
| Focused metadata/library tests | 41 passed | Native AppleDouble adapter guards, directory metadata preservation, upload/restore and unchanged-original checks |
| Local installer/control/inventory/bytecode tests | 108 passed | Local fixture run covering replacement, restart, native inventory and immutable bundled resources |
| Native filesystem inventory fixtures | 7 passed | Read-only native filesystem inventory behavior; included in the relevant combined fixture results |
| Latest CI | All 7 jobs succeeded in each run at `950191aa36880b551bca8804dcf6ad545db57133` | [Push run 39064762933](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/actions/runs/39064762933) and [PR run 39064767064](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/actions/runs/39064767064); production source remains the build-22 source above |
| Latest CI native stress | 10,000 files verified; 512 commits across 16 writers; 300 hostile archives rejected; 2.775 seconds | Disposable local fixtures, not real-cloud saturation or large-application acceptance |
| Latest CI backend/security and deployment helpers | 118 backend tests passed; production audit reported 0 vulnerabilities; 31 deployment/verifier tests passed | Controlled regression/security fixtures and dependency audit; no paid transaction or independent penetration test implied |
| Build-22 Mac compilation and strict signature | Passed on the real arm64 Mac | Developer ID-signed 0.17.0 (22); strict bundle signature remained valid after the tests |
| Real Mac focused tests | 108 passed in 23.320 seconds at `950191aa36880b551bca8804dcf6ad545db57133` | Installer/control/inventory/bytecode fixtures on the actual arm64 host; not an observed replacement installation |
| Real Mac native filesystem inventory | 20 entries observed; shared readers agreed | Root and old NFS mounts were visible through the read-only native inventory path |
| Build-22 expanded archive smoke | Passed in 0.371 seconds | Real `ditto`/AppleDouble roundtrip with root/nested directory attributes, resource forks, empty attributes, relative symlinks and executable bits |
| Build-22 real lifecycle | Initial keep-cache case timed out at 30 seconds; separate retry passed all 3 cases in 59.268 seconds | Retry retained the same 30-second per-case and 120-second total limits; cleanup 26.0 seconds, keep 10.8 seconds, dirty-cache retention 10.6 seconds |
| Build-22 authenticated GCS fixture retry | **Passed in 42.929 seconds**; exactly 3 tiny uploads and 6 full readbacks | Small file, complete folder and disposable app restored independently with matching content and metadata; UUID-isolated prefix; originals, production index and strict bundle signature unchanged |
| Earlier build-22 GCS attempt | Blocked before the first upload after 26.697 seconds; 0 objects and 0 completed checks | Ownership and empty prefix verified; read-only production-space diagnostic confirmed 9.523 GiB free versus 10.062501833 GiB required; retained as failed-attempt evidence |
| Cloud retry free space | 11.024 GiB at start; 11.021 GiB afterward | Followed cleanup of 9 owned, idle compiler-cache locations; the 10 GiB production reserve stayed unchanged |
| Build-22 notarization, stapling and Gatekeeper | **Passed** | Apple accepted submission `40e43cdb-e838-49bd-9c44-acc5b1b67aa8`; ticket stapled and Gatekeeper accepted the signed build-22 bundle |
| Build-22 package and generated installer archive verification | **Passed** | 69,509,769-byte ZIP; 214,440,163 bytes expanded; exact generated installer verified the archive; package identity and SHA-256 recorded below |
| GitHub prerelease | Published as [v0.17.0-rc.1](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/releases/tag/v0.17.0-rc.1), targeting `950191aa36880b551bca8804dcf6ad545db57133` | Intentional test candidate: `candidate: true`, `automaticUpdateEligible: false`; no stable-release or automatic-update eligibility implied |
| Fresh GitHub download | All 6 assets matched expected bytes/hashes; generated installer archive verification passed | Verifies the downloaded release assets, not installation or relaunch |
| Installation and relaunch | **Passed: 0.17.0 (22) installed and running** | Freshly downloaded generated installer; `~/Applications/GenDragoon Cloud SSD.app`; PID 22611 matched to the installed executable; preflight passed at 10.777 GiB free with the 10 GiB reserve unchanged |
| Post-launch trust and bundle integrity | **Passed** | Developer ID signature, Gatekeeper and stapled ticket verified after launch; no Python bytecode caches in signed Resources |
| Settings and cloud state after replacement | **Preserved** | Rclone configuration and application-library file byte-for-byte unchanged; 8 preferences unchanged, including 6 TB monthly, 100 GB cache and project/bucket choices; workspace destination exactly preserved |
| Installed native window | One accessibility window observed; running PID responsive | Python AX inspection did not extract labels; detailed labels and native Firebase/Google sign-in remain unverified |
| Obsolete app removal | Six obsolete copies deleted; previous current installation replaced | Temporary build-19 backup `GenDragoonCloudSSD.previous-56f1fd2c752a4c15b6fbbbf17356d89a.app` retained pending final cleanup |

The test counts above describe separate runs with overlapping coverage and must
not be added together as a count of unique tests. Earlier CI also passed all
seven jobs for `fa35ec0cf4c07faaed0375ddd85a0c7044118c6f`; the latest runs above
supersede that observation for current source coverage.

The build-22 lifecycle failure remains part of the record. Its keep-cache case
reached the existing 30-second limit; the independent successful retry did not
increase that limit, change the 120-second overall budget or remove a case. A
passing retry does not erase the initial timeout.

The first build-22 cloud attempt created 21,973 bytes of disposable source
fixtures and verified the authorized project's bucket ownership and empty
test prefix. It then halted before the first transfer. A read-only call to the exact production
space check confirmed the reason: the 656-byte first file requires 67,110,832
bytes of staging allowance plus the 10 GiB reserve, or 10,804,529,072 bytes free
(10.062501833 GiB). Only 9.523 GiB was available at the diagnostic. No reserve
was reduced, no cloud object was uploaded, the original fixtures and production
index were unchanged, and the signed bundle remained valid. This confirmed
space safeguard remains part of the record.

After nine owned, idle compiler-cache locations were cleaned, the separate
build-22 cloud retry passed in **42.929 seconds**, with 11.024 GiB free at the
start and 11.021 GiB afterward. It completed exactly three uploads and six full
readbacks: `Small File.txt` as a 656-byte flat object, `Complete Folder` as a
2,309-byte archive, and `Cloud Roundtrip.app` as a 3,757-byte archive. All content
and manifest metadata matched, including the independent restore of each
fixture. The test used an isolated UUID prefix and retained originals, the
production index and a valid strict bundle signature. It did not perform
offload, cloud deletion, app launch, native Firebase UI acceptance or backend
acceptance; these tiny fixtures do not establish large-application behavior.
The sanitized result is retained in
[build22-gcs-roundtrip-retry.json](validation/2026-10-17/build22-gcs-roundtrip-retry.json).

### Notarized package and verified download

Build 22's Apple submission
`40e43cdb-e838-49bd-9c44-acc5b1b67aa8` was accepted. The ticket was stapled,
the strict signature remained valid, and Gatekeeper accepted the bundle.
[build22-notarization-resume.json](validation/2026-10-17/build22-notarization-resume.json)
records the completed result for the exact build and source identities.

| Package identity | Observed value |
|---|---|
| Application | 0.17.0 (22), arm64 Mac |
| ZIP size | 69,509,769 bytes |
| ZIP SHA-256 | `932b1fd7ed4b056c3d6f2edfd87895d1530a27a2f27036d01be59cab2e11a25f` |
| Expanded size | 214,440,163 bytes |
| Published release | [v0.17.0-rc.1](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/releases/tag/v0.17.0-rc.1), GitHub prerelease targeting `950191aa36880b551bca8804dcf6ad545db57133` |
| Distribution flags | `candidate: true`; `automaticUpdateEligible: false` |

The exact generated build-22 installer passed archive verification. All six
release assets were then freshly downloaded from GitHub and matched the
expected byte counts/hashes, and the downloaded installer/archive verification
passed again. This is deliberately a prerelease for the authorized test
installation; it is not eligible for automatic updates or a claim of stable
production acceptance.

An earlier installation preflight found 9.423 GiB free against a 10.264 GiB
requirement and correctly stopped before replacement. After space reclamation,
the actual installation preflight passed at **10.777 GiB free**, retaining the
same 10 GiB reserve. The freshly downloaded generated installer then installed
0.17.0 (22), and the new app relaunched successfully.

Before replacement, the old rclone process (PID 74542) was quiet across three
samples over 12 seconds. It received one `SIGTERM`, exited normally, and the
native filesystem inventory confirmed that its NFS mount was absent. The old
bundle's helper processes were stopped. The installed app's PID 22611 was then
matched to `~/Applications/GenDragoon Cloud SSD.app`; post-launch Developer ID,
Gatekeeper and stapled-ticket checks passed, with zero Python bytecode caches.
Rclone configuration and the production application-library file remained
byte-for-byte unchanged. Eight preferences and the exact workspace destination
were preserved, including the 6 TB monthly selection, 100 GB cache setting and
chosen project/bucket.

The installed app is responsive and exposes one native accessibility window.
Python AX inspection did not retrieve its labels; no current Google-button or
authenticated-UI acceptance is claimed. The temporary previous-build backup
`GenDragoonCloudSSD.previous-56f1fd2c752a4c15b6fbbbf17356d89a.app` remains for
final cleanup; it is no longer the current installation.

### Why builds 20 and 21 were superseded

An early build-20 package was signed but unnotarized; that observation remains
in `mac-package.json`. Later, with notarization authentication resolved, a
build-20 candidate was accepted by Apple. A subsequent real smoke test created
and modified Python bytecode inside its signed Resources directory, invalidating
the bundle signature. That accepted-then-modified bundle was not a valid final
replacement.

Build 21 disabled bytecode writes at native Python entrypoints, Swift launches,
and child interpreters, removed inherited bytecode caches before signing, and
made packaging reject cache artifacts. Its real lifecycle and file-metadata
smoke tests passed with the signature intact. After legitimate native Google
Cloud configuration, the small file passed upload verification and a separate
restore, giving two cloud readbacks. The folder uploaded and passed its first
byte-for-byte readback, but strict restore verification detected missing root
directory metadata. Local reproduction isolated the missing
`app.gendragoon.cloudsmoke` attribute; files, relative symlinks, empty directories
and executable flags matched. The safeguards retained originals and the
production library index, and the Mac signature remained valid. This partial
trial was not a completed file/folder/app cloud acceptance pass.

Build-22 source fixes the root metadata omission by using native `copyfile`
AppleDouble serialization to supplement a missing `__MACOSX/._<root-name>` entry
before hashing and uploading the ZIP. A real Mac component diagnostic proved
that this standard entry restores the exact root metadata without copying the
full source tree. The committed regression and expanded real-smoke coverage
include root and nested directory attributes, empty attributes, resource forks,
relative symlinks, executable flags and unchanged-original checks. Manifest
strictness, archive path validation and space reserves were not reduced. The
source also adds read-only native filesystem inventory. Build 22's expanded
real-Mac archive smoke, bounded file/folder/app cloud roundtrip and Apple
notarization now passed as recorded above. The verified build-22 installation
and relaunch have also completed; temporary previous-build cleanup remains.

## Historical checks observed earlier in this integration

The table below preserves earlier observations and their original test counts.
These are not current build-22 pass claims; in particular, a historical report
whose filename contains `final` still belongs to its earlier candidate.

| Check | Observed result | Scope |
|---|---|---|
| Google Cloud destination | Bucket `gen-dragoon-ssd` belongs to project ID `gendragood-ssd`, project number `10068843866`; project active | Existing delegated Google credentials; bucket metadata and Resource Manager |
| Existing selected tier | 6 TB; monthly default where no annual preference was saved | Existing native preferences; retained by the new purchase UI |
| Live backend deep health | HTTP 200; dependencies ready | Existing Cloud Run service |
| Live v3 capabilities | Protocol 3, resumable/parallel uploads and range downloads available | Public capability response |
| Live billing status | Checkout enabled; live mode; webhook configured; runtime storage verified | Server readiness response, not a completed purchase |
| macOS compilation | Earlier active Swift sources compiled as 0.17.0 (20) | Apple Silicon Mac, macOS/Xcode 27 |
| macOS signature | `codesign --verify --deep --strict` passed at that observation | Earlier locally staged Developer ID-signed bundle; later bytecode mutation is recorded above |
| Real macOS lifecycle | All 3 cases passed on the earlier signed candidate helpers: automatic cache cleanup, explicit cache retention, and changed-cache retention | Locally compiled/ad hoc-signed disposable AppKit applications; actual LaunchServices, kernel executable identity, start time, open resources and watcher identity; originals/index unchanged; no cloud calls or security-policy changes |
| iOS compilation | `xcodebuild` simulator build succeeded | Real Xcode build; ZIPFoundation 0.9.20 revision resolved and saved |
| Integrated Python suite | 152 passed | Disposable upload, restore, selection, cleanup, restart, vendor refresh, and updater fixtures |
| Launch lifecycle/security suite | 36 passed | Disposable cache and receipt tests, including unexpected/late files, changed leaves and swapped symlink parents; process/mount operations substituted |
| Preloader suite | 8 passed | Byte budgets, priorities, bounded reads, symlinks, unchanged content |
| Metadata regression suite | 13 passed, in addition to the integrated library cases | macOS native fallback, resource-fork hashes, no-follow reads, bounded metadata, restore compatibility and original preservation |
| Backend regression/security | 118 passed; production npm audit: zero vulnerabilities | Actual local HTTP/router tests with controlled storage/Stripe fixtures |
| Deployment and candidate verifier helpers | 31 passed | 10 deployment tests and 21 verifier tests; no-traffic/tag handling, unchanged service configuration, private source allowlist, TLS/credential boundaries and bounded diagnostic requests |
| Native helper stress | 10,000 files verified; 512 index commits across 16 workers; 300 hostile archives rejected; mutation detected | Disposable local storage, 2.451 seconds on the Linux test host |
| Mac installer/reference helper fixtures | 167 passed | Signature/Gatekeeper rejection, archive integrity, installation/update/reset safety and guarded replacement fixtures |
| Linux desktop companion | 35 passed; 1 expected Windows-only skip | Actual local v3-router transfer/readback and Linux process-group lifecycle; changed and unexpected cache-data retention; 36 tests in 4.411 seconds on the recorded earlier CI run |
| Windows desktop companion | 32 passed; 4 expected platform skips | Actual Windows Job Object launch and managed-cache eviction; actual local v3-router transfer/readback; 36 tests in 39.188 seconds on the recorded earlier push run and 40.390 seconds on its PR run |
| Android compilation | Java compilation and debug APK assembly passed | GitHub hosted runner; unit-test task reported NO-SOURCE, so no Android unit or device test pass is implied |
| Cross-platform CI | All 7 jobs passed for earlier code commit `18b54fcd21698239e7ca2775cd8e3b3c41d3ae38` | [Push run 39023761715](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/actions/runs/39023761715) and [PR run 39023766003](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/actions/runs/39023766003); original run evidence is retained |
| Real macOS archive roundtrip | Passed | Production `ditto` packaging/extraction restored data, resource forks, custom attributes and empty attributes; later data/metadata mutations rejected; original preserved; 2,050-byte fixture; 0.027 seconds |
| Native startup UI | Passed | The complete staged 0.17.0 (20) app opened through macOS Launch Services; its native Google sign-in window and Continue with Google button were observed; then a graceful quit was requested |
| Bundled Node refresh | Passed | Official Node 24.22.0 arm64 archive passed its pinned SHA-256; runtime version, existing JIT entitlements and re-signed bundle verified; provenance and license retained |
| Mac candidate packaging | Earlier package passed strict signature, source comparison and generated-installer archive checks | 0.17.0 (20), arm64/macOS 14+; 69,524,635-byte ZIP; source commit `7c37bb40b9e093ef157fef830a2eb079112a395e`; matching Swift inputs and 14 first-party resources; this particular historical package was unnotarized and ineligible for installation or automatic updates |

Build/test outputs are retained during development in the Mac validation
workspace and summarized here. No private credentials are included.

The first real Mac lifecycle run exposed that the Python.org macOS runtime
does not expose `os.listxattr`. The corrected helper uses bounded, no-follow
Darwin `libSystem` calls when Python lacks the APIs. The real Mac rerun above
passed with that correction; metadata errors still retain the original.

The real file-restore trial also showed that macOS `ditto --keepParent` wraps a
single file in its parent directory. Production packaging now omits that flag
for regular files and keeps it for folders and application bundles, with the
build-22 root AppleDouble supplement described above. Extended
attributes that cannot be preserved by the raw streaming layout make an app
ineligible for that layout; it falls back to verified archive/local staging.

A later lifecycle run reached the old harness's shared 55-second limit after
cleanup and keep-cache passed, before the dirty-cache case completed. The
harness now allocates preparation 20 seconds, each of the three cases its own
30 seconds, final checks 5 seconds and cleanup 5 seconds, with a hard 120-second
total. Six deadline regression tests pass. Production quiet checks, process
validation, fixture self-exit and the 5 MiB fixture cap are unchanged. The
recorded earlier Mac rerun passed all cases and the file archive test. Build
22's expanded directory-metadata smoke passed separately in 0.371 seconds;
its lifecycle timeout and successful retry are recorded in the current results.

The Mac signature check exposed a real command-line bug: `codesign -R` treated
a bare requirement string as a filename. All six affected source call sites
now pass the explicit inline `=` prefix. The exact Developer ID/team predicate
passed on the Mac; the existing strict signature and Gatekeeper checks remain.

Cache review reproduced deletion of unexpected files beside and inside a
verified app. Cleanup now restricts removal to the recorded managed payload,
checks each leaf before removal and removes directories non-recursively.
Regression checks cover pre-existing and late-added content, changed leaves
and swapped symlink parents. User data outside managed cache is excluded.

The Windows follow-up fixed CPython's differing path-stat and descriptor-stat
representations of creation/change time and filename-derived execute bits.
Normalization is confined to comparisons between those APIs. Full same-API
before/after fingerprints, file identity, link/reparse guards and content hashes
remain checked. Both previously failing Windows cleanup cases passed in the two
recorded earlier runs above. The exact job results are retained in
[cross-platform-ci.json](validation/2026-10-17/cross-platform-ci.json).

## Deployed backend candidate and bounded load evidence

The source at `c5b02fc89e05f71a96c984cd152fb162f6242e43` was deployed as revision
`gendragoon-free-00025-qik`, tag `review-0170-20261017a`, with **zero production
traffic**. Its literal environment, secret bindings, runtime service identity
and container count match the serving revision. The tagged URL is
<https://review-0170-20261017a---gendragoon-free-f6kvqszh5a-uc.a.run.app>.
This candidate shares the existing service's data and secret configuration.

Health, transfer capabilities and pricing returned HTTP 200. Anonymous GETs to
all five checked account/file/key/workspace/entitlement routes returned 401.
The verifier used ADC only for the fixed Google Cloud control-plane origin,
verified HTTPS certificates and hostnames, refused redirects, and did not
print configuration values or fetch secret payloads. It excluded billing
activation because that endpoint can create configuration and validation state.

| Bounded public-endpoint run | Successful | Failed | p50 | p95 | Elapsed |
|---|---:|---:|---:|---:|---:|
| First Mac run | 240 / 256 | 16 timeouts | 709.717 ms | 5,122.740 ms | 26.980 s |
| Independent workspace probe | 256 / 256 | 0 | 399.108 ms | 531.865 ms | 6.739 s |
| Full Mac repeat | 256 / 256 | 0 | 99.637 ms | 119.595 ms | 2.128 s |

Every run kept 16 workers, a five-second request budget, a 45-second load
deadline and no retries. The verifier gained per-path and request-phase
diagnostics; neither the backend behavior nor these limits changed. The first
timeouts did not reproduce, and their cause remains unresolved. The repeat
confirmed the same candidate still had zero production traffic afterward.
Both Mac reports are retained under [validation/2026-10-17](validation/2026-10-17).

These checks cover bounded public-endpoint concurrency and anonymous access
rejection. They do not establish authenticated large transfers, sustained
saturation capacity, successful Stripe payment/webhooks, or an independent
penetration test. The candidate has not been promoted to production.

## Installation status and remaining scope

Notarization authentication is now resolved through the existing
`GenDragoonNotary` Keychain profile. The earlier HTTP 401 and unnotarized
Gatekeeper results are historical observations, not current credential
blockers. Build 20's later Apple acceptance did not survive its subsequent
resource mutation and cannot authorize build 22. Build 22 has completed the Mac
tests, bounded cloud fixture roundtrip and strict signature checks recorded
above. Its own Apple submission was accepted, its ticket stapled, and Gatekeeper
and package verification passed. The verified GitHub download has been
installed as 0.17.0 (22), and the new app relaunched as PID 22611 from the
expected installation. Post-launch trust, signed-resource integrity, settings
and workspace checks passed. Final temporary-backup cleanup remains pending.

The current user request authorizes installing a verified Mac test candidate.
No public stable-release or paid-billing acceptance is claimed by that test
installation. The published release is marked as a candidate and deliberately
excluded from automatic updates. Actual installer, installed-version,
post-launch trust and process/window observations support the test installation
reported here; they do not complete the broader production checks below.

Six obsolete GenDragoon app copies have been deleted, and the former current
**0.16.2 (19)** has been replaced by **0.17.0 (22)**. Its temporary installer
backup remains pending final cleanup. The new app is running; removing that
backup must be recorded separately before claiming all old copies are gone.

Node 24.22.0 includes the maintenance fix documented in its
[official release](https://nodejs.org/en/blog/release/v24.22.0). Separately,
Node's [October security notice](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
announces HIGH-severity fixes for 24.x on or after October 21. As of this
October 17 validation, the fixed version and vulnerability details are not
published. This candidate cannot claim to include those unreleased fixes.
See [VENDOR_REFRESH.md](VENDOR_REFRESH.md) and the recorded runtime provenance.

The Mac began with limited free storage. The early package report observed
7.81 GiB free after native/mobile builds; this is a historical measurement.
Later build and test work resumed after space management. The initial build-22
cloud attempt's read-only diagnostic measured 9.523 GiB free, below the first
file's 10.062501833 GiB requirement. Cleaning nine owned, idle compiler-cache
locations made room for the successful retry, which observed 11.024 GiB free
at its start and 11.021 GiB afterward. After packaging and the fresh release
download, an earlier installation preflight observed 9.423 GiB free, below its
10.264 GiB requirement. The successful installation later passed at 10.777 GiB
free after space reclamation. The existing 10 GiB reserve has not been reduced
to make tests pass. Every new archive-staging, large-app or installation
operation must use its actual current free-space check; bounded fixtures do not
establish large-app compatibility or capacity.

The earlier disconnected-browser observation and Desktop Commander timeout at
10:04 UTC are historical. Mac operations subsequently resumed, including
credential validation, build-22 notarization, the completed Mac tests and cloud
fixture retry, verified prerelease download, installation and relaunch recorded
above. The earlier build-20 Google sign-in window observation remains historical.
For the installed build 22, one native accessibility window and a responsive
process were observed, but Python AX did not extract window labels. Complete
Firebase/Google sign-in in the app, authenticated native UI and Checkout remain
unverified. Installed-version and post-launch trust checks passed; temporary
previous-build backup removal is the remaining old-copy cleanup.

The accessible Stripe connector account is live. No sandbox purchase has been
completed in this integration, and no real paid subscription was purchased.
An open or expired Checkout Session and a successful readiness response do not
prove successful payment, webhook fulfillment, entitlement activation,
cancellation, renewal, or refund handling. Owner complimentary access is also
not evidence of a paid checkout.

Existing `gdsk_` API keys authorize scoped file operations for their owning
workspace. They do not carry invented administrator scopes. Server-verified
Google identity and backend owner policy control owner benefits. A protected
local billing directory was not readable and its permissions were not changed;
no private owner credential has been copied to source or displayed.

The local Android SDK installation lacks platform/build-tool packages, and its
newest CLI binary targets the wrong CPU. The older Java SDK manager runs, but
there are no already accepted SDK license records. Android compilation is
configured for a GitHub hosted Android build environment. Device installation,
Play/App Store distribution, and mobile application-provider integration are
separate checks. Windows/Linux support currently includes a tested command-line
companion rather than a completed graphical app for those platforms.

## Gates applied to the authorized Mac test installation

1. Built the committed candidate and recorded its dependency, regression and
   source-linked CI results; matched the package to that source and version.
2. Passed the real Mac lifecycle retry, metadata and controlled cloud fixture
   checks with originals/index retained and a valid bundle signature afterward.
   Earlier failures remain recorded; platform security and space guards were
   not reduced.
3. Completed this bundle's Apple notarization, stapling, strict signature and
   Gatekeeper checks, then generated, downloaded and verified the package.
4. Used the generated installer and actual activity/inventory checks for the
   requested replacement; verified installed 0.17.0 (22), successful relaunch,
   post-launch trust and preserved settings/configuration. Six obsolete copies
   were removed; final cleanup of the temporary build-19 backup remains pending.

These gates support the user's request to test the Mac application. Pending
paid Stripe acceptance, representative large-app trials and other platforms'
graphical applications remain separate production acceptance work. Their
limitations must remain explicit in the test-installation handoff.

## Broader production acceptance remains open

- Complete Firebase/Google authentication and authenticated native UI acceptance.
- Verify selected paid-plan checkout, successful payment, webhook fulfillment,
  entitlements and subscription lifecycle in the appropriate controlled account
  and environment. Live readiness or owner complimentary access is insufficient.
- Validate representative compatible large applications, optimized preloading,
  managed cache/install, exit cleanup and retained data under realistic disk and
  network conditions; extend authenticated transfer/offload acceptance beyond
  the tiny fixtures.
- Complete Windows/Linux graphical apps and iOS/Android device/provider behavior,
  installation and distribution. Current compile and companion results have the
  narrower scopes recorded above.
- Establish sustained authenticated load/capacity and broader security evidence.
  The bounded public-endpoint runs and hostile-fixture tests are not exhaustive
  full-application stress validation or an independent penetration test.

The repository includes CI for native helpers, Windows/Linux companion,
backend regression/security checks, macOS compilation, Android compilation,
and iOS simulator compilation. A workflow definition is not a passing run;
record the source-linked observed run result before treating those gates as
complete. A verified test installation does not certify a public stable release
or promote the zero-traffic backend candidate to production.
