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
| iOS compilation | `xcodebuild` simulator build succeeded | Real Xcode build; ZIPFoundation 0.9.20 revision resolved and saved |
| Integrated Python suite | 137 passed | Disposable upload, restore, selection, cleanup, restart, and updater fixtures |
| Launch lifecycle/security suite | 29 passed | Disposable cache and receipt tests; process/mount operations substituted |
| Preloader suite | 8 passed | Byte budgets, priorities, bounded reads, symlinks, unchanged content |
| Native helper stress | 10,000 files verified; 512 index commits across 16 workers; 300 hostile archives rejected; mutation detected | Disposable local storage, approximately 2 seconds on the Linux test host |
| Desktop companion tests | 22 implemented cases passed initially; Windows-specific runtime case added | Actual local v3-router fixture and Linux child-process lifecycle; Windows requires its CI runner |

Build/test outputs are retained during development in the Mac validation
workspace and summarized here. No private credentials are included.

## Installation and production gates

The staged Mac bundle is **not yet an installable public release**. Gatekeeper
assessment returned `rejected: source=Unnotarized Developer ID`. The available
App Store Connect keys returned HTTP 401 with the available authentication
configuration. A valid notarization credential configuration, including the
issuer ID when using a team API key, is needed before notarization, stapling,
release packaging, automatic update, or a checked reinstall can pass.

The Mac began with limited free storage. Native/mobile builds brought free
space below the existing 10 GiB reserve. Generated build intermediates are
being cleaned after validation; the reserve is not reduced to make tests pass.
Production archive staging, large-app trials, and the installer must have
sufficient actual space. The bounded fixture tests are not a substitute for a
large real application's compatibility and streaming/performance trial.

The connected browser plugin reported that the browser was not connected.
Desktop Commander file/process operations work. Complete native sign-in,
Checkout interaction, and visual acceptance testing need the actual connected
browser/user session. Existing Mac installations remain available until the
replacement passes its installation and acceptance gates.

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
