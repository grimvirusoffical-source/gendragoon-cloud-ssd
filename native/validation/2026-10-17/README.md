# Observed validation evidence — October 17, 2026

These reports preserve observed results from successive candidates, not
production acceptance certification. They contain no credentials or secret
configuration values. A historical filename containing `final` does not make
that report the current candidate's result. The full scope and remaining gates are in
[VALIDATION.md](../../VALIDATION.md).

## Current handoff — source 9214bdc, build 22

Production source `9214bdcdc3c953c39c5015177dc6185cfc61e95d` was built as
0.17.0 (22). The subsequent head
`950191aa36880b551bca8804dcf6ad545db57133` changes only two test fixtures;
production source and signed resources are unchanged by that commit. All seven
CI jobs succeeded in each of [push run 39064762933](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/actions/runs/39064762933)
and [PR run 39064767064](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/actions/runs/39064767064)
at that head. Real Mac compilation, focused tests, expanded metadata smoke and
a lifecycle retry completed. After an initial attempt stopped at the unchanged
space reserve, a separate cloud retry passed exactly three tiny uploads and
six full readbacks. **Build 22 is Apple-notarized, stapled, Gatekeeper-accepted,
packaged and published as a GitHub prerelease; its fresh download is verified.**
The freshly downloaded generated installer has installed **0.17.0 (22)** at
`~/Applications/GenDragoon Cloud SSD.app`, replacing 0.16.2 (19), and the new app
relaunched as PID 22611 matched to that installation. Its successful preflight
had 10.777 GiB free with the 10 GiB reserve unchanged. Post-launch Apple trust,
settings and workspace checks passed. Temporary old-build backup cleanup and
detailed window-label inspection remain pending.

| Current observed check | Result and scope |
|---|---|
| Real arm64 Mac focused suite | 108 tests passed in 23.320 seconds at `950191aa36880b551bca8804dcf6ad545db57133`; Developer ID strict signature valid after tests |
| Native filesystem inventory | 20 entries observed, including root and old NFS mounts; shared readers agreed; no disk operation |
| Expanded Mac archive smoke | Passed in 0.371 seconds; root/nested extended attributes, resource forks, empty attributes, relative symlinks and executable bits preserved |
| Real Mac lifecycle | First keep-cache case timed out at 30 seconds; independent retry passed all three cases in 59.268 seconds, with the same 30-second per-case and 120-second total limits; cleanup 26.0 seconds, keep 10.8 seconds, dirty-cache retention 10.6 seconds |
| Build-22 GCS retry | Passed in 42.929 seconds: exactly 3 tiny uploads and 6 full readbacks, with all content/manifest metadata and independent restore checks matching; original fixtures, production index and strict signature unchanged |
| Earlier build-22 GCS attempt | Stopped before first upload after 26.697 seconds: 0 objects, 0 completed checks; ownership/empty prefix verified; 21,973 bytes of fixtures retained unchanged |
| Earlier production-space diagnostic | Read-only check confirmed 9.523 GiB free versus 10.062501833 GiB required for the first 656-byte file; 10 GiB reserve unchanged; production index and bundle signature intact |
| Successful retry free space | 11.024 GiB at start and 11.021 GiB afterward, following cleanup of 9 owned, idle compiler-cache locations; reserve unchanged |
| Latest CI native stress | 10,000 files, 16 writers, 512 commits and 300 rejected hostile archives in 2.775 seconds; local disposable fixtures, not cloud saturation |
| Latest CI backend/security | 118 tests passed, production audit reported 0 vulnerabilities, and 31 deployment/verifier tests passed; no paid purchase or independent penetration test implied |
| Apple notarization and trust | Submission `40e43cdb-e838-49bd-9c44-acc5b1b67aa8` accepted; build 22 signed, notarized, stapled and accepted by Gatekeeper |
| Package verification | 69,509,769-byte ZIP; 214,440,163 bytes expanded; exact generated build-22 installer passed archive verification |
| GitHub publication | [v0.17.0-rc.1](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/releases/tag/v0.17.0-rc.1), a prerelease targeting `950191aa36880b551bca8804dcf6ad545db57133`; `candidate: true`, `automaticUpdateEligible: false` |
| Fresh GitHub download | All 6 assets matched expected bytes/hashes and downloaded installer/archive verification passed |
| Earlier installation preflight | 9.423 GiB free versus 10.264 GiB required; correctly stopped before replacement; superseded by the successful preflight below |
| Successful installation and relaunch | Generated installer installed 0.17.0 (22) from the fresh GitHub download; preflight passed at 10.777 GiB free with the 10 GiB reserve unchanged; PID 22611 matched to the installed app |
| Post-launch trust | Developer ID, Gatekeeper and stapled ticket passed; zero Python bytecode caches in signed Resources |
| Settings and workspace | Rclone configuration and app-library file byte-for-byte unchanged; 8 preferences preserved, including 6 TB monthly, 100 GB cache and project/bucket; workspace destination exactly unchanged |
| Installed window | One native accessibility window; PID still running and responsive; Python AX did not extract labels, so detailed labels and native Google/Firebase UI acceptance remain unverified |
| Old installations | Six obsolete copies deleted and former current 0.16.2 (19) replaced; temporary build-19 installer backup awaiting final cleanup |

