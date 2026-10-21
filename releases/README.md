# GenDragoon Releases

Pre-release builds of GenDragoon Cloud SSD. Source code: [gendragoon-cloud-ssd](https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd).

Every build here is a **test build** for evaluation. Nothing is signed for distribution or published through an app store.

## Current release

[all-platforms-2026-10-19](https://github.com/grimvirusoffical-source/Gendragoon-Releases/releases/tag/all-platforms-2026-10-19)

| Platform | Files | Signing |
|---|---|---|
| Windows 10/11 x64 | Unpacked desktop app (`.zip`) | Unsigned |
| Linux x64 | AppImage, `.deb`, `.tar.gz` | Unsigned |
| Windows and Linux | Command-line companion (Python source) | Not applicable |
| Android 8.0+ | Debug APK for sideloading; release AAB | APK debug key only; AAB unsigned |
| Chrome, Edge, Opera, Firefox | Browser extension zips (0.2.0) | Unsigned |

macOS and iOS builds are not published here yet. The release notes list what has and has not been tested.

Earlier pre-releases (Android debug APK, Windows unpacked app, desktop companion) are kept for reference and are superseded by the current release.

## Verify a download

Each release includes `SHA256SUMS`:

```sh
sha256sum -c SHA256SUMS
```

## Install

- **Windows:** unzip and run `GenDragoon Cloud SSD.exe`. SmartScreen warns because the build is unsigned.
- **Linux:** `chmod +x` the AppImage and run it, or install the `.deb` with `sudo apt install ./<file>.deb`.
- **Android:** allow installation from unknown sources and open the APK.
- **Companion:** unzip, then run `sh install-linux.sh` or `install-windows.ps1`.
- **Browser extensions:** for local testing, unzip and load the folder as an unpacked extension (Chrome, Edge, Opera) or as a temporary add-on (Firefox).

## Support

Contact: support@example.com (placeholder)
