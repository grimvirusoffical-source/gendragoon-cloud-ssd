# 2026-10-18 validation snapshot

**Build 29 is installed and running; automatic 27→29 update and old-version
cleanup passed. The Firestore upload-receipt fix is live. Full product acceptance
remains incomplete.** [Current complete validation record](../../VALIDATION.md)

## Current Mac evidence

- [Native build](build29-macos.json), [Apple notarization](build29-notarization.json), [package](build29-package.json)
- [Fresh five-asset download](build29-release-download.json) and [public update discovery](build29-public-update-check.json)
- [Actual automatic 27→29 acceptance: 58.795 seconds](build29-automatic-update-acceptance.json)
- [All 23 preferences and library/configuration preservation](build29-installed-preservation.json)
- [Old-installation cleanup](build29-old-installations-cleanup.json)
- [Four actual Swift helper regressions](build29-native-helper.json)
- [Signed-source-linked seven-job CI](build29-ci-success.json)
- [Native UI observation; authenticated fixture roundtrip unverified](build29-native-ui-acceptance.json)

## Upload-receipt repair and deployment

- [Original 503 reproduced](backend-range-fix-red.json)
- [171 backend tests](backend-range-fix-tests.json), [zero-vulnerability production audit](backend-range-fix-audit.json), [seven-job CI](backend-range-fix-ci.json)
- [Real Firestore rejection, map receipt and concurrent-retry proof](backend-range-fix-firestore.json)
- [Candidate verification: 256/256 public requests](backend-range-fix-candidate-verification.json)
- [Promotion and initial cold-start readiness failure](backend-range-fix-promotion.json)
- [Separate successful canonical readiness check, 69.778 seconds later](backend-range-fix-canonical-ready.json)

The real database fixture was deleted. These checks do not establish a native
HTTP upload/download, paid Stripe transaction, commercial-game lifecycle or
independent penetration test. The app's original-file checkbox was restored;
its disposable UI-test source folder was unchanged.

## Preserved earlier attempts

[Build-24 handoff and backend-26 history](README_BUILD24_HISTORY.md) retains the
failed actual update, earlier promotion/readiness and earlier CI record.

Additional recovery evidence: [stalled helper diagnosis](build23-stalled-cloud-discovery-diagnostic.json),
[failed bootstrap](build27-bootstrap-attempt-73614a8bd6f24c4980784b1b6e03b992.json),
[successful bootstrap retry](build27-bootstrap-postquit-retry.json),
[post-quit open-file inspection](build29-postquit-open-file-inspection.json),
[staging cleanup](redundant-build-staging-cleanup.json), and
[superseded build artifacts](superseded-build-artifacts-cleanup.json).

Earlier failures remain historical evidence. The 10 GiB reserve was unchanged.
