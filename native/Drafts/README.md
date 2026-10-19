# Drafts (not compiled)

Files here are **not** part of any build. `build_macos.py` compiles `native/Sources/*.swift` only.

- `TeamsScreen.swift`: SwiftUI Teams screen for the Mac app (list, chat with 3 s polling, members, rename). Written without a Swift toolchain; compile it on the Mac before moving it into `Sources/`. It reuses `GDTransferClient.jsonData` for authenticated requests. Uses `Host.current().localizedName` as the default chat name.
