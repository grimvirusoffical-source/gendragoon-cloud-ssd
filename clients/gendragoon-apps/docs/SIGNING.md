# Windows signing

The NSIS installer builds without a certificate. CI sets `CSC_IDENTITY_AUTO_DISCOVERY=false` and does not set a certificate variable, so the uploaded artifact is unsigned.

`apps/desktop/electron-builder.config.cjs` turns on `signAndEditExecutable` only when one of these is present in the environment:

- `CSC_LINK` and `CSC_KEY_PASSWORD`
- `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`

Those variables are the signing hook. Do not commit a `.pfx`, a password, an Apple certificate, or a GitHub token. `GH_TOKEN` is also left unset. `electron-builder` is invoked with `--publish never`, while the publish block still points at GitHub Releases for `grimvirusoffical-source/gendragoon-apps` so a later release job can publish without changing the app id.

The Mac app is signed and notarized from the SwiftUI project. This repo does not produce a dmg.
