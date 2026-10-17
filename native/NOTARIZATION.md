# macOS 0.17 release: notarization and safe-install gates

This applies to the **separately staged** Developer ID-signed `GenDragoon Cloud SSD.app`.
It does **not** authorize overwriting `~/Applications/GenDragoon Cloud SSD.app`
or deleting any user files, cloud data, saved app data or earlier build.

## Apple account prerequisites

- Developer ID Application certificate and private key accessible to `codesign`;
  bundle `app.gendragoon.cloudssd`, Apple Developer Team `NZPU8H843J`.
- macOS with Xcode / `xcrun notarytool`, `xcrun stapler`, `spctl`, `ditto`.
- Use an existing validated notarytool Keychain profile when one is available.
  The helper receives its profile name and does not read `.p8` files, passwords,
  or Keychain secret values.
- Credential support depends on the installed Apple tool. On the authorized
  Mac, **notarytool 1.1.3 (42)** reports in both `store-credentials --help` and
  `history --help` that `--issuer` is required for **Team API Keys** and must
  be omitted for **Individual API Keys**. A filename or HTTP 401 response does
  not establish which type an existing key is, or whether it is still valid.
- For a **team** App Store Connect API key, use its matching local `.p8`, key ID
  and actual issuer UUID. The issuer UUID is not the Apple Developer Team ID.
  Store credentials locally on the Mac, never in source or conversation:
  ```sh
  xcrun notarytool store-credentials "GenDragoonNotary" --issuer YOUR_TEAM_ISSUER_UUID --key-id YOUR_TEAM_KEY_ID --key /PRIVATE/PATH/AuthKey_YOUR_TEAM_KEY_ID.p8
  ```
  For a confirmed **individual** API key with the installed supporting tool,
  omit `--issuer` completely:
  ```sh
  xcrun notarytool store-credentials "GenDragoonNotary" --key-id YOUR_INDIVIDUAL_KEY_ID --key /PRIVATE/PATH/AuthKey_YOUR_INDIVIDUAL_KEY_ID.p8
  ```
  Alternative Apple Account method (password prompted interactively):
  ```sh
  xcrun notarytool store-credentials "GenDragoonNotary" --apple-id YOUR_APPLE_ID --team-id NZPU8H843J
  ```
  Confirm privately on the Mac with `xcrun notarytool history --keychain-profile GenDragoonNotary`.
  HTTP 401 means authentication is not working; do not retry automated submission
  or replace the app until the profile validates. Never commit or paste keys.

### Credential references and observed version behavior

