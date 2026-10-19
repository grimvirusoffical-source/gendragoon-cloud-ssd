# macOS application components

This directory holds the reference components for the upload workspace, drive organization, plan selection, updates and Account reset. The complete application is under [native](../native/README.md).

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

The native CloudModel adapter, operation gate, helper packaging and Python/rclone requirements are in [native](../native/README.md). Library list/scan/restore calls must use
the selected project/bucket/remote explicitly. Legacy unscoped entries are not
silently assigned to a newly chosen project.

## Drive cleanup and plans

`DriveCleanupSection.swift` and `Resources/gendragoon_drive_cleanup.py` preview
organization of an explicitly chosen local folder into Applications,
Media/Videos, Media/Audio, Media/Pictures, Files and Folders. Apply and Undo use
verified plans/receipts and refuse unsafe roots, collisions or changed items.
They do not clear arbitrary drives or permanently delete originals.

`PlanSelectionSection.swift` makes each server-provided tier selectable and
persists the chosen IDs and billing interval in an account/workspace scope.
Purchasing requires the current server offer to be available and an
authenticated checkout adapter. The reference `commercial/pricing.json` catalog
is still a proposal; it does not establish deployed Stripe products, GPU capacity
or entitlements. Current native purchasing uses the server catalog described in
[native/Backend/README.md](../native/Backend/README.md).

## Updates, reset and installation

`Resources/gendragoon_auto_update.py` preserves the v0.16.2 JSON/command
interface, selects published stable releases, verifies SHA-256, bundle identity,
Developer ID and Gatekeeper approval, and replaces the app only while it is
closed and its cloud drive is unmounted. It retains rollback copies and checks
relaunch. Automatic application defaults to relaunch, with an explicit opt-out.

`Resources/gendragoon_app_control.py` and `AccountResetSection.swift` implement
a bounded, acknowledged restart after the calling app exits. Reset preserves
cloud files, local originals, library metadata, settings, credentials and
caches.

Uploads, cleanup, restart and updates share the maintenance lock. Any host
adopting these reference components must connect them to its central operation
gate, including mounts, launches, cache installs and transfers. The current
native integration is documented under [native](../native/README.md); these
component contracts cannot infer all activity of another host application.

[INSTALL.md](INSTALL.md) documents the checked-in `install-macos.py` script for
the pinned original reference package. That package does not include these new
source components. A supported Mac is required for actual installation and
signature/Gatekeeper checks.

The automatic updater requires a nondraft, nonprerelease `vX.Y.Z` release newer
than the installed version, with `GenDragoon-Cloud-SSD-Mac-vX.Y.Z.zip` and a
`sha256.txt` naming that exact ZIP. The app must have bundle ID
`app.gendragoon.cloudssd`, Developer ID Team `NZPU8H843J`, and pass native trust
assessment. No release is installed automatically unless it passes those checks.

The reference updater contract checks at startup and every 20 minutes and waits
for transfers and mounts to finish. The current scheduler lives in the native application.

## Tests

From the repository root:

```sh
python3 -B -W error::ResourceWarning -m unittest discover -s macos/tests -v
node --test commercial/catalog.test.js
```

Tests use disposable local data and mocked macOS and cloud commands. They exercise helper behavior and failure paths; they do not cover native UI, signing, sandboxing, live Google Cloud or Stripe.

The reference library keeps local restore, launch and evict operations. Managed launch, cache cleanup and large-app staging are in [native](../native/README.md). The old reference streaming helper's hardcoded mount must not be used for an arbitrary project or bucket. Moving an application bundle to cloud storage does not make it runnable on a different operating system.

These components target macOS; the Python and JavaScript SDKs are storage clients. The Windows/Linux command-line client and the mobile clients are described in [native/Desktop](../native/Desktop/README.md) and [native/Mobile](../native/Mobile/PLATFORM_BEHAVIOR.md). SDK download behavior is covered by the regression suites described in [sdk/README.md](../sdk/README.md).
