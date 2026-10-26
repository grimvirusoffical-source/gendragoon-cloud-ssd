# GenDragoon Mount Host

GenDragoon Mount Host 1.0.0 is an independent MIT licensed, read-only Windows
filesystem host for an already running authenticated IPv4 loopback WebDAV
service. Its source and standalone distribution contain no GenDragoon GUI,
account client, private codec, encryption library, or cloud credentials. It
does not download, install, modify, or terminate another program.

WinFsp - Windows File System Proxy, Copyright (C) Bill Zissimopoulos

WinFsp repository: https://github.com/winfsp/winfsp

WinFsp is a separately installed dependency. Read `THIRD_PARTY_NOTICES.md` and
its unmodified license before distributing this host. A public repository
alone does not establish eligibility for the WinFsp FLOSS exception. Do not
co-bundle this standalone FLOSS artifact with proprietary software.

## Build and verification

Go 1.26.0 or later is required by unchanged rclone v1.75.2. The dependency graph
mirrors that upstream release, including cgofuse
v1.6.1-0.20260126094232-f2c4fccdb286 and x/sys v0.48.0. Versions and upstream
file hashes are recorded in `dependency-provenance.json`. There are no module
replacement directives, private imports, or private submodules.

On Windows, with an official WinFsp installation available:

```powershell
$env:CGO_ENABLED = '0'
go test -tags=cmount -mod=readonly -count=1 ./...
go build -tags=cmount -mod=readonly -trimpath -ldflags='-s -w' -o gendragoon-mounthost.exe .
```

Portable gate, HTTP control, configuration, and relay tests also run on other
platforms with `go test -race -mod=readonly -count=1 ./...`. The Windows-only
filesystem wrapper tests are compiled and executed on Windows. Unit tests do
not establish actual driver behavior. Release acceptance separately requires
real WinFsp tests for a held read handle, duplicated handle, directory handle,
mapped view after the original handle closes, concurrent open versus unmount,
continued reads after a refused busy unmount, read-only writes, and idle normal
unmount. Do not declare the Windows mount feature accepted before those gates
pass on the exact artifact.

The standalone release builder must include the owned source, exact module
files, provenance, this license and notices, and all licenses/notices for the
Go modules actually linked. It must not include a WinFsp DLL or a codec/GUI
artifact. WinFsp is obtained independently from its publisher.

## Private startup contract

The only mount flags are `--mount-point X:` and `--volume-label LABEL`. The
mount point is an unused ASCII drive letter. The label is 1–32 ASCII letters,
digits, spaces, dots, underscores, or hyphens, beginning with a letter or digit.
Arbitrary rclone, filesystem, proxy, or remote options are not accepted.

The caller supplies these environment variables to the new host process:

| Name | Requirement |
| --- | --- |
| `GD_MOUNT_DAV_URL` | Exactly `http://127.0.0.1:PORT/`, with a nonzero port; no userinfo, query, fragment, or remote path. |
| `GD_MOUNT_DAV_TOKEN` | A 32–256 character base64url/hex bearer for the existing loopback DAV service. |
| `GD_MOUNT_CONTROL_TOKEN` | A different independent 32–256 character base64url/hex bearer. |
| `GD_MOUNT_FILE_SECURITY` | Exact current-token user SDDL `O:<sid>G:<sid>D:P(A;;FRFX;;;<sid>)`. Only canonical ordinary domain/local or AzureAD user SIDs are accepted. |

Secrets are absent from argv, ready/status messages, and normal error output.
Ambient `RCLONE_*` configuration is removed case-insensitively in this process.
No user's rclone configuration is loaded. The fixed native filesystem identity
is `FUSE-GDHost`; file security is independently checked against the
current process token, and broader ACEs are rejected.

`--version` prints exactly `GenDragoon Mount Host 1.0.0`. `--help` displays usage
and the WinFsp attribution. Neither requires credentials.

After native Init and actual drive presence, stdout emits one JSON ready line
under 4096 bytes:

```json
{"schema":1,"status":"ready","mountPoint":"X:","controlURL":"http://127.0.0.1:PORT","pid":1234,"readOnly":true,"protocol":"gendragoon-mounthost/v1","version":"1.0.0"}
```

