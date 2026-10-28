# Kamatera-backed mounted storage — 0.22.2 (38)

## Corrected data path

The authoritative objects remain on the existing Kamatera Receiver at
`api.red-xai.com`, with the deployed storage root
`/srv/red-xai/gendragoon-receivers`. This client change does not relocate data or
introduce another storage provider.

Normal mounted reads now use `gendragoon_remote_archive.py` rather than
`stage_item`, `download_archive`, or extraction into an application cache. The
reader authenticates the selected workspace, archive root, index pages and each
requested data chunk. It supports existing flat and ZIP-root archives, including
stored and deflated ZIP members. Only the selected member/range is served.

Payload caching is in process memory: up to 8 MiB per reader, four admitted
readers per mount process, with separately bounded index/read allocations.
Filesystem helpers have disk VFS caching disabled. OS virtual memory, application
preferences and files explicitly saved by another application are not claimed to
use zero local storage. Upload preparation and explicit Download/offline exports
can still require local working space. A highly compressed legacy ZIP member may
need earlier compressed bytes to seek, but no complete archive is written locally.

Indexes or ZIP directories beyond the reader limits fail clearly instead of
silently downloading the entire archive. Re-uploading existing ordinary archives
is not required. Old retained caches are not deleted automatically.

## Open and Play

- Normal Mac **Open** resolves the selected item on its authenticated mounted
  workspace. It no longer restores an offline copy first.
- Mac **Play** requires a current `remote-memory-v1` workspace mount, resolves the
  authenticated app hierarchy, checks bundle compatibility and signature, and
  starts that mounted path. Required macOS extended attributes that the read-only
  mount cannot reproduce cause an explicit error, not an automatic local copy.
- Windows/Linux source changes prepare compatible portable executables from the
  owned read-only mount and keep only small control/session records locally.
  The executable's real format, architecture and digest are checked; arbitrary
  browser paths and process IDs remain forbidden.
- Multiple different managed apps may run together. The native UI warns about
  shared performance and requires confirmation before force-stopping another app.
- Explicit offline restore remains available. The legacy command-line launcher
  must be given `--allow-local-copy` to permit full local app restoration.
- Stopping one app never unmounts a shared workspace or deletes cloud objects.

This is **cloud-backed storage**, not server-side application execution. Desktop
CPU/RAM execution remains on the compatible client OS. It is not Windows-on-Mac
emulation and does not make an iPhone application runnable on a Linux server.

## Upgrade procedure

Install the signed/notarized Mac update, then normally unmount and remount the
workspace. Old mount daemons keep their old implementation until replaced; the
new Play path refuses an old mount rather than silently falling back. Close apps
and files before unmounting. Existing accounts, server archives and older caches
are retained.

The download is a **macOS Apple Silicon preview update**. Source changes for
Windows/Linux are included and tested separately; this Mac ZIP is not an Intel,
Windows, Linux, Android or iOS installer. Intel source compilation is a separate
check and does not imply a universal bundled runtime.

## Verification observed for this candidate

- 231 selected regression tests: 216 passed, 15 platform/runtime skips, no failures.
- 34 desktop mount tests with the actual pinned encryption runtime: 31 passed,
  three platform/driver skips. Verified remote file reads leave the payload cache
  directory empty.
- Real macOS NFS mount over authenticated loopback DAV: passed reads and write
  refusal, with disposable fixtures and normal unmount.
- Range tests include corruption, wrong workspace, traversal, duplicate ZIP
  members, RAM limits, and reading a small member without fetching unrelated data.
- Apple Silicon optimized native build, Developer ID signing, Apple notarization,
  stapling and Gatekeeper assessment: passed for 0.22.2 build 38.

These counts overlap; they are not a unique combined test total. Source-only
Windows/Linux mounted-app changes still require target-OS release acceptance.

## Explicitly outside this Mac storage correction

The iOS client still has a separate legacy transfer backend and is not migrated
by this release. Mobile launcher requests are not execution confirmations; the
mobile execution/streaming service is not implemented. Mandatory device-token
rollout and cross-account free-signup abuse prevention are not declared complete.

The branch also contains earlier three-mode encryption, verified OS-Trash offload
and first-workspace free-tier work. Features requiring new Receiver/control
capabilities remain subject to server deployment; this document does not claim a
production service deployment. The existing Kamatera read API is sufficient for
the on-demand mounted-read correction.


## 0.22.4 mount recovery correction

The read-only macOS mount now distinguishes transient transport/capacity errors
from quota/authentication failures. Temporary read failures return retryable HTTP
503 before streaming begins. A failure after headers closes that response; it
never appends a second HTTP error message into the requested file's bytes.

The first data block is verified before success is announced. Top-level app
folder listing no longer decrypts every backup just to show its name. Archive
metadata loading has per-item locks so one slow backup does not monopolize the
mount status lock. A per-mount LRU shares at most 32 MiB of verified blocks for up
to 60 seconds in RAM; separate per-reader and metadata safety bounds remain.
Normal requests still require native authorization and live catalog identity
checks. Logout clears shared blocks. No disk payload cache or full local restore
was introduced. The original encryption implementation is unchanged.

Validation on an Apple Silicon Mac: the focused combined regression command ran
160 tests (159 passed, one platform opt-in skip). A separately enabled, real NFS
fixture generated a first-read outage and a midstream disconnect and read the
correct complete fixture without recreating the mount. Local data was generated
only for that disposable test. Network outages can still interrupt a cloud-only
drive; this correction does not promise offline access or bypass failed trust,
expired sessions, or changed cloud objects.
