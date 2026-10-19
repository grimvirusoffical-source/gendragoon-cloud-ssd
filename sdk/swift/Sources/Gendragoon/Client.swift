import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct ClientOptions: Sendable {
    /// Decides which operations may run. Defaults to Gating.levelGate().
    public var gate: Gate?
    /// Appended to the User-Agent header.
    public var userAgent: String = ""
    public var timeout: TimeInterval = 60
    public init(gate: Gate? = nil, userAgent: String = "", timeout: TimeInterval = 60) { self.gate = gate; self.userAgent = userAgent; self.timeout = timeout }
}

struct Reply {
    var status: Int
    var body: Data
    var headers: [String: String]
    func header(_ k: String) -> String? { headers.first { $0.key.caseInsensitiveCompare(k) == .orderedSame }?.value }
    var etag: String { (header("ETag") ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "\"")) }
    func obj() throws -> JObj { try parseObject(body) }
}

final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// The gate and HTTP transport shared by every client type.
public class Transport: @unchecked Sendable {
    public static let version = "0.1.0"
    let gate: Gate
    let session: URLSession
    let ua: String

    init(_ opts: ClientOptions) {
        gate = opts.gate ?? Gating.levelGate()
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = opts.timeout
        cfg.httpCookieStorage = nil
        cfg.urlCache = nil
        session = URLSession(configuration: cfg, delegate: NoRedirects(), delegateQueue: nil)
        ua = "gendragoon-sdk-swift/\(Transport.version)" + (opts.userAgent.isEmpty ? "" : " " + opts.userAgent)
    }

    /// Throws LevelError if the gate refuses the operation.
    public func check(_ op: String) throws { try gate(Operation.named(op)) }

    func send(_ method: String, _ url: String, body: Data? = nil, headers: [String: String] = [:], authorization: String?) async throws -> Reply {
        guard let u = URL(string: url) else { throw GendragoonError.invalid("bad URL") }
        var req = URLRequest(url: u)
        req.httpMethod = method
        req.setValue(ua, forHTTPHeaderField: "User-Agent")
        if let a = authorization { req.setValue(a, forHTTPHeaderField: "Authorization") }
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        req.httpBody = body
        let (data, resp): (Data, URLResponse) = try await withCheckedThrowingContinuation { cont in
            session.dataTask(with: req) { d, r, e in
                if let e = e { cont.resume(throwing: e) } else if let r = r { cont.resume(returning: (d ?? Data(), r)) } else { cont.resume(throwing: URLError(.badServerResponse)) }
            }.resume()
        }
        guard let http = resp as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        var h: [String: String] = [:]
        for (k, v) in http.allHeaderFields { if let k = k as? String { h[k] = "\(v)" } }
        let r = Reply(status: http.statusCode, body: data, headers: h)
        if r.status >= 300 {
            let code = (try? r.obj())?.s("error") ?? ""
            throw APIError(status: r.status, code: code, retryAfter: Int(r.header("Retry-After") ?? "") ?? 0)
        }
        return r
    }
}

public struct Capabilities: Sendable {
    public var maxBlobBytes: Int64, maxManifestBytes: Int64, batchHasMax: Int64, listMax: Int64
    public var manifestCas: Bool, eventsPoll: Bool, eventsWebhook: Bool, eventsStream: Bool
}

public struct Usage: Sendable, Equatable {
    public var usedBytes: Int64, quotaBytes: Int64, objectCount: Int64, changeSeq: Int64
    public var workspaceId: String
    public var lastChangeAt: String?
    public var remaining: Int64 { max(0, quotaBytes - usedBytes) }
}

public struct ListItem: Sendable { public var id: String; public var size: Int64; public var generation: String? }
public struct ListPage: Sendable { public var items: [ListItem]; public var next: String? }
public struct PutResult: Sendable { public var created: Bool; public var generation: String }
public struct Manifest: Sendable { public var data: Data; public var generation: String }

/// One binding, authenticated with its gdpk_ API key. Safe for concurrent use.
public final class Client: Transport, CustomStringConvertible, @unchecked Sendable {
    public let base: String
    private let lock = NSLock()
    private var key: String

