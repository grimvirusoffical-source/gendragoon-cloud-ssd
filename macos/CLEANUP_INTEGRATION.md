# Local drive cleanup integration

This guide describes the reference contract for `DriveCleanupSection.swift`
and `Resources/gendragoon_drive_cleanup.py`. The complete current application is
under [native](../native/README.md); authoritative build, runtime and remaining
release evidence is in [native/VALIDATION.md](../native/VALIDATION.md), recorded
on October 17, 2026. The host wiring below remains an integration contract.
The section provides Choose Folder, Preview, confirmation before Organize, and
Undo Last Cleanup, showing proposed moves and skipped entries. No real user
folders were organized by the reference development fixtures.

## Required host wiring

Supply the installed, trusted Python executable URL explicitly; do not choose an
interpreter from an arbitrary `PATH`. The helper requires Python 3.9 or newer,
macOS, and a local filesystem with atomic no-overwrite rename support. Bundle a
signed compatible runtime or declare and verify its supported installation.

All upload/download transfers, mounts, app cache installs and launches, updates,
reset requests, and cleanup must use **one shared operation coordinator**. Its
`acquireExclusiveOperation` callback must synchronously check the actual current
busy/pending state and reserve exclusive cleanup work atomically on the main
actor, returning false if any conflicting work exists. Its release callback
must release that same reservation. Both callbacks are required; no-op callbacks
or a UI-only busy flag are unsafe. The section disables controls from `isBusy`
and its own pending state, holds the reservation until the helper exits, and
passes `--ui-busy false` only after acquiring it. It never kills a helper on a
UI timeout while filesystem moves might be in progress.

The helper also holds the existing private
`AutoUpdates/update.lock` with a nonblocking exclusive `flock` for preview,
apply, and undo. Existing reset/update helpers use that lock. Other filesystem
helpers must cooperate with the same lock and coordinator. The OS cannot infer
all in-process URLSession transfers. A helper returning `busy` is a refusal,
never permission to bypass the coordinator.

The folder picker retains security-scoped access for the current session. A
sandboxed app needs user-selected read/write entitlement and an appropriately
signed helper/XPC configuration that actually receives access to the chosen
folder and private support directory. Do not assume a plain subprocess inherits
security-scoped access: verify the distribution's sandbox/inheritance model or
pass a security-scoped bookmark to an entitled XPC service. A helper without
access must show a failure. Persist security-scoped bookmarks if restoring
historical plans/receipts after relaunch is added. Current UI Undo covers the
most recent successful cleanup in this view's lifetime; private receipts remain
on disk for recovery. No Files and Folders/Full Disk Access permission is
silently requested or bypassed.

## Behavior and safety boundaries

Only direct children of an explicitly chosen, owned, readable/writable local
folder are organized:

| Entry | Destination |
| --- | --- |
| `.app` directory bundle | `Applications/` |
| Recognized video | `Media/Videos/` |
| Recognized audio | `Media/Audio/` |
| Recognized picture | `Media/Pictures/` |
| Other regular file, including unknown extensions | `Files/` |
| Other normal directory | `Folders/` |

Bundles and folders move as whole directory entries. They are not flattened,
installed, launched, deleted, or copied to cloud storage. Arbitrary file types
remain intact. Existing organization folders stay in place. Collisions get
stable names such as `Example (2).app`, with case-insensitive preview collision
checks and kernel-enforced no-overwrite moves.

The helper refuses home itself, filesystem/mount roots, system directories,
Library/app-support/cache locations, recognized cloud-sync roots, and nonlocal
or FUSE backing filesystems. It rejects symlinked ancestry, linked/shared private
storage, unowned entries, cross-volume trees, and special files. Top-level
symlinks, hidden/system entries, temporary/incomplete transfer files, and trees
containing temporary/system entries stay in place. Embedded app/folder symlinks
are recorded without traversal and are preserved by the atomic directory rename.
macOS `ps` and user-scoped `lsof` inspections identify running bundles and open
regular files; those candidates are skipped or cause a later apply/undo refusal.
These conservative checks supplement the required app coordinator.

Preview hashes contents and records inode/device, ownership, mode, mtime, flags,
birthtime where available, extended attributes, and descendant metadata. Darwin
extended attributes use `flistxattr`/`fgetxattr`; Linux fixture tests use CPython's
Linux-only xattr APIs. Only the moved root entry's ctime is omitted from its
comparison because the rename itself changes that timestamp. File bytes,
modification times, permissions, and extended attributes survive moves. Access
times may advance when the operating system reads files for verification;
preview does not rewrite user files or change their permissions. Large previews
hash all selected data and can take time; a tree above 100,000 entries is refused
rather than partially approved.

Plans and receipts live at
`~/Library/Application Support/GenDragoon Cloud SSD/DriveCleanup`, in owned private
directories/files (0700/0600). A generated local authentication key seals their
canonical JSON with HMAC. It is never printed. This detects corruption and edits;
it does not establish a security boundary against code already running as the
same user with access to that key. Saved records contain paths and fingerprints,
not file contents or API credentials. Plans are immutable and single-use. Apply
requires the exact plan ID and revalidates root context, all sources, and
destination names before any move. It checks fingerprints again after each
atomic no-overwrite rename, rejecting a source swapped during the final race
window. Cross-volume errors never fall back to copy-and-delete.

Receipts journal apply/undo intent before moves. Mid-apply failure rolls completed
unchanged moves back without overwriting conflicts. Undo requires unchanged
destinations and vacant original names; it validates every move before starting.
Interrupted apply/undo can recover only when exactly one approved source or
destination contains the same fingerprint. Changed, conflicting, or uninspectable
entries stop automatic recovery and retain the receipt for review. New content
inside category folders is never removed. Only empty organization directories
created by this transaction are removed after a successful undo or rollback.

## Helper contract and validation

The host must hold its coordinator reservation for each command:

```text
python gendragoon_drive_cleanup.py preview --root /absolute/chosen/folder --ui-busy false
python gendragoon_drive_cleanup.py apply --plan PLAN_ID --ui-busy false
python gendragoon_drive_cleanup.py undo --receipt RECEIPT_ID --ui-busy false
```

Commands emit one JSON result. Preview returns `state: preview`, `plan_id`,
`root`, `planned_count`, `moves` (`source`/`destination`), and skipped
`name`/`reason` records. Success states are `applied` and `undone`; apply returns
the receipt ID. Failure exits nonzero with `state: failed`, a stable `error`,
safe `message`, and `receipt_id` when a transaction exists. A `rolled_back`
failure is not success; `recovery_needed` requires receipt review/Undo. Never
retry an apply automatically or replace an existing approved plan.

Run the local fixtures without touching real folders:

```bash
python3 -m unittest discover -s macos/tests -p test_drive_cleanup.py -v
```

27 fixtures cover categories/app bundles, preview without moves, preservation,
collisions, no overwrite, apply/undo, source and destination changes, source-swap
races, cross-volume refusal, symlinks and unsafe roots, private storage/tampering,
busy/lock gates, rollback, interrupted receipts, undo failure compensation, and
xattr changes. Linux fixture results do not verify the macOS libc backend or
SwiftUI compilation. Before shipping, build the actual native target and test
the signed helper on supported macOS with disposable folders, sandbox grants,
running apps/transfers, large files, separate local volumes, and injected
interruption/conflict cases. A build, signing/notarization, deployment, and
installed-app end-to-end check are still required.
