# GenDragoon Cloud SSD

> **0.22.2 storage update:** mounted reads and normal Open/Play no longer restore full archives automatically. See [Kamatera streaming notes](native/KAMATERA-STREAMING.md). Older local-cache behavior described below applies only to explicit offline/legacy paths.

GenDragoon Cloud SSD stores encrypted files, folders and applications in **MachineNotes** on your Red-XAI server. The macOS app uses your Red-XAI account and the pinned Red-SecretsXAI library to encrypt archives locally and encode them as red-X barcode PNGs before upload. This repository holds the clients, backend services, release tooling and storage SDKs.

## Features

- Upload files, folders and applications with verified read-back, optional removal of the local original only after verification, and protected restores.
- Managed launch of applications from a local cache, bounded preloading, and cache cleanup that never touches user data.
- Drive cleanup: preview and sort a folder into Applications, Videos, Audio, Pictures, Files and Folders, with an undo journal.
- Account-isolated MachineNotes, storage and performance plans with server-verified billing. The verified service owner can list MachineNote and library metadata across accounts; regular accounts can list only their own.
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

## Configuration

The backend reads its settings from the environment. Variable names, and which ones are secrets, are listed in [native/Backend/README.md](native/Backend/README.md#configuration-and-deployment), including accounts (`ACCOUNTS_SEAL_KEY`) and phone two-factor codes through Twilio (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` or `TWILIO_API_KEY_SID` with `TWILIO_API_KEY_SECRET`, and `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM_NUMBER`). Secret values live in the deployment's private credential configuration, never in this repository.

## Security

The current macOS storage flow offers only server-backed MachineNotes. Legacy Google/provider helpers remain for compatibility with older clients and tests; the app does not enumerate Google projects, offer Google buckets, or send new uploads to a saved Google destination. Removing those choices does not delete any existing Google Cloud buckets.

MachineNote ownership is enforced by the Receiver API. Owner-wide enumeration requires the current identity provider to verify the configured owner email on every request; a saved owner flag cannot grant access. Administrative inventory exposes names, plans, usage and library metadata. It does not expose storage secrets or grant decryption of another account's encrypted archives. Archive decryption remains dependent on the account's client-held encryption secret.


Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md). No user data, private API keys or cloud credentials belong in this repository.

## About

Gendragoon is developed and maintained by Red-XAI LLC. Red-XAI LLC is wholly owned by GRIM-VIRUS, an independent recording artist who leads development under the alias MainDirectory. © Red-XAI LLC. All rights reserved.

## License

License: to be announced. © Red-XAI LLC. All rights reserved until a license file is added.

## Support

Contact: support@infected-nation.com
