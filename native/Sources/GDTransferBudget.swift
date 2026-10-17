import Foundation

/// One budget for every in-flight file on a client. Dividing the verified
/// worker allowance prevents a batch from multiplying per-file concurrency.
struct GDTransferBudget {
    struct Lease {
        let workers: Int
        let verifiedLimit: Int
        let downloadBytes: Int64
    }
    private(set) var leases: [String: Lease] = [:]
    var workersInUse: Int { leases.values.reduce(0) { $0 + $1.workers } }
    var reservedDownloadBytes: Int64 { leases.values.reduce(0) { $0 + $1.downloadBytes } }

    mutating func reserve(key: String, verifiedLimit: Int, requestedWorkers: Int?, downloadBytes: Int64 = 0) throws -> Int {
        guard !key.isEmpty, (1...24).contains(verifiedLimit), downloadBytes >= 0,
              downloadBytes <= 4_000_000_000_000,
              requestedWorkers == nil || (1...24).contains(requestedWorkers!) else {
            throw GDTransferError(message: "Invalid transfer resource allowance.", status: 0)
        }
        let count = min(verifiedLimit, requestedWorkers ?? verifiedLimit)
        let sharedLimit = min(verifiedLimit, leases.values.map(\.verifiedLimit).min() ?? verifiedLimit)
        guard leases[key] == nil, workersInUse + count <= sharedLimit else {
            throw GDTransferError(message: "The active transfers already use this project's worker allowance. Pause or finish them before starting another.", status: 0)
        }
        leases[key] = Lease(workers: count, verifiedLimit: verifiedLimit, downloadBytes: downloadBytes)
        return count
    }

    mutating func release(key: String) { leases.removeValue(forKey: key) }
}
