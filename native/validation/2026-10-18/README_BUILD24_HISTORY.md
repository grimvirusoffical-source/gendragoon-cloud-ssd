# 2026-10-18 validation snapshot

**Installed-update acceptance is incomplete.** The captured installed application is **0.18.0 build 23**, used as the bootstrap for testing automatic installation of build 24. Build 24 is a signed, notarized, published release-candidate artifact; these reports do **not** show it installed by the automatic updater. A restart-preflight fix and a fresh acceptance run are underway.

## Build 24 artifact and publication

The native build completed successfully and was signed. Apple notarization, stapling and Gatekeeper acceptance subsequently completed. Packaging records a 69,715,030-byte archive with SHA-256 `3209e0ee83590d332a01eeb255a6603f9603a77eded8a78e06034d247b7b6ffe`. It is eligible for the opt-in preview channel, not stable automatic updates.

- [Native build report](build24-macos.json)
- [Notarization completion](build24-notarization-resume.json)
- [Package and required resources](build24-package.json)

The artifact and installer assets were published as [v0.18.0-rc.1](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/releases/tag/v0.18.0-rc.1). A fresh download matched the package checksum and passed installer package verification. That download check explicitly reports `package_verified_only` and does not independently assess Apple trust; the trust evidence is in the notarization/package reports above. [Release-download report](build24-release-download.json)

## Actual automatic-update result

The real build 23 → 24 run automatically downloaded and verified the preview update: its receipt reached `ready` for build 24 after approximately 6.3 seconds. After 252 seconds, the installed build and app PID were still unchanged at build 23. The test invoked neither an external updater nor an external quit. **This acceptance run failed.** [Automatic-update acceptance](build24-automatic-update-acceptance.json)

Read-only diagnosis confirmed the current Apple trust and staged update were valid, but parent-identity verification rejected restart; an exact quiet-preflight check also found active helper work. Follow-up investigation identified a protected macOS process lookup in the first preflight failure. The process-identity/polling fixes require a new signed build and another real handoff test. [Restart diagnostic](build23-restart-readonly-diagnostic.json)

## Backend promotion and readiness

Revision `gendragoon-free-00026-jas` passed its isolated candidate checks: 256/256 public-endpoint requests succeeded with 16 workers, protected anonymous requests were rejected, and the comparison found matching service identity, literal environment and secret bindings. This was a bounded read-only check, not sustained saturation testing or an independent penetration test. [Candidate verification](backend-0180-candidate-verification.json)

The revision was then promoted to **100% production traffic**. Six existing aliases—`live-buying`, `owner-access`, `polished-ui`, `store-privacy`, `store-support`, and `transfer-v3`—were repointed to it; the old `review-0170-20261017a` tag was removed. Environment and secret bindings were unchanged. [Promotion record](backend-0180-promotion.json)

The first post-promotion check encountered cold-start readiness: billing status returned disabled checkout/storage verification, and the webhook probe returned 503. **26.7 seconds after that snapshot**, canonical checks passed: deep health and billing readiness returned 200, checkout/project creation and runtime storage verification were enabled, anonymous projects returned 401, and the unsigned webhook probe returned 400. Stripe mode was **live**, but no live payment was submitted. [Canonical readiness](backend-0180-canonical-ready.json)

## Completed component and CI gates

The real Mac lifecycle fixture passed all three cases in 31.152 seconds: clean-cache eviction, requested cache retention, and dirty-cache protection. Sources remained intact; the run used no cloud operations or security-policy changes. The dirty case's `failed-retained` state is the expected protective outcome. [Mac lifecycle report](build24-mac-lifecycle.json)

All seven [CI jobs in run 39082136001](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/actions/runs/39082136001) passed: Linux desktop, Windows desktop, native helpers, macOS compile, Android, backend and iOS. CI/release metadata identifies head `5f42b6766e13aa4f8debf31b3695d3465384d6cd`; the native build report separately records source commit `f3c3ea853cabfb15ebccf2cbecf99017a8998f7c`. [CI result](build24-ci-success.json)

Still outstanding: successful installed automatic-update handoff, authenticated native Files upload/download acceptance, paid Stripe sandbox acceptance, and a large commercial application's streamed lifecycle. Later build 25/26 evidence must be recorded before advancing these conclusions.
