import Foundation
import XCTest
@testable import Gendragoon

/// Starts provider_dev_server.js once when GD_DEV_SERVER is set (or uses GD_SDK_BASE).
enum DevServer {
    nonisolated(unsafe) static var proc: Process?
    nonisolated(unsafe) static var stdin: Pipe?
    static let base: String? = {
        let env = ProcessInfo.processInfo.environment
        if let b = env["GD_SDK_BASE"] { return b }
        guard let script = env["GD_DEV_SERVER"] else { return nil }
        let p = Process(), out = Pipe(), inp = Pipe()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["node", script, "--exit-with-stdin"]
        var e = env
        e["PROVIDER_V1_ENABLED"] = "true"
        p.environment = e
        p.standardOutput = out
        p.standardInput = inp
        try! p.run()
        proc = p
        stdin = inp
        var line = Data()
        while true {
            let b = out.fileHandleForReading.readData(ofLength: 1)
            if b.isEmpty || b == Data("\n".utf8) { break }
            line += b
        }
        atexit { DevServer.stdin?.fileHandleForWriting.closeFile(); DevServer.proc?.waitUntilExit() }
        return (try? parseObject(line))?.s("base")
    }()
}

/// The shared contract suite (sdk/spec/CONTRACT.md) against a local backend.
final class ContractTests: XCTestCase {
    let pass = "contract passphrase"
    var base: String!

    override func setUpWithError() throws {
        guard let b = DevServer.base else { throw XCTSkip("set GD_SDK_BASE or GD_DEV_SERVER to run the contract suite") }
        base = b
    }

    func uid() -> String { "u" + Bytes.hex(Bytes.random(6)) }
    func account(_ user: String, _ o: ClientOptions = ClientOptions()) -> AccountClient { AccountClient(base: base, idToken: { "dev-user:" + user }, options: o) }
    static func max(_ l: Level) -> ClientOptions { ClientOptions(gate: Gating.levelGate(l)) }

    struct Rig { var acct: AccountClient; var conn: Connection; var client: Client; var keys: Keyring }
    func rig(_ ws: String, _ o: ClientOptions = ClientOptions()) async throws -> Rig {
        let acct = account(uid())
        let g = try await acct.createGrant(workspaceId: ws, requester: ClientInfo(name: "Swift contract", host: "test"))
        let conn = try await Connector(base: base, options: o).redeemGrant(g.code, client: ClientInfo(name: "Swift contract"))
        let c = try Client(base: base, apiKey: conn.apiKey, options: o)
        return Rig(acct: acct, conn: conn, client: c, keys: Keyring(c))
    }

