import Foundation

/// Data removed after the account is deleted. A workspace lock does not use this plan:
/// transfer checkpoints live under the cache directory and stay so an upload can resume.
/// Bring-your-own credentials are not stored yet. The keychain service is cleared anyway.
enum LocalWipePlan {
    static let defaultsPrefix="GenDragoon."
    static let cacheDirectory="GenDragoonTransfers"
    static let exportsDirectory="Exports"
    static let authService="app.gendragoon.cloudssd.mobile.auth"
    static let byoService="app.gendragoon.cloudssd.mobile.byo"
    static let authAccount="firebase-refresh"

    static func wipedDefaults(_ keys:[String])->[String] { keys.filter{$0.hasPrefix(defaultsPrefix)} }
    /// Keychain services removed for this deletion outcome. A 401 passes `wipe: false` and removes none.
    /// The deletion receipt service is included only when the account wipe runs.
    static func keychainServicesRemoved(wipe:Bool)->[String] {
        wipe ? [authService,byoService,DeletionReceiptVault.service] : []
    }
    static func lockPauseDeletes()->[String] { [] }
    static func accountWipeIncludesCheckpoints()->Bool { true }
}
