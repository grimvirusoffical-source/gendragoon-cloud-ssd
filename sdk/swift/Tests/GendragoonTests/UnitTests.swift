import Foundation
import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import Gendragoon

/// Cross-language vectors (sdk/spec/vectors/v1.json), the operation table and the gate. No network.
final class UnitTests: XCTestCase {
    static let spec = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../spec").standardizedFileURL
    static let v = try! parseObject(Data(contentsOf: spec.appendingPathComponent("vectors/v1.json")))
    var v: JObj { UnitTests.v }
    func h(_ s: String) -> Data { try! Bytes.fromHex(s) }
    func json(_ o: Any) -> Data { try! JSONSerialization.data(withJSONObject: o) }
    func dummy() -> Client { try! Client(base: "http://127.0.0.1:9", apiKey: "gdpk_0123456789abcdef_" + String(repeating: "A", count: 43)) }

    func testHkdf() {
        for case let o as JObj in v.a("hkdf") { XCTAssertEqual(Bytes.hex(GDCrypto.subKey(h(o.s("ikm")), o.s("purpose"))), o.s("out")) }
    }

    func testEnvelopeScrypt() throws {
        let e = v.o("envelopeScrypt")
        let env = try KeyEnvelope.fromJSON(json(e["envelope"]!))
        XCTAssertEqual(Bytes.hex(try GDCrypto.unwrapMasterKey(env, passphrase: e.s("passphrase"))), e.s("masterKey"))
        XCTAssertThrowsError(try GDCrypto.unwrapMasterKey(env, passphrase: "not the passphrase")) { XCTAssertEqual($0 as? GendragoonError, .wrongPassphrase) }
        let again = try GDCrypto.wrapMasterKey(h(e.s("masterKey")), passphrase: e.s("passphrase"), kdf: env.kdf, random: { n in try! Bytes.fromB64u(n == 16 ? env.salt : env.iv) })
        XCTAssertEqual(again, env)
    }

    func testEnvelopeArgon2idNeedsPlugin() throws {
        let e = v.o("envelopeArgon2id")
        let env = try KeyEnvelope.fromJSON(json(e["envelope"]!))
        XCTAssertThrowsError(try GDCrypto.unwrapMasterKey(env, passphrase: e.s("passphrase"))) { if case .unsupported = $0 as? GendragoonError {} else { XCTFail("\($0)") } }
    }

    func testChunk() throws {
        let c = v.o("chunk")
        let (id, blob) = try GDCrypto.sealChunk(h(c.s("fileKey")), h(c.s("plaintext")), nonce: h(c.s("nonce")))
        XCTAssertEqual(id, c.s("id")); XCTAssertEqual(Bytes.hex(blob), c.s("blob"))
        XCTAssertEqual(Bytes.hex(try GDCrypto.openChunk(h(c.s("fileKey")), id: id, blob: blob)), c.s("plaintext"))
        var bad = blob; bad[bad.count - 1] ^= 1
        XCTAssertThrowsError(try GDCrypto.openChunk(h(c.s("fileKey")), id: id, blob: bad))
    }

    func testManifestAndDocument() throws {
        let m = v.o("manifest"), mk = h(m.s("masterKey"))
        XCTAssertEqual(GDCrypto.driveManifestKey(mk, m.s("driveName")), m.s("manifestKey"))
        XCTAssertEqual(GDCrypto.driveManifestKey(nil, m.s("driveName")), m.s("plainManifestKey"))
        let pt = Data(m.s("plaintext").utf8)
        XCTAssertEqual(Bytes.hex(try GDCrypto.sealManifest(mk, key: m.s("manifestKey"), pt, nonce: h(m.s("nonce")))), m.s("sealed"))
        XCTAssertEqual(try GDCrypto.openManifest(mk, key: m.s("manifestKey"), h(m.s("sealed"))), pt)
        XCTAssertThrowsError(try GDCrypto.openManifest(nil, key: m.s("manifestKey"), h(m.s("sealed")))) { XCTAssertEqual($0 as? GendragoonError, .locked) }
        // The drive document re-encodes byte for byte as the Go SDK wrote it.
        XCTAssertEqual(String(decoding: try DriveDocument.decode(pt).encode(), as: UTF8.self), m.s("plaintext"))
    }

    func testShare() throws {
        let s = v.o("share")
        let id = try Identity(privateBytes: h(s.s("recipientPrivate")))
        XCTAssertEqual(id.publicId, s.s("recipientPublic"))
        XCTAssertEqual(Bytes.hex(id.privateBytes()), s.s("recipientPrivate"))
        let share = try Share.fromJSON(String(decoding: json(s["share"]!), as: UTF8.self))
        let f = try Sharing.openEnvelope(id, share)
        XCTAssertEqual(String(decoding: Sharing.payload(f.path, f.entry), as: UTF8.self), s.s("payload"))
        let eph = try Identity(privateBytes: h(s.s("ephemeralPrivate")) + Bytes.fromB64u(share.epk))
        let again = try Sharing.seal(Bytes.fromB64u(String(s.s("recipientPublic").dropFirst(6))), Data(s.s("payload").utf8), ephemeral: eph, nonce: h(s.s("nonce")))
        XCTAssertEqual(again, share)
        let other = try Identity.create(dummy())
        XCTAssertThrowsError(try Sharing.openEnvelope(other, share)) { XCTAssertTrue("\($0)".contains("someone else")) }
    }

