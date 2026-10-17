# macOS application components

This directory contains source components for the requested upload workspace,
drive organization, plan selection, updates and Account reset. The repository
does not contain the main native Swift/Xcode project. These components have not
been integrated into that project, compiled against the macOS SDK, signed,
notarized or installed. They do not change the currently installed app.

The Python connection, library and updater baselines came from the official
v0.16.2/build19 archive after verifying SHA-256
`02f238beb8614f27fa6b943ed9c79a4d23faa9ce1b65e125cb4cbd28b50ab144`.
The original archive and signed bundle remain untouched.

## Upload workspace

`ProjectUploadSection.swift` uses one persisted workspace for its Google Cloud
project/bucket selector, application-inclusive upload tree and lower upload
queue. It accepts whole `.app` bundles, ordinary files of any extension and
complete folders. It retains the explicit destination across refresh/relaunch;
an unavailable destination stays visible and blocks a new upload. It does not
silently switch to another project or bucket.

`Resources/gendragoon_upload_workspace.py` stores private, locked, atomic state
with revision checks. Jobs retain their original destination, sources and
offload choice. Running work blocks destination/source changes. The worker
passes explicit project, bucket, remote and prefix to the library rather than
using the original helper's fixed bucket.

`Resources/gendragoon_connect.py` verifies both bucket access and ownership by
the selected project before committing its tested rclone configuration and the
same authoritative workspace destination. Failed validation preserves the
previous selection/configuration. It uses delegated Google authorization, not
an embedded owner/service key.

`Resources/gendragoon_library.py` compares a full cloud read-back and restored
content manifest before an optional offload. The checkbox starts unchecked;
offload means moving the original to Finder Trash after verification and
source-mutation checks. Verification failures retain originals. Symlink roots,
escaping links, devices, sockets and pipes are rejected. This is ordinary
file/folder/application data support, not support for uploading live devices.

Follow [UPLOAD_INTEGRATION.md](UPLOAD_INTEGRATION.md) for the actual native
CloudModel adapter, operation gate, helper packaging, Python/rclone requirements
and security-scoped access validation. Library list/scan/restore calls must use
the selected project/bucket/remote explicitly. Legacy unscoped entries are not
silently assigned to a newly chosen project.

## Drive cleanup and plans

`DriveCleanupSection.swift` and `Resources/gendragoon_drive_cleanup.py` preview
organization of an explicitly chosen local folder into Applications,
Media/Videos, Media/Audio, Media/Pictures, Files and Folders. Apply and Undo use
verified plans/receipts and refuse unsafe roots, collisions or changed items.
They do not clear arbitrary drives or permanently delete originals. See
[CLEANUP_INTEGRATION.md](CLEANUP_INTEGRATION.md) for native integration and
recovery details.

`PlanSelectionSection.swift` makes each server-provided tier selectable and
persists the chosen IDs and billing interval in an account/workspace scope.
Purchasing requires the current server offer to be available and an
authenticated checkout adapter. The source pricing catalog is still a
proposal; it does not establish deployed Stripe products, GPU capacity or
entitlements. See [PLAN_INTEGRATION.md](PLAN_INTEGRATION.md) and run the catalog
tests below.

## Updates, reset and installation

`Resources/gendragoon_auto_update.py` preserves the v0.16.2 JSON/command
interface, selects published stable releases, verifies SHA-256, bundle identity,
Developer ID and Gatekeeper approval, and replaces the app only while it is
closed and its cloud drive is unmounted. It retains rollback copies and checks
relaunch. Automatic application defaults to relaunch, with an explicit opt-out.

`Resources/gendragoon_app_control.py` and `AccountResetSection.swift` implement
a bounded, acknowledged restart after the calling app exits. Reset preserves
cloud files, local originals, library metadata, settings, credentials and
caches. See [ACCOUNT_INTEGRATION.md](ACCOUNT_INTEGRATION.md).

Uploads, cleanup, restart and updates share the maintenance lock. The actual
native app must also connect every component to its central operation gate,
including existing mounts, launches, cache installs and transfers. These
components cannot infer all activity of an unmodified native app.

[INSTALL.md](INSTALL.md) documents the checked-in `install-macos.py` script for
the pinned original reference package. That package does not include these new
source components. A supported Mac is required for actual installation and
signature/Gatekeeper checks.

The automatic updater requires a nondraft, nonprerelease `vX.Y.Z` release newer
than the installed version, with `GenDragoon-Cloud-SSD-Mac-vX.Y.Z.zip` and a
`sha256.txt` naming that exact ZIP. The app must have bundle ID
`app.gendragoon.cloudssd`, Developer ID Team `NZPU8H843J`, and pass native trust
assessment. The inspected v0.16.2 draft still has notarization and a signed-in
Mac smoke test outstanding. The published v0.4.0 prerelease is also ineligible.
No eligible stable update was available during the public release check.

The inspected native updater already describes checks at startup and every
20 minutes, applying updates after transfers finish and drives unmount. Retain
that scheduler when integrating the updated helper.

## Validation and remaining work

From the repository root:

```sh
python3 -B -W error::ResourceWarning -m unittest discover -s macos/tests -v
node --test commercial/catalog.test.js
```

Tests use disposable local data and mocked macOS/cloud commands. They exercise
the helper behavior and failure paths; they do not establish native UI,
signature, TCC/sandbox, live Google Cloud, Stripe or installed-app readiness.
No cleanup command has organized the user's real files here.

The library retains local restore/launch/evict operations. Optimized streaming
of large apps, verified automatic cache eviction after process exit, and the
native launch coordinator still need integration and real Mac validation. The
old raw streaming helper's hardcoded mount must not be used for an arbitrary
selected project/bucket. Do not promise that moving an application bundle to
cloud storage makes it runnable on a different operating system.

These native components target macOS. The repository's existing Python and
JavaScript SDKs are storage clients, not complete Windows, Linux, iOS or Android
apps. Separate platform implementations and testing are still required, and
mobile operating systems restrict installation/execution of arbitrary apps.

The live account/file API checks returned HTTP 503,
`API key verification unavailable`; `/health` explicitly did not check
dependencies. The existing owner-key binding is present, but authenticated
cloud readiness has not been established. Backend source/service logs and the
Stripe integration are absent from this checkout. Full-app load/security tests
and live payment/entitlement checks remain blocked by those prerequisites.

The unchanged SDKs also have previously identified download/redirect defects;
passing these native-helper tests does not resolve or certify those clients.
Complete native build/signing, authorized staging tests, payment/webhook tests
and full-app security/load testing before marking the app ready for release.
