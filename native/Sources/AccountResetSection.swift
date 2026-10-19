import AppKit
import Combine
import Dispatch
import Foundation
import SwiftUI

/// Add this section to the application's Account view.
/// `isBusy` must include all transfers, mounts, installs, and update work.
@MainActor
public struct AccountResetSection: View {
    private let isBusy: Bool
    private let acquireExclusiveOperation: @MainActor () -> Bool
    private let releaseExclusiveOperation: @MainActor () -> Void
    @StateObject private var controller = AccountResetController()

    /// The callback must prevent new work while a restart is pending.
    public init(
        isBusy: Bool,
        acquireExclusiveOperation: @escaping @MainActor () -> Bool,
        releaseExclusiveOperation: @escaping @MainActor () -> Void
    ) {
        self.isBusy = isBusy
        self.acquireExclusiveOperation = acquireExclusiveOperation
        self.releaseExclusiveOperation = releaseExclusiveOperation
    }

    public var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    controller.requestReset(
                        isBusy: isBusy,
                        acquire: acquireExclusiveOperation,
                        release: releaseExclusiveOperation
                    )
                } label: {
                    Label("Reset App", systemImage: "arrow.clockwise")
                }
                .disabled(isBusy || controller.isRequestPending)
                .help("Restart GenDragoon while preserving cloud files and saved credentials.")

                Text("Restart and refresh GenDragoon. Cloud files, saved credentials, and local data are preserved.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if isBusy && !controller.isRequestPending {
                    Text("Available when transfers, mounts, installs, and updates finish.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if controller.isRequestPending {
                    HStack(spacing: 8) {
                        ProgressView()
                            .controlSize(.small)
                        Text(controller.statusText)
                            .font(.caption)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        } header: {
            Text("App")
        }
        .alert(item: $controller.failure) { failure in
            Alert(
                title: Text("Couldn’t reset GenDragoon"),
                message: Text(failure.message),
                dismissButton: .default(Text("OK"))
            )
        }
    }
}

@MainActor
private final class AccountResetController: ObservableObject {
    @Published private(set) var isRequestPending = false
    @Published private(set) var statusText = "Preparing to restart…"
    @Published var failure: ResetFailure?

    func requestReset(
        isBusy: Bool,
        acquire: @escaping @MainActor () -> Bool,
        release: @escaping @MainActor () -> Void
    ) {
        guard !isBusy, !isRequestPending else { return }
        guard Bundle.main.bundleURL.pathExtension.lowercased() == "app" else {
            failure = ResetFailure("Reset App must run from the installed GenDragoon app bundle.")
            return
        }
        guard let helper = Bundle.main.url(
            forResource: "gendragoon_app_control",
            withExtension: "py"
        ), FileManager.default.isReadableFile(atPath: helper.path) else {
            failure = ResetFailure("Reset App isn’t available in this build. Install the latest signed GenDragoon update.")
            return
        }

        guard acquire() else {
            failure = ResetFailure("Another operation is active. Finish it before resetting the app.")
            return
        }
        failure = nil
        statusText = "Preparing to restart…"
        isRequestPending = true
        // Notify the app's operation coordinator before starting the helper.

        let arguments = [
            "python3", helper.path, "reset",
            "--pid", String(ProcessInfo.processInfo.processIdentifier),
            "--app", Bundle.main.bundleURL.path,
            "--ui-busy", isBusy ? "true" : "false"
        ]

        Task { [self] in
            do {
                let response = try await Task.detached(priority: .userInitiated) {
                    try ResetHelperProcess.run(arguments: arguments)
                }.value

                guard response.state == "scheduled",
                      let requestID = response.requestID,
                      requestID.range(of: #"^[0-9a-f]{32}$"#, options: .regularExpression) != nil,
                      let deadlineSeconds = response.deadlineSeconds,
                      (1...240).contains(deadlineSeconds),
                      let exitTimeoutSeconds = response.exitTimeoutSeconds,
                      (1...deadlineSeconds).contains(exitTimeoutSeconds) else {
                    throw ResetFailure("The restart could not be prepared. GenDragoon is still running.")
                }

                // The helper acknowledges only after its detached worker owns
                // update.lock and has completed restart preflight. It waits for
                // this exact process to exit before relaunching the signed app.
                statusText = "Waiting for GenDragoon to close…"
                NSApp.terminate(nil)

                // A document or app delegate can defer or cancel termination.
                // Keep new work blocked while the helper still waits for exit.
                try await waitForWorkerOutcome(
                    helperPath: helper.path,
                    requestID: requestID,
                    deadlineSeconds: deadlineSeconds
                )
            } catch {
                failure = ResetFailure(ResetHelperMessage.redact(error.localizedDescription))
                isRequestPending = false
                release()
            }
        }
    }

    private func waitForWorkerOutcome(
        helperPath: String,
        requestID: String,
        deadlineSeconds: Int
    ) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(deadlineSeconds))
        var lastStatusError: String?

        while clock.now < deadline {
            try await Task.sleep(for: .seconds(1))
            let response: ResetHelperReply
            do {
                response = try await Task.detached(priority: .utility) {
                    try ResetHelperProcess.run(
                        arguments: ["python3", helperPath, "status", "--request-id", requestID],
                        timeoutSeconds: 3
                    )
                }.value
            } catch {
                lastStatusError = ResetHelperMessage.redact(error.localizedDescription)
                continue
            }

            guard response.requestID == requestID else {
                lastStatusError = "A matching reset status is not available."
                continue
            }
            switch response.state {
            case "failed":
                throw ResetFailure("\(ResetHelperMessage.redact(response.message ?? response.error ?? "The restart worker failed."))\n\nGenDragoon is still running.")
            case "restarted":
                // A successful normal restart exits this process, so its UI
                // cannot reach this branch. Report inconsistent status safely.
                throw ResetFailure("GenDragoon is still open after a reported restart. Close and reopen it normally.")
            case "scheduled", "waiting_for_exit", "restarting":
                continue
            case "not_found":
                lastStatusError = "A matching reset status is not available."
            default:
                lastStatusError = "The restart status could not be confirmed."
            }
        }