    static func isApiKey(_ k: String) -> Bool { k.range(of: "^gdpk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil }
    static func isHex64(_ s: String) -> Bool { s.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }

    public init(base: String, apiKey: String, options: ClientOptions = ClientOptions()) throws {
        guard Client.isApiKey(apiKey) else { throw GendragoonError.invalid("malformed API key") }
        var b = base
        while b.hasSuffix("/") { b.removeLast() }
        self.base = b
        key = apiKey
        super.init(options)
    }

    /// The key in use (after rotateApiKey, the new one).
    public var apiKey: String { lock.lock(); defer { lock.unlock() }; return key }
    public var description: String { "Client(\(base))" }
    private func setKey(_ k: String) { lock.lock(); key = k; lock.unlock() }

    func request(_ op: String, _ method: String, _ path: String, body: Data? = nil, headers: [String: String] = [:], auth: Bool = true) async throws -> Reply {
        try check(op)
        return try await send(method, base + path, body: body, headers: headers, authorization: auth ? "Bearer " + apiKey : nil)
    }

    static func needHex(_ id: String, _ what: String) throws { guard isHex64(id) else { throw GendragoonError.invalid("\(what) must be 64 lower-case hex characters") } }

    public func capabilities() async throws -> Capabilities {
        let d = try await request("capabilities", "GET", "/capabilities", auth: false).obj(), e = d.o("events")
        return Capabilities(maxBlobBytes: d.l("maxBlobBytes"), maxManifestBytes: d.l("maxManifestBytes"), batchHasMax: d.l("batchHasMax"), listMax: d.l("listMax"),
                            manifestCas: d.b("manifestCas"), eventsPoll: e.b("poll"), eventsWebhook: e.b("webhook"), eventsStream: e.b("stream"))
    }

    public func health() async throws { _ = try await request("health", "GET", "/health") }

    public func usage() async throws -> Usage {
        let d = try await request("usage", "GET", "/usage").obj()
        return Usage(usedBytes: d.l("usedBytes"), quotaBytes: d.l("quotaBytes"), objectCount: d.l("objectCount"), changeSeq: d.l("changeSeq"), workspaceId: d.s("workspaceId"), lastChangeAt: d.os("lastChangeAt"))
    }

    // MARK: blobs

    /// Stores data content-addressed (id = SHA-256) and returns the id.
    @discardableResult
    public func putBlob(_ data: Data) async throws -> (id: String, result: PutResult) {
        let id = Bytes.hex(Bytes.sha256(data))
        return (id, try await putBlob(id: id, data, mode: "content"))
    }

    /// Stores data under an id the caller chose (for example an HMAC of the plaintext).
    @discardableResult
    public func putSealedBlob(id: String, _ data: Data) async throws -> PutResult { try await putBlob(id: id, data, mode: "sealed") }

    private func putBlob(id: String, _ data: Data, mode: String) async throws -> PutResult {
        try Client.needHex(id, "blob id")
        let r = try await request("blobs.put", "PUT", "/blobs/" + id, body: data,
                                  headers: ["Content-Type": "application/octet-stream", "X-Id-Mode": mode, "X-Content-SHA256": Bytes.hex(Bytes.sha256(data))])
        return PutResult(created: r.status == 201, generation: r.etag)
    }

    /// Reads a blob and verifies its checksum.
    public func getBlob(_ id: String) async throws -> Data {
        try Client.needHex(id, "blob id")
        let r = try await request("blobs.get", "GET", "/blobs/" + id)
        if let want = r.header("X-Content-SHA256"), want != Bytes.hex(Bytes.sha256(r.body)) { throw GendragoonError.checksum }
        return r.body
    }

    /// Level L3, risk destructive. Deleting a missing blob succeeds.
    public func deleteBlob(_ id: String) async throws {
        try Client.needHex(id, "blob id")
        _ = try await request("blobs.delete", "DELETE", "/blobs/" + id)
    }

    private func list(_ op: String, _ path: String, cursor: String?, limit: Int) async throws -> ListPage {
        var q: [String] = []
        if let c = cursor, !c.isEmpty { q.append("cursor=" + (c.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? c)) }
        if limit > 0 { q.append("limit=\(limit)") }
        let d = try await request(op, "GET", path + (q.isEmpty ? "" : "?" + q.joined(separator: "&"))).obj()
        var page = ListPage(items: [], next: d.os("next"))
        if let items = d["items"] as? [Any] {
            for case let o as JObj in items { page.items.append(ListItem(id: o.s("id"), size: o.l("size"), generation: o.os("generation"))) }
        } else {
            for id in d.ss("ids") { page.items.append(ListItem(id: id, size: 0, generation: nil)) }
        }
        return page
    }

    public func listBlobs(cursor: String? = nil, limit: Int = 0) async throws -> ListPage { try await list("blobs.list", "/blobs", cursor: cursor, limit: limit) }
    public func listManifests(cursor: String? = nil, limit: Int = 0) async throws -> ListPage { try await list("manifests.list", "/manifests", cursor: cursor, limit: limit) }

    private func all(_ page: (String?) async throws -> ListPage) async throws -> [ListItem] {
        var o: [ListItem] = [], cursor: String? = nil
        repeat { let p = try await page(cursor); o += p.items; cursor = p.next } while !(cursor ?? "").isEmpty
        return o
    }
    public func allBlobs() async throws -> [ListItem] { try await all { try await self.listBlobs(cursor: $0) } }
    public func allManifests() async throws -> [ListItem] { try await all { try await self.listManifests(cursor: $0) } }

    /// The subset of ids that exist, in input order.
    public func hasBlobs(_ ids: [String]) async throws -> [String] {
        var present: [String] = []
        var i = 0
        while i < ids.count {
            let body = JV.obj([("ids", JV.strs(Array(ids[i..<min(i + 1000, ids.count)])))]).data
            present += try await request("blobs.batchHas", "POST", "/blobs/batch-has", body: body, headers: ["Content-Type": "application/json"]).obj().ss("present")
            i += 1000
        }
        return present
    }

    // MARK: manifests

    public func getManifest(_ key: String) async throws -> Manifest {
        try Client.needHex(key, "manifest key")
        let r = try await request("manifests.get", "GET", "/manifests/" + key)
        return Manifest(data: r.body, generation: r.etag)
    }

    /// Losing a compare-and-swap race throws APIError with preconditionFailed set.
    @discardableResult
    public func putManifest(_ key: String, _ data: Data, ifAbsent: Bool = false, ifGeneration: String? = nil) async throws -> PutResult {
        try Client.needHex(key, "manifest key")
        var h = ["Content-Type": "application/octet-stream", "X-Content-SHA256": Bytes.hex(Bytes.sha256(data))]
        if ifAbsent { h["If-None-Match"] = "*" } else if let g = ifGeneration, !g.isEmpty { h["If-Match"] = "\"\(g)\"" }
        let r = try await request("manifests.put", "PUT", "/manifests/" + key, body: data, headers: h)
        return PutResult(created: r.status == 201, generation: r.etag)
    }

    /// Level L3, risk destructive.
    public func deleteManifest(_ key: String, ifGeneration: String? = nil) async throws {
        try Client.needHex(key, "manifest key")
        var h: [String: String] = [:]
        if let g = ifGeneration, !g.isEmpty { h["If-Match"] = "\"\(g)\"" }
        _ = try await request("manifests.delete", "DELETE", "/manifests/" + key, headers: h)
    }

    // MARK: key envelope

    public func getKeyEnvelope() async throws -> KeyEnvelope { try KeyEnvelope.fromJSON(try await request("keyEnvelope.get", "GET", "/key-envelope").body) }

    func putKeyEnvelope(_ op: String, _ env: KeyEnvelope, _ pre: [String: String]) async throws {
        try env.validate()
        var h = pre
        h["Content-Type"] = "application/json"
        _ = try await request(op, "PUT", "/key-envelope", body: env.json.data, headers: h)
    }

    /// Replaces the API key (the old one works for ten more minutes) and returns the new one to store.
    public func rotateApiKey() async throws -> String {
        let k = try await request("apiKey.rotate", "POST", "/connect/rotate").obj().s("apiKey")
        guard Client.isApiKey(k) else { throw GendragoonError.invalid("unexpected rotate response") }
        setKey(k)
        return k
    }

    /// Deletes every manifest and blob of this binding. Level L4, risk bulk-destructive: the default gate refuses it.
    @discardableResult
    public func wipe() async throws -> Int {
        try check("storage.wipe")
        var n = 0
        for it in try await allManifests() { _ = try await request("storage.wipe", "DELETE", "/manifests/" + it.id); n += 1 }
        for it in try await allBlobs() { _ = try await request("storage.wipe", "DELETE", "/blobs/" + it.id); n += 1 }
        return n
    }
}