Apple's [TN3147](https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool)
documents reuse of existing App Store Connect `.p8` files with issuer/key ID/path
and the Keychain profile workflow. The
[custom notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
documents Apple Account/app-specific-password and Keychain authentication.
Apple's [API-key creation guide](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)
still lists a restriction on individual keys as retrieved October 17, 2026;
that statement conflicts with the installed Apple CLI help quoted above.
Use the installed tool's documented key-type requirements and an actual
successful profile validation for this Mac. Do not infer success from either
documentation alone or the existence of a local key file.

## Safe release sequence

1. Keep the existing app and application-support data. Build in a separate folder
   with `native/build_macos.py`; inspect `codesign --verify --deep --strict`.
2. Restore disk space without lowering the **10 GiB free reserve**. Budget for
   a zipped notarization submission, uncompressed staged app, package ZIP,
   extraction and a retained backup. `native/notarize_macos.py` checks actual
   free space and does not clean user files or replace an installed application.
   Its staging guard rejects application/system directories, path aliases,
   nested app locations, shared files and shared-writable staging trees. It also
   requires `lsof` to confirm the staging bundle is stopped and unused; incomplete
   inspection blocks the operation. The helper removes only its own temporary
   submission workspace.
3. Optional dry-run on the staging bundle:
   ```sh
   python3 native/notarize_macos.py --app "/PATH/TO/STAGING/GenDragoon Cloud SSD.app" --check-only
   ```
4. With a working Keychain profile and adequate free space, run:
   ```sh
   python3 native/notarize_macos.py --app "/PATH/TO/STAGING/GenDragoon Cloud SSD.app" --keychain-profile GenDragoonNotary
   ```
   The helper submits a temporary ZIP without an unbounded `--wait`, saves the
   returned submission ID durably, and polls that same ID. It requires
   `Accepted`, staples the **staged** app, then validates its ticket, Gatekeeper,
   signature and team. It rechecks the stopped state and exact signed identity
   immediately before stapling.
   Its outcome is not a claim that GenDragoon's cloud or billing works.
5. Re-run regression tests and real launch/cache smoke tests for the release
   candidate; package with
   `python3 native/package_macos.py --app "/PATH/TO/STAGING/GenDragoon Cloud SSD.app" --output /PATH/TO/RELEASE`
   **without `--candidate`**. Production packaging now requires an actual
   validated stapled ticket, not only a Gatekeeper acceptance.
6. On the **final generated** installer, verify pinned ZIP size, SHA-256,
   metadata, notarization and Gatekeeper before a checked installation.
   Confirm a safe unmounted/idle state and enough free space. Retain the
   automatically named previous-app backup and all user data until:
   sign-in, real upload+verified restore, representative large-app launch
   and exit, cleanup with retention, selected-tier Checkout and entitlement
   activation are accepted in the intended environment.
7. Only then consider publishing a stable GitHub release and permitting
   automatic updates. Never publish a `--candidate` ZIP as stable.

## Receipts, timeouts and resuming

The default receipt is `gendragoon-notarization-receipt.json` beside the staged
app, outside its signed bundle. It records the submission ID, archive SHA-256,
build/version, signed executable/Info.plist/resource-seal hashes and progress.
It contains no credentials. Keep it local with the staging build; local paths
in a receipt should be removed before publishing any evidence. A private
exclusive lock prevents competing invocations using the same receipt.

- Exit **0** with `status: complete` means the returned ticket, Gatekeeper and
  strict signature checks passed. `--check-only` also exits 0, but explicitly
  reports `notarized: false` and only performs local preflight.
- Exit **2** with `status: pending` means Apple is still processing or a status
  request timed out. The receipt already contains the submission ID. Run the
  **same command with the same staging path and receipt** again; it resumes that
  ID without creating another upload. `--wait-seconds 0` checks once, and the
  default polling window is 60 seconds. Each status call has a 30-second limit,
  so the polling window may be exceeded by at most one in-flight status call.
- Exit **1** means blocked or rejected. The receipt and staging app remain.
  Rejected submissions are not retried automatically. Use
  `xcrun notarytool log SUBMISSION_UUID --keychain-profile GenDragoonNotary`
  to inspect the rejection locally, and build corrected code in a fresh staging
  folder so an older receipt cannot be reused for different signed content.
- If the upload itself is interrupted **before a submission ID is received and
  saved**, a durable `submitting` marker blocks a second automatic upload. The
  upload may have reached Apple. Reconcile `notarytool history` and its submission
  log against the receipt's recorded archive SHA-256 before any manual recovery;
  do not delete the marker and blindly resubmit. This helper does not invent a
  submission ID or guess which history entry belongs to an ambiguous upload.

`--receipt` may select another JSON filename in the same staging folder. Reuse
that filename on every follow-up call. Receipts are private, atomically replaced
and fsynced; symlinked, hard-linked, non-regular, malformed or mismatched receipts
block further activity. JSON responses are parsed only from stdout, so a tool
warning on stderr cannot corrupt an otherwise valid submission result. The
helper suppresses arbitrary authentication diagnostics from its public errors.

These guards do not provide an atomic exclusion against another same-user
process changing or launching the bundle between checks. Keep the dedicated
staging folder under one build/notarization operation and leave that candidate
closed until the helper finishes.

## Independent verification

- Source/CI compilation: not proof of a notarized app or customer acceptance.
- Signature: `codesign --verify --deep --strict /PATH/TO/APP`
- Stapled ticket: `xcrun stapler validate /PATH/TO/APP`
- Gatekeeper: `spctl --assess --type execute --verbose=4 /PATH/TO/APP`
- Authenticated cloud transfers, live Stripe fulfillment, production load,
  mobile device tests, and compatible large-app performance require separate
  real-world evidence. Do not infer any of these from unit tests.
