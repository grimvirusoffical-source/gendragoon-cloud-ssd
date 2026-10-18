import Foundation

enum GDSupportContactError: Error, Equatable {
    case stillPlaceholder
}

/// One contact for a deletion that cannot be retried. `isPlaceholder` stays true until grim picks the real email or URL.
struct GDSupportContact: Equatable {
    var value: String
    var isPlaceholder: Bool

    static let current = GDSupportContact(value: "support@example.com", isPlaceholder: true)

    /// Throws while `current` is still a placeholder. A release must not ship that value.
    static func assertReleaseReady() throws {
        if current.isPlaceholder {
            throw GDSupportContactError.stillPlaceholder
        }
    }
}
