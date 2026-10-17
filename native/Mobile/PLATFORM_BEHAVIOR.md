# GenDragoon mobile behavior — 0.17.0 / build 20

The mobile clients reuse the existing authenticated `/v3/cloud` transfer service.
They offer individual files, application-package files and complete selected
directory trees. App packages are prominently selectable without claiming that
mobile operating systems can run arbitrary desktop programs.

| Platform | File/folder access | Application behavior | Cache/original behavior |
| --- | --- | --- | --- |
| iOS/iPadOS | Native Files picker with security-scoped access; folders become portable ZIP archives, including empty files/directories. | Store, restore and share application packages for compatible devices. No arbitrary `.app`, `.exe`, `.apk` or downloaded iOS executable launch. | Checkbox plus explicit selection confirmation; full cloud SHA-256 read-back and per-entry archive verification precede provider-coordinated original deletion. Reset clears local settings/transfer cache and keeps cloud and exported files. |
| Android | Storage Access Framework file and complete document-tree pickers; bounded streaming ZIP creation. | Restore APK, then explicitly hand it to Android's system installer. Unknown-source authorization, installation approval, architecture and package-signature decisions remain with Android/the user. AAB, iOS and desktop packages remain stored files. | Full cloud read-back, ZIP entry verification and an unchanged source snapshot are required before `DocumentsContract.deleteDocument`. Installed apps are OS-managed, not automatically uninstalled as GenDragoon cache. |

Original removal is off by default and applies only to the exact picker selection.
Some document providers delete permanently. A denied provider permission, changed
source, interrupted upload or failed read-back retains the original. Mobile folder
archiving can require substantial temporary space; a 512 MiB free-space reserve is
required in addition to the selected folder and its metadata. Large directory
uploads require the app/provider to remain available; all completed transfer chunks
are retained by the existing resumable upload protocol. Repreparing an interrupted
iOS folder can create a new upload session rather than resuming the previous ZIP
session because its temporary filename changes.

The selected workspace is saved per signed-in account. Upload and restore capture
that selection when they start. The account Reset App action preserves cloud files
and exported documents. Android background transfer scheduling remains implemented
through the existing visible WorkManager foreground worker.

## Build requirements and evidence

- iOS targets iOS 17+ and preserves the existing bundle identifier, signing team and
  App Store marketing version `1.0`; build number is `20`. ZIPFoundation is pinned to
  `0.9.20`. The Xcode project was updated without regenerating its signing settings.
- Android targets SDK 36 with the existing Java 17/desugaring setup; version name is
  `0.17.0`, version code `20`. The project generator now retains the desugaring
  dependency needed by existing Java library calls.
- Android requests `REQUEST_INSTALL_PACKAGES` only for the explicitly invoked APK
  installer handoff. Play distribution requires its permission declaration/review
  as appropriate for the app's approved core file-management behavior. The new
  permission is not permission to install silently or bypass Play review.
- Mobile source requires actual Xcode/Android compilation, provider-based transfer
  tests, device installation tests, background interruption tests and store review.
  Source-level inspection and desktop archive tests are not substitutes for those
  checks. Build results are recorded by the release validation workflow.
- Mobile self-updates continue through App Store/TestFlight/Google Play delivery;
  desktop updater behavior is not claimed for mobile binaries.

## Primary references

- [Apple App Review Guidelines, Software Requirements](https://developer.apple.com/app-store/review/guidelines/#software-requirements)
- [Android Storage Access Framework](https://developer.android.com/training/data-storage/shared/documents-files)
- [Android package installer user action](https://developer.android.com/reference/android/content/pm/PackageInstaller.SessionParams#setRequireUserAction(int))
- [Google Play use of REQUEST_INSTALL_PACKAGES](https://support.google.com/googleplay/android-developer/answer/12085295)
- [ZIPFoundation source and API](https://github.com/weichsel/ZIPFoundation/tree/0.9.20)
