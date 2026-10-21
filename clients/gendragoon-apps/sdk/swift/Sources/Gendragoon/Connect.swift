import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

public struct ClientInfo: Sendable, Equatable {
    public var name: String
    public var host: String?
    public init(name: String, host: String? = nil) { self.name = name; self.host = host }
    var json: JV { var o: [(String, JV)] = [("name", .str(name))]; if let h = host, !h.isEmpty { o.append(("host", .str(h))) }; return .obj(o) }
}

public struct Connection: Sendable {
    public var bindingId: String, apiKey: String, keyExpiresAt: String, workspaceId: String
    public var scopes: [String]
    public var quotaBytes: Int64
}

public struct PKCE: Sendable {
    public var verifier: String, challenge: String, state: String
    /// A fresh verifier (43 characters), its S256 challenge and a random state value.
    public static func create() -> PKCE {
        let v = Bytes.b64u(Bytes.random(32))
        return PKCE(verifier: v, challenge: GDCrypto.pkceChallenge(v), state: Bytes.b64u(Bytes.random(16)))
    }
}

/// App-side connect: a one-time connect code (gdpg_) or a connect link with PKCE (gdpc_ code plus verifier).
public final class Connector: Transport, @unchecked Sendable {
    public let base: String
    public init(base: String, options: ClientOptions = ClientOptions()) {
        var b = base
        while b.hasSuffix("/") { b.removeLast() }
        self.base = b
        super.init(options)
    }