    func testPkce() { XCTAssertEqual(GDCrypto.pkceChallenge(v.o("pkce").s("verifier")), v.o("pkce").s("challenge")) }

    func testOperationTableMatchesSpec() throws {
        let spec = try parseObject(Data(contentsOf: UnitTests.spec.appendingPathComponent("operations.json")))
        let ops = spec.a("operations").compactMap { $0 as? JObj }
        let services = spec.o("levelSource").o("services")
        XCTAssertEqual(ops.count, Operation.all.count)
        for (o, s) in zip(Operation.all, ops) {
            XCTAssertEqual(o.id, s.s("id")); XCTAssertEqual(o.level.description, s.s("level"))
            XCTAssertEqual(o.service, s.s("service")); XCTAssertEqual(o.risk.rawValue, s.s("risk")); XCTAssertEqual(o.context, s.s("context"))
            XCTAssertGreaterThanOrEqual(o.level, Level(parsing: services.o(o.service).s("level"))!, o.id)
        }
    }

    func testGateAndEnvironmentCap() {
        let prev = ProcessInfo.processInfo.environment[Gating.maxLevelEnv]
        defer { if let p = prev { setenv(Gating.maxLevelEnv, p, 1) } else { unsetenv(Gating.maxLevelEnv) } }
        unsetenv(Gating.maxLevelEnv)
        let g = Gating.levelGate()
        XCTAssertNoThrow(try g(Operation.named("files.deleteFolder")))
        XCTAssertThrowsError(try g(Operation.named("storage.wipe")))
        XCTAssertThrowsError(try g(Operation.named("crypto.exportMasterKey")))
        setenv(Gating.maxLevelEnv, "L2", 1)
        XCTAssertThrowsError(try Gating.levelGate(.l4)(Operation.named("files.deleteFolder")))
        setenv(Gating.maxLevelEnv, "L4", 1)
        XCTAssertThrowsError(try Gating.levelGate(.l3)(Operation.named("storage.wipe")))
        setenv(Gating.maxLevelEnv, "banana", 1)
        XCTAssertThrowsError(try Gating.levelGate(.l4)(Operation.named("usage")))
    }

    func testPathsAndLinks() throws {
        for bad in ["", "/a", "a/", "a//b", "a/../b", ".", "a\\b", "a/\u{1}", String(repeating: "x", count: 1025)] {
            XCTAssertThrowsError(try Drive.cleanPath(bad), bad)
        }
        XCTAssertNoThrow(try Drive.cleanPath("saves/slot 1.sav"))
        let p = PKCE.create()
        let link = try Connector.connectLink(ClientInfo(name: "My Game"), p, redirect: "http://127.0.0.1:5000/cb")
        let req = try AccountClient.parseConnectLink(link)
        XCTAssertEqual(req.challenge, p.challenge); XCTAssertEqual(req.client.name, "My Game"); XCTAssertEqual(req.state, p.state)
        XCTAssertThrowsError(try Connector.connectLink(ClientInfo(name: "x"), p, redirect: "https://evil.example/cb"))
        XCTAssertThrowsError(try Connector.connectLink(ClientInfo(name: "x"), p, redirect: "http://127.0.0.1/cb"))
        XCTAssertThrowsError(try AccountClient.parseConnectLink(link.replacingOccurrences(of: "127.0.0.1", with: "evil.example")))
    }

    func testSecretsNotInDescription() {
        let c = dummy()
        XCTAssertFalse("\(c)".contains("gdpk_")); XCTAssertFalse("\(Keyring(c))".contains("AAAA"))
    }

    func testLoopbackChecksState() async throws {
        let p = PKCE.create()
        let lb = try Loopback(p)
        let code = "gdpc_" + String(repeating: "C", count: 43)
        async let got = lb.wait(timeout: 10)
        func get(_ q: String) async throws -> Int {
            let (_, r) = try await URLSession.shared.data(from: URL(string: lb.redirectUri + q)!)
            return (r as! HTTPURLResponse).statusCode
        }
        let bad = try await get("?code=\(code)&state=wrong")
        XCTAssertEqual(bad, 400)
        let ok = try await get("?code=\(code)&state=\(p.state)")
        XCTAssertEqual(ok, 200)
        let c = try await got
        XCTAssertEqual(c, code)
    }
}
