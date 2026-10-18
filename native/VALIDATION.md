# Validation record — 2026-10-18

**Mac replacement is complete. GenDragoon 0.18.0 build 29 is installed and running.
The upload-receipt server fix is live. Full product acceptance remains incomplete.**

## Current installation and automatic update

The installed app is at `~/Applications/GenDragoon Cloud SSD.app`. The latest public
preview is [v0.18.0-rc.3](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/releases/tag/v0.18.0-rc.3).
Its signed production source is `577c2a7c98f3c70a00937594c6a206dd353b5004`.
The subsequent `0bb1d5abb05e7571b230922085c22419705527b0` changes only an atomic
test-fixture receipt; it does not change the signed application code.

| Check | Observed result | Evidence |
|---|---|---|
| Mac compilation and signing | Build 29 passed on the actual arm64 Mac | [Build](validation/2026-10-18/build29-macos.json) |
| Apple trust | Notarization, stapling and Gatekeeper passed; post-install checks passed | [Notarization](validation/2026-10-18/build29-notarization.json), [installed checks](validation/2026-10-18/build29-installed-preservation.json) |
| Fresh release download | All five assets matched their expected hashes | [Download](validation/2026-10-18/build29-release-download.json) |
| Actual automatic 27→29 update | Passed in **58.795 seconds**, with no externally invoked updater or quit | [Installed-app acceptance](validation/2026-10-18/build29-automatic-update-acceptance.json) |
| Preservation | All 23 saved preferences matched the baseline; application-library and rclone-configuration hashes were unchanged | [Preservation](validation/2026-10-18/build29-installed-preservation.json) |
| Old installations | Cleanup left build 29 as the only matching app in the scanned Applications, Downloads, Desktop and updater locations; no scan errors or outside Spotlight matches | [Cleanup](validation/2026-10-18/build29-old-installations-cleanup.json) |
| Production Swift helper | Four real Mac completion/failure/timeout/cancellation cases passed in 28.330 seconds | [Helper tests](validation/2026-10-18/build29-native-helper.json) |

The actual updater test started build 27 as PID 65419. It exited normally at about
43.84 seconds; installation began at about 50.09 seconds; build 29 appeared as
PID 65660 at about 56.69 seconds. The final receipt reached
`exact_executable_observed` at 58.795 seconds.

The release ZIP is 69,722,465 bytes with SHA-256
`c087b8fb5bb42144b91805c5258e8674d4d321c8fe6ebff3a036c39e1f0b01d5`.
The latest downloaded ZIP and installation scripts were retained. Cloud data,
settings, application-library data and source archives were retained.
The 10 GiB free-space reserve was not reduced.

## Upload-receipt failure and live repair

The running app displayed `Transfer unavailable; retry safely` during an upload.
The v3 chunk handler saved its GCS chunk, then tried to persist `receivedRanges`
as nested arrays. Firestore Standard rejects that value shape. Earlier mocks
did not enforce the database restriction.

Commit `b0a50bd8d6b220edbb891d849601c2f18f4c0d76` stores receipt entries as maps
(`[{start: 0, end: 0}]`). The HTTP protocol still returns pairs (`[[0, 0]]`),
and legacy pair receipts remain readable. Every receipt read validates bounds
and canonical ranges; malformed progress fails closed. An already saved chunk
can be retried after a failed metadata transaction without double-counting bytes.

- The original upload test reproduced HTTP 503 after adding the real database
  constraint to its fixture, before changing production code.
  [Regression reproduction](validation/2026-10-18/backend-range-fix-red.json)
- All **171 backend tests passed in 11.671 seconds**, including out-of-order
  chunks, interrupted metadata commits, duplicate retries, legacy resume,
  zero-byte files, exact downloads, quotas, ownership and per-tier stress fixtures.
  [Tests](validation/2026-10-18/backend-range-fix-tests.json)
- Production dependency audit reported **zero vulnerabilities**.
  [Audit](validation/2026-10-18/backend-range-fix-audit.json)
