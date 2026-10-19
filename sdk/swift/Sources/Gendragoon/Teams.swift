import Foundation

public struct TeamMember: Sendable {
    public var memberId: String, displayName: String, color: String, colorHex: String, role: String
    public var muted: Bool
    /// End of the mute, or nil while muted until lifted.
    public var mutedUntil: Date?
    public var muteReason: String?
    init(_ d: JObj) {
        memberId = d.s("memberId"); displayName = d.s("displayName"); color = d.s("color"); colorHex = d.s("colorHex"); role = d.s("role")
        let m = d["muted"] as? JObj
        muted = m != nil
        muteReason = m?.os("reason")
        mutedUntil = m.flatMap { $0["until"] is NSNull || $0["until"] == nil ? nil : Date(timeIntervalSince1970: Double($0.l("until")) / 1000) }
    }
}

public struct Team: Sendable {
    public var id: String, name: String, tier: String, interval: String, subscriptionStatus: String, role: String
    public var memberLimit: Int, memberCount: Int
    public var priceCents: Int64
    public var subscriptionActive: Bool
    public var me: TeamMember
    public var members: [TeamMember]
    init(_ d: JObj) {
        id = d.s("id"); name = d.s("name"); tier = d.s("tier"); interval = d.s("interval"); subscriptionStatus = d.s("subscriptionStatus"); role = d.s("role")
        memberLimit = Int(d.l("memberLimit")); memberCount = Int(d.l("memberCount")); priceCents = d.l("priceCents"); subscriptionActive = d.b("subscriptionActive")
        me = TeamMember(d.o("me")); members = d.a("members").compactMap { ($0 as? JObj).map(TeamMember.init) }
    }
}

public struct TeamTier: Sendable { public var id: String, name: String; public var members: Int; public var monthlyCents: Int64, yearlyCents: Int64 }

public struct MemberColor: Sendable { public var id: String, hue: String, hex: String; public var taken: Bool }

/// Result of a call that may need payment: open `url` when it is set.
public struct Checkout: Sendable {
    public var url: String?, checkoutError: String?
    public var totalCents: Int64
    public var resumed: Bool, alreadyActivated: Bool, complimentary: Bool
    init(_ d: JObj) {
        url = d.os("url"); checkoutError = d.os("checkoutError"); totalCents = d.l("totalCents")
        resumed = d.b("resumed"); alreadyActivated = d.b("alreadyActivated"); complimentary = d.b("complimentary")
    }
}

public struct Invite: Sendable { public var code: String, inviteId: String, link: String; public var expiresAtMs: Int64; public var maxUses: Int }
public struct InvitePreview: Sendable { public var teamName: String; public var memberCount: Int, memberLimit: Int; public var memberColors: [MemberColor] }

public struct TeamWorkspace: Sendable {
    public var id: String, teamId: String, name: String, plansStatus: String, projectStatus: String, access: String
    public var customStorage: Bool, needsCustomSetup: Bool
    public var quotaGB: Double
    public var usedBytes: Int64
    /// The file routes for this workspace ("v3": /v3/cloud/<id>, "v2": /v2/workspaces/<id>/cloud), or nil for custom storage.
    public var storageRoutes: [String: String]?
    init(_ d: JObj) {
        id = d.s("id"); teamId = d.s("teamId"); name = d.s("name"); plansStatus = d.s("plansStatus"); projectStatus = d.s("projectStatus"); access = d.s("access")
        customStorage = d.b("customStorage"); needsCustomSetup = d.b("needsCustomSetup"); usedBytes = d.l("usedBytes")
        quotaGB = (d["quotaGB"] as? NSNumber)?.doubleValue ?? 0
        storageRoutes = d["storageRoutes"] as? [String: String]
    }
}

public struct SharedWorkspace: Sendable { public var id: String, name: String, sharedByMemberId: String, sharedByName: String, permission: String; public var mine: Bool }
public struct TeamWorkspaces: Sendable { public var team: [TeamWorkspace]; public var shared: [SharedWorkspace]; public var subscriptionActive: Bool }

public struct ChatMessage: Sendable {
    public var seq: Int64
    public var kind: String, text: String
    public var cardScope: String?, cardWorkspaceId: String?, cardName: String?, removedReason: String?
    init(_ d: JObj) {
        seq = d.l("seq"); kind = d.s("kind"); text = d.s("text")
        let c = d["card"] as? JObj
        cardScope = c?.os("scope"); cardWorkspaceId = c?.os("workspaceId"); cardName = c?.os("name")
        removedReason = (d["removed"] as? JObj)?.os("reason")
    }
}

