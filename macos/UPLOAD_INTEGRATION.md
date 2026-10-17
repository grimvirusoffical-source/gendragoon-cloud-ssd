# Shared Google Cloud destination and upload UI

This is source for the missing native app project. It has not been inserted into
the existing compiled app, compiled against AppKit/SwiftUI, signed, released, or
installed on a Mac. This Linux environment has no Swift compiler or macOS SDK.

Add `ProjectUploadSection.swift` to the macOS 14+ app target. Its single
`@StateObject UploadWorkspaceModel` supplies the destination selector, source
picker/tree, and lower upload queue. Use this complete section in the existing
upload screen; do not keep a second destination variable in the lower panel.
Instantiate this section once. If the native layout needs separate top and lower
views, extract child views that observe this same model; never create a second
workspace model or a second default destination for the lower panel.

The following is an adapter example, not a claim that the absent app defines
these property names:

~~~swift
ProjectUploadSection(
    projects: cloud.authorizedProjects.map { project in
        UploadCloudProject(
            id: project.id,
            displayName: project.name,
            buckets: project.authorizedBuckets.map { bucket in
                UploadCloudBucket(
                    id: bucket.name,
                    displayName: bucket.name,
                    remote: bucket.configuredRcloneRemoteName,
                    prefix: bucket.uploadPrefix
                )
            }
        )
    },
    externalBusy: operations.hasActiveWorkExcludingThisUploadWorkspace,
    requiresSecurityScopedAccess: appBuildUsesAppSandbox,
    onBusyStateChange: { operations.uploadWorkspaceIsBusy = $0 },
    onRefreshCloudChoices: { await cloud.reloadAuthorizedProjectsAndBuckets() }
)
~~~

Supply choices from the real authenticated CloudModel. Project IDs and bucket
names must be exact; `remote` is the configured rclone section name without a
colon/path. Pass the intended prefix explicitly. Do not invent a remote name,
read guessed UserDefaults keys, substitute a default project, or map an empty
list to its first element. The CloudModel adapter must also discard stale
project/bucket discovery results using its own request generation.

Project/bucket options commit as one explicit destination, avoiding an interim
new-project/old-bucket combination. Both destination badges and the picker read
the helper's persisted `{project,bucket,remote,prefix}`. Refresh and relaunch do
not choose another destination. A saved context missing from current authorized
choices remains visible and blocks a new upload until access returns or the user
explicitly selects another destination. A helper validation error does not commit
the newly clicked option.

The required busy callback participates in the same operation coordinator used
by Account Reset App, updates, mounts, cache installs, launches, and cleanup. It
must prevent other work from starting while the picker, mutation, or upload
worker is active. `externalBusy` reports other operations and excludes this
section's own busy flag, avoiding a self-lock. The helper independently enforces
its maintenance lock and durable active-job state. Queued jobs remain durable
when the app closes; they do not alone freeze the composer. Running jobs freeze
destination/source changes. Existing queued jobs keep their original destination,
sources, and offload choice if the composer changes.

Include these resources together, retaining their filenames:

- `gendragoon_upload_workspace.py`
- `gendragoon_library.py`
- `gendragoon_connect.py`

They belong in the native target's Copy Bundle Resources phase. Provision a
trusted Python 3.10+ runtime, configured rclone, and the existing authenticated
Google Cloud tooling/configuration required by those helpers. The UI calls the
workspace helper with `Process` argument arrays through `/usr/bin/env python3`;
it uses no shell, environment dump, app owner key, or credential values. Read-only
state/tree calls have a 120-second UI timeout. State-changing calls await the
actual helper outcome; killing only a selection parent could otherwise leave a
Configure Cloud child that commits later. Helpers bound their external commands.
The UI adds no upload timeout; individual helpers retain bounded external-command
timeouts (including archive and rclone operations), so oversized or slow uploads
can still fail safely. Optimized streaming for large applications remains a
separate integration task. File-backed private stdout/stderr capture avoids pipe
deadlocks, reads at
most 5 MiB of JSON, and displays bounded/redacted helper errors. A failure
envelope retains its authoritative state; it never becomes a success alert.

All destination/source/enqueue mutations send the displayed state's
`--expected-revision`. Older state revisions cannot replace newer state. Tree
responses additionally use a request generation, so a slow response for one
folder cannot replace a newly requested folder. Revision conflicts require
reviewing the refreshed state and explicitly retrying the action.

`Add Applications…` starts in `/Applications`, and `My Applications…` starts in
`~/Applications`. The open panel accepts files, directories, multiple selections,
and all file types, with `treatsFilePackagesAsDirectories = false`. The helper
reports `.app` nodes as atomic; the tree identifies them as Applications and
never drills into their Contents as an upload selection. The same selected
applications/files/folders populate the lower queue. Unsupported links or local
permission failures are reported rather than followed silently.

The offload checkbox starts unchecked. When explicitly checked, the immutable
job requests moving originals to Finder Trash only after the library helper's
verified cloud backup, restore comparison, and source-unchanged checks. The UI
does not itself delete, trash, or infer verification from a progress value.
Progress displays durable completed-item counts and item states, without a
fabricated byte percentage. No Cancel button is exposed because this worker
contract does not support safe cancellation.

For a sandboxed build, pass `requiresSecurityScopedAccess: true`. Native panel
URLs are used to create security-scoped bookmarks, retained locally at the
app's Application Support `GenDragoon Cloud SSD/UploadUI/source-bookmarks.plist`.
Bookmarks are separate from the authoritative cloud destination/queue. They are
resolved without UI before a queued upload, checked for stale/moved paths, and
held while this workspace model is alive. Missing access requires selecting the
source again. A tree URL alone cannot manufacture a security-scope grant: use
the open panel if prompted. For a non-sandboxed Developer ID build, pass false.
Bookmark lookup keys resolve allowed ancestor links to match the Python helper's
canonical source paths; the original scoped URL is retained for the actual grant.

The native project's entitlements and executable packaging are missing.
Validate the signed app's user-selected read/write access, app-scoped bookmarks,
helper execution/inherited sandbox access, network access, and Finder Trash
permissions before claiming sandbox support. Holding native bookmark access
does not establish that an external Python/rclone child can use it; if inheritance
is unavailable, move file I/O into a correctly entitled native helper/XPC service.
Do not disable the sandbox or bypass TCC to make an upload appear to work.

On a Mac, build the actual app target with its pinned Xcode version and run
integration checks against an authorized staging bucket: persist a nondefault
project/bucket across refresh and relaunch; deny access/remove that context and
confirm it stays selected; exercise delayed results and revision conflicts;
select applications, extensionless/hidden/binary files, and nested folders;
verify atomic app selection, queued destination snapshots, real item progress,
busy gating, failures retaining originals, and successful verified offload to
Trash. Repeat relaunch with queued jobs and revoked/stale bookmark access. Python
fixture tests validate the helper separately; they are not a native UI build or
a live cloud upload test.
