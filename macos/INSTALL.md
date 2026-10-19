# Install the verified reference package

`install-macos.py` installs or reinstalls the original official v0.16.2/build19
Apple Silicon package on macOS 14 or later, using Python 3.9 or later. This
package predates the source changes in this directory: installing it does not
install the new upload, cleanup, plan selection or Account reset components.
Those components require integration into the native project and a new signed
build. The v0.16.2 GitHub release remains a draft pending notarization and a
signed-in Mac smoke test.

Obtain `GenDragoon-Cloud-SSD-Mac-v0.16.2.zip` from the repository's official
release assets using your existing GitHub access. The installer requires this
local archive and checks its pinned size and SHA-256; it does not download an
unverified substitute.

From the repository root, inspect the package without installing or launching
it (Linux is supported for this check):

```sh
python3 -B macos/install-macos.py \
  --archive /path/to/GenDragoon-Cloud-SSD-Mac-v0.16.2.zip --verify-archive
```

On a supported Mac, finish active transfers and disconnect the cloud mount in
the app, then run:

```sh
python3 -B macos/install-macos.py \
  --archive /path/to/GenDragoon-Cloud-SSD-Mac-v0.16.2.zip --reinstall --restart
```

The default destination is `~/Applications/GenDragoon Cloud SSD.app`. The
installer verifies bundle identity, version, architecture, Developer ID Team
`NZPU8H843J`, and Gatekeeper acceptance before replacement. It stages the app
on the destination volume, checks busy/mounted state, requests a graceful quit,
retains a backup, checks launch and rolls back a failed replacement or launch.
It shares the upload/cleanup/reset/updater maintenance lock and postpones
installation when those helpers are active. An older unmodified native app
cannot report every active operation through that lock; finish its work first.
It refuses downgrades and requires `--reinstall` to replace the same version.
It preserves settings, Keychain credentials, originals, cloud files and caches.
If rollback restores the previous app, that app may remain stopped.

Gatekeeper rejection stops installation. The installer does not bypass native
trust checks, force-unmount drives, force-kill applications or read an owner API
key. Observing the executable launch does not establish successful sign-in,
cloud operations, billing or complete app functionality.

Run the disposable-fixture installer tests from the repository root:

```sh
python3 -B -W error::ResourceWarning -m unittest discover \
  -s macos/tests -p test_install_macos.py -v
```

Automatic updates use the separate `Resources/gendragoon_auto_update.py` helper
and the release contract in `README.md`. A new source component becomes an app
update only after the complete native app is built, signed, notarized, tested
and published as an eligible stable release with its checksum asset.