    static func isGrant(_ s: String) -> Bool { s.range(of: "^gdpg_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil }
    static func isCode(_ s: String) -> Bool { s.range(of: "^gdpc_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil }

    private func post(_ op: String, _ path: String, _ body: JV) async throws -> Connection {
        try check(op)
        let d = try await send("POST", base + path, body: body.data, headers: ["Content-Type": "application/json"], authorization: nil).obj()
        let c = Connection(bindingId: d.s("bindingId"), apiKey: d.s("apiKey"), keyExpiresAt: d.s("keyExpiresAt"), workspaceId: d.s("workspaceId"), scopes: d.ss("scopes"), quotaBytes: d.l("quotaBytes"))
        guard Client.isApiKey(c.apiKey) else { throw GendragoonError.invalid("unexpected connect response") }
        return c
    }

    /// Exchanges a one-time connect code for an API key. Level L2, risk credential.
    public func redeemGrant(_ grant: String, client: ClientInfo) async throws -> Connection {
        let g = grant.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Connector.isGrant(g) else { throw GendragoonError.invalid("that is not a GenDragoon connect code") }
        return try await post("connect.redeemGrant", "/connect/redeem", .obj([("grant", .str(g)), ("client", client.json)]))
    }

    /// Exchanges an authorization code and the PKCE verifier for an API key. Level L2, risk credential.
    public func exchangeCode(_ code: String, verifier: String) async throws -> Connection {
        guard Connector.isCode(code) else { throw GendragoonError.invalid("that is not a GenDragoon authorization code") }
        return try await post("connect.exchangeCode", "/connect/token", .obj([("code", .str(code)), ("codeVerifier", .str(verifier))]))
    }

    public static func isLoopback(_ redirect: String) -> Bool {
        guard let u = URLComponents(string: redirect), u.scheme == "http", u.user == nil, u.password == nil, u.port != nil else { return false }
        return u.host == "127.0.0.1" || u.host == "[::1]" || u.host == "::1"
    }

    static func esc(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return (s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s).replacingOccurrences(of: "%20", with: "+")
    }

    /// The gendragoon://connect link to open. `redirect` must be http://127.0.0.1:<port>/…
    public static func connectLink(_ client: ClientInfo, _ p: PKCE, redirect: String, scopes: [String] = ["blobs:rw"]) throws -> String {
        guard isLoopback(redirect) else { throw GendragoonError.invalid("redirect must be http://127.0.0.1:<port>/…") }
        var q = ["client": client.name, "scope": scopes.joined(separator: " "), "code_challenge": p.challenge, "code_challenge_method": "S256", "redirect_uri": redirect, "state": p.state]
        if let h = client.host, !h.isEmpty { q["host"] = h }
        return "gendragoon://connect?" + q.keys.sorted().map { esc($0) + "=" + esc(q[$0]!) }.joined(separator: "&")
    }
}

/// A one-shot listener on 127.0.0.1 that receives the connect redirect and checks its state value.
public final class Loopback: @unchecked Sendable {
    private let fd: Int32
    private let want: Data
    public let redirectUri: String

    public init(_ p: PKCE) throws {
        #if canImport(Glibc)
        let s = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        #else
        let s = socket(AF_INET, SOCK_STREAM, 0)
        #endif
        guard s >= 0 else { throw GendragoonError.unsupported("cannot open a loopback socket") }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let ok = withUnsafeMutablePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, len) == 0 && listen(s, 4) == 0 && getsockname(s, $0, &len) == 0 }
        }
        guard ok else { close(s); throw GendragoonError.unsupported("cannot listen on 127.0.0.1") }
        fd = s
        want = Data(p.state.utf8)
        redirectUri = "http://127.0.0.1:\(UInt16(bigEndian: addr.sin_port))/gendragoon/callback"
    }

    deinit { close(fd) }

    static func query(_ q: String, _ name: String) -> String {
        for part in q.split(separator: "&") {
            let kv = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let dec = { (s: Substring) in String(s).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? "" }
            if dec(kv[0]) == name { return kv.count > 1 ? dec(kv[1]) : "" }
        }
        return ""
    }

    /// Blocks a background thread until a valid redirect arrives or `timeout` passes; returns the authorization code.
    public func wait(timeout: TimeInterval = 300) async throws -> String {
        let fd = self.fd, want = self.want
        return try await withCheckedThrowingContinuation { cont in
            Thread.detachNewThread {
                let deadline = Date().addingTimeInterval(timeout)
                while true {
                    let left = deadline.timeIntervalSinceNow
                    if left <= 0 { cont.resume(throwing: GendragoonError.invalid("timed out waiting for the connect redirect")); return }
                    var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                    if poll(&pfd, 1, Int32(min(left, 1) * 1000)) <= 0 { continue }
                    let c = accept(fd, nil, nil)
                    if c < 0 { continue }
                    var buf = [UInt8](repeating: 0, count: 8192)
                    var n = 0
                    var tv = timeval(tv_sec: 5, tv_usec: 0)
                    setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
                    while n < buf.count {
                        let cap = buf.count, at = n
                        let r = buf.withUnsafeMutableBytes { recv(c, $0.baseAddress! + at, cap - at, 0) }
                        if r <= 0 { break }
                        n += r
                        if String(decoding: buf[0..<n], as: UTF8.self).contains("\r\n\r\n") { break }
                    }
                    let line = String(decoding: buf[0..<n], as: UTF8.self).components(separatedBy: "\r\n")[0].split(separator: " ")
                    let target = line.count >= 2 && line[0] == "GET" ? String(line[1]) : ""
                    let parts = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
                    let path = parts.first.map(String.init) ?? ""
                    let q = parts.count > 1 ? String(parts[1]) : ""
                    let code = Loopback.query(q, "code")
                    let good = path == "/gendragoon/callback" && Bytes.equal(Data(Loopback.query(q, "state").utf8), want) && Connector.isCode(code)
                    let msg = good ? "Connected. You can close this window and return to the app.\n" : "This link is not for this app.\n"
                    let resp = Array("HTTP/1.1 \(good ? "200 OK" : "400 Bad Request")\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: \(msg.utf8.count)\r\nConnection: close\r\n\r\n\(msg)".utf8)
                    _ = resp.withUnsafeBytes { send(c, $0.baseAddress!, resp.count, 0) }
                    close(c)
                    if good { cont.resume(returning: code); return }
                }
            }
        }
    }
}
