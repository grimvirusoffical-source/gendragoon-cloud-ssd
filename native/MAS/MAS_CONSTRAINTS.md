# Mac App Store build: constraints, status and checklist

Status: **config prepared, nothing built, signed or submitted.** Needs a Mac, Xcode, and Josh's Apple Developer Program account.
This is an honest read of the current Mac app source (`native/Sources`, `native/Resources`) against App Sandbox and App Review rules. Rules can change and review is Apple's call, so treat the "will it pass" column as a risk estimate, not a promise.

## What the MAS build does differently (implemented)
* `Resources/gendragoon_distribution.json` is `direct` in the repo. `MAS/build_mas.py` writes `mas` only into the staged MAS bundle.
* A Mac App Store receipt (`Contents/_MASReceipt/receipt`) always forces `mas`, even if the JSON says `direct`. Unknown/corrupt values fail safe to no self-update.
* Swift (`GDDistribution` in `GenDragoonAutoUpdate.swift`): the coordinator never starts, never checks, never schedules a restart; the "Automatic app updates" panel renders nothing. (Swift not compiled on this Linux box: **untested**, needs `xcrun swiftc` on a Mac.)
* Python helper (`gendragoon_auto_update.py`): every action except `status` prints `{"event":"disabled"}` and exits 0 without touching the network. `check/prepare/install_worker` also refuse internally. Tested in `Tests/test_distribution_channels.py` (8 tests) and `Tests/test_mas_config.py` (5 tests).
* Entitlements: App Sandbox, `network.client`, `files.user-selected.read-write`, `files.bookmarks.app-scope`. Helpers (`rclone`, `gendragoon_node`) get sandbox + inherit; node also gets JIT.

## What cannot work (or is likely to be rejected) inside the sandbox
| Feature in the current app | Problem | Likely resolution (needs Josh's decision, none implemented) |
|---|---|---|
| `rclone nfsmount` of the cloud drive (`GenDragoonApp.swift` ~L292) | Mounting a filesystem needs privileges the sandbox does not grant. | Drop the mounted-drive feature in MAS. Offer in-app browse/preload/stream only. |
| Restoring and RUNNING third-party Mac apps from the cloud (`gendragoon_app_launch.py`, "PLAY apps") | Runs code the app downloaded. App Review 2.5.2 forbids downloading/executing code that changes app features; launched apps inherit the sandbox or fail. | MAS edition without "run apps": files, backups, preload only. |
| Self-update from GitHub | Forbidden by Apple. | Done: disabled. |
| Bundled Python runtime, Node and rclone | Allowed if bundled, signed and sandboxed, but each adds review risk and size; Python must not fetch/exec code. | Keep bundled and inert; or port the helpers to Swift (large). |
| Writes to `~/Applications`, `~/Library/Application Support/...` | Application Support becomes the sandbox container (data will not be shared with the Developer ID build). Writes outside it need a user-picked folder + bookmark. | Use security-scoped bookmarks. Migration from the direct build is manual. |
| `/usr/bin/open -a Opera ...` and other shell-outs | Sandbox blocks launching arbitrary binaries. | Use `NSWorkspace.open(URL)` only. |
| Stripe web checkout for plans | Guideline 3.1.1: digital goods/subscriptions unlocked in the app generally must use In-App Purchase (external links are allowed only in some storefronts, e.g. US, per current rules). | StoreKit IAP for MAS, or ship MAS as free with sign-in only. Needs legal/pricing decision. |
| Ads (`GenDragoonAds.swift`) | Needs ATT/privacy-label review, depends on the ad SDK. | Review separately. |
| Bundle id | The direct build uses `app.gendragoon.cloudssd`. The same id can be used for MAS, but it needs its own provisioning profile and App Store Connect record. | Josh decides; or use a distinct MAS bundle id. |

## What Josh must provide
1. Apple Developer Program membership (US$99/yr) and an App Store Connect app record.
2. Certificates: "Apple Distribution" / "3rd Party Mac Developer Application", and "Mac Installer Distribution" / "3rd Party Mac Developer Installer", plus a Mac App Store provisioning profile.
3. Decisions on the table above (mounted drive, run-apps feature, IAP vs free, ads).
4. Privacy policy URL, support URL, age rating, export compliance answers, screenshots (see `RELEASE_PACKAGES/mac-app-store`).
5. Run on a Mac: `python3 native/MAS/build_mas.py --base-app <app> --output <dir>` then validate and upload with Transporter. **Nothing here uploads.**