        let detail = lastStatusError.map { "\n\n\($0)" } ?? ""
        throw ResetFailure("The restart worker’s maximum deadline has passed without a confirmed restart. GenDragoon is still running. Check the app control status before trying again.\(detail)")
    }
}

private struct ResetFailure: Error, LocalizedError, Identifiable {
    let id = UUID()
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? { message }
}

private struct ResetHelperReply: Decodable, Sendable {
    let state: String
    let error: String?
    let message: String?
    let requestID: String?
    let exitTimeoutSeconds: Int?
    let deadlineSeconds: Int?

    enum CodingKeys: String, CodingKey {
        case state, error, message
        case requestID = "request_id"
        case exitTimeoutSeconds = "exit_timeout_seconds"
        case deadlineSeconds = "deadline_seconds"
    }
}

private enum ResetHelperProcess {
    /// Runs only on a detached task. File-backed output avoids pipe deadlocks,
    /// including a helper that writes substantial stderr before returning JSON.
    static func run(arguments: [String], timeoutSeconds: Double = 120) throws -> ResetHelperReply {
        let fileManager = FileManager.default
        let outputDirectory = fileManager.temporaryDirectory
            .appendingPathComponent("gendragoon-reset-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(
            at: outputDirectory,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        defer { try? fileManager.removeItem(at: outputDirectory) }

        let stdoutURL = outputDirectory.appendingPathComponent("stdout")
        let stderrURL = outputDirectory.appendingPathComponent("stderr")
        guard fileManager.createFile(atPath: stdoutURL.path, contents: nil, attributes: [.posixPermissions: 0o600]),
              fileManager.createFile(atPath: stderrURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw ResetFailure("Could not prepare the restart. GenDragoon is still running.")
        }

        let stdout = try FileHandle(forWritingTo: stdoutURL)
        defer { try? stdout.close() }
        let stderr = try FileHandle(forWritingTo: stderrURL)
        defer { try? stderr.close() }

        let process = Process()
        guard let python = GDRuntime.pythonURL else { throw ResetFailure("A supported Python runtime is unavailable. Run the installer.") }
        process.executableURL = python
        GDRuntime.configurePython(process, arguments: arguments.first == "python3" ? Array(arguments.dropFirst()) : arguments)
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = stdout
        process.standardError = stderr

        let completion = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in completion.signal() }
        do {
            try process.run()
        } catch {
            throw ResetFailure("Could not start the reset helper: \(ResetHelperMessage.redact(error.localizedDescription)). GenDragoon is still running.")
        }

        guard completion.wait(timeout: .now() + timeoutSeconds) == .success else {
            if process.isRunning {
                process.terminate()
                _ = completion.wait(timeout: .now() + 2)
            }
            throw ResetFailure("The reset helper did not respond within \(Int(timeoutSeconds)) seconds. GenDragoon is still running. Check the app control status before trying again.")
        }

        let output = try readBoundedFile(stdoutURL)
        let reply = try? JSONDecoder().decode(ResetHelperReply.self, from: output)
        guard process.terminationReason == .exit,
              process.terminationStatus == 0,
              let reply else {
            let detail: String
            if let reply {
                detail = reply.message ?? reply.error ?? "The helper returned state \(reply.state)."
            } else {
                let stderrData = (try? readBoundedFile(stderrURL)) ?? Data()
                let stderrText = String(decoding: stderrData, as: UTF8.self)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                detail = stderrText.isEmpty
                    ? "The helper did not return a valid restart acknowledgement (exit \(process.terminationStatus))."
                    : stderrText
            }
            throw ResetFailure("\(ResetHelperMessage.redact(detail))\n\nGenDragoon is still running.")
        }
        return reply
    }

    private static func readBoundedFile(_ url: URL) throws -> Data {
        let reader = try FileHandle(forReadingFrom: url)
        defer { try? reader.close() }
        return try reader.read(upToCount: 16_384) ?? Data()
    }
}

private enum ResetHelperMessage {
    /// The helper already emits bounded, safe messages. Also redact common
    /// credential forms in interpreter/OS errors before displaying them.
    static func redact(_ message: String) -> String {
        var result = String(message.prefix(4_096))
        let replacements: [(String, String)] = [
            (#"(?i)(https?://)[^/\s@]+@"#, "$1[REDACTED]@"),
            (#"([?&][^=\s&]+)=([^&\s]+)"#, "$1=[REDACTED]"),
            (#"(?i)(authorization\s*[:=]\s*(?:bearer|basic)?\s*)[^\s,;]+"#, "$1[REDACTED]"),
            (#"(?i)\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token)\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"#, "$1[REDACTED]"),
            (#"\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_-]+\b"#, "[REDACTED]"),
            (#"\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b"#, "[REDACTED]")
        ]
        for (pattern, replacement) in replacements {
            if let regex = try? NSRegularExpression(pattern: pattern) {
                result = regex.stringByReplacingMatches(
                    in: result,
                    range: NSRange(result.startIndex..., in: result),
                    withTemplate: replacement
                )
            }
        }
        result = result.components(separatedBy: .controlCharacters).joined(separator: " ")
        return String(result.prefix(1_600)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
