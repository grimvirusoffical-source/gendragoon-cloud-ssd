import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import Gendragoon

/// Starts contract/teams_dev_server.cjs once when GD_TEAMS_SERVER is set (or uses GD_TEAMS_ORIGIN).
enum TeamsServer {
    nonisolated(unsafe) static var proc: Process?
    nonisolated(unsafe) static var stdin: Pipe?
    static let origin: String? = {
        let env = ProcessInfo.processInfo.environment
        if let o = env["GD_TEAMS_ORIGIN"] { return o }
        guard let script = env["GD_TEAMS_SERVER"] else { return nil }
        let p = Process(), out = Pipe(), inp = Pipe()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["node", script, "--exit-with-stdin"]
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
        atexit { TeamsServer.stdin?.fileHandleForWriting.closeFile(); TeamsServer.proc?.waitUntilExit() }
        return (try? parseObject(line))?.s("origin")
    }()
}

/// The Teams contract suite (sdk/spec/CONTRACT.md, T01-T11).
final class TeamsTests: XCTestCase {
    var origin: String!

    override func setUpWithError() throws {
        guard let o = TeamsServer.origin else { throw XCTSkip("set GD_TEAMS_ORIGIN or GD_TEAMS_SERVER to run the Teams contract suite") }
        origin = o
    }

    func user(_ uid: String, _ max: Level = .l3) -> TeamsClient {
        TeamsClient(origin: origin, idToken: { "dev-user:" + uid }, options: ClientOptions(gate: Gating.levelGate(max)))
    }

