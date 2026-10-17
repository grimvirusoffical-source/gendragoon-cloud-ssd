# Validation record — 2026-10-17

This is an engineering validation record, not a claim that every requested
feature has passed a complete production acceptance test. No real customer
charge, deletion of user originals, or replacement of the installed Mac app
is implied by source/unit-test results.

## Verified during this integration

| Check | Observed result | Scope |
|---|---|---|
| Google Cloud destination | Bucket `gen-dragoon-ssd` belongs to project ID `gendragood-ssd`, project number `10068843866`; project active | Existing delegated Google credentials; bucket metadata and Resource Manager |
| Existing selected tier | 6 TB; monthly default where no annual preference was saved | Existing native preferences; retained by the new purchase UI |
| Live backend deep health | HTTP 200; dependencies ready | Existing Cloud Run service |
| Live v3 capabilities | Protocol 3, resumable/parallel uploads and range downloads available | Public capability response |
| Live billing status | Checkout enabled; live mode; webhook configured; runtime storage verified | Server readiness response, not a completed purchase |
| macOS compilation | Full active Swift sources compiled as 0.17.0 (20) | Apple Silicon Mac, macOS/Xcode 27 |
| macOS signature | `codesign --verify --deep --strict` passed | Locally staged Developer ID-signed bundle |
| Real macOS lifecycle | All 3 cases passed on the final signed candidate helpers: automatic cache cleanup, explicit cache retention, and changed-cache retention | Locally compiled/ad hoc-signed disposable AppKit applications; actual LaunchServices, kernel executable identity, start time, open resources and watcher identity; originals/index unchanged; no cloud calls or security-policy changes; parent signature still valid after both final Mac smoke tests |
| iOS compilation | `xcodebuild` simulator build succeeded | Real Xcode build; ZIPFoundation 0.9.20 revision resolved and saved |
| Integrated Python suite | 152 passed | Disposable upload, restore, selection, cleanup, restart, vendor refresh, and updater fixtures |
| Launch lifecycle/security suite | 36 passed | Disposable cache and receipt tests, including unexpected/late files, changed leaves and swapped symlink parents; process/mount operations substituted |
| Preloader suite | 8 passed | Byte budgets, priorities, bounded reads, symlinks, unchanged content |
| Metadata regression suite | 13 passed, in addition to the integrated library cases | macOS native fallback, resource-fork hashes, no-follow reads, bounded metadata, restore compatibility and original preservation |
| Backend regression/security | 118 passed; production npm audit: zero vulnerabilities | Actual local HTTP/router tests with controlled storage/Stripe fixtures |
| Deployment and candidate verifier helpers | 31 passed | 10 deployment tests and 21 verifier tests; no-traffic/tag handling, unchanged service configuration, private source allowlist, TLS/credential boundaries and bounded diagnostic requests |
| Native helper stress | 10,000 files verified; 512 index commits across 16 workers; 300 hostile archives rejected; mutation detected | Disposable local storage, 2.451 seconds on the Linux test host |
| Mac installer/reference helper fixtures | 167 passed | Signature/Gatekeeper rejection, archive integrity, installation/update/reset safety and guarded replacement fixtures |
| Linux desktop companion | 35 passed; 1 expected Windows-only skip | Actual local v3-router transfer/readback and Linux process-group lifecycle; changed and unexpected cache-data retention; 36 tests in 4.411 seconds on the final code CI run |
| Windows desktop companion | 32 passed; 4 expected platform skips | Actual Windows Job Object launch and managed-cache eviction; actual local v3-router transfer/readback; 36 tests in 39.188 seconds on the final code push run and 40.390 seconds on its PR run |
| Android compilation | Java compilation and debug APK assembly passed | GitHub hosted runner; unit-test task reported NO-SOURCE, so no Android unit or device test pass is implied |
| Cross-platform CI | All 7 jobs passed for code commit `18b54fcd21698239e7ca2775cd8e3b3c41d3ae38` | [Push run 39023761715](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/actions/runs/39023761715) and [PR run 39023766003](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/actions/runs/39023766003); this documentation refresh records those observed results |
| Real macOS archive roundtrip | Passed | Production `ditto` packaging/extraction restored data, resource forks, custom attributes and empty attributes; later data/metadata mutations rejected; original preserved; 2,050-byte fixture; 0.027 seconds |
| Native startup UI | Passed | The complete staged 0.17.0 (20) app opened through macOS Launch Services; its native Google sign-in window and Continue with Google button were observed; then a graceful quit was requested |
| Bundled Node refresh | Passed | Official Node 24.22.0 arm64 archive passed its pinned SHA-256; runtime version, existing JIT entitlements and re-signed bundle verified; provenance and license retained |
| Mac candidate packaging | Passed strict signature, source comparison and generated-installer archive checks | 0.17.0 (20), arm64/macOS 14+; 69,524,635-byte ZIP; source commit `7c37bb40b9e093ef157fef830a2eb079112a395e`; matching Swift inputs and 14 first-party resources; Gatekeeper remains rejected, with installation and automatic updates ineligible |