- A temporary document in the actual storage project's Firestore reproduced
  `INVALID_ARGUMENT: Nested arrays are not allowed`. Map receipts then wrote
  and read successfully; two concurrent retries counted one chunk once.
  The fixture was deleted and customer records were untouched.
  [Real Firestore proof](validation/2026-10-18/backend-range-fix-firestore.json)

The real Firestore proof verifies the persistence defect and repair. It does
not establish an authenticated native upload/download roundtrip.

## Deployment and source-linked CI

All seven jobs passed in [push run 39089772493](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/actions/runs/39089772493)
and [PR run 39089775087](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/actions/runs/39089775087)
for the backend fix. These jobs cover backend/native fixtures, Mac compilation,
Windows/Linux desktop fixtures, Android build/tests and iOS simulator build.
Their names do not imply complete device or platform acceptance.
[CI result](validation/2026-10-18/backend-range-fix-ci.json)

Candidate `gendragoon-free-00028-rey` passed 256/256 public endpoint requests
with 16 workers and rejected anonymous protected requests. Service identity,
literal environment and secret bindings matched the serving revision.
[Candidate check](validation/2026-10-18/backend-range-fix-candidate-verification.json)

That revision now receives **100% production traffic**, and the six existing
public aliases point to it. The earlier review tag was removed. The initial
post-promotion readiness snapshot encountered cold-start initialization and
failed; that result is preserved. A separate check 69.778 seconds later passed:
health 200, billing readiness 200, anonymous projects 401, and invalid webhook
signature 400. Checkout, project creation and runtime storage verification were
enabled. No live payment was submitted.
[Promotion](validation/2026-10-18/backend-range-fix-promotion.json),
[canonical readiness](validation/2026-10-18/backend-range-fix-canonical-ready.json)

Do not roll back to the previous receipt reader after map receipts have been
written; a rollback target must understand both receipt representations.

## Native UI and continuing acceptance limits

The signed-in build-29 window showed distinct Files and Applications pages,
an enabled project file/folder upload control, an enabled connected-bucket scan
control and the retained selected project with 24 authorized transfer workers.
Native accessibility activation did not reliably open the project upload picker,
so **no authenticated fixture upload was submitted and the native roundtrip is
unverified**. The disposable source folder remains unchanged. The originals
checkbox was restored and observed selected after the reversible UI check.
[Native UI record](validation/2026-10-18/build29-native-ui-acceptance.json)

Previously completed component evidence includes four real Mac project-envelope
cases, six Swift transfer-budget checks, 168 SHA-256-verified real GCS roundtrips
across seven worker settings, and three actual AppKit cache-lifecycle fixture
cases. The real network measurements were not monotonically faster at higher
worker settings. The Mac lifecycle fixtures were disposable apps, not commercial
games. [Release feature and component notes](RELEASE_0_18.md),
[lifecycle evidence](validation/2026-10-18/build24-mac-lifecycle.json)

Still incomplete: authenticated native Files upload/download acceptance; a paid
Stripe sandbox purchase and fulfillment lifecycle; representative large
commercial-app/game launch, preloading and cache cleanup; complete Windows/Linux
graphical and iOS/Android device/provider behavior and distribution; sustained
authenticated load and broader security acceptance. Project removal currently
archives the product project and retains cloud data and continuing subscriptions;
it is not permanent deletion of a Google Cloud project.

## Historical observations

Earlier failed handoffs, helper deadlock, open-file inspection timeouts and
free-space blocks remain recorded. They are superseded only where later
evidence establishes a passing result.

- [Build-22 and earlier validation record](VALIDATION_2026_10_17_BUILD22.md)
- [Build-24 handoff and backend-26 history](validation/2026-10-18/README_BUILD24_HISTORY.md)
- [Build-23 stalled cloud-helper diagnosis](validation/2026-10-18/build23-stalled-cloud-discovery-diagnostic.json)
- [Failed bootstrap attempt retained as evidence](validation/2026-10-18/build27-bootstrap-attempt-73614a8bd6f24c4980784b1b6e03b992.json)
- [Successful bootstrap retry](validation/2026-10-18/build27-bootstrap-postquit-retry.json)
