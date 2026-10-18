import XCTest
@testable import GenDragoonContract

final class KeyEnvelopeContractTests: XCTestCase {
    func testCreateFixtureIsTheNestedShape() throws {
        let fixture = try GDFixtureFile.load("key-envelope", "create")
        XCTAssertEqual(fixture.status, 201)
        let wire = try GDKeyEnvelopeContract.decode(fixture.body)
        XCTAssertEqual(wire.kdf.alg, "argon2id")
        XCTAssertEqual(wire.kdf.memoryKiB, 19456)
        XCTAssertEqual(wire.version, 1)
        XCTAssertEqual(GDKeyEnvelopeContract.createHeaders()["If-None-Match"], String?("*"))
        XCTAssertEqual(GDKeyEnvelopeContract.followUp(status: fixture.status, json: fixture.body), .saveUnwrappedKey)
        XCTAssertTrue(GDKeyEnvelopeContract.mayCacheLocally(after: .saveUnwrappedKey, unwrappedExisting: false))
    }

    func testConflictFetchesTheExistingKeyAndDoesNotReplaceIt() throws {
        let fixture = try GDFixtureFile.load("key-envelope", "conflict")
        XCTAssertEqual(fixture.status, 409)
        XCTAssertEqual(GDServerCode.read(fixture.body), "envelope_exists")
        let follow = GDKeyEnvelopeContract.followUp(status: fixture.status, json: fixture.body)
        XCTAssertEqual(follow, .fetchAndUnwrapExisting)
        XCTAssertFalse(GDKeyEnvelopeContract.mayCacheLocally(after: follow, unwrappedExisting: false))
        XCTAssertTrue(GDKeyEnvelopeContract.mayCacheLocally(after: follow, unwrappedExisting: true))
    }

    func testVersionMismatchRewrapsTheSameKey() throws {
        let fixture = try GDFixtureFile.load("key-envelope", "version-mismatch")
        XCTAssertEqual(fixture.status, 412)
        XCTAssertEqual(GDServerCode.read(fixture.body), "version_mismatch")
        XCTAssertEqual(GDKeyEnvelopeContract.followUp(status: fixture.status, json: fixture.body), .refetchAndRewrapSameKey)
        XCTAssertEqual(GDKeyEnvelopeContract.updateHeaders(version: 1)["If-Match"], String?("\"1\""))
    }

    func testUpdateFixtureMatchesTheQuotedVersion() throws {
        let fixture = try GDFixtureFile.load("key-envelope", "update")
        XCTAssertEqual(fixture.status, 200)
        let wire = try GDKeyEnvelopeContract.decode(fixture.body)
        XCTAssertEqual(wire.version, 2)
    }

    func testGetAndMissingFixtures() throws {
        let present = try GDFixtureFile.load("key-envelope", "get")
        XCTAssertEqual(present.status, 200)
        _ = try GDKeyEnvelopeContract.decode(present.body)
        let missing = try GDFixtureFile.load("key-envelope", "get-missing")
        XCTAssertEqual(missing.status, 404)
        XCTAssertEqual(GDServerCode.read(missing.body), "not_found")
    }

    func testInvalidEnvelopesAndLimits() throws {
        let salt = try GDFixtureFile.load("key-envelope", "salt-wrong-length")
        let iv = try GDFixtureFile.load("key-envelope", "iv-wrong-length")
        XCTAssertEqual(GDServerCode.read(salt.body), "envelope_invalid")
        XCTAssertEqual(GDServerCode.read(iv.body), "envelope_invalid")
        guard case .showError(let saltMessage) = GDKeyEnvelopeContract.followUp(status: salt.status, json: salt.body) else {
            return XCTFail("bad salt")
        }
        XCTAssertFalse(saltMessage.contains("envelope_invalid"))
        let huge = try GDFixtureFile.load("key-envelope", "kdf-params-invalid")
        XCTAssertEqual(huge.body["error"] as? String, String?("kdf_params_invalid"))
        let request = try XCTUnwrap(huge.requestBody as? [String: Any])
        XCTAssertThrowsError(try GDKeyEnvelopeContract.decode(request))
        XCTAssertEqual(GDKeyEnvelopeContract.maxMemoryKiB, 1_048_576)
        var within = try GDKeyEnvelopeContract.decode(try GDFixtureFile.load("key-envelope", "create").body)
        within.kdf.memoryKiB = 1_048_576
        within.kdf.iterations = 10
        try GDKeyEnvelopeContract.validate(within)
        within.kdf.memoryKiB = 67_108_864
        XCTAssertThrowsError(try GDKeyEnvelopeContract.validate(within))
        within.kdf.memoryKiB = 32
        within.kdf.iterations = 11
        XCTAssertThrowsError(try GDKeyEnvelopeContract.validate(within))
        XCTAssertThrowsError(try GDKeyEnvelopeContract.decode(["version": 1, "opsLimit": 3, "memLimit": 65536, "salt": "aa", "iv": "bb", "wrappedKey": "cc"]))
        let created = try GDFixtureFile.load("key-envelope", "create")
        let submitted = try XCTUnwrap(created.requestBody as? [String: Any])
        let fromRequest = try GDKeyEnvelopeContract.decode(submitted)
        let fromResponse = try GDKeyEnvelopeContract.decode(created.body)
        XCTAssertEqual(GDBase64URL.decode(fromRequest.salt), GDBase64URL.decode(fromResponse.salt))
        XCTAssertEqual(GDBase64URL.decode(fromRequest.iv), GDBase64URL.decode(fromResponse.iv))
        XCTAssertEqual(GDBase64URL.decode(fromRequest.wrappedKey), GDBase64URL.decode(fromResponse.wrappedKey))
        let written = try JSONSerialization.jsonObject(with: try GDKeyEnvelopeContract.encode(fromRequest)) as? [String: Any]
        for field in ["salt", "iv", "wrappedKey"] {
            let stored = try XCTUnwrap(written?[field] as? String)
            XCTAssertEqual(stored, created.body[field] as? String, field)
            XCTAssertFalse(stored.contains("="), field)
            XCTAssertFalse(stored.contains("+"), field)
            XCTAssertFalse(stored.contains("/"), field)
            XCTAssertEqual(GDBase64URL.encode(try XCTUnwrap(GDBase64URL.decode(stored))), stored, field)
        }
        var scrypt = created.body
        for n in [1 << 14, 1 << 20] {
            scrypt["kdf"] = ["alg": "scrypt", "N": n, "r": 8, "p": 1]
            let accepted = try GDKeyEnvelopeContract.decode(scrypt)
            XCTAssertEqual(accepted.kdf.n, n)
        }
        for n in [1 << 13, 1 << 21, 49152] {
            scrypt["kdf"] = ["alg": "scrypt", "N": n, "r": 8, "p": 1]
            XCTAssertThrowsError(try GDKeyEnvelopeContract.decode(scrypt), "N \(n)")
        }
        let large = try GDFixtureFile.load("key-envelope", "payload-too-large")
        XCTAssertEqual(large.status, 413)
        guard case .showError = GDKeyEnvelopeContract.followUp(status: large.status, json: large.body) else {
            return XCTFail("413")
        }
    }

}
