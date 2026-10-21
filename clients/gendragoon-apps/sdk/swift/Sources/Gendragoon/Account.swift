import Foundation

public struct Grant: Sendable { public var code: String, expiresAt: String; public var ttlSeconds: Int64 }

public struct ConnectRequest: Sendable {
    public var client: ClientInfo
    public var scopes: [String]
    public var challenge: String, redirectUri: String, state: String
}

public struct Binding: Sendable {
    public var id: String, workspaceId: String, createdAt: String
    public var lastUsedAt: String?
    public var client: ClientInfo
    public var scopes: [String]
    public var usedBytes: Int64, quotaBytes: Int64, objectCount: Int64
    public var active: Bool
}

/// Calls of a signed-in GenDragoon user (Firebase ID token): connect codes, approving connect links and managing
/// connected apps. They act on the person's account; a Rotten Apple app should not make them on the person's
/// behalf (docs/LEVELS.md).
public final class AccountClient: Transport, @unchecked Sendable {
    public let base: String
    private let token: @Sendable () async throws -> String

    public init(base: String, idToken: @escaping @Sendable () async throws -> String, options: ClientOptions = ClientOptions()) {
        var b = base
        while b.hasSuffix("/") { b.removeLast() }
        self.base = b
        token = idToken
        super.init(options)
    }

    /// Validates a connect link the way GenDragoon does before showing it to the user.
    public static func parseConnectLink(_ link: String) throws -> ConnectRequest {
        guard let u = URLComponents(string: link), u.scheme == "gendragoon",
              u.host == "connect" || u.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == "connect" else { throw GendragoonError.invalid("not a connect link") }
        var v: [String: String] = [:]
        for part in (u.percentEncodedQuery ?? "").split(separator: "&") {
            let kv = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let dec = { (s: Substring) in String(s).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? "" }
            let k = dec(kv[0])
            if v[k] == nil { v[k] = kv.count > 1 ? dec(kv[1]) : "" }
        }
        let g = { (k: String) in v[k] ?? "" }
        let scopes = g("scope").replacingOccurrences(of: ",", with: " ").split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" }).map(String.init)
        let req = ConnectRequest(client: ClientInfo(name: g("client"), host: g("host").isEmpty ? nil : g("host")), scopes: scopes.isEmpty ? ["blobs:rw"] : scopes,
                                 challenge: g("code_challenge"), redirectUri: g("redirect_uri"), state: g("state"))
        guard !req.client.name.isEmpty else { throw GendragoonError.invalid("the app did not say who it is") }
        guard g("code_challenge_method") == "S256", req.challenge.count == 43 else { throw GendragoonError.invalid("missing PKCE challenge") }
        guard Connector.isLoopback(req.redirectUri) else { throw GendragoonError.invalid("the code can only go to an app on this device") }
        guard !req.state.isEmpty else { throw GendragoonError.invalid("missing state") }
        for s in req.scopes where s != "blobs:rw" && s != "blobs:r" { throw GendragoonError.invalid("unknown scope \(s)") }
        return req
    }

    private func call(_ op: String, _ method: String, _ path: String, _ body: JV? = nil) async throws -> JObj {
        try check(op)
        let tok = try await token()
        let r = try await send(method, base + path, body: body?.data, headers: body == nil ? [:] : ["Content-Type": "application/json"], authorization: "Bearer " + tok)
        return r.status == 204 || r.body.isEmpty ? [:] : try r.obj()
    }

    /// Issues a one-time connect code for a workspace. Level L3, risk sharing.
    public func createGrant(workspaceId: String, requester: ClientInfo, scopes: [String] = ["blobs:rw"]) async throws -> Grant {
        let d = try await call("account.createGrant", "POST", "/connect/grants", .obj([("workspaceId", .str(workspaceId)), ("scopes", JV.strs(scopes)), ("requester", requester.json)]))
        let g = Grant(code: d.s("grant"), expiresAt: d.s("expiresAt"), ttlSeconds: d.l("ttlSeconds"))
        guard Connector.isGrant(g.code) else { throw GendragoonError.invalid("unexpected grant response") }
        return g
    }

    /// Approves a connect link; returns the loopback redirect (with code and state) to open. Level L3, risk sharing.
    public func authorize(workspaceId: String, _ req: ConnectRequest) async throws -> String {
        let d = try await call("account.authorize", "POST", "/connect/authorize", .obj([("workspaceId", .str(workspaceId)), ("scopes", JV.strs(req.scopes)),
                                                                                       ("requester", req.client.json), ("codeChallenge", .str(req.challenge)), ("codeChallengeMethod", .str("S256"))]))
        let code = d.s("code")
        guard Connector.isCode(code) else { throw GendragoonError.invalid("unexpected authorize response") }
        return req.redirectUri + (req.redirectUri.contains("?") ? "&" : "?") + "code=" + Connector.esc(code) + "&state=" + Connector.esc(req.state)
    }

    /// The account's connected apps. Level L2, risk read.
    public func listBindings() async throws -> [Binding] {
        try await call("account.listBindings", "GET", "/bindings").a("bindings").compactMap { $0 as? JObj }.map { b in
            let c = b.o("client")
            return Binding(id: b.s("id"), workspaceId: b.s("workspaceId"), createdAt: b.s("createdAt"), lastUsedAt: b.os("lastUsedAt"), client: ClientInfo(name: c.s("name"), host: c.os("host")),
                           scopes: b.ss("scopes"), usedBytes: b.l("usedBytes"), quotaBytes: b.l("quotaBytes"), objectCount: b.l("objectCount"), active: b.b("active"))
        }
    }

    /// Disconnects an app at once; its data is kept. Level L3, risk sharing.
    public func revokeBinding(_ id: String) async throws { _ = try await call("account.revokeBinding", "DELETE", "/bindings/" + Connector.esc(id)) }

    /// Disconnects an app and deletes everything it stored. Level L4, risk bulk-destructive: the default gate refuses it.
    @discardableResult
    public func revokeAndDelete(_ id: String) async throws -> Int64 {
        try await call("account.revokeAndDelete", "DELETE", "/bindings/" + Connector.esc(id) + "?deleteData=true").l("purgedObjects")
    }
}