public struct ChatPage: Sendable { public var messages: [ChatMessage]; public var latestSeq: Int64; public var pollAfterMs: Int }

public struct AuditEntry: Sendable {
    public var seq: Int64, atMs: Int64
    public var untilMs: Int64?
    public var prev: String, hash: String, action: String, actor: String, source: String
    public var target: String?, reason: String?, rule: String?
}

/// Teams calls of a signed-in GenDragoon user (/v2/teams on the API origin, Firebase ID token). The server refuses
/// gdsk_ API keys for teams and team workspaces. Calls that start a subscription return a Stripe Checkout URL for the
/// person to open; the SDK never completes a payment. Levels are listed in docs/LEVELS.md.
public final class TeamsClient: Transport, @unchecked Sendable {
    public let origin: String
    private let token: @Sendable () async throws -> String

    /// `origin` is the GenDragoon API origin; `idToken` returns a current Firebase ID token.
    public init(origin: String, idToken: @escaping @Sendable () async throws -> String, options: ClientOptions = ClientOptions()) {
        var o = origin
        while o.hasSuffix("/") { o.removeLast() }
        self.origin = o
        token = idToken
        super.init(options)
    }

    private static func seg(_ v: CustomStringConvertible) throws -> String {
        let s = v.description
        guard !s.isEmpty, s.count <= 128, !s.contains(where: { "/?#".contains($0) }) else { throw GendragoonError.invalid("invalid id \(s)") }
        return Connector.esc(s)
    }

    private static func intent(_ id: String) throws {
        guard UUID(uuidString: id) != nil else { throw GendragoonError.invalid("intentId must be a UUID") }
    }

    private func call(_ op: String, _ method: String, _ path: String, _ body: JV? = nil) async throws -> JObj {
        try check(op)
        let tok = try await token()
        let r = try await send(method, origin + "/v2/teams" + path, body: body?.data, headers: body == nil ? [:] : ["Content-Type": "application/json"], authorization: "Bearer " + tok)
        return r.status == 204 || r.body.isEmpty ? [:] : try r.obj()
    }

    private func t(_ id: String) throws -> String { "/" + (try TeamsClient.seg(id)) }

    private static func colors(_ d: JObj) -> [MemberColor] {
        d.a("memberColors").compactMap { $0 as? JObj }.map { MemberColor(id: $0.s("id"), hue: $0.s("hue"), hex: $0.s("hex"), taken: $0.b("taken")) }
    }

    /// The team tiers as the server lists them (Enterprise is by contact and not listed). Level L2, risk read.
    public func catalog() async throws -> [TeamTier] {
        try await call("teams.catalog", "GET", "/catalog").a("tiers").compactMap { $0 as? JObj }.map {
            TeamTier(id: $0.s("id"), name: $0.s("name"), members: Int($0.l("members")), monthlyCents: $0.l("monthlyCents"), yearlyCents: $0.l("yearlyCents"))
        }
    }

    /// Teams the account belongs to. Level L2, risk read.
    public func list() async throws -> [Team] {
        try await call("teams.list", "GET", "").a("teams").compactMap { ($0 as? JObj).map(Team.init) }
    }

    /// Creates a team and opens its subscription checkout. Reuse `intentId` on retry. Level L3, risk billing.
    public func create(intentId: String, name: String, tier: String, interval: String = "month", ownerShade: String? = nil) async throws -> (team: Team, checkout: Checkout) {
        try TeamsClient.intent(intentId)
        var f: [(String, JV)] = [("intentId", .str(intentId)), ("name", .str(name)), ("tier", .str(tier)), ("interval", .str(interval))]
        if let s = ownerShade { f.append(("ownerShade", .str(s))) }
        let d = try await call("teams.create", "POST", "", .obj(f))
        return (Team(d.o("team")), Checkout(d))
    }

    /// A team with its members and the member colors. Level L2, risk read.
    public func get(_ teamId: String) async throws -> (team: Team, colors: [MemberColor]) {
        let d = try await call("teams.get", "GET", try t(teamId))
        return (Team(d.o("team")), TeamsClient.colors(d.o("colors")))
    }

