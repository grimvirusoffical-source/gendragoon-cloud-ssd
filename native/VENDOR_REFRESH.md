# Refresh the staged macOS Node runtime

The macOS builder copies vendor binaries from the supplied base app. Refresh
that newly built candidate before notarization and release packaging; rebuilding
from an older base app requires this step again.

```sh
python3 native/build_macos.py --output /absolute/path/to/fresh-build
python3 native/update_vendor_macos.py \
  --staged-app '/absolute/path/to/fresh-build/GenDragoon Cloud SSD.app'
```

Quit the staged candidate first. The helper requires an absolute, explicit path
and refuses installed/system locations, symlinks, shared hard links, a bundle
with the wrong identity, a folder writable by other users, or any process using
files in the bundle. It does not stop programs or replace an installed app.

The helper downloads only the official Node 24.22.0 Apple Silicon archive:

- Archive: <https://nodejs.org/dist/v24.22.0/node-v24.22.0-darwin-arm64.tar.gz>
- SHA-256: `6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5`
- Checksum provenance: the signed **SHASUMS** section of
  <https://nodejs.org/en/blog/release/v24.22.0#shasums>, retrieved October 17, 2026.

TLS uses macOS `/etc/ssl/cert.pem`; certificate and hostname verification remain
enabled. Redirects and environment proxy substitution are rejected. The archive
digest is pinned in the source rather than accepted from a mutable download
response. The helper does not independently validate a PGP signature.

Downloads are limited to 80 MiB and 180 seconds (20-second individual network
timeouts), decompression to 512 MiB and 50,000 entries, the Node binary to 200 MiB,
and its license to 2 MiB. Only the exact archive entries `bin/node` and `LICENSE`
are copied into fixed filenames. Symlinks, hard links and sparse files cannot
provide either selected entry. The executable must be a thin arm64 Mach-O.

An APFS clone of the staged bundle is prepared privately. The Node executable
retains the existing two reviewed JIT entitlements and signing identifier; both
Node and the parent are signed with the existing Developer ID Application
identity for team `NZPU8H843J`. Parent entitlements are preserved. Strict signature
verification, the exact runtime version and unchanged original bundle are checked
before replacement; final verification failure restores the previous staged
bundle. A failed rollback retains its recovery directory and prints its path.

The signed bundle includes `Contents/Resources/gendragoon_node.LICENSE` and
`Contents/Resources/node-vendor-provenance.json`, recording the version, source,
archive digest, binary digests before and after signing, identity and security
limit. No owner credentials or signing private keys are embedded.

After refreshing, run the candidate's relevant runtime/integration checks,
notarize and staple it through Apple's normal service, and then package it:

```sh
python3 native/package_macos.py \
  --app '/absolute/path/to/fresh-build/GenDragoon Cloud SSD.app' \
  --output /absolute/path/to/release-output
```

The refresh does not change Gatekeeper settings or clear quarantine and does not
claim successful notarization. A newly signed candidate needs a fresh notarization
submission and new package checksum.

## Known upstream security limit

Node 24.22.0 was released October 14, 2026 and includes the
[HMAC stream/digest memory fix](https://github.com/nodejs/node/pull/65112).
Separately, the Node project announced HIGH-severity fixes for 24.x scheduled
on or shortly after October 21, 2026. As of October 17, its
[official notice](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
does not publish a fixed version or vulnerability details. This refresh cannot
claim to include those unreleased fixes; update the pin and repeat the release
verification when the official fixed release is available.

Portable fixture checks run with:

```sh
python3 -m unittest discover -s native/Tests -p test_integrated_vendor_refresh.py -v
```

These fixture tests cover staging guards, archive handling and rollback. The
download, actual Apple signing, runtime execution and release trust checks must
also succeed on the Mac; local fixture tests do not establish those results.
