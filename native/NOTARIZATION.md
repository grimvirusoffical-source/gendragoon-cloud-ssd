# macOS 0.17 release: notarization and safe-install gates

This applies to the **separately staged** Developer ID-signed `GenDragoon Cloud SSD.app`.
It does **not** authorize overwriting `~/Applications/GenDragoon Cloud SSD.app`
or deleting any user files, cloud data, saved app data or earlier build.

## Apple account prerequisites

- Developer ID Application certificate and private key accessible to `codesign`;
  bundle `app.gendragoon.cloudssd`, Apple Developer Team `NZPU8H843J`.
- macOS with Xcode / `xcrun notarytool`, `xcrun stapler`, `spctl`, `ditto`.
- A **team** App Store Connect API key with its correct *issuer ID*, *key ID*
  and matching private `.p8`, or Apple Account + team ID + app-specific password.
  An *individual* App Store Connect API key cannot use Apple's `notarytool`.
- Create the notarytool profile **interactively on the Mac**, never in a repo or
  conversation. For a team key:
  ```sh
  xcrun notarytool store-credentials "GenDragoonNotary" --issuer YOUR_TEAM_ISSUER_UUID --key-id YOUR_TEAM_KEY_ID --key /PRIVATE/PATH/AuthKey_YOUR_TEAM_KEY_ID.p8
  ```
  Alternative Apple Account method (password prompted interactively):
  ```sh
  xcrun notarytool store-credentials "GenDragoonNotary" --apple-id YOUR_APPLE_ID --team-id NZPU8H843J
  ```
  Confirm privately on the Mac with `xcrun notarytool history --keychain-profile GenDragoonNotary`.
  HTTP 401 means authentication is not working; do not retry automated submission
  or replace the app until the profile validates. Never commit or paste keys.

## Safe release sequence

1. Keep the existing app and application-support data. Build in a separate folder
   with `native/build_macos.py`; inspect `codesign --verify --deep --strict`.
2. Restore disk space without lowering the **10 GiB free reserve**. Budget for
   a zipped notarization submission, uncompressed staged app, package ZIP,
   extraction and a retained backup. `native/notarize_macos.py` checks actual
   free space and cannot delete files or mutate the installed application.
3. Optional dry-run on the staging bundle:
   ```sh
   python3 native/notarize_macos.py --app "/PATH/TO/STAGING/GenDragoon Cloud SSD.app" --check-only
   ```
4. With a working Keychain profile and adequate free space, run:
   ```sh
   python3 native/notarize_macos.py --app "/PATH/TO/STAGING/GenDragoon Cloud SSD.app" --keychain-profile GenDragoonNotary
   ```
   The helper submits a temporary ZIP to Apple, requires `Accepted`, staples
   the **staged** app, validates the ticket, Gatekeeper, signature and team.
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

## Independent verification

- Source/CI compilation: not proof of a notarized app or customer acceptance.
- Signature: `codesign --verify --deep --strict /PATH/TO/APP`
- Stapled ticket: `xcrun stapler validate /PATH/TO/APP`
- Gatekeeper: `spctl --assess --type execute --verbose=4 /PATH/TO/APP`
- Authenticated cloud transfers, live Stripe fulfillment, production load,
  mobile device tests, and compatible large-app performance require separate
  real-world evidence. Do not infer any of these from unit tests.