    /// Resumes or replaces the team subscription checkout. Level L3, risk billing.
    public func checkout(_ teamId: String, tier: String? = nil, interval: String? = nil) async throws -> Checkout {
        var f: [(String, JV)] = []
        if let v = tier { f.append(("tier", .str(v))) }
        if let v = interval { f.append(("interval", .str(v))) }
        return Checkout(try await call("teams.checkout", "POST", try t(teamId) + "/checkout", .obj(f)))
    }

    /// Creates an invite code (owner); the code is shown once. Level L3, risk sharing.
    public func createInvite(_ teamId: String, expiresInHours: Int = 0, maxUses: Int = 0) async throws -> Invite {
        var f: [(String, JV)] = []
        if expiresInHours > 0 { f.append(("expiresInHours", .int(Int64(expiresInHours)))) }
        if maxUses > 0 { f.append(("maxUses", .int(Int64(maxUses)))) }
        let d = try await call("teams.createInvite", "POST", try t(teamId) + "/invites", .obj(f))
        return Invite(code: d.s("code"), inviteId: d.s("inviteId"), link: d.s("link"), expiresAtMs: d.l("expiresAtMs"), maxUses: Int(d.l("maxUses")))
    }

    /// Revokes an invite code (owner). Level L3, risk sharing.
    public func revokeInvite(_ teamId: String, inviteId: String) async throws {
        _ = try await call("teams.revokeInvite", "POST", try t(teamId) + "/invites/" + TeamsClient.seg(inviteId) + "/revoke", .obj([]))
    }

    /// Team name, size and free colors for an invite code. Level L2, risk read.
    public func previewInvite(code: String) async throws -> InvitePreview {
        let d = try await call("teams.previewInvite", "POST", "/join/preview", .obj([("code", .str(code))]))
        return InvitePreview(teamName: d.s("teamName"), memberCount: Int(d.l("memberCount")), memberLimit: Int(d.l("memberLimit")), memberColors: TeamsClient.colors(d.o("colors")))
    }

    /// Joins a team with an invite code and a free member color. Level L3, risk sharing.
    public func join(code: String, color: String, displayName: String? = nil, deviceName: String? = nil) async throws -> (teamId: String, alreadyMember: Bool) {
        var f: [(String, JV)] = [("code", .str(code)), ("color", .str(color))]
        if let v = displayName { f.append(("displayName", .str(v))) }
        if let v = deviceName { f.append(("deviceName", .str(v))) }
        let d = try await call("teams.join", "POST", "/join", .obj(f))
        return (d.s("teamId"), d.b("alreadyMember"))
    }

    /// Changes your display name or color in a team. Level L2, risk write.
    public func updateMe(_ teamId: String, displayName: String? = nil, color: String? = nil) async throws {
        var f: [(String, JV)] = []
        if let v = displayName { f.append(("displayName", .str(v))) }
        if let v = color { f.append(("color", .str(v))) }
        _ = try await call("teams.updateMe", "PATCH", try t(teamId) + "/me", .obj(f))
    }

    /// Leaves a team; your shared personal workspaces are unshared. Level L3, risk destructive.
    public func leave(_ teamId: String) async throws { _ = try await call("teams.leave", "POST", try t(teamId) + "/leave", .obj([])) }

    /// Team workspaces (files over storageRoutes) and shared personal workspaces. Level L2, risk read.
    public func workspaces(_ teamId: String) async throws -> TeamWorkspaces {
        let d = try await call("teams.workspaces", "GET", try t(teamId) + "/workspaces")
        return TeamWorkspaces(team: d.a("teamWorkspaces").compactMap { ($0 as? JObj).map(TeamWorkspace.init) },
                              shared: d.a("sharedWorkspaces").compactMap { $0 as? JObj }.map {
                                  SharedWorkspace(id: $0.s("id"), name: $0.s("name"), sharedByMemberId: $0.o("sharedBy").s("memberId"),
                                                  sharedByName: $0.o("sharedBy").s("displayName"), permission: $0.s("permission"), mine: $0.b("mine"))
                              }, subscriptionActive: d.b("subscriptionActive"))
    }

