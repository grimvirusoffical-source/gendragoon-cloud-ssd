import Foundation

public struct SyncOptions: Sendable {
    /// Drive folder that corresponds to the local folder ("" is the drive root).
    public var prefix = ""
    /// Report what would change without changing anything.
    public var dryRun = false
    /// True for local relative paths (slash-separated) that must not be synced.
    public var skip: (@Sendable (String) -> Bool)?
    public init(prefix: String = "", dryRun: Bool = false, skip: (@Sendable (String) -> Bool)? = nil) { self.prefix = prefix; self.dryRun = dryRun; self.skip = skip }
}

public struct SyncReport: Sendable {
    public var uploaded: [String] = [], downloaded: [String] = [], deleted: [String] = []
    public var unchanged = 0
}

public enum SyncDirection: Sendable { case toDrive, toLocal }

/// Folder sync between the local disk and a drive.
public enum Sync {
    static func scan(_ root: URL, _ skip: ((String) -> Bool)?) -> [String: URL] {
        var o: [String: URL] = [:]
        let fm = FileManager.default
        func walk(_ dir: URL, _ rel: String) {
            guard let items = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isSymbolicLinkKey, .isDirectoryKey, .isRegularFileKey]) else { return }
            for u in items {
                let r = rel.isEmpty ? u.lastPathComponent : rel + "/" + u.lastPathComponent
                if let s = skip, s(r) { continue }
                let v = try? u.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey, .isRegularFileKey])
                if v?.isSymbolicLink == true { continue } // symlinks are never followed or uploaded
                if v?.isDirectory == true { walk(u, r) } else if v?.isRegularFile == true { o[r] = u }
            }
        }
        walk(root, "")
        return o
    }

    static func dp(_ prefix: String, _ rel: String) -> String { prefix.isEmpty ? rel : prefix + "/" + rel }
    static func under(_ p: String, _ prefix: String) -> Bool { prefix.isEmpty || p.hasPrefix(prefix + "/") }
    static func rel(_ p: String, _ prefix: String) -> String { prefix.isEmpty ? p : String(p.dropFirst(prefix.count + 1)) }

    static func push(_ d: Drive, _ local: URL, _ o: SyncOptions, mirror: Bool) async throws -> SyncReport {
        if !o.prefix.isEmpty { try Drive.cleanPath(o.prefix) }
        let files = scan(local, o.skip)
        let doc = try await d.load().0
        var rep = SyncReport()
        var changed: [String: FileEntry] = [:]
        for r in files.keys.sorted(by: Drive.ordered) {
            let p = try Drive.cleanPath(dp(o.prefix, r))
            let data = try Data(contentsOf: files[r]!)
            let old = doc.files[p]
            if let old = old, old.size == Int64(data.count), old.sha256 == Bytes.hex(Bytes.sha256(data)) { rep.unchanged += 1; continue }
            rep.uploaded.append(p)
            if o.dryRun { continue }
            var key: Data?
            if d.encrypted {
                if let k = old?.key, let raw = try? Bytes.fromB64u(k), raw.count == GDCrypto.keyBytes { key = raw } else { key = Bytes.random(GDCrypto.keyBytes) }
            }
            var e = try await d.upload(key, data)
            let mod = (try? files[r]!.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date()
            e.mtime = Int64(mod.timeIntervalSince1970 * 1000)
            changed[p] = e
        }
        let gone = mirror ? doc.files.keys.filter { under($0, o.prefix) && files[rel($0, o.prefix)] == nil }.sorted(by: Drive.ordered) : []
        rep.deleted = gone
        if o.dryRun || (changed.isEmpty && gone.isEmpty) { return rep }
        let ch = changed
        try await d.update { latest in
            for (k, v) in ch { latest.files[k] = v }
            for p in gone { latest.files.removeValue(forKey: p) }
        }
        return rep
    }

    static func unsafe(_ rel: String, _ why: String) -> GendragoonError {
        GendragoonError.invalid("unsafe path \"\(rel)\": \(why)")
    }

    static func isInside(_ p: String, _ root: String) -> Bool { p == root || p.hasPrefix(root.hasSuffix("/") ? root : root + "/") }

    /// The local file a pull writes for `rel`. Nothing on the way may be a symbolic link (checked with lstat, so links
    /// are never followed), every existing component must be a folder, an existing target must be a regular file, and
    /// the resolved folder must stay inside the local root.
    static func localTarget(_ local: URL, _ rel: String) throws -> URL {
        let fm = FileManager.default
        try fm.createDirectory(at: local, withIntermediateDirectories: true)
        let root = local.standardizedFileURL.resolvingSymlinksInPath()
        let parts = rel.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        if parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) { throw unsafe(rel, "is not a valid drive path") }
        var cur = root
        for (i, part) in parts.enumerated() {
            cur = cur.appendingPathComponent(part)
            guard let attrs = try? fm.attributesOfItem(atPath: cur.path) else { break } // does not follow links
            let type = attrs[.type] as? FileAttributeType
            if type == .typeSymbolicLink { throw unsafe(rel, "\"\(cur.path)\" is a symbolic link") }
            let last = i == parts.count - 1
            if !last && type != .typeDirectory { throw unsafe(rel, "\"\(cur.path)\" is not a folder") }
            if last && type != .typeRegular { throw unsafe(rel, "\"\(cur.path)\" is not a regular file") }
        }
        let target = root.appendingPathComponent(rel).standardizedFileURL
        guard isInside(target.path, root.path), target.path != root.path else { throw unsafe(rel, "escapes the local folder") }
        let dir = target.deletingLastPathComponent()
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        guard isInside(dir.resolvingSymlinksInPath().path, root.path) else { throw unsafe(rel, "escapes the local folder") }
        return target
    }

    static func writeAtomic(_ target: URL, _ data: Data, _ mtime: Int64) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: target, options: .atomic)
        try fm.setAttributes([.modificationDate: Date(timeIntervalSince1970: Double(mtime) / 1000)], ofItemAtPath: target.path)
    }

    static func pull(_ c: Client, _ d: Drive, _ local: URL, _ o: SyncOptions, mirror: Bool) async throws -> SyncReport {
        let doc = try await d.load().0
        let files = scan(local, o.skip)
        var rep = SyncReport()
        var remote = Set<String>()
        for p in doc.files.keys.sorted(by: Drive.ordered) where under(p, o.prefix) {
            let e = doc.files[p]!
            let r = rel(p, o.prefix)
            if let s = o.skip, s(r) { continue }
            guard (try? Drive.cleanPath(p)) == p else { throw unsafe(p, "is not a valid drive path") }
            remote.insert(r)
            if let u = files[r], let have = try? Data(contentsOf: u), Int64(have.count) == e.size, Bytes.hex(Bytes.sha256(have)) == e.sha256 { rep.unchanged += 1; continue }
            rep.downloaded.append(p)
            if o.dryRun { continue }
            try writeAtomic(try localTarget(local, r), try await Drive.readEntry(c, e), e.mtime)
        }
        if mirror {
            for r in files.keys.sorted(by: Drive.ordered) where !remote.contains(r) {
                rep.deleted.append(dp(o.prefix, r))
                if !o.dryRun { try FileManager.default.removeItem(at: files[r]!) }
            }
        }
        return rep
    }

    /// Uploads local files that are new or differ (by SHA-256). Remote-only files are kept. Level L2, risk write.
    public static func push(_ c: Client, drive d: Drive, from local: URL, options: SyncOptions = SyncOptions()) async throws -> SyncReport {
        try c.check("sync.push")
        return try await push(d, local, options, mirror: false)
    }

    /// Downloads drive files that are new or differ, written atomically. Local-only files are kept. Level L2, risk write.
    public static func pull(_ c: Client, drive d: Drive, to local: URL, options: SyncOptions = SyncOptions()) async throws -> SyncReport {
        try c.check("sync.pull")
        return try await pull(c, d, local, options, mirror: false)
    }

    /// Makes one side identical to the other, deleting files only on the target side. Level L3, risk bulk-destructive.
    public static func mirror(_ c: Client, drive d: Drive, local: URL, direction: SyncDirection, options: SyncOptions = SyncOptions()) async throws -> SyncReport {
        try c.check("sync.mirror")
        return direction == .toDrive ? try await push(d, local, options, mirror: true) : try await pull(c, d, local, options, mirror: true)
    }
}
