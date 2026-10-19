import Foundation

public enum ChangeType: String, Sendable {
    case manifestCreated = "manifest.created", manifestUpdated = "manifest.updated", manifestDeleted = "manifest.deleted"
    case usageChanged = "usage.changed", bindingRevoked = "binding.revoked"
}

public struct ChangeEvent: Sendable {
    public var type: ChangeType
    public var key: String?
    public var generation: String?
    public var usage: Usage?
    public init(type: ChangeType, key: String? = nil, generation: String? = nil, usage: Usage? = nil) { self.type = type; self.key = key; self.generation = generation; self.usage = usage }
}

/// Change events by polling. The server has no webhook or stream (Capabilities.eventsPoll only), so `watch`
/// polls /usage for changeSeq and lists manifests only when it moved.
public enum Events {
    /// Yields changes until the consuming task is cancelled or the binding is revoked. The first poll records the
    /// current state and yields nothing. Level L2, risk read.
    public static func watch(_ c: Client, interval: TimeInterval = 5, resyncEvery: TimeInterval = 600, keys: Set<String>? = nil) throws -> AsyncStream<ChangeEvent> {
        try c.check("events.watch")
        let every = max(interval, 1)
        let filter = keys?.isEmpty == false ? keys : nil
        return AsyncStream { cont in
            let task = Task { () async -> Void in
                var seen: [String: String?]?
                var last: Usage?
                var lastList = Date.distantPast
                while !Task.isCancelled {
                    var u: Usage?
                    do { u = try await c.usage() } catch let e as APIError where e.unauthorized {
                        cont.yield(ChangeEvent(type: .bindingRevoked)); cont.finish(); return
                    } catch {}
                    if let u = u {
                        if let l = last, u.usedBytes != l.usedBytes || u.objectCount != l.objectCount || u.quotaBytes != l.quotaBytes {
                            cont.yield(ChangeEvent(type: .usageChanged, usage: u))
                        }
                        if last == nil || u.changeSeq != last!.changeSeq || Date().timeIntervalSince(lastList) >= resyncEvery {
                            if let items = try? await c.allManifests() {
                                var now: [String: String?] = [:]
                                for it in items where filter == nil || filter!.contains(it.id) { now[it.id] = it.generation }
                                lastList = Date()
                                if let s = seen {
                                    for k in now.keys.sorted(by: Drive.ordered) {
                                        if s[k] == nil { cont.yield(ChangeEvent(type: .manifestCreated, key: k, generation: now[k]!)) }
                                        else if s[k]! != now[k]! { cont.yield(ChangeEvent(type: .manifestUpdated, key: k, generation: now[k]!)) }
                                    }
                                    for k in s.keys.sorted(by: Drive.ordered) where now[k] == nil { cont.yield(ChangeEvent(type: .manifestDeleted, key: k)) }
                                }
                                seen = now
                            }
                        }
                        last = u
                    }
                    try? await Task.sleep(nanoseconds: UInt64(every * 1_000_000_000))
                }
                cont.finish()
            }
            cont.onTermination = { _ in task.cancel() }
        }
    }
}