    /// Creates a team workspace and opens its plans checkout (owner). `plans` carries the plan ids, for example
    /// storageTier and performanceTier. Level L3, risk billing.
    public func createWorkspace(_ teamId: String, intentId: String, name: String, plans: [String: String], storage: String = "managed") async throws -> (workspace: TeamWorkspace, checkout: Checkout) {
        try TeamsClient.intent(intentId)
        let p = JV.obj(plans.sorted { $0.key < $1.key }.map { ($0.key, .str($0.value)) })
        let d = try await call("teams.createWorkspace", "POST", try t(teamId) + "/workspaces",
                               .obj([("intentId", .str(intentId)), ("name", .str(name)), ("storage", .str(storage)), ("plans", p)]))
        return (TeamWorkspace(d.o("workspace")), Checkout(d))
    }

    /// Resumes a team workspace's plans checkout (owner). Level L3, risk billing.
    public func checkoutWorkspace(_ teamId: String, workspaceId: String) async throws -> Checkout {
        Checkout(try await call("teams.checkoutWorkspace", "POST", try t(teamId) + "/workspaces/" + TeamsClient.seg(workspaceId) + "/checkout", .obj([])))
    }

    /// Shows one of your personal workspaces to the team, view only. Level L3, risk sharing.
    public func share(_ teamId: String, workspaceId: String) async throws {
        _ = try await call("teams.share", "POST", try t(teamId) + "/shares", .obj([("workspaceId", .str(workspaceId))]))
    }

    /// Stops showing a personal workspace to the team. Level L3, risk sharing.
    public func unshare(_ teamId: String, workspaceId: String) async throws {
        _ = try await call("teams.unshare", "DELETE", try t(teamId) + "/shares/" + TeamsClient.seg(workspaceId))
    }

    /// Chat messages above `after` (0 for the latest page). Level L2, risk read.
    public func messages(_ teamId: String, after: Int64 = 0, limit: Int = 0) async throws -> ChatPage {
        let q = "?after=\(after)" + (limit > 0 ? "&limit=\(limit)" : "")
        let d = try await call("teams.chat.list", "GET", try t(teamId) + "/chat" + q)
        return ChatPage(messages: d.a("messages").compactMap { ($0 as? JObj).map(ChatMessage.init) }, latestSeq: d.l("latestSeq"), pollAfterMs: Int(d.l("pollAfterMs")))
    }

    /// Yields new chat messages until the consuming task is cancelled or you lose access to the team. Polls every
    /// pollAfterMs (the server also offers Server-Sent Events at /chat/stream; this SDK polls). Level L2, risk read.
    public func watchChat(_ teamId: String, after: Int64 = 0, interval: TimeInterval = 0) throws -> AsyncStream<ChatMessage> {
        try check("teams.chat.watch")
        return AsyncStream { cont in
            let task = Task { () async -> Void in
                var last = after, wait: TimeInterval = 3
                while !Task.isCancelled {
                    do {
                        let p = try await self.messages(teamId, after: last, limit: 100)
                        for m in p.messages where m.seq > last { last = m.seq; cont.yield(m) }
                        if p.pollAfterMs > 0 { wait = Double(p.pollAfterMs) / 1000 }
                    } catch let e as APIError where [401, 403, 404].contains(e.status) {
                        cont.finish(); return
                    } catch {}
                    try? await Task.sleep(nanoseconds: UInt64(max(wait, interval) * 1e9))
                }
                cont.finish()
            }
            cont.onTermination = { _ in task.cancel() }
        }
    }

    /// Posts a text message. Level L2, risk write.
    @discardableResult
    public func post(_ teamId: String, text: String) async throws -> ChatMessage {
        ChatMessage(try await call("teams.chat.post", "POST", try t(teamId) + "/chat", .obj([("text", .str(text))])).o("message"))
    }

    /// Posts a workspace card (scope "team" or "personal"). A personal-workspace card also shares it with the team, so
    /// it needs the sharing level too. Level L2, risk write.
    @discardableResult
    public func postCard(_ teamId: String, scope: String, workspaceId: String, text: String = "") async throws -> ChatMessage {
        if scope == "personal" { try check("teams.share") }
        let card = JV.obj([("scope", .str(scope)), ("workspaceId", .str(workspaceId))])
        return ChatMessage(try await call("teams.chat.post", "POST", try t(teamId) + "/chat", .obj([("text", .str(text)), ("card", card)])).o("message"))
    }

    /// Reports a message (spam, abuse, harassment, illegal or other). Level L2, risk write.
    public func report(_ teamId: String, seq: Int64, category: String, note: String = "") async throws {
        _ = try await call("teams.chat.report", "POST", try t(teamId) + "/chat/\(seq)/report", .obj([("category", .str(category)), ("note", .str(note))]))
    }

