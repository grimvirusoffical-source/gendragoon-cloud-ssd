import Foundation

public struct FileEntry: Sendable, Equatable {
    public var size: Int64
    /// Milliseconds since the Unix epoch.
    public var mtime: Int64
    public var sha256: String
    public var chunks: [String]
    /// base64url file key; present in encrypted drives.
    public var key: String?

    var json: JV {
        var o: [(String, JV)] = [("size", .int(size)), ("mtime", .int(mtime)), ("sha256", .str(sha256)), ("chunks", JV.strs(chunks))]
        if let k = key, !k.isEmpty { o.append(("key", .str(k))) }
        return .obj(o)
    }
    init(json d: JObj) { size = d.l("size"); mtime = d.l("mtime"); sha256 = d.s("sha256"); chunks = d.ss("chunks"); key = d.os("key") }
    init(size: Int64, mtime: Int64, sha256: String, chunks: [String], key: String?) { self.size = size; self.mtime = mtime; self.sha256 = sha256; self.chunks = chunks; self.key = key }
}

/// The decrypted content of a drive manifest (spec/FORMATS.md).
public struct DriveDocument: Sendable {
    public var encrypted: Bool
    public var files: [String: FileEntry] = [:]
    public var folders: [String] = []
    public var updatedAt: Int64 = 0

    func encode() -> Data {
        let fs = files.keys.sorted(by: Drive.ordered).map { ($0, files[$0]!.json) }
        let fo = folders.sorted(by: Drive.ordered)
        return JV.obj([("v", .int(1)), ("encrypted", .bool(encrypted)), ("files", .obj(fs)), ("folders", fo.isEmpty ? .null : JV.strs(fo)), ("updatedAt", .int(updatedAt))]).data
    }

    static func decode(_ data: Data) throws -> DriveDocument {
        let d = try parseObject(data)
        guard d.l("v") == 1 else { throw GendragoonError.corrupt }
        var doc = DriveDocument(encrypted: d.b("encrypted"), folders: d.ss("folders"), updatedAt: d.l("updatedAt"))
        for (k, v) in d.o("files") { if let e = v as? JObj { doc.files[k] = FileEntry(json: e) } }
        return doc
    }

    func folderSet() -> Set<String> {
        var s = Set(folders)
        for p in files.keys { var d = Drive.dir(p); while !d.isEmpty { s.insert(d); d = Drive.dir(d) } }
        return s
    }
}

public struct Entry: Sendable, Equatable {
    public var name: String, path: String
    public var folder: Bool
    public var size: Int64
    public var mtime: Date?
}

/// A named tree of files and folders stored in one manifest, committed with compare-and-swap so concurrent
/// writers never lose each other's changes.
public final class Drive: @unchecked Sendable {
    public static let defaultChunkSize = 4 << 20
    let client: Client
    let keys: Keyring?
    let chunkSize: Int
    public let name: String
    public let manifestKey: String
    public var encrypted: Bool { keys != nil }

    /// Byte order of UTF-8, which is the order every SDK sorts paths in.
    static func ordered(_ a: String, _ b: String) -> Bool { Array(a.utf8).lexicographicallyPrecedes(Array(b.utf8)) }
    static func dir(_ p: String) -> String { guard let i = p.lastIndex(of: "/") else { return "" }; return String(p[..<i]) }
    static func baseName(_ p: String) -> String { guard let i = p.lastIndex(of: "/") else { return p }; return String(p[p.index(after: i)...]) }
    static let notFound = APIError(status: 404, code: "not_found")

