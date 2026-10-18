import Foundation

/// Mirrors `packages/core` `SUPPORT_CONTACT` in gendragoon-apps.
/// RELEASE BLOCKER until grim supplies the real contact. `isPlaceholder` must be false
/// before a release ships. Release CI runs
/// `xcodebuild test -configuration Release`; `testReleaseBuildRejectsPlaceholderSupportContact`
/// fails while this flag is true. Debug test runs only check that the placeholder is still
/// the shared value.
enum SupportContact {
    /// Shared-core placeholder. Not a deliverable address.
    static let address="SUPPORT_CONTACT_PLACEHOLDER@invalid"
    static let isPlaceholder=true
}