    func pay(_ url: String) async throws {
        var req = URLRequest(url: URL(string: origin + "/__dev/pay")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = JV.obj([("url", .str(url))]).data
        let (_, res) = try await URLSession.shared.data(for: req)
        XCTAssertEqual((res as! HTTPURLResponse).statusCode, 200)
    }

    func status(_ f: () async throws -> Void) async -> Int {
        do { try await f(); return 0 } catch let e as APIError { return e.status } catch { return -1 }
    }

    func refused(_ f: () async throws -> Void) async -> Bool {
        do { try await f(); return false } catch is LevelError { return true } catch { return false }
    }

    func testT01toT11() async throws {
        let aliceUid = "alice" + Bytes.hex(Bytes.random(4))
        let alice = user(aliceUid), bob = user("bob" + Bytes.hex(Bytes.random(4)))

        // T01 catalog
        let tiers = try await alice.catalog()
        XCTAssertGreaterThanOrEqual(tiers.count, 3)

        // T02 create and pay
        let low = user("x", .l2)
        let lowRefused = await refused { _ = try await low.create(intentId: UUID().uuidString.lowercased(), name: "Studio", tier: "team") }
        XCTAssertTrue(lowRefused)
        let (team, checkout) = try await alice.create(intentId: UUID().uuidString.lowercased(), name: "Studio", tier: "team")
        XCTAssertEqual(team.role, "owner")
        try await pay(XCTUnwrap(checkout.url))
        let list = try await alice.list()
        XCTAssertTrue(list.count == 1 && list[0].subscriptionActive)
        let id = team.id

        // T03 invite, preview, join
        let inv = try await alice.createInvite(id, maxUses: 2)
        let p = try await bob.previewInvite(code: inv.code)
        XCTAssertEqual(p.teamName, "Studio")
        let color = try XCTUnwrap(p.memberColors.first { !$0.taken }).id
        let j = try await bob.join(code: inv.code, color: color, displayName: "Bob")
        XCTAssertTrue(j.teamId == id && !j.alreadyMember)
        let again = try await bob.join(code: inv.code, color: color)
        XCTAssertTrue(again.alreadyMember)
        try await alice.revokeInvite(id, inviteId: inv.inviteId)

        // T04 view and update me
        try await bob.updateMe(id, displayName: "Bobby")
        let view = try await alice.get(id)
        XCTAssertEqual(view.team.members.count, 2)
        let b = try XCTUnwrap(view.team.members.first { $0.role == "member" })
        XCTAssertEqual(b.displayName, "Bobby")

        // T05 chat post, list, watch
        let msg = try await bob.post(id, text: "hello")
        let page = try await alice.messages(id)
        XCTAssertTrue(page.latestSeq == msg.seq && page.messages.last?.text == "hello")
        let stream = try bob.watchChat(id, after: page.latestSeq)
        try await alice.post(id, text: "welcome")
        var it = stream.makeAsyncIterator()
        let got = await it.next()
        XCTAssertEqual(got?.text, "welcome")

        // T06 report and delete
        try await alice.report(id, seq: msg.seq, category: "spam", note: "test")
        let del = await status { try await bob.deleteMessage(id, seq: msg.seq, reason: "cleanup") }
        XCTAssertEqual(del, 403)
        try await alice.deleteMessage(id, seq: msg.seq, reason: "off topic")
        let removed = try await alice.messages(id, after: msg.seq - 1, limit: 1)
        XCTAssertEqual(removed.messages.first?.kind, "removed")

        // T07 team workspace and roles
        let (ws, wc) = try await alice.createWorkspace(id, intentId: UUID().uuidString.lowercased(), name: "Art", plans: ["storageTier": "100GB", "performanceTier": "boost"])
        XCTAssertEqual(ws.storageRoutes?["v3"], "/v3/cloud/" + ws.id)
        try await pay(XCTUnwrap(wc.url))
        try await alice.setRole(id, memberId: b.memberId, role: "viewer")
        let spaces = try await bob.workspaces(id)
        XCTAssertTrue(spaces.team.count == 1 && spaces.team[0].access == "read" && spaces.subscriptionActive)
        try await alice.setRole(id, memberId: b.memberId, role: "member")

        // T11 personal workspace card
        let wid = UUID().uuidString.lowercased()
        var seed = URLRequest(url: URL(string: origin + "/__dev/personal-workspace")!)
        seed.httpMethod = "POST"
        seed.setValue("application/json", forHTTPHeaderField: "Content-Type")
        seed.httpBody = JV.obj([("uid", .str(aliceUid)), ("workspaceId", .str(wid)), ("name", .str("Sketches"))]).data
        let (_, seeded) = try await URLSession.shared.data(for: seed)
        XCTAssertEqual((seeded as! HTTPURLResponse).statusCode, 200)
        let l2Refused = await refused { _ = try await self.user(aliceUid, .l2).postCard(id, scope: "personal", workspaceId: wid, share: true) }
        XCTAssertTrue(l2Refused)
        do { _ = try await alice.postCard(id, scope: "personal", workspaceId: wid, text: "not shared yet"); XCTFail("unshared personal card") }
        catch let e as APIError { XCTAssertEqual(e.status, 403); XCTAssertEqual(e.code, "SHARE_REQUIRED") }
        let card = try await alice.postCard(id, scope: "personal", workspaceId: wid, text: "have a look", share: true)
        XCTAssertEqual(card.kind, "workspace_card")
        let bobSees = try await bob.workspaces(id)
        XCTAssertEqual(bobSees.shared.count, 1)
        _ = try await alice.postCard(id, scope: "personal", workspaceId: wid, text: "again")
        try await alice.unshare(id, workspaceId: wid)

        // T08 mute and unmute
        try await alice.mute(id, memberId: b.memberId, reason: "cool down")
        let muted = await status { try await bob.post(id, text: "hi") }
        XCTAssertEqual(muted, 403)
        try await alice.unmute(id, memberId: b.memberId)
        try await bob.post(id, text: "back")

        // T09 audit
        let auditRefused = await status { _ = try await bob.audit(id) }
        XCTAssertEqual(auditRefused, 403)
        var audit = try await alice.audit(id)
        XCTAssertTrue(audit.count >= 4 && TeamsClient.verifyAuditChain(audit))
        audit[1].prev = audit[0].prev
        XCTAssertFalse(TeamsClient.verifyAuditChain(audit))

        // T10 levels and removal
        let transferRefused = await refused { try await alice.transfer(id, memberId: b.memberId, color: "blue-500") }
        let deleteRefused = await refused { try await alice.delete(id, confirmName: "Studio") }
        XCTAssertTrue(transferRefused && deleteRefused)
        try await alice.kick(id, memberId: b.memberId, reason: "done")
        let gone = await status { _ = try await bob.get(id) }
        XCTAssertTrue(gone == 403 || gone == 404)
    }
}
