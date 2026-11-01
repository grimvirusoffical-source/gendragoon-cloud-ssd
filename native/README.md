# GenDragoon native applications

> **0.22.2 storage update:** mounted reads and normal Open/Play no longer restore full archives automatically. See [Kamatera streaming notes](KAMATERA-STREAMING.md). Older local-cache behavior described below applies only to explicit offline/legacy paths.

This tree contains the macOS app, the iOS and Android clients, the cloud backend and the upload, cleanup, reset and update features.
The previous `GenDragoonFreeCloud.swift` is kept under `Legacy`; the current app uses `GenDragoonCustomerCloud.swift` and the v3 transfer client.

## macOS application behavior

The signed-in macOS app offers only MachineNotes on the Red-XAI server. Its
persistent upload selection is populated from the authenticated Receiver's
active MachineNotes, with no Google project or bucket discovery. A saved
legacy provider destination remains preserved locally but cannot run an upload;
select an available MachineNote instead. Queued legacy uploads can be cancelled
without touching source files or remote objects. The selected MachineNote is
shared by the upload tree and library, and queued jobs retain their own frozen
MachineNote context, including the chosen library folder for each source.

The common **Select Apps, Files or Folders** picker accepts multiple complete
application bundles, arbitrary files and folders together. Picker selections,
Finder drops and clipboard file URLs go directly into the selection; **Upload**
starts the batch without an intermediate add-to-tree action. The optional local
browser selects items with checkboxes. Offload remains off by default.

The storage browser is a native macOS outline with multiple selection, nested
library folders, drag/drop move, Option-drag copy, contextual menus, and
Command-C/X/V, Return-to-rename and Delete shortcuts. Folder creation, rename,
move, copy and deletion use authenticated, atomic, revision-checked Receiver
operations. Sibling collisions and folder cycles are rejected; stale views
refresh rather than overwriting concurrent changes. Copies preserve immutable
archive identity and encryption associated data. Operations stay inside one
MachineNote. A complete uploaded folder remains a folder backup; library folders
organize those backups. Deleting library entries retains shared encrypted
archive objects and does not reclaim their storage quota.

Upload progress is persisted by the worker and refreshed while its child runs.
It reports a monotonic 0–100 work estimate, actual encoded network byte/object
counts, current preparation/encoding/transfer/readback/verification activity,
and observed ETA estimates when enough progress has been measured. Background
and Show/Hide progress controls change presentation; the upload continues while
the app stays open. The tier comparison estimates the network time saved versus
serial requests from observed request durations; it excludes encoding and
verification and is not a guarantee of speed or a billing entitlement source.

Users can list only their own MachineNotes. The verified service owner can list
all account and library metadata through a separately authorized server API;
the server rechecks the verified owner email for every request. This inventory
does not provide other users' encryption secrets or decrypted archive contents.
The client integrates the pinned Red-SecretsXAI public encryption and visual
barcode APIs without modifying its repository. Existing compact PNG archives
remain readable. New barcode carriers have storage overhead, and quotas count
the actual encoded bytes stored on the server.
The upload tree makes Applications a first-class source, alongside individual
files and complete folders. A macOS `.app` is treated as one application bundle.
The optional removal checkbox is off by default. Removal requires an immutable
cloud archive, full cloud readback, SHA-256 verification, extraction, a complete
file/symlink/executable manifest comparison, macOS extended-attribute checks,
and a final source-mutation check. Originals move to Finder Trash; the app does
not empty Trash. An error, changed source, or running application retains the
original. Cloud revisions retain the prior recovery metadata.

Compatible apps launch from a managed local copy. Eligible large newly verified
macOS apps can also receive an immutable raw directory layout for an isolated,
read-only NFS/VFS mount. Bundles with metadata that this layout cannot preserve,
including resource forks or extended attributes, use verified archive/local
staging instead. Startup preloading is bounded by bytes, worker count, elapsed
time, and available disk space. Logical preloaded bytes are not a measurement
of cloud network traffic or a guarantee of launch speed. Application signing,
licensing, platform requirements, installers, privileged helpers, and software
that writes inside its bundle can require a conventional local installation.
Unsupported apps fail visibly; they are not described as successfully streamed.

