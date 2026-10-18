import XCTest
@testable import GenDragoonContract

final class StorageURLFixtureTests: XCTestCase {
    private let workspace = "11111111-1111-4111-8111-000000000001"

    private func now() throws -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return try XCTUnwrap(formatter.date(from: "2023-11-14T22:20:00.000Z"))
    }

    private func fixture(_ name: String) throws -> GDFixtureFile {
        try GDFixtureFile.load("storage-urls", name)
    }

    func testGetFixture() throws { try assertReadable("get", method: "GET") }
    func testPutFixture() throws { try assertReadable("put", method: "PUT") }
    func testDeleteFixture() throws { try assertReadable("delete", method: "DELETE") }
    func testManifestGetFixture() throws {
        let loaded = try fixture("manifest-get")
        let session = try GDStorageContract.parseSession(workspace: workspace, json: loaded.body, now: now())
        XCTAssertEqual(session.urls.first?.generation, String?("42"))
        let rows = loaded.body["urls"] as? [[String: Any]]
        XCTAssertEqual(GDStorageContract.decimalGeneration(rows?.first?["generation"]), String?("42"))
    }
    func testManifestPutFixtureKeepsTheServersNumericZero() throws {
        let loaded = try fixture("manifest-put")
        let request = try XCTUnwrap(loaded.requestBody as? [String: Any])
        XCTAssertNotNil(request["ifGeneration"] as? NSNumber)
        XCTAssertNil(request["ifGeneration"] as? String)
        XCTAssertNil(GDStorageContract.decimalGeneration(request["ifGeneration"]))
        let built = GDStorageContract.putBody(objectIDs: ["manifest"], ifGeneration: "0")
        XCTAssertEqual(built["ifGeneration"] as? String, String?("0"))
        XCTAssertEqual(built["op"] as? String, String?("put"))
    }
    func testManifestPutGenerationStringFixture() throws {
        let loaded = try fixture("manifest-put-generation-string")
        let request = try XCTUnwrap(loaded.requestBody as? [String: Any])
        XCTAssertEqual(request["ifGeneration"] as? String, String?("9223372036854775807"))
        let built = GDSealedManifest.uploadBody(generation: "9223372036854775807")
        XCTAssertEqual(built["ifGeneration"] as? String, String?("9223372036854775807"))
        XCTAssertNil(built["ifGeneration"] as? NSNumber)
        let session = try GDStorageContract.parseSession(workspace: workspace, json: loaded.body, now: now())
        XCTAssertEqual(session.mode, "write")
        XCTAssertEqual(session.urls.first?.method, String?("PUT"))
    }
    func testManifestDeleteFixture() throws { try assertReadable("manifest-delete", method: "DELETE") }
    func testInvalidObjectIdFixture() throws {
        let loaded = try fixture("invalid-object-id")
        XCTAssertEqual(loaded.status, 400)
        XCTAssertEqual(GDServerCode.read(loaded.body), "invalid_object_id")
    }
    func testInvalidOpFixture() throws {
        let loaded = try fixture("invalid-op")
        XCTAssertEqual(GDFixtureFile.strings(loaded.requestBody)["op"], String?("resumable"))
        XCTAssertEqual(loaded.status, 400)
        XCTAssertEqual(GDServerCode.read(loaded.body), "invalid_op")
    }
    func testLockedFixture() throws {
        let loaded = try fixture("locked")
        XCTAssertEqual(loaded.status, 423)
        guard case .reviewWorkspaces = GDStorageContract.routeLock(status: loaded.status, json: loaded.body) else {
            return XCTFail("locked put")
        }
    }
    func testLockedDeleteFixture() throws {
        let loaded = try fixture("locked-delete")
        XCTAssertEqual(loaded.status, 423)
        XCTAssertEqual(GDServerCode.read(loaded.body), "workspace_lock")
    }
    func testManifestGenerationRequiredFixture() throws {
        let loaded = try fixture("manifest-generation-required")
        XCTAssertEqual(loaded.status, 400)
        XCTAssertEqual(GDServerCode.read(loaded.body), "manifest_generation_required")
        XCTAssertEqual(GDSealedManifest.interpretUpload(status: loaded.status, json: loaded.body), .clientBug)
        let human = GDSealedManifest.interpretUpload(status: 400, json: ["error": "The manifest upload was missing its generation."])
        XCTAssertEqual(human, .failed)
    }

    private func assertReadable(_ name: String, method: String) throws {
        let loaded = try fixture(name)
        XCTAssertEqual(loaded.status, 200, name)
        let session = try GDStorageContract.parseSession(workspace: workspace, json: loaded.body, now: now())
        XCTAssertEqual(session.urls.first?.method, String?(method), name)
        XCTAssertEqual(GDFixtureFile.strings(loaded.requestBody)["op"], String?(method.lowercased()), name)
    }
}
