import CryptoKit
import Foundation
import Security

enum GDHostedVaultError: Error, Equatable {
    case message(String)
}

protocol GDHostedVaultStore {
    func load() throws -> Data?
    func save(_ data: Data) throws
}

/// Keychain cache of the unwrapped workspace key. It never mints a device-only key.
enum GDHostedVault {
    static let service = "app.gendragoon.cloudssd"
    static let account = "hosted-aes-256"

    static func key(store: GDHostedVaultStore = GDKeychainHostedVaultStore()) throws -> SymmetricKey {
        let loaded: Data?
        do {
            loaded = try store.load()
        } catch let error as GDHostedVaultError {
            throw error
        }
        guard let loaded else {
            throw GDHostedVaultError.message("Enter the workspace passphrase to unlock files. This Mac does not create a separate device key.")
        }
        if loaded.isEmpty {
            throw GDHostedVaultError.message("The saved workspace key is empty. Enter the passphrase again.")
        }
        guard loaded.count == 32 else {
            throw GDHostedVaultError.message("The saved workspace key is unusable. Enter the passphrase again. A new device key was not created.")
        }
        return SymmetricKey(data: loaded)
    }

    static func cache(key: SymmetricKey, store: GDHostedVaultStore = GDKeychainHostedVaultStore()) throws {
        let data = key.withUnsafeBytes { Data($0) }
        guard data.count == 32 else {
            throw GDHostedVaultError.message("The workspace key is not 256 bits.")
        }
        try store.save(data)
    }
}

struct GDKeychainHostedVaultStore: GDHostedVaultStore {
    func load() throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: GDHostedVault.service,
            kSecAttrAccount as String: GDHostedVault.account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        if status == errSecInteractionNotAllowed {
            throw GDHostedVaultError.message("The Keychain is locked. Unlock this Mac and enter the workspace passphrase.")
        }
        guard status == errSecSuccess, let data = item as? Data else {
            throw GDHostedVaultError.message("The saved workspace key could not be read.")
        }
        if data.isEmpty {
            throw GDHostedVaultError.message("The saved workspace key is empty. Enter the passphrase again.")
        }
        return data
    }

    func save(_ data: Data) throws {
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: GDHostedVault.service,
            kSecAttrAccount as String: GDHostedVault.account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecSuccess { return }
        if status == errSecDuplicateItem {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: GDHostedVault.service,
                kSecAttrAccount as String: GDHostedVault.account,
            ]
            let update: [String: Any] = [kSecValueData as String: data]
            guard SecItemUpdate(query as CFDictionary, update as CFDictionary) == errSecSuccess else {
                throw GDHostedVaultError.message("The workspace key could not be updated in the Keychain.")
            }
            return
        }
        if status == errSecInteractionNotAllowed {
            throw GDHostedVaultError.message("The Keychain is locked. Unlock this Mac and enter the workspace passphrase.")
        }
        throw GDHostedVaultError.message("The workspace key could not be saved in the Keychain.")
    }
}
