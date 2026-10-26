# GenDragoon MachineNotes desktop

`gendragoon_gui.py` is the current Windows/Linux desktop Files and Teams client.
It uses the account's authenticated `/v1/receivers/*` MachineNotes API, the pinned
Red-SecretsXAI C++ codec, and genuine visual PNG ciphertext carriers. Account
sign-in, encryption keys, storage subscriptions, and Teams membership have separate
roles; signing in or joining a team does not grant somebody else's file keys.

The source is implemented and has local codec/model tests. Windows and Linux
runtime candidates must pass their respective CI before being described as
validated releases. CI builds executable GUI/native-host candidates; it does not
sign, publish, install, or submit them to an app store.

## Current desktop behavior

- Browser approval uses Red-XAI's PKCE approval flow. Access and refresh credentials
  stay in process memory, with serialized renewal during long transfers. Closing
  the app discards them; there are no plaintext token files or credential arguments.
- Files displays owned MachineNotes and their nested virtual folders. Create,
  rename, move, copy, paste, drag items into folders, and remove library references
  through the authenticated, revision-checked server operations. Folder backups
  remain complete archive items. Removing references retains encrypted payload
  bytes and does not reclaim quota.
- Upload files/folders, retain originals, then download the full encrypted archive,
  decrypt it, restore it, and verify every file against its authenticated SHA-256
  manifest. Transfers use the server's worker allowance. Immutable chunks can be
  reused after interrupted requests; bounded network retries cannot replay arbitrary
  metadata mutations. The UI reports actual phase/archive and streamed carrier bytes.
- Restore renamed/copied items without changing their crypto IDs or associated
  data. Restore only into new destinations using an atomic no-replace operation.
  Virtual-folder downloads compose their retained archive children.
- Import/export the same account-bound portable vault used by the Mac and Android
  clients. AES-256-GCM, PBKDF2-HMAC-SHA256 with exactly 600,000 iterations, a random
  16-byte salt, and a random 12-byte nonce protect the storage secret and encrypted
  private KXAI keymap. Passphrases require at least 12 Unicode code points. Auth
  tokens and integration keys are excluded. Different existing keys are preserved.
- Initialize keys only after a fresh full-account response proves storage empty.
  Export the new vault before uploading; an API key cannot initialize account keys.
  Existing encrypted storage requires the original vault. A vault cannot be
  recovered from account sign-in or an integration key.
- Teams supports username registration, note-team creation, invitations/join,
  membership lists, and paginated server-relayed chat. Integration-key mode has
  Files access to its bound note and no Teams rights. Peer calls/live media are
  not provided in this Tk view, and Teams membership grants no storage access.
- Browser/editor companion requests require an exact installed extension allowlist
  and native approval for the current account. Browser uploads use the native file
  picker. Explicit editor selections are confirmed, then saved to a private durable
  queue before returning acceptance. Jobs retain their account/note/folder context,
  resume only after the same account and vault are available, and retain originals.
- A single desktop coordinator protects writers. Profile, Jobs, keymap, staging,
  and restored files are private to the local user. Windows creates new paths with
  explicit current-user owner SID/private ACLs, including elevated processes.
- The new workspace-drive source provides a **real read-only filesystem mount**
  through an existing trusted rclone executable. The Files view has Mount, Open,
  Unmount, and rclone-selection controls. Multiple MachineNotes have separate
  account/note identities, caches, DAV credentials, and mount locations. The
  already verified `1c6a586` candidates predate this drive feature; a new candidate
  must pass its own platform checks before receiving a mount validation claim.

Mac application bundles, extended attributes, and symbolic links must be restored
with their original platform's client. Portable restores normalize local
permissions to private owner access. Managed macOS application launch remains
specific to the Mac client.

## Read-only workspace drives