Build/test outputs are retained during development in the Mac validation
workspace and summarized here. No private credentials are included.

The first real Mac lifecycle run exposed that the Python.org macOS runtime
does not expose `os.listxattr`. The corrected helper uses bounded, no-follow
Darwin `libSystem` calls when Python lacks the APIs. The real Mac rerun above
passed with that correction; metadata errors still retain the original.

The real file-restore trial also showed that macOS `ditto --keepParent` wraps a
single file in its parent directory. Production packaging now omits that flag
for regular files and keeps it for folders and application bundles. Extended
attributes that cannot be preserved by the raw streaming layout make an app
ineligible for that layout; it falls back to verified archive/local staging.

A later lifecycle run reached the old harness's shared 55-second limit after
cleanup and keep-cache passed, before the dirty-cache case completed. The
harness now allocates preparation 20 seconds, each of the three cases its own
30 seconds, final checks 5 seconds and cleanup 5 seconds, with a hard 120-second
total. Six deadline regression tests pass. Production quiet checks, process
validation, fixture self-exit and the 5 MiB fixture cap are unchanged. The final
Mac rerun passed all cases and the archive test; it retained valid signatures.

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
final runs above. The exact job results are retained in
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

## Installation and production gates

The staged Mac bundle is **not yet an installable public release**. Gatekeeper
assessment returned `rejected: source=Unnotarized Developer ID`. The available
App Store Connect keys returned HTTP 401 with the available authentication
configuration. A valid notarization credential configuration, including the
issuer ID when using a team API key, is needed before notarization, stapling,
production release packaging, automatic update, or a checked reinstall can pass.
The separately marked candidate ZIP can be inspected without treating it as a
trusted release; its archive-only verification does not assess Apple trust.

Node 24.22.0 includes the maintenance fix documented in its
[official release](https://nodejs.org/en/blog/release/v24.22.0). Separately,
Node's [October security notice](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
announces HIGH-severity fixes for 24.x on or after October 21. As of this
October 17 validation, the fixed version and vulnerability details are not
published. This candidate cannot claim to include those unreleased fixes.
See [VENDOR_REFRESH.md](VENDOR_REFRESH.md) and the recorded runtime provenance.

The Mac began with limited free storage. Native/mobile builds brought free
space below the existing 10 GiB reserve. Verified generated build intermediates
were cleaned after validation; the final package record still observed 7.81 GiB
free. The reserve was not reduced to make tests pass.
Production archive staging, large-app trials, and the installer must have
sufficient actual space. The bounded fixture tests are not a substitute for a
large real application's compatibility and streaming/performance trial.

The connected browser plugin reported that the browser was not connected.
Desktop Commander file/process operations and native accessibility inspection
were used for the completed Mac checks. Native startup was visually verified at
the Google sign-in gate. Later Desktop Commander process requests timed out; a
read-only file request ended at 10:04 UTC with no response from the device.
The final candidate remains staged on the Mac, without a GitHub release upload.
Complete sign-in, Checkout interaction, and authenticated acceptance testing
still need the actual connected browser/user session. Existing Mac
installations remain available until the replacement passes its installation
and acceptance gates.

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

## Required evidence before replacing the installed Mac app

1. Final native build and dependency/regression tests pass for the committed source.
2. Real Mac launch/cache smoke tests pass without altering platform security policy.
3. Authenticated upload/download/offload, selected-plan checkout and webhook
   fulfillment are verified in the appropriate controlled account/environment.
4. Representative compatible large applications pass launch, cache, exit, and
   retained-data checks under realistic disk/network conditions.
5. Apple notarization/stapling and Gatekeeper assessment pass.
6. The checksum-pinned installer passes, the new app launches, and its user-facing
   behavior is checked before old installations are removed.

The repository includes CI for native helpers, Windows/Linux companion,
backend regression/security checks, macOS compilation, Android compilation,
and iOS simulator compilation. A workflow definition is not a passing run;
record the observed run result before treating those gates as complete.
