# GenDragoon Windows and Linux companion

This is the command-line native companion for Windows and Linux. It talks to the
same authenticated `/v3/cloud/{workspace}` transfer routes as the macOS and mobile
clients. It does not create a separate storage account or alternative cloud API.

## Implemented behavior

- Upload a selected file or a complete directory tree. Empty files and directories
  are preserved in ZIP packages. Native portable applications use the same package
  format with an explicit platform, architecture, executable path and per-file
  SHA-256 manifest.
- Retain originals by default. `--remove-original` performs a full cloud download,
  SHA-256 comparison and complete package restore check, then checks that the
  original tree is unchanged before moving that exact selection to Trash/Recycle
  Bin. Trash is intentionally not emptied. Linux cross-filesystem original removal
  is refused; the user can use the system file manager after verification.
- Restore compatible portable applications to a dedicated managed cache. All
  archive entry paths, types, sizes and digests are validated before launch.
- Start a compatible native PE/ELF executable and wait for its application process
  tree to exit before removing its managed cache. Windows uses a Job Object; Linux
  uses a new process group plus cached executable-path checks. Interrupted monitors
  leave the lease and cache in place for inspection.
- Warm at most 16 MiB of the native executable before launch. This implementation
  fully downloads ZIP packages; it does **not** claim sparse large-app streaming.
- Store application packages for other platforms as ordinary files. Desktop
  installers, privileged services and applications with external machine-specific
  installation requirements are not treated as portable apps.

## Installation

Python 3.11 or newer must already be installed. From this checked-out folder:

```sh
sh install-linux.sh
```

On Windows, run `install-windows.ps1` through the PowerShell execution policy already
configured on your machine. The installer does not disable that policy or elevate
privileges. It reports the full `gendragoon.cmd` command path after installing.

Both scripts install only the current-user companion. They do not uninstall old
GenDragoon applications or alter application data. The macOS installer is separate.

## Commands

Run `gendragoon capabilities` to see the precise local platform support. Account
operations prompt for a session token or scoped account API key using a hidden
terminal prompt. A parent process can supply it through `--token-stdin`; it must
never be placed in a command argument, committed to source or printed to logs.
Owner credentials are not embedded in this companion. Existing server authorization
and workspace scopes remain authoritative.

```sh
gendragoon workspaces
gendragoon list --workspace free
gendragoon upload --source /path/to/Folder --workspace free
gendragoon upload --source /path/to/PortableApp --application-entrypoint bin/app --workspace free
gendragoon upload --source /path/to/Folder --workspace free --remove-original
gendragoon restore --file-id CLOUD_FILE_UUID --workspace free
gendragoon launch --file-id CLOUD_FILE_UUID
gendragoon evict --file-id CLOUD_FILE_UUID
```

Use `--destination /path/to/file` when restoring a plain file or another platform's
application package. Existing destination files are never overwritten. A restored
GenDragoon package has its original root folder and empty directories preserved.

`launch --keep-cache` retains the verified managed copy after exit. Normal launch
removes an unchanged managed copy after comparing it with its saved manifest.
Changed application data, unexpected files and interrupted launches retain the
cache for inspection; the launch result reports `cacheRemoved: false` and a
`cacheRetainedReason`. Cleanup only removes verified manifest files and empty
directories, so new sibling or nested files that arrive during cleanup are
retained. Such a late change can leave a partially cleaned cache, with remaining
content preserved for recovery. Uploaded cloud files and the user's original
application remain unchanged. Save changed application data before restoring a
fresh verified copy for another launch.

## Validation and limits

Run the tests from the repository root:

```sh
python -m unittest discover -s native/Desktop/tests -p 'test_desktop.py' -v
```

The protocol integration cases require the existing `native/Backend` npm
dependencies and start a loopback-only instance of the real transfer router with
in-memory Google Cloud/Firestore fixtures. They never contact production, alter a
Stripe plan or delete user files.

At code commit `18b54fcd21698239e7ca2775cd8e3b3c41d3ae38`, both the
[push](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/actions/runs/39023761715)
and [PR](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/actions/runs/39023766003)
workflows passed all seven jobs. The Desktop suite ran 36 tests: Linux passed 35
with one Windows-only skip; Windows passed 32 with four platform-specific skips.
The real Windows Job Object launch and unchanged-cache removal passed, including
the corrected path/descriptor metadata comparisons.

Coverage includes a multi-chunk round trip through the actual router, per-file
corruption, path traversal, reserved Windows paths, symbolic links, source changes,
cache tampering, active leases, native executable lifecycle and concurrent folder
restores. Changed, unexpected and late-added cache data is retained. These bounded
tests do not certify every third-party app or provide an independent penetration
test. See [the validation record](../VALIDATION.md) for exact scope and evidence.

This is a command-line client, not a finished Windows/Linux graphical application.
Signed installers, platform-specific updater delivery, service/FUSE mounting and
true demand paging for large applications remain separate release work. Files in a
raw macOS rclone bucket are not automatically imported into the paid `/v3/cloud`
workspace catalog.

## Platform references

- [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [QueryInformationJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject)
- [FreeDesktop Trash specification](https://specifications.freedesktop.org/trash-spec/latest/)