The managed launcher tracks Launch Services, application and bundled helper
processes, open resources, and its own mount. Automatic cleanup waits for exit.
It removes only dedicated unchanged cache, or the private read-only VFS cache
after a graceful unmount. Changed or ambiguous local cache is retained. User
documents and settings outside the cached bundle are never part of eviction.
Cloud application objects remain stored. The optional keep-cache setting
retains the managed copy. Legacy/manual-provider launch uses the existing
restore path and does not claim this monitored lifecycle.

Cleanup Drive previews an explicitly selected local folder and categorizes
eligible content into Applications, Media/Videos, Media/Audio, Media/Pictures,
Files, and Folders. It uses a private validated plan, no-overwrite moves,
protected-root and in-use checks, and an undo journal. It is a local organizer,
not a request to rewrite or delete every object in a cloud bucket.

Reset App under Account performs the guarded reset/restart flow. It preserves
account credentials and cloud/user data. Update, reset, upload, configuration,
and cleanup use a shared maintenance gate. Updates require a newer published
stable release, pinned checksums, expected bundle/team identity, a valid
Developer ID signature, Gatekeeper acceptance, sufficient local space, and an
idle app. Replacement keeps a rollback copy and checks the restarted process.

## Build and installation

Requirements: Apple Silicon Mac, macOS 14+, Xcode, Python 3.13,
and a valid existing GenDragoon bundle containing the vendor rclone/Node
executables and artwork. The build never replaces that base bundle.

```sh
python3 native/build_macos.py --output /path/to/fresh-build-directory
```

All `Sources/*.swift` are compiled. Resource helpers come from this checkout.
The build bundles the visual codec's pinned NumPy and Pillow wheels for the
matching Python ABI and signs their native extensions. The script signs with
the existing Developer ID identity. Private signing keys
and owner API credentials are not copied into the app or repository.

Refresh the copied vendor Node runtime in the stopped staging bundle before
notarization and packaging, following [VENDOR_REFRESH.md](VENDOR_REFRESH.md):

```sh
python3 native/update_vendor_macos.py \
  --staged-app '/path/to/fresh-build-directory/GenDragoon Cloud SSD.app'
```

After successful validation, notarize and staple the bundle through Apple's
notary service, then generate the release archive and its installation script:

```sh
python3 native/package_macos.py \
  --app '/path/to/fresh-build-directory/GenDragoon Cloud SSD.app' \
  --output /path/to/release-output
```

The output contains a ZIP, `sha256.txt`, `install-macos.py`, `Install.command`,
and package status. The installer verifies the exact version, build, size,
checksum, bundle identity, signature, Gatekeeper acceptance, free space, and
idle state before replacing an installation. `--candidate` can package an
unnotarized development build for review, but the generated installer retains
its trust checks and that package is not eligible for automatic updates.

## Billing, identity, and owner operations

Checkout uses the authenticated server's catalog and readiness state. The
intended tier and billing interval must survive navigation and match the
checkout response. Browser redirection or an open Checkout Session does not
prove a payment succeeded: signed Stripe events and server-side subscription
state control entitlements. Owner benefits are server-verified; a client-side
label or API key cannot manufacture owner/admin privileges.

The backend retrieves Stripe secrets from its configured secret store. Scoped
customer API keys are hashed server-side and are never committed here. An
existing owner credential must remain in an authorized private credential
store and be attached only to approved operations at the configured origin.

## Platform boundaries

macOS apps run on compatible Macs. iOS uses document providers and managed
archives; it cannot execute arbitrary desktop apps. Android application
installation is handed to the operating system and requires user approval.
Windows and Linux need their native executable formats and platform-specific
installation behavior. Remote desktop/compute execution is a distinct service;
the current backend does not claim that remote compute is provisioned.

## Verification

Run the integrated Python tests with adjacent resources on the import path:

```sh
PYTHONPATH=native/Resources python3 -m unittest discover -s native/Tests -p 'test_integrated_*.py'
PYTHONPATH=native/Resources python3 -m unittest discover -s native/Tests -p 'test_app_launch.py'
python3 -m unittest discover -s native/Tests -p test_preload.py
python3 native/Tests/stress_native.py
```

Fixtures never authorize deleting real user data.
