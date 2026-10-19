import Foundation
import CryptoKit

/// Product project choices are shared by Files, Storage and Performance.
/// Firebase account identity and project identity scope all saved view settings.
enum GDProjectPreferences {
    static let selectionChanged = Notification.Name("GDProjectSelectionChanged")
    static func key(accountID: String, workspaceID: String = "", setting: String) -> String {
        let scope = SHA256.hash(data: Data((accountID + "\n" + workspaceID).utf8))
            .map { String(format: "%02x", $0) }.joined()
        return "gd.project." + scope + "." + setting
    }
    static func selected(accountID: String) -> String {
        let value = UserDefaults.standard.string(forKey: key(accountID: accountID, setting: "selected"))
        if let value, value == "free" || UUID(uuidString: value) != nil { return value }
        // Preserve the existing account-specific Cloud choice when upgrading.
        let legacy = SHA256.hash(data: Data(accountID.utf8)).map { String(format: "%02x", $0) }.joined()
        let previous = UserDefaults.standard.string(forKey: "gd.customer.workspace." + legacy) ?? "free"
        return previous == "free" || UUID(uuidString: previous) != nil ? previous : "free"
    }
    static func select(_ workspaceID: String, accountID: String) {
        guard !accountID.isEmpty, workspaceID == "free" || UUID(uuidString: workspaceID) != nil else { return }
        let preference = key(accountID: accountID, setting: "selected")
        guard UserDefaults.standard.string(forKey: preference) != workspaceID else { return }
        UserDefaults.standard.set(workspaceID, forKey: preference)
        NotificationCenter.default.post(name: selectionChanged, object: nil,
            userInfo: ["accountID": accountID, "workspaceID": workspaceID])
    }
}
