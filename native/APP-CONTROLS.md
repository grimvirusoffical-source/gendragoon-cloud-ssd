# Platform app controls and mobile launchers

Development candidate: `codex/platform-app-controls-20261027` (PR #26).

## Desktop execution

Windows and Linux display Play for matching portable application candidates and
Stop for managed sessions. A file name or catalog platform is a display hint, not
execution authority: the restored archive, native PE/ELF header, architecture and
current account/workspace generation must pass the existing broker checks.
Installers (MSI, MSIX, DEB, RPM, APK, IPA and similar packages) are not launched as
portable executables. Desktop execution uses local CPU/RAM and a verified cache;
this is not cross-OS emulation or a hosted application streaming service.

The broker, not the browser, controls Stop. Linux binds signals to descendant
processes with pidfds. Windows uses its held application Job handle. Normal Stop
asks the app to exit; a second native confirmation is required before force quit.
The verified cache and cloud archive are retained. Starting another managed app
warns about shared performance and offers keep-running, explicit force-stop, or
cancel. No user process names or arbitrary PIDs are accepted by the extension.

## Browser companion

`native/Extensions/shared/platform.js` identifies Windows, Linux, macOS, Android,
iPhone/iOS and iPad/iPadOS. Android is checked before Linux. Desktop-mode iPads
are distinguished from Macs by touch capability. User-agent detection is advisory;
authorized local native companion capabilities are authoritative. Browser Play/Stop
requires the installed GenDragoon native app, the same selected and mounted
workspace, and native confirmation. Web pages alone cannot execute desktop files.

Companion methods are `appSessions`, `playApp`, and `stopApp`. Parameters contain
only an owned `workspaceId` and an application catalog `key`. File paths, PIDs,
shell commands and browser-supplied force flags are rejected.

## Android home-screen launchers

For Android application backups, the native UI offers Play (send start signal)
and Keep launcher on Home screen. Android's system pinned-shortcut prompt must
be approved by the user. The icon contains a tiny explicit GenDragoon intent,
not a replacement APK, account token or original application payload. A tap opens
GenDragoon, verifies the current receiver/workspace/item, asks for confirmation,
and sends an Android start request. Android reports its actual device model and
OS release; iOS app backups cannot use the Android launcher.

## iPhone/iPad launchers

IPA backup actions expose a `gendragoon://launch` link. The UI offers Copy and
Share and explains the Shortcuts URL -> Open URLs -> Add to Home Screen workflow.
Apple's user-mediated shortcut creation is not silently replaced with an installed
app. The app identifies iPhone/iPad and iOS/iPadOS, rejects malformed or wrong-OS
links, and checks the signed-in account fingerprint before requesting a launch.
Links contain no access token or password.

## Start request APIs and execution boundary

- Red-XAI: `POST /v1/receivers/me/workspaces/{workspace}/app-launch-intents`.
- Existing iOS v3 service: `POST /v3/cloud/{workspace}/app-launch-intents`.
- Body: `key`, `platform`, `requestId` (32 hexadecimal characters).

Both APIs authenticate the current owner, resolve the application inside that
workspace, validate its OS, bound request storage, and return an idempotent receipt.
A receipt says `status=requested` and `executionConfirmed=false`; expiry is two
minutes. It does **not** mean an application is running. A compatible mobile
execution/streaming service and its acknowledgement path are not part of this
candidate. Until that runner is implemented and deployed, mobile icons signal the
request but do not run an offloaded phone application. No installer restriction,
app signing policy, or account authorization is bypassed.

## Validation

- Local full macOS native Swift compilation: passed (Apple Silicon).
- Local iOS Simulator build with launcher URL and UI changes: passed.
- Broker policy and mocked process identity tests: 8 passed.
- Existing desktop model suite on Mac: 42 passed, 13 target/runtime skips.
- Native bridge and extension packaging tests: 10 passed.
- Combined launch HTTP routes, browser detection and workspace tests: 19 passed.
- Receiver suite: 114 passed, 8 opt-in integration skips.
- Legacy backend suite: 483 passed, 5 skips (available local dependencies).
- Android GitHub lint + unit tests: passed on source snapshot f5fbc1d.
- Real Linux two-app process isolation test: passed in Platform app controls CI.
- Real Windows two-app process isolation: see Platform app controls CI; do not
  infer a Windows pass from the Mac compile or Linux results.

No production deployment, installed-app replacement, user-file offload or force
quit of a real user's application was performed for these tests.