The published ZIP's SHA-256 is
`932b1fd7ed4b056c3d6f2edfd87895d1530a27a2f27036d01be59cab2e11a25f`.
The release is deliberately a test candidate and is not eligible for automatic
updates. The actual installation, process identity and post-launch trust checks
now establish the successful test replacement and relaunch, separately from
the package/download checks and broader production acceptance.

Before installation, old rclone PID 74542 was quiet for three samples over
12 seconds, received one `SIGTERM` and exited normally. Native inventory
verified that its NFS mount was absent, and the old bundle's helpers were
stopped. The temporary backup
`GenDragoonCloudSSD.previous-56f1fd2c752a4c15b6fbbbf17356d89a.app` remains pending
final cleanup. The current app is the installed build 22; no current
Google-button label or completed authenticated UI flow is claimed yet.

The lifecycle timeout remains a failed observation; the successful retry does
not erase it. The first cloud attempt's read-only diagnosis confirmed a
production safeguard. Its first-file requirement was 10,804,529,072 bytes free,
including 67,110,832 bytes for staging and the unchanged 10 GiB reserve. No
upload, offload, source deletion or production-index change occurred in that
initial attempt; it remains distinct from the successful retry.

The successful retry transferred `Small File.txt` as a 656-byte flat object,
`Complete Folder` as a 2,309-byte archive, and `Cloud Roundtrip.app` as a
3,757-byte archive through an isolated UUID prefix. Each completed upload
verification and an independent restore, yielding six full cloud readbacks.
Offload, cloud deletion, app launch, native Firebase UI and backend acceptance
were outside this cloud trial's scope. Tiny fixture success does not establish
large-application behavior. The sanitized report is retained as
[build22-gcs-roundtrip-retry.json](build22-gcs-roundtrip-retry.json).

Apple authentication is resolved through the Mac Keychain profile
`GenDragoonNotary`. A later build-20 candidate was accepted by Apple, then its
signature was broken by Python bytecode writes during a real smoke test.
Build 21 fixed the bytecode lifecycle and passed real lifecycle/file-metadata
checks with its signature intact. Its legitimate authenticated GCS trial
completed the small file's upload and separate restore (two readbacks), but
folder verification stopped after the first readback because the selected
directory's root extended attribute was missing. Originals and the production
index remained unchanged; the bundle signature stayed valid.

Build-22 source adds the native AppleDouble root-metadata supplement and
expanded directory-metadata regressions, plus read-only native filesystem
inventory. Current local runs passed 161 integrated tests, 41 focused
metadata/library tests, and 108 installer/control/inventory/bytecode tests;
the seven native inventory fixtures passed. These are overlapping run scopes,
not a combined count of unique tests. The real Mac focused suite above is also
a separate run with overlapping coverage. All seven CI jobs previously passed
for `fa35ec0cf4c07faaed0375ddd85a0c7044118c6f`; the two source-linked runs above
are the current CI observation.

The user's request authorized the verified Mac installation for testing, now
completed after its trust and component checks. Paid Stripe/Firebase UI acceptance, large real
applications, cross-platform graphical/device behavior, and sustained full-app
load/security acceptance remain broader unfinished work; they are not claims
made by the local test results or by a test installation.

## Build-22 report index

