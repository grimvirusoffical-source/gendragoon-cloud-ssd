import Foundation
import Darwin

/// A socketpair is inherited only as stdin. No credential socket or token file exists.
final class GDWorkerAuthChannel: @unchecked Sendable {
    private let parent: FileHandle
    private let child: FileHandle
    private let payload: Data
    private let nonce: String
    private let receiver: String
    private let workspace: String
    private let renew: @Sendable (Bool) async throws -> String
    private let closeLock = NSLock()
    private var closed = false
    private var task: Task<Void, Never>?

    @MainActor static func make(_ input: Data?) throws -> GDWorkerAuthChannel? {
        guard let input, let decoded = try? JSONSerialization.jsonObject(with: input), var value = decoded as? [String: Any],
              value["provider"] as? String == "redxai" else { return nil }
        let authorization = try GDRedXAIAuthSession.shared.workerRenewalAuthorization(value)
        let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
            + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        value["authBroker"] = ["protocol": 1, "fd": 0, "nonce": nonce]
        var payload = try JSONSerialization.data(withJSONObject: value)
        payload.append(10)
        guard payload.count <= 32 * 1024 else { throw GDNativeFailure(message: "Private helper input exceeded its safety limit.") }
        return try GDWorkerAuthChannel(payload: payload, nonce: nonce,
            receiver: authorization.receiver, workspace: authorization.workspace, renew: authorization.renew)
    }

    init(payload: Data, nonce: String, receiver: String, workspace: String,
         renew: @escaping @Sendable (Bool) async throws -> String) throws {
        var descriptors: [Int32] = [-1, -1]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
            throw GDNativeFailure(message: "Could not create a private helper session channel.")
        }
        for fd in descriptors {
            _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
            var enabled: Int32 = 1
            _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size))
        }
        parent = FileHandle(fileDescriptor: descriptors[0], closeOnDealloc: true)
        child = FileHandle(fileDescriptor: descriptors[1], closeOnDealloc: true)
        self.payload = payload; self.nonce = nonce; self.receiver = receiver; self.workspace = workspace; self.renew = renew
    }

    func attach(to process: Process) { process.standardInput = child }
    func start() throws {
        try child.close() // Process has already duplicated it to the child's fd0.
        try parent.write(contentsOf: payload)
        task = Task.detached(priority: .utility) { await self.serve() }
    }
    func close() {
        closeLock.lock()
        let shouldClose = !closed; closed = true
        closeLock.unlock()
        if shouldClose {
            _ = shutdown(parent.fileDescriptor, SHUT_RDWR)
            try? parent.close(); try? child.close(); task?.cancel()
        }
    }
    deinit { close() }

    private func line() throws -> Data? {
        var result = Data()
        while result.count <= 4096 {
            guard let byte = try parent.read(upToCount: 1), !byte.isEmpty else { return nil }
            if byte[0] == 10 { return result }
            result.append(byte)
        }
        throw GDNativeFailure(message: "Invalid private renewal request.")
    }
    private func serve() async {
        var generation = 0
        var issuedToken: String?
        do {
            while !Task.isCancelled, let data = try line() {
                guard let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      request["protocol"] as? Int == 1, let operation = request["operation"] as? String,
                      ["renew", "authorize"].contains(operation),
                      request["nonce"] as? String == nonce, request["receiverId"] as? String == receiver,
                      request["workspaceId"] as? String == workspace,
                      let requestedGeneration = request["generation"] as? Int,
                      requestedGeneration >= 0, requestedGeneration <= generation else { break }
                var response: [String: Any]
                do {
                    // A later library subprocess may inherit its parent's old
                    // generation after an earlier child renewed. Return native's
                    // current valid token without forcing another rotation.
                    let token = try await renew(operation == "renew" && requestedGeneration == generation)
                    guard token.range(of: "^rxca_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { break }
                    if operation == "renew" && requestedGeneration == generation || issuedToken != nil && token != issuedToken { generation += 1 }
                    issuedToken = token
                    response = ["ok": true, "bearerToken": token, "receiverId": receiver,
                                "workspaceId": workspace, "generation": generation]
                } catch { response = ["ok": false, "error": "session_renewal_denied"] }
                var encoded = try JSONSerialization.data(withJSONObject: response); encoded.append(10)
                try parent.write(contentsOf: encoded)
                if response["ok"] as? Bool != true { break }
            }
        } catch { /* The helper reports an allowlisted session error; no request data is logged. */ }
        close()
    }
}
