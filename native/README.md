# GenDragoon native integration — 0.17.0

This tree consolidates the complete macOS app, iOS and Android clients, cloud
backend, and the previously separate upload, cleanup, reset, and update UI.
The initial full source came from the existing v0.16.2 macOS development tree.
The old, unreferenced `GenDragoonFreeCloud.swift` is retained under `Legacy`;
the current app uses `GenDragoonCustomerCloud.swift` and the v3 transfer client.

## macOS application behavior

The signed-in native workspace owns one persistent upload selection. Google
Cloud discovery verifies the actual project ID and the bucket's owning project
number before committing the selected project, bucket, remote, and prefix.
The top selector, upload tree, and upload panel use that committed state. An
account lacking account-wide discovery permission can retain an explicitly
verified destination. Legacy 16- and 18-character app keys keep their original
cache paths and are adopted only into a matching verified workspace.

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

Requirements: Apple Silicon Mac, macOS 14+, Xcode, a supported Python runtime,
and a valid existing GenDragoon bundle containing the vendor rclone/Node
executables and artwork. The build never replaces that base bundle.

```sh
python3 native/build_macos.py --output /path/to/fresh-build-directory
```

All `Sources/*.swift` are compiled. Resource helpers come from this checkout.
The script signs with the existing Developer ID identity. Private signing keys
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
No current validation result should be interpreted as a completed paid
purchase unless the payment and webhook evidence is recorded explicitly.

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

See [VALIDATION.md](VALIDATION.md) for actual results, environment limits, and
the remaining gates. Fixtures never authorize deleting real user data.