    func apiError(_ f: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async -> APIError? {
        do { try await f(); XCTFail("expected APIError", file: file, line: line) } catch let e as APIError { return e } catch { XCTFail("expected APIError, got \(error)", file: file, line: line) }
        return nil
    }

    func fails(_ f: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async -> Error? {
        do { try await f(); XCTFail("expected an error", file: file, line: line) } catch { return error }
        return nil
    }

    func testC01ConnectWithGrant() async throws {
        let r = try await rig("ws")
        try await r.client.health()
        let caps = try await r.client.capabilities()
        XCTAssertTrue(caps.eventsPoll && !caps.eventsWebhook && caps.maxBlobBytes == 16 << 20)
        let e = await apiError { _ = try await Connector(base: self.base).redeemGrant("gdpg_" + String(repeating: "A", count: 43), client: ClientInfo(name: "x")) }
        XCTAssertEqual(e?.code, "invalid_grant")
    }

    func testC02ConnectWithPkce() async throws {
        let acct = account(uid())
        let p = PKCE.create()
        let req = try AccountClient.parseConnectLink(try Connector.connectLink(ClientInfo(name: "Swift contract"), p, redirect: "http://127.0.0.1:9/cb"))
        let redirect = URLComponents(string: try await acct.authorize(workspaceId: "ws", req))!
        let q = Dictionary(uniqueKeysWithValues: redirect.queryItems!.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(q["state"], p.state)
        let k = Connector(base: base)
        _ = await apiError { _ = try await k.exchangeCode(q["code"]!, verifier: PKCE.create().verifier) }
        let c = try await k.exchangeCode(q["code"]!, verifier: p.verifier)
        XCTAssertEqual(c.workspaceId, "ws")
    }

    func testC03MasterKeyLifecycle() async throws {
        let r = try await rig("ws")
        try await r.keys.create(pass)
        let e = await apiError { try await Keyring(r.client).create(self.pass) }
        XCTAssertEqual(e?.preconditionFailed, true)
        let k2 = Keyring(r.client)
        let wrong = await fails { try await k2.unlock("not the passphrase") }
        XCTAssertEqual(wrong as? GendragoonError, .wrongPassphrase)
        try await r.keys.changePassphrase("a brand new passphrase")
        try await k2.unlock("a brand new passphrase")
        XCTAssertThrowsError(try r.keys.exportMasterKey()) { XCTAssertTrue($0 is LevelError) }
    }

    func testC04EncryptedFilesAndFolders() async throws {
        let r = try await rig("ws")
        try await r.keys.create(pass)
        let d = try Drive(r.client, name: "saves", keys: r.keys, chunkSize: 1024)
        let data = Bytes.random(5000)
        try await d.mkdir("levels/1")
        let written = try await d.writeFile("slots/slot1.sav", data)
        XCTAssertEqual(written.chunks.count, 5)
        let back = try await d.readFile("slots/slot1.sav")
        XCTAssertEqual(back, data)
        let ls = try await d.list("")
        XCTAssertEqual(ls.map { "\($0.name):\($0.folder)" }, ["levels:true", "slots:true"])
        try await d.move("slots/slot1.sav", to: "slots/slot2.sav")
        _ = try await d.stat("slots/slot2.sav")
        let notEmpty = await fails { try await d.delete("levels") }
        XCTAssertTrue("\(notEmpty!)".contains("not empty"))
        let removed = try await d.deleteFolder("levels")
        XCTAssertEqual(removed, 0)
        try await d.delete("slots/slot2.sav")
        let gone = await apiError { _ = try await d.readFile("slots/slot2.sav") }
        XCTAssertEqual(gone?.notFound, true)
        let probe = data.prefix(64)
        for b in try await r.client.allBlobs() {
            let raw = try await r.client.getBlob(b.id)
            XCTAssertNil(raw.range(of: probe))
        }
    }

    func testC05PlainDrive() async throws {
        let r = try await rig("ws")
        let d = try Drive(r.client, name: "public", keys: nil, plain: true)
        try await d.writeFile("readme.txt", Data("hello".utf8))
        let e = try await d.stat("readme.txt")
        XCTAssertEqual(e.chunks.first, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
        XCTAssertNil(e.key)
    }

    func testC06ConcurrentWriters() async throws {
        let r = try await rig("ws")
        try await r.keys.create(pass)
        let client = r.client, keys = r.keys
        try await withThrowingTaskGroup(of: Void.self) { g in
            for w in 0..<2 {
                g.addTask {
                    let d = try Drive(client, name: "shared", keys: keys)
                    for i in 0..<10 { try await d.writeFile("w\(w)/f\(i)", Data([UInt8(i)])) }
                }
            }
            try await g.waitForAll()
        }
        let n = try await Drive(r.client, name: "shared", keys: r.keys).snapshot().files.count
        XCTAssertEqual(n, 20)
    }

    func testC07Quota() async throws {
        let r = try await rig("small")
        let e = await apiError { try await Drive(r.client, name: "big", keys: nil, plain: true).writeFile("too-big.bin", Data(count: 100 << 10)) }
        XCTAssertEqual(e?.quotaExceeded, true)
        let u = try await r.client.usage()
        XCTAssertEqual(u.quotaBytes, 64 << 10)
        XCTAssertLessThanOrEqual(u.usedBytes, u.quotaBytes)
    }

    func testC08Gate() async throws {
        let r = try await rig("ws", ContractTests.max(.l2))
        let e = await fails { _ = try await Drive(r.client, name: "x", keys: nil, plain: true).deleteFolder("a") } as? LevelError
        XCTAssertEqual(e?.operation.id, "files.deleteFolder")
        XCTAssertEqual(e?.operation.level, .l3)
        let w = await fails { _ = try await r.client.wipe() }
        XCTAssertTrue(w is LevelError)
    }

    func testC09Events() async throws {
        let r = try await rig("ws")
        try await r.keys.create(pass)
        let d = try Drive(r.client, name: "watched", keys: r.keys)
        let stream = try Events.watch(r.client, interval: 1)
        var it = stream.makeAsyncIterator()
        func next(_ t: ChangeType) async throws -> ChangeEvent {
            while let ev = await it.next() { if ev.type == t { return ev } }
            throw GendragoonError.invalid("stream ended before \(t)")
        }
        try await Task.sleep(nanoseconds: 1_200_000_000)
        try await d.writeFile("a", Data([1]))
        let created = try await next(.manifestCreated)
        XCTAssertEqual(created.key, d.manifestKey)
        try await d.writeFile("a", Data([2]))
        _ = try await next(.manifestUpdated)
        try await r.acct.revokeBinding(r.conn.bindingId)
        _ = try await next(.bindingRevoked)
    }

    func testC10Sharing() async throws {
        let r = try await rig("ws")
        try await r.keys.create(pass)
        let d = try Drive(r.client, name: "docs", keys: r.keys)
        try await d.writeFile("letter.txt", Data("for your eyes only".utf8))
        let rk = try await Sharing.createReadKey(r.client, label: "recipient", ttlDays: 1)
        let reader = try Client(base: base, apiKey: rk.apiKey!)
        let id = try Identity.create(reader)
        let share = try Share.fromJSON(try await Sharing.export(r.client, drive: d, path: "letter.txt", to: id.publicId).toJSON())
        let (f, data) = try await Sharing.open(reader, identity: id, share)
        XCTAssertEqual(f.path, "letter.txt")
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "for your eyes only")
        _ = await fails { _ = try await Sharing.open(reader, identity: try Identity.create(reader), share) }
        _ = await apiError { try await reader.putSealedBlob(id: String(repeating: "0", count: 64), Data([1])) }
        _ = await apiError { try await Keyring(reader).unlock(self.pass) }
        let keys = try await Sharing.listReadKeys(r.client)
        XCTAssertEqual(keys.count, 1)
        XCTAssertNil(keys.first?.apiKey)
        try await Sharing.revokeReadKey(r.client, keyId: rk.keyId)
        let e = await apiError { _ = try await Sharing.open(reader, identity: id, share) }
        XCTAssertEqual(e?.unauthorized, true)
    }

    func testC11Sync() async throws {
        let r = try await rig("ws")
        try await r.keys.create(pass)
        let d = try Drive(r.client, name: "sync", keys: r.keys)
        let fm = FileManager.default
        let tmp = fm.temporaryDirectory.appendingPathComponent("gd-sync-" + Bytes.hex(Bytes.random(4)))
        defer { try? fm.removeItem(at: tmp) }
        let src = tmp.appendingPathComponent("src"), dst = tmp.appendingPathComponent("dst")
        try fm.createDirectory(at: src.appendingPathComponent("a/b"), withIntermediateDirectories: true)
        try Data("one".utf8).write(to: src.appendingPathComponent("a/b/one.txt"))
        try Data("two".utf8).write(to: src.appendingPathComponent("two.txt"))
        let o = SyncOptions(prefix: "backup")
        let first = try await Sync.push(r.client, drive: d, from: src, options: o)
        XCTAssertEqual(first.uploaded.count, 2)
        let again = try await Sync.push(r.client, drive: d, from: src, options: o)
        XCTAssertEqual(again.uploaded.count, 0)
        XCTAssertEqual(again.unchanged, 2)
        let pulled = try await Sync.pull(r.client, drive: d, to: dst, options: o)
        XCTAssertEqual(pulled.downloaded.count, 2)
        XCTAssertEqual(try String(contentsOf: dst.appendingPathComponent("a/b/one.txt"), encoding: .utf8), "one")
        try fm.removeItem(at: src.appendingPathComponent("two.txt"))
        let dry = try await Sync.mirror(r.client, drive: d, local: src, direction: .toDrive, options: SyncOptions(prefix: "backup", dryRun: true))
        XCTAssertEqual(dry.deleted, ["backup/two.txt"])
        _ = try await d.stat("backup/two.txt")
        _ = try await Sync.mirror(r.client, drive: d, local: src, direction: .toDrive, options: o)
        _ = await apiError { _ = try await d.stat("backup/two.txt") }
    }

    func testC12GarbageAndWipe() async throws {
        let r = try await rig("ws", ContractTests.max(.l4))
        try await r.keys.create(pass)
        let d = try Drive(r.client, name: "g", keys: r.keys)
        try await d.writeFile("keep", Data("keep".utf8))
        try await d.writeFile("drop", Data("drop".utf8))
        try await d.delete("drop")
        let n = try await Drive.collectGarbage(r.client, keys: r.keys)
        XCTAssertEqual(n, 1)
        let kept = try await d.readFile("keep")
        XCTAssertEqual(kept, Data("keep".utf8))
        let refused = await fails { _ = try await Drive.collectGarbage(r.client, keys: nil) }
        XCTAssertTrue("\(refused!)".contains("refusing"))
        try await r.client.wipe()
        let left = try await r.client.allManifests()
        XCTAssertTrue(left.isEmpty)
        let u = try await r.client.usage()
        XCTAssertEqual(u.usedBytes, 0)
        XCTAssertEqual(u.objectCount, 0)
    }

    func testC13RotateKey() async throws {
        let r = try await rig("ws")
        let old = r.client.apiKey
        let new = try await r.client.rotateApiKey()
        XCTAssertNotEqual(new, old)
        try await r.client.health()
    }

    func testC14AccountBindings() async throws {
        let r = try await rig("ws")
        try await Drive(r.client, name: "p", keys: nil, plain: true).writeFile("x", Data("12345".utf8))
        let list = try await r.acct.listBindings()
        XCTAssertEqual(list.count, 1)
        XCTAssertTrue(list[0].active)
        XCTAssertGreaterThan(list[0].usedBytes, 0)
        let gated = await fails { _ = try await r.acct.revokeAndDelete(list[0].id) }
        XCTAssertTrue(gated is LevelError)
        let e = await apiError { _ = try await self.account("nobody", ContractTests.max(.l4)).revokeAndDelete(list[0].id) }
        XCTAssertEqual(e?.notFound, true)
    }
}
