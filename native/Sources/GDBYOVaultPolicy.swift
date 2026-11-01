import Foundation

/// A recovery record deliberately has no RedX API key. Reconnecting supplies
/// a newly verified scoped key without replacing the recovered encryption keys.
enum GDBYOVaultPolicy {
    static func record(_ value: [String: String]) throws -> [String: String] {
        guard Set(value.keys).isSubset(of: ["key", "storageSecret"]),
              let secret = value["storageSecret"],
              secret.range(of: "^[A-Za-z0-9_-]{32,128}$", options: .regularExpression) != nil,
              value["key"] == nil || value["key"]!.range(of: "^rx_live_[A-Za-z0-9]+$", options: .regularExpression) != nil else {
            throw GDPortableVaultFailure(message: "The BYO connection's private Keychain credentials are unavailable.")
        }
        return value
    }
    static func account(owner: String, receiver: String) throws -> String {
        guard GDPortableVaultCodec.validReceiver(owner), GDPortableVaultCodec.validReceiver(receiver), owner != receiver else {
            throw GDPortableVaultFailure(message: "Invalid BYO recovery context.")
        }
        return owner + ":" + receiver
    }
    static func recovery(existing: [String: String]?, secret: String) throws -> [String: String] {
        let recovered = try record(["storageSecret": secret])
        guard let existing else { return recovered }
        let retained = try record(existing)
        guard retained["storageSecret"] == secret else {
            throw GDPortableVaultFailure(message: "This BYO workspace already has different encryption keys on this Mac. Import will not replace them.")
        }
        return retained
    }
}
