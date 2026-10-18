import CryptoKit
import XCTest
@testable import GenDragoonContract

final class HostedVaultTests: XCTestCase {
    final class MemoryVault: GDHostedVaultStore {
        var data: Data?
        var saves = 0
        var locked = false
        func load() throws -> Data? {
            if locked { throw GDHostedVaultError.message("The Keychain is locked. Unlock this Mac and enter the workspace passphrase.") }
            return data
        }
        func save(_ data: Data) throws { saves += 1; self.data = data }
    }

    func testMissingCacheDoesNotMintADeviceKey() throws {
        let store = MemoryVault()
        XCTAssertThrowsError(try GDHostedVault.key(store: store))
        XCTAssertEqual(store.saves, 0)
        XCTAssertNil(store.data)
    }

    func testWrongSizeAndEmptyDataDoNotMintAReplacement() throws {
        let store = MemoryVault()
        store.data = Data(repeating: 1, count: 16)
        XCTAssertThrowsError(try GDHostedVault.key(store: store))
        store.data = Data()
        XCTAssertThrowsError(try GDHostedVault.key(store: store))
        XCTAssertEqual(store.saves, 0)
    }

    func testLockedKeychainAsksForThePassphrase() {
        let store = MemoryVault()
        store.locked = true
        XCTAssertThrowsError(try GDHostedVault.key(store: store)) { error in
            guard case GDHostedVaultError.message(let text) = error else { return XCTFail("\(error)") }
            XCTAssertTrue(text.contains("Keychain") || text.contains("passphrase"))
        }
    }

    func testCacheUpdatesADuplicateAndRoundTrips() throws {
        let store = MemoryVault()
        let first = SymmetricKey(data: Data(repeating: 0x11, count: 32))
        let second = SymmetricKey(data: Data(repeating: 0x22, count: 32))
        try GDHostedVault.cache(key: first, store: store)
        try GDHostedVault.cache(key: second, store: store)
        XCTAssertEqual(store.saves, 2)
        let loaded = try GDHostedVault.key(store: store)
        XCTAssertEqual(loaded.withUnsafeBytes { Data($0) }, Data(repeating: 0x22, count: 32))
    }
}
