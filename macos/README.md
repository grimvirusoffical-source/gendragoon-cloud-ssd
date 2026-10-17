# macOS maintenance source

This directory holds source for verified update/relaunch handling and a data-preserving Account reset action. These files are not installed in the existing signed app, and the Account section is not yet connected to the missing native Swift project.

The updater baseline was extracted from the official v0.16.2 release archive after verifying SHA-256 `02f238beb8614f27fa6b943ed9c79a4d23faa9ce1b65e125cb4cbd28b50ab144`. The original archive and its signed resources have not been modified.

## Components

- `Resources/gendragoon_auto_update.py` continues the command and JSON-event interface used by the v0.16.2 native app. It selects published stable releases, verifies checksum, bundle identity, the pinned Developer ID and Gatekeeper approval, and installs only when the app is closed and its cloud drive is unmounted. Automatic update application relaunches the verified app, with checked launch and rollback handling.
- `Resources/gendragoon_app_control.py` schedules a bounded local restart after the calling app exits. It preserves cloud files, local originals, library metadata, settings, credentials and caches. Reset is a restart, not a factory wipe or account deletion. It refuses known busy/mounted states and coordinates with the updater lock.
- `AccountResetSection.swift` supplies the Account button/controller. The native app must integrate it and its operation gate as described in `ACCOUNT_INTEGRATION.md`.

The two Python resources belong inside `GenDragoon Cloud SSD.app/Contents/Resources` during the native build. Add the Swift source to the app target and place its section in the actual Account view. Rebuild and sign the complete app; do not modify resources inside an installed signed bundle.

## Update release contract

The stable GitHub release must provide:

1. A nondraft, nonprerelease `vX.Y.Z` tag newer than the installed version.
2. `GenDragoon-Cloud-SSD-Mac-vX.Y.Z.zip` and `sha256.txt` naming that exact ZIP.
3. The expected bundle identifier `app.gendragoon.cloudssd` and Developer ID Team `NZPU8H843J`.
4. A valid Apple signature and successful Gatekeeper assessment on the supported Mac.

The v0.16.2 package is still a draft whose notes say notarization and a signed-in desktop smoke test are pending. The only published v0.4.0 release is a prerelease. Neither qualifies as a stable automatic update. User approval to make changes does not establish native build, notarization or functional-test success.

Native update controls already present in the inspected v0.16.2 binary describe checks at startup and every 20 minutes, with restart after transfers finish and drives unmount. This source preserves that scheduling contract; it does not create a second independent update scheduler.

## Verification

Run the local Python regression suite from the repository root:

```sh
python3 -B -m unittest discover -s macos/tests -v
```

These tests use disposable files and mocked macOS commands. They do not establish native signature acceptance, Account UI integration, a successful installed-app update or full app readiness. The actual Mac build and signed-in end-to-end tests remain necessary.

Current validation: 52 update/reset tests passed. The separate installer suite also passed 27 tests. A real public release check returned `No newer eligible stable release is published.` The read-only account/file API checks still return HTTP 503, `API key verification unavailable`; owner-key authentication and full cloud functionality remain unverified.

The cloud environment's separate installer and package verification are described in `/workspace/.setup/gendragoon-cloud-ssd/INSTALL.md`. The owner credential is provided securely to the API through the existing environment binding; it is not embedded in these resources or used to control the Mac.