- [build22-ci.json](build22-ci.json): both successful seven-job CI runs for
  fixture-only head `950191aa36880b551bca8804dcf6ad545db57133`, with production
  Mac source `9214bdcdc3c953c39c5015177dc6185cfc61e95d` identified separately.
- [build22-mac-archive.json](build22-mac-archive.json): the 0.371-second real Mac
  file/folder/app metadata roundtrip, including root/nested attributes, empty
  attributes, resource forks, symlinks, executable bits and mutation guards.
- [build22-mac-lifecycle.json](build22-mac-lifecycle.json): the failed initial
  keep-cache case, retained with its 30-second deadline and observed timings.
- [build22-mac-lifecycle-retry.json](build22-mac-lifecycle-retry.json): all three
  lifecycle cases passed in 59.268 seconds, retaining the same per-case and
  overall deadlines.
- [build22-native-inventory.json](build22-native-inventory.json): 20 native
  filesystem entries, agreeing readers, root and selected cloud-drive presence;
  read-only observation with no disk operation.
- [build22-gcs-roundtrip.json](build22-gcs-roundtrip.json): the first cloud
  attempt stopped before any upload; includes the follow-up read-only
  production-space diagnosis and unchanged originals/index/signature.
- [build22-gcs-roundtrip-retry.json](build22-gcs-roundtrip-retry.json): successful
  42.929-second trial with three tiny uploads, six full readbacks and matching
  independent restores, within its isolated prefix and stated component scope.
- [build22-notarization-resume.json](build22-notarization-resume.json): completed
  build-22 notarization, signing, stapling and Gatekeeper acceptance for Apple
  submission `40e43cdb-e838-49bd-9c44-acc5b1b67aa8`.
- [build22-package-and-download.json](build22-package-and-download.json): package
  identity, published prerelease and all six verified fresh-download assets;
  retains the earlier blocked installation preflight. The archive verifier's
  static `release_status` label is not a live GitHub status check; actual
  publication is recorded separately.

## Historical report index

- `backend-first-run.json`: the first Mac run, including its 16 timed-out
  responses. An HTTP 200 header did not override a failed request deadline.
- `backend-repeat.json`: the repeat with the same 256 requests, 16 workers,
  five-second request budget and 45-second load limit. Diagnostic fields were
  added, with no retries or weaker limits. All checks passed; the earlier
  timeout cause remains unresolved.
- `mac-archive-roundtrip.json`: real macOS `ditto` and native extended-attribute
  checks using a disposable file with a resource fork, custom attribute and
  empty attribute. Originals and modified content were preserved.
- `mac-node-provenance.json`: the exact official Node 24.22.0 arm64 archive and
  resulting signed runtime hashes. The upcoming Node security-release limit
  remains explicit.
- `mac-native-lifecycle-final.json`: the earlier signed candidate's unchanged
  production helpers passed all three real AppKit lifecycle cases in 50.753
  seconds, with independent per-case deadlines and detailed timings.
- `mac-native-initial-budget-failure.json`: the earlier shared 55-second harness
  timeout is retained as evidence. Its temporary fixture path is omitted.
- `mac-package.json`: historical build-20 package from source
  `7c37bb40b9e093ef157fef830a2eb079112a395e`, with size/SHA-256,
  source/resource comparison, runtime syntax and generated-installer archive
  verification. That particular early package was unnotarized and ineligible
  for installation/automatic updates; it is not the later accepted build-20
  bundle or the current build-22 package.
- `cross-platform-ci.json`: observed successful push and PR runs for the earlier
  Windows portability source `18b54fcd21698239e7ca2775cd8e3b3c41d3ae38`,
  including all seven jobs and actual Desktop test/skip counts.
- `evening-ci.json`: observed successful push and PR runs for
  `868ac6a3efe726a326c51afe439522f2c8520355`, including all seven push jobs.
  This is a separate historical CI record; it does not contain the subsequent
  `fa35ec0` or build-22 run results.

The recorded backend candidate receives zero production traffic, but retains the service's
existing data and secret configuration. These probes used public read-only routes
and anonymous rejection tests; they did not perform billing activation, a purchase,
authenticated customer transfers or writes/deletes. The later GCS fixture
trial described above used its own authorized test prefix and has a separate
scope from these public-endpoint backend probes.
