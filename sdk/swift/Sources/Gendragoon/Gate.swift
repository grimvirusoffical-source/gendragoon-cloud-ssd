import Foundation

/// Rotten Apple developer unlock levels (docs/SDK_LEVELS.md): L0 Applicant, L1 Starter, L2 Established,
/// L3 Trusted, L4 By approval. The `data.storage` and `gendragoon` services are L2.
public enum Level: Int, Comparable, CustomStringConvertible, Sendable {
    case l0 = 0, l1, l2, l3, l4
    public static func < (a: Level, b: Level) -> Bool { a.rawValue < b.rawValue }
    public var description: String { "L\(rawValue)" }

    /// Parses "L2" or "2".
    public init?(parsing s: String) {
        var t = s.trimmingCharacters(in: .whitespaces).uppercased()
        if t.hasPrefix("L") { t.removeFirst() }
        guard t.count == 1, let n = Int(t), let l = Level(rawValue: n) else { return nil }
        self = l
    }
}

public enum Risk: String, Sendable {
    case read, write, credential, destructive, bulkDestructive = "bulk-destructive", key, keyExport = "key-export", sharing
}

/// One entry of the shared operation table (spec/operations.json).
public struct Operation: Sendable {
    public let id: String
    public let level: Level
    /// Rotten Apple service id: "data.storage" or "gendragoon".
    public let service: String
    public let risk: Risk
    /// "app" (API key), "user" (signed-in account) or "local" (no network).
    public let context: String
    public let method: String
    public let path: String
    public let scope: String
    public let summary: String

    public static func named(_ id: String) -> Operation {
        guard let o = all.first(where: { $0.id == id }) else { preconditionFailure("gendragoon: unknown operation \(id)") }
        return o
    }
}

/// Thrown when the gate refuses an operation.
public struct LevelError: Error, CustomStringConvertible {
    public let operation: Operation
    public let allowed: Level
    public var description: String { "gendragoon: \(operation.id) needs \(operation.level) (\(operation.risk.rawValue)); this client allows up to \(allowed)" }
}

/// Decides whether an operation may run; throws to refuse.
public typealias Gate = @Sendable (Operation) throws -> Void

public enum Gating {
    public static let defaultMaxLevel = Level.l3
    /// A host (the Rotten Apple launcher) sets this to cap the level. It can only lower the cap.
    public static let maxLevelEnv = "GENDRAGOON_SDK_MAX_LEVEL"

    /// Allows operations at or below `max`, lowered further by GENDRAGOON_SDK_MAX_LEVEL. An unreadable value locks to L0.
    public static func levelGate(_ max: Level = defaultMaxLevel) -> Gate {
        var eff = max
        if let env = ProcessInfo.processInfo.environment[maxLevelEnv] {
            if let l = Level(parsing: env) { eff = Swift.min(eff, l) } else { eff = .l0 }
        }
        let cap = eff
        return { op in if op.level > cap { throw LevelError(operation: op, allowed: cap) } }
    }
}
