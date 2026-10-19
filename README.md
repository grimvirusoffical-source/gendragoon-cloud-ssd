# GenDragoon Cloud SSD

GenDragoon Cloud SSD turns your own Google Cloud storage into a drive you can upload to, restore from and run applications out of. This repository holds the clients, the backend service, the release tooling and the storage SDKs.

## Features

- Upload files, folders and applications with verified read-back, optional removal of the local original only after verification, and protected restores.
- Managed launch of applications from a local cache, bounded preloading, and cache cleanup that never touches user data.
- Drive cleanup: preview and sort a folder into Applications, Videos, Audio, Pictures, Files and Folders, with an undo journal.
- Accounts, projects, storage and performance plans with server-verified billing.
- Clients for macOS, iOS, Android, Windows and Linux, plus Python and JavaScript storage SDKs.
- Self-update on the direct macOS download with pinned checksums and signature checks. Store builds do not self-update.

## Repository layout

| Path | Contents |
| --- | --- |
| `native/` | macOS app, Android and iOS clients, Windows/Linux command-line companion, backend and release scripts |
| `native/Backend` | Node.js API (identity, billing, transfers) |
| `native/MAS` | Mac App Store build configuration |
| `macos/` | Reference macOS components and the installer |
| `sdk/` | Python and JavaScript storage SDKs |
| `fixtures/` | Shared cross-platform test fixtures |

## Install

Pre-built test builds are published at [Gendragoon-Releases](https://github.com/grimvirusoffical-source/Gendragoon-Releases/releases). Each release lists its files, whether they are signed, and a `SHA256SUMS` file. To install the macOS app from source see [native/README.md](native/README.md) and [macos/INSTALL.md](macos/INSTALL.md).

## Build and test

```sh
# Backend
cd native/Backend && npm ci && npm test

# Python helpers and companion
PYTHONPATH=native/Resources python3 -m unittest discover -s native/Tests -p 'test_integrated_*.py'
python3 -m unittest discover -s native/Desktop/tests -p 'test_desktop.py'

# macOS app (Apple Silicon, Xcode)
python3 native/build_macos.py --output /path/to/build

# Android
cd native/Mobile/Android && ./gradlew :app:assembleDebug
```

More detail: [native/README.md](native/README.md), [native/Backend/README.md](native/Backend/README.md), [native/Desktop/README.md](native/Desktop/README.md), [native/Mobile/PLATFORM_BEHAVIOR.md](native/Mobile/PLATFORM_BEHAVIOR.md), [sdk/README.md](sdk/README.md).

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md). No user data, private API keys or cloud credentials belong in this repository.

## About

Gendragoon is developed and maintained by Red-XAI LLC. Red-XAI LLC is wholly owned by GRIM-VIRUS, an independent recording artist who leads development under the alias MainDirectory. © Red-XAI LLC. All rights reserved.

## License

License: to be announced. © Red-XAI LLC. All rights reserved until a license file is added.

## Support

Contact: support@example.com (placeholder)