Startup failures emit only `{ "schema":1, "status":"error", "code":"..." }`.
The fixed codes are `invalid_configuration`, `private_permissions_failed`,
`dav_connect_failed`, `mount_failed`, `native_runtime_unavailable`, and
`control_failed`. Dependency error text, paths, upstream URLs and content are
not forwarded. Startup can remain pending while a native mount is pending;
the caller must retain its process/context instead of killing it on a timeout.

## Authenticated control

Control binds only `127.0.0.1:0`. Every request requires the control bearer,
the exact listener Host header, an IPv4 loopback peer, no Origin header, and no
query. Request headers and bodies are bounded. `POST /v1/unmount` and
`POST /v1/cache/trim` require
`Content-Type: application/json` and an empty object no larger than 1024 bytes.
Bodies are parsed before admission/serialization locks, with a five second
server read timeout. Control does not permit forwarding, remount, file access,
configuration changes or forced shutdown.

`GET /v1/status` returns schema 1, `state` (`mounted`, `quiescing`, `unmounted`),
and nonnegative `openFiles`, `openDirectories`, `pending`, `inflight` counts.
These are lifetime reservations owned by this host, not an external handle
snapshot. A successful Open or OpenEx and Opendir stays reserved through native
Close/Release/Releasedir. Duplicate handle lifetimes and mapped views must be
validated by the driver acceptance tests described above.

`POST /v1/cache/trim` requests native cache maintenance for at most 1024 current
file paths, each at most 4096 UTF-8 bytes. Paths stay private and are removed
only after the matching successful native Close. No caller-selected paths are
accepted. The response contains only schema 1, `status: trim-requested`, and a
bounded `requested` count. This acknowledges notification requests, not a purge
or successful close. Missing/over-budget tracking returns busy; a failed native
notification returns retained. No lifetime reservation is discarded.

On Windows the unchanged cgofuse `Notify(path, 0)` calls WinFsp's native cache
invalidation, without fabricating a file-change event. WinFsp acquires its native
file lock and requests cache purge; Microsoft's cache API will not purge mapped
files. This is an investigation candidate until all actual driver gates pass.
See the pinned [cgofuse notification API](https://github.com/winfsp/cgofuse/blob/f2c4fccdb286/fuse/host.go),
[WinFsp notification implementation](https://github.com/winfsp/winfsp/blob/v2.1/src/dll/fuse/fuse.c),
[native cache invalidation](https://github.com/winfsp/winfsp/blob/v2.1/src/sys/file.c),
and [Microsoft cache-purge contract](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ccpurgecachesection).
The gate lock is released before Notify because native Close callbacks may run
during invalidation. Admission remains open and existing reads remain available;
GET status has no maintenance side effects.

`POST /v1/unmount` first requests the same bounded native maintenance, then
atomically checks pending opens, descriptors and in-flight
operations under the same lock used by admission. A busy result is HTTP 409
with schema 1 and `status: busy`; it does not call VFS shutdown or native unmount
and leaves the mount serving. If idle, it switches to quiescing while rejecting
new operations, calls native unmount, and waits for native Mount to return.
Only then does HTTP 200 report `status: unmounted` and the original mountPoint.
A false native unmount returns HTTP 503 `status: retained` and reopens admission.
An uncertain descriptor close, unknown close, or callback panic fails closed;
it does not infer that the filesystem is idle. No force, RC stop, WNet cancel,
signal, process termination, or stale handle snapshot fallback is implemented.

## Read-only DAV boundary

The unchanged backend talks only to an internal authenticated loopback relay.
The relay pins the configured upstream origin, sets its bearer in memory,
disables proxies and uses RoundTrip without redirect following. Redirects are
refused; caller headers and Location are not relayed. Only GET, HEAD, OPTIONS
and bounded PROPFIND are accepted. File responses stream without whole-file
buffering. There is no writable VFS disk cache, symlink/reparse support or
write operation. Metadata and directory caches are in memory.

This adapter provides filesystem admission controls; it does not make an
unencrypted DAV service encrypted, authenticate a cloud account, or prove an
underlying service's ownership/billing policies. The calling application owns
its authenticated backend lifetime and must retain that context while mounted.