Windows needs an existing WinFsp installation; Linux needs existing permitted
`/dev/fuse` access and `fusermount3` or `fusermount`. GenDragoon installs no driver,
changes no kernel permissions, and never labels a download folder as a drive.
These prerequisites follow the [official rclone mount documentation](https://rclone.org/commands/rclone_mount/).

The authenticated loopback DAV adapter uses the account's current ownership and
encrypted archive manifests. Every request checks the frozen account and note.
Metadata, ranges, and file bytes come from verified archives in a private cache.
Opening a folder backup can download and restore that complete archive before its
first file read; this is not sparse archive access. macOS apps, symbolic links,
and extended attributes still need their original platform's restore client.
PUT, MOVE, DELETE and other mutations are rejected; edit files through GenDragoon.

The rclone child receives only temporary loopback credentials in its environment,
without an account token, refresh token, storage secret, or keymap path. Registry
files contain mount/process identities and tool metadata only. Account switching,
disconnect, key replacement, and Quit are blocked while any drive remains mounted,
orphaned, preparing, or uncertain. Verified caches are retained after unmount.

Linux uses normal `fusermount -u`, retaining a busy drive. Windows verifies its
recorded volume through the opened handle and requires a successful exclusive
[volume lock](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_lock_volume)
before dismount/shutdown, holding that lock until the owned rclone process exits.
Unsupported WinFsp controls fail closed and preserve the session. No force/lazy
unmount or arbitrary process termination is provided.

CI stages a hash-pinned official rclone executable only in the ephemeral runner,
then tests real mount/read/busy refusal/normal unmount **if** that runner already
has usable FUSE or WinFsp. The separate mount-capability report states `verified`,
`prerequisite-unavailable`, or `failed`; a missing-driver skip is not evidence
that a drive mounted. Windows driver compatibility remains unverified until its
real mount gate passes. Product installation does not download this CI fixture.

## Current client installation

Use Python **3.13** with Tkinter. The checked-out installer writes only GenDragoon's
current-user program/runtime and a private virtual environment. It never elevates
privileges or changes PowerShell execution policy. Account approval and vault
import happen in the window, not on a command line.

```sh
sh native/Desktop/install-linux.sh
```

On Windows, run `native/Desktop/install-windows.ps1` through the machine's existing
PowerShell policy. It builds an actual `GenDragoonNativeHost.exe`; a batch file is
not substituted for a native-messaging executable. Windows 10 version 1903 or newer
is required for native Unicode codec paths. Packaged executables embed a UTF-8
process manifest. Source installation creates a separate application-owned Python
launcher with that manifest and explicit module paths; it validates the process
code page and dependencies, while preserving the original Python installation.
Application code lives under `%LOCALAPPDATA%\Programs\GenDragoon\Companion`;
the client's private account files remain under `%LOCALAPPDATA%\GenDragoon`.
Starting the codec from an ordinary Python process with a legacy ANSI code page
fails before key creation and directs the user to the verified launcher.
Source builds require CMake and
a C++ compiler; compiled runtime inputs can instead be selected explicitly:

```sh
python -B native/Desktop/stage_runtime.py --destination /new/staging/path --prebuilt native/Desktop/runtimes/linux-x86_64.zip
python -B /new/staging/path/gendragoon_gui.py --check
```

The public platform ZIPs contain Python3.13 bytecode, the matching native codec,
and license notices. `runtime-index.json` pins archive digests; the internal
manifest pins all sizes/hashes, platform, architecture, bytecode version, and
library commit `9235941b431bc1c23c34286b82052f845121592f`. Unsafe paths, source
files, links, incompatible versions, and changed archives fail closed. The
GenDragoon-owned `codec_loader.py` adapts only the two verified codec package
directories' frozen sibling imports; the vendor checkout and crypto API stay
unchanged. Source builds place all output outside the vendor tree.

Dependencies are pinned in `requirements.txt`; release tooling is separate in
`requirements-build.txt`. Version metadata comes from the official package pages:
[cryptography](https://pypi.org/project/cryptography/),
[pywin32](https://pypi.org/project/pywin32/), and
[PyInstaller](https://pypi.org/project/pyinstaller/).

In **Storage keys → Configure browser/editor access**, enter exact installed
Chromium extension IDs and explicitly enable Firefox/VS Code as needed. A
standalone GUI candidate carries its own PE/ELF host; source/Python installs use
their verified interpreter on Linux. Linux Opera requires a system host directory,
so the current-user installer refuses that registration. Nothing writes to `/etc`.

## Legacy v3 command-line companion

The retained `gendragoon_desktop.py` CLI below targets the older
`/v3/cloud/{workspace}` protocol and its legacy package/app lifecycle. It is not
the current MachineNotes GUI and does not migrate encrypted account keys.

### Legacy behavior

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

### Legacy commands

Run the retained CLI explicitly with `python gendragoon_desktop.py`; current
installers launch the MachineNotes GUI. Run
`python gendragoon_desktop.py capabilities` to see the legacy platform support. Account
operations prompt for a session token or scoped account API key using a hidden
terminal prompt. A parent process can supply it through `--token-stdin`; it must
never be placed in a command argument, committed to source or printed to logs.
Owner credentials are not embedded in this companion. Existing server authorization
and workspace scopes remain authoritative.

```sh
python gendragoon_desktop.py workspaces
python gendragoon_desktop.py list --workspace free
python gendragoon_desktop.py upload --source /path/to/Folder --workspace free
python gendragoon_desktop.py upload --source /path/to/PortableApp --application-entrypoint bin/app --workspace free
python gendragoon_desktop.py upload --source /path/to/Folder --workspace free --remove-original
python gendragoon_desktop.py restore --file-id CLOUD_FILE_UUID --workspace free
python gendragoon_desktop.py launch --file-id CLOUD_FILE_UUID
python gendragoon_desktop.py evict --file-id CLOUD_FILE_UUID
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

## Tests and limits

Run the tests from the repository root:

```sh
python -m unittest discover -s native/Desktop/tests -p 'test_desktop.py' -v
```

The protocol integration cases require the existing `native/Backend` npm
dependencies and start a loopback-only instance of the real transfer router with
in-memory Google Cloud/Firestore fixtures. They never contact production, alter a
Stripe plan or delete user files.

Coverage includes a multi-chunk round trip through the actual router, per-file
corruption, path traversal, reserved Windows paths, symbolic links, source changes,
cache tampering, active leases, native executable lifecycle and concurrent folder
restores. Changed, unexpected and late-added cache data is retained. These bounded
tests do not certify every third-party app or provide an independent penetration
test.

This is a command-line client, not a finished Windows/Linux graphical application.
Signed installers, platform-specific updater delivery, service/FUSE mounting and
true demand paging for large applications remain separate release work. Files in a
raw macOS rclone bucket are not automatically imported into the paid `/v3/cloud`
workspace catalog.

## Platform references

- [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [QueryInformationJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject)
- [FreeDesktop Trash specification](https://specifications.freedesktop.org/trash-spec/latest/)

