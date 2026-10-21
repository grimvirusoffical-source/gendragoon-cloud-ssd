# Red-XAI Updater

Menu-bar app for grim's Mac apps. It imports `@gendragoon/updater` and reads the public GitHub Releases feed for `grimvirusoffical-source/gendragoon-cloud-ssd`. Stable means a non-prerelease. The current tagged Mac builds are prereleases, so a stable check reports that no stable release is published.

The default asset pattern is `^GenDragoon-Cloud-SSD-Mac-.*\.zip$`. Checksums come from the release's `sha256.txt`. A bad checksum does not install. A failed post-launch health check rolls back.

This app is not inside the Windows NSIS installer. The Mac GenDragoon client itself remains the SwiftUI app. Add another public repo by appending to `RED_XAI_FEEDS` in `src/feeds.ts`. Private tokens, if you ever need one, are read from the OS keychain inside the host and are not stored in this repo.