    /// Removes a message (owner; reason required). Level L3, risk destructive.
    public func deleteMessage(_ teamId: String, seq: Int64, reason: String) async throws {
        _ = try await call("teams.chat.delete", "POST", try t(teamId) + "/chat/\(seq)/delete", .obj([("reason", .str(reason))]))
    }

    private func moderate(_ action: String, _ teamId: String, _ memberId: String, _ reason: String, _ until: Date?) async throws {
        var f: [(String, JV)] = [("reason", .str(reason))]
        if let u = until { f.append(("until", .int(Int64(u.timeIntervalSince1970 * 1000)))) }
        _ = try await call("teams.members." + action, "POST", try t(teamId) + "/members/" + TeamsClient.seg(memberId) + "/" + action, .obj(f))
    }

    /// Mutes a member until a time, or until lifted when nil (owner; reason required). Level L3, risk destructive.
    public func mute(_ teamId: String, memberId: String, reason: String, until: Date? = nil) async throws { try await moderate("mute", teamId, memberId, reason, until) }
    /// Lifts a mute (owner). Level L3, risk write.
    public func unmute(_ teamId: String, memberId: String, reason: String = "") async throws { try await moderate("unmute", teamId, memberId, reason, nil) }
    /// Removes a member; they can rejoin with a new invite (owner; reason required). Level L3, risk destructive.
    public func kick(_ teamId: String, memberId: String, reason: String) async throws { try await moderate("kick", teamId, memberId, reason, nil) }
    /// Removes a member and blocks rejoining until a time, or for good when nil (owner; reason required). Level L3, risk destructive.
    public func ban(_ teamId: String, memberId: String, reason: String, until: Date? = nil) async throws { try await moderate("ban", teamId, memberId, reason, until) }

    /// Makes a member a "viewer" (read team files) or a "member" (read and write) (owner). Level L3, risk sharing.
    public func setRole(_ teamId: String, memberId: String, role: String) async throws {
        guard role == "viewer" || role == "member" else { throw GendragoonError.invalid("role must be \"viewer\" or \"member\"") }
        _ = try await call("teams.members.setRole", "POST", try t(teamId) + "/members/" + TeamsClient.seg(memberId) + "/role", .obj([("role", .str(role))]))
    }

    /// The team's hash-chained audit log, oldest first (owner). Level L2, risk read.
    public func audit(_ teamId: String) async throws -> [AuditEntry] {
        try await call("teams.audit", "GET", try t(teamId) + "/audit").a("entries").compactMap { $0 as? JObj }.map {
            AuditEntry(seq: $0.l("seq"), atMs: $0.l("atMs"), untilMs: $0["untilMs"] == nil || $0["untilMs"] is NSNull ? nil : $0.l("untilMs"),
                       prev: $0.s("prev"), hash: $0.s("hash"), action: $0.s("action"), actor: $0.s("actor"), source: $0.s("source"),
                       target: $0.os("target"), reason: $0.os("reason"), rule: $0.os("rule"))
        }
    }

    /// Checks that audit entries are consecutive and each links to the previous hash. The digests themselves are
    /// recomputed by the server.
    public static func verifyAuditChain(_ entries: [AuditEntry]) -> Bool {
        var prev = String(repeating: "0", count: 64)
        for (i, e) in entries.enumerated() {
            guard e.seq == Int64(i + 1), e.prev == prev, e.hash.count == 64, e.hash.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { return false }
            prev = e.hash
        }
        return true
    }

    /// Hands the team to another member (owner). Level L4, risk sharing: the default gate refuses it.
    public func transfer(_ teamId: String, memberId: String, color: String, ownerShade: String? = nil) async throws {
        var f: [(String, JV)] = [("memberId", .str(memberId)), ("color", .str(color))]
        if let s = ownerShade { f.append(("ownerShade", .str(s))) }
        _ = try await call("teams.transfer", "POST", try t(teamId) + "/transfer", .obj(f))
    }

    /// Deletes the team, its chat and its team workspaces with their files (owner). Level L4, risk bulk-destructive:
    /// the default gate refuses it.
    public func delete(_ teamId: String, confirmName: String) async throws {
        _ = try await call("teams.delete", "POST", try t(teamId) + "/delete", .obj([("confirmName", .str(confirmName))]))
    }
}