    /// Opens the drive called `name`. Pass `keys: nil, plain: true` to store files unencrypted.
    public init(_ client: Client, name: String, keys: Keyring?, plain: Bool = false, chunkSize: Int = defaultChunkSize) throws {
        guard !name.isEmpty, name.utf8.count <= 128 else { throw GendragoonError.invalid("drive name must be 1 to 128 bytes") }
        guard chunkSize > 0, chunkSize <= (16 << 20) - 64 else { throw GendragoonError.invalid("chunk size must be below 16 MiB") }
        self.client = client; self.name = name; self.chunkSize = chunkSize
        if plain {
            self.keys = nil
            manifestKey = GDCrypto.driveManifestKey(nil, name)
        } else {
            guard let k = keys else { throw GendragoonError.invalid("an encrypted drive needs a keyring (or plain: true)") }
            self.keys = k
            manifestKey = GDCrypto.driveManifestKey(try k.master(), name)
        }
    }

    func mk() throws -> Data? { try keys?.master() }

    /// Validates a drive path: slash-separated, no leading or trailing slash, no empty, "." or ".." segments,
    /// no backslash or control characters, at most 1024 bytes.
    @discardableResult
    public static func cleanPath(_ p: String) throws -> String {
        let bad = GendragoonError.invalid("invalid path \"\(p)\"")
        guard !p.isEmpty, p.utf8.count <= 1024, !p.hasPrefix("/"), !p.hasSuffix("/"), !p.contains("\\") else { throw bad }
        for seg in p.split(separator: "/", omittingEmptySubsequences: false) {
            if seg.isEmpty || seg == "." || seg == ".." || seg.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) { throw bad }
        }
        return p
    }

    func load() async throws -> (DriveDocument, String) {
        let m: Manifest
        do { m = try await client.getManifest(manifestKey) } catch let e as APIError where e.notFound { return (DriveDocument(encrypted: encrypted), "") }
        return (try DriveDocument.decode(try GDCrypto.openManifest(try mk(), key: manifestKey, m.data)), m.generation)
    }

    func update(_ fn: (inout DriveDocument) throws -> Void) async throws {
        var attempt = 0
        while true {
            var (doc, gen) = try await load()
            try fn(&doc)
            doc.updatedAt = Int64(Date().timeIntervalSince1970 * 1000)
            do {
                _ = try await client.putManifest(manifestKey, try GDCrypto.sealManifest(try mk(), key: manifestKey, doc.encode()), ifAbsent: gen.isEmpty, ifGeneration: gen)
                return
            } catch let e as APIError where e.preconditionFailed && attempt < 12 {}
            let ms = 10 + Int.random(in: 0..<(40 << min(attempt, 4)))
            try await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
            attempt += 1
        }
    }

    public func snapshot() async throws -> DriveDocument { try client.check("files.list"); return try await load().0 }

    /// Direct children of `folder` ("" is the root): folders first, then by name.
    public func list(_ folder: String = "") async throws -> [Entry] {
        try client.check("files.list")
        if !folder.isEmpty { try Drive.cleanPath(folder) }
        let doc = try await load().0
        var dirs = doc.folderSet().filter { Drive.dir($0) == folder }.map { Entry(name: Drive.baseName($0), path: $0, folder: true, size: 0, mtime: nil) }
        var files = doc.files.filter { Drive.dir($0.key) == folder }.map { Entry(name: Drive.baseName($0.key), path: $0.key, folder: false, size: $0.value.size, mtime: Date(timeIntervalSince1970: Double($0.value.mtime) / 1000)) }
        dirs.sort { Drive.ordered($0.name, $1.name) }
        files.sort { Drive.ordered($0.name, $1.name) }
        return dirs + files
    }

    public func stat(_ p: String) async throws -> FileEntry {
        try client.check("files.stat")
        guard let e = try await load().0.files[p] else { throw Drive.notFound }
        return e
    }

    /// Creates or replaces a file. Unchanged chunks of an existing file are not uploaded again.
    @discardableResult
    public func writeFile(_ p: String, _ data: Data, mtime: Date = Date()) async throws -> FileEntry {
        try client.check("files.write")
        try Drive.cleanPath(p)
        var fileKey: Data?
        if encrypted {
            if let (doc, _) = try? await load(), let k = doc.files[p]?.key, let raw = try? Bytes.fromB64u(k), raw.count == GDCrypto.keyBytes { fileKey = raw }
            if fileKey == nil { fileKey = Bytes.random(GDCrypto.keyBytes) }
        }
        var entry = try await upload(fileKey, data)
        entry.mtime = Int64(mtime.timeIntervalSince1970 * 1000)
        let e = entry
        try await update { doc in
            if doc.folderSet().contains(p) { throw GendragoonError.invalid("\"\(p)\" is a folder") }
            var d = Drive.dir(p)
            while !d.isEmpty { if doc.files[d] != nil { throw GendragoonError.invalid("\"\(d)\" is a file") }; d = Drive.dir(d) }
            doc.files[p] = e
        }
        return entry
    }

    func upload(_ fileKey: Data?, _ data: Data) async throws -> FileEntry {
        var entry = FileEntry(size: Int64(data.count), mtime: 0, sha256: Bytes.hex(Bytes.sha256(data)), chunks: [], key: fileKey.map(Bytes.b64u))
        var parts: [(String, Data)] = []
        var off = 0
        let d = Data(data)
        while off < d.count {
            let piece = d.subdata(in: off..<min(off + chunkSize, d.count))
            parts.append(fileKey != nil ? try GDCrypto.sealChunk(fileKey!, piece) : (Bytes.hex(Bytes.sha256(piece)), piece))
            off += chunkSize
        }
        var have = Set(try await client.hasBlobs(parts.map { $0.0 }))
        for (id, blob) in parts {
            entry.chunks.append(id)
            if !have.insert(id).inserted { continue }
            if fileKey != nil { try await client.putSealedBlob(id: id, blob) } else { try await client.putBlob(blob) }
        }
        return entry
    }

    /// A file's content, verified against its SHA-256.
    public func readFile(_ p: String) async throws -> Data {
        try client.check("files.read")
        guard let e = try await load().0.files[p] else { throw Drive.notFound }
        return try await Drive.readEntry(client, e)
    }

    static func readEntry(_ c: Client, _ e: FileEntry) async throws -> Data {
        var fileKey: Data?
        if let k = e.key, !k.isEmpty { fileKey = try Bytes.fromB64u(k) }
        var buf = Data()
        for id in e.chunks {
            var blob = try await c.getBlob(id)
            if let fk = fileKey { blob = try GDCrypto.openChunk(fk, id: id, blob: blob) }
            buf.append(blob)
        }
        guard Int64(buf.count) == e.size, Bytes.hex(Bytes.sha256(buf)) == e.sha256 else { throw GendragoonError.corrupt }
        return buf
    }

    /// Creates a folder and its parents. An existing folder is not an error.
    public func mkdir(_ p: String) async throws {
        try client.check("files.mkdir")
        try Drive.cleanPath(p)
        try await update { doc in
            var s = doc.folderSet()
            var d = p
            while !d.isEmpty {
                if doc.files[d] != nil { throw GendragoonError.invalid("\"\(d)\" is a file") }
                if s.insert(d).inserted { doc.folders.append(d) }
                d = Drive.dir(d)
            }
        }
    }

    /// Renames a file or a folder with everything in it. The destination must not exist.
    public func move(_ from: String, to: String) async throws {
        try client.check("files.move")
        try Drive.cleanPath(from); try Drive.cleanPath(to)
        if to == from || to.hasPrefix(from + "/") { throw GendragoonError.invalid("cannot move a folder into itself") }
        try await update { doc in
            let s = doc.folderSet()
            if doc.files[to] != nil || s.contains(to) { throw GendragoonError.invalid("\"\(to)\" already exists") }
            if let e = doc.files.removeValue(forKey: from) { doc.files[to] = e; return }
            guard s.contains(from) else { throw Drive.notFound }
            for q in doc.files.keys where q.hasPrefix(from + "/") { doc.files[to + q.dropFirst(from.count)] = doc.files.removeValue(forKey: q) }
            var fo = doc.folders.map { $0 == from || $0.hasPrefix(from + "/") ? to + $0.dropFirst(from.count) : $0 }
            fo.append(to)
            doc.folders = Array(Set(fo))
        }
    }

    /// Removes one file or one empty folder. Level L3, risk destructive. Blobs stay until collectGarbage.
    /// Cloud saves at L2 use `deleteSlot`.
    public func delete(_ p: String) async throws {
        try client.check("files.delete")
        try await update { doc in
            if doc.files.removeValue(forKey: p) != nil { return }
            let s = doc.folderSet()
            guard s.contains(p) else { throw Drive.notFound }
            if s.contains(where: { $0.hasPrefix(p + "/") }) || doc.files.keys.contains(where: { $0.hasPrefix(p + "/") }) { throw GendragoonError.invalid("folder \"\(p)\" is not empty") }
            doc.folders.removeAll { $0 == p }
        }
    }

    /// Removes one save slot: the file `folder/slot`, where `slot` is a single path segment. It never removes a
    /// folder, a nested file or anything outside `folder`, and it only changes this drive's manifest (the slot's
    /// blobs stay until collectGarbage). Its reach is the same as overwriting that slot, which L2 already allows,
    /// so it is level L2, risk destructive. The engine cloud-save components use it.
    public func deleteSlot(folder: String, slot: String) async throws {
        try client.check("files.deleteSlot")
        let p = try Drive.slotPath(folder: folder, slot: slot)
        try await update { doc in
            guard doc.files.removeValue(forKey: p) != nil else { throw Drive.notFound }
        }
    }

    /// `folder/slot` for a save slot. `slot` must be one path segment; `folder` may be "" (the drive root).
    public static func slotPath(folder: String, slot: String) throws -> String {
        if slot.isEmpty || slot.contains("/") { throw GendragoonError.invalid("invalid slot name \"\(slot)\"") }
        let p = folder.isEmpty ? slot : folder + "/" + slot
        _ = try cleanPath(p)
        return p
    }

    /// Removes a folder and everything in it; returns how many files were removed. Level L3, risk bulk-destructive.
    @discardableResult
    public func deleteFolder(_ p: String) async throws -> Int {
        try client.check("files.deleteFolder")
        var n = 0
        try await update { doc in
            let gone = doc.files.keys.filter { $0.hasPrefix(p + "/") }
            n = gone.count
            for q in gone { doc.files.removeValue(forKey: q) }
            doc.folders.removeAll { $0 == p || $0.hasPrefix(p + "/") }
        }
        return n
    }

    /// Deletes blobs no drive references. Refuses if any manifest is not a readable drive, unless `force`.
    /// Level L3, risk bulk-destructive.
    @discardableResult
    public static func collectGarbage(_ c: Client, keys: Keyring?, force: Bool = false) async throws -> Int {
        try c.check("files.collectGarbage")
        let mk = keys?.masterIfUnlocked
        var used = Set<String>()
        for m in try await c.allManifests() {
            let got: Manifest
            do { got = try await c.getManifest(m.id) } catch let e as APIError where e.notFound { continue }
            guard let plain = try? GDCrypto.openManifest(mk, key: m.id, got.data), let doc = try? DriveDocument.decode(plain) else {
                if force { continue }
                throw GendragoonError.invalid("manifest \(m.id.prefix(12)) is not a readable drive; refusing to collect garbage")
            }
            for e in doc.files.values { used.formUnion(e.chunks) }
        }
        var deleted = 0
        for b in try await c.allBlobs() where !used.contains(b.id) {
            _ = try await c.request("files.collectGarbage", "DELETE", "/blobs/" + b.id)
            deleted += 1
        }
        return deleted
    }
}
