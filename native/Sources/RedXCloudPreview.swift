import SwiftUI
import AppKit
import Foundation

// Isolated integration surface: legacy Firebase/Google storage stays untouched.
// REDXAI's verified CLI owns the OAuth, Receiver authorization and PNG codec.
@MainActor
final class RedXCloudPreviewModel: ObservableObject {
    @Published var busy = false
    @Published var status = "Connect your Red-XAI account to begin."
    @Published var output = ""
    @Published var cliVersion = "Not checked"
    @Published var currentAction = ""

    private static var cli: String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            home + "/.local/bin/REDXAI",
            home + "/.npm-global/bin/REDXAI",
            "/opt/homebrew/bin/REDXAI",
            "/usr/local/bin/REDXAI"
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    func inspect() {
        guard !busy else { return }
        run(["version"], label: "Checking REDXAI CLI") { [weak self] success, output in
            self?.cliVersion = success ? output.trimmingCharacters(in: .whitespacesAndNewlines) : "Not installed"
        }
    }

    func run(_ args: [String], label: String, password: String? = nil,
             completion: ((Bool, String) -> Void)? = nil) {
        guard !busy else { return }
        guard let cli = Self.cli else {
            status = "REDXAI CLI is missing. Install it with the Red-XAI installer first."
            output = "Expected ~/.local/bin/REDXAI or ~/.npm-global/bin/REDXAI."
            completion?(false, output)
            return
        }
        busy = true
        currentAction = label
        status = label + "…"
        output = ""
        let program = Process()
        program.executableURL = URL(fileURLWithPath: cli)
        program.arguments = args
        // Finder apps do not inherit Terminal's PATH. REDXAI's Node shebang
        // needs the installed Node binary; do not replace process privileges.
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = [
            "/opt/homebrew/bin", "/usr/local/bin",
            FileManager.default.homeDirectoryForCurrentUser.path + "/.local/bin",
            FileManager.default.homeDirectoryForCurrentUser.path + "/.npm-global/bin",
            environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        ].joined(separator: ":")
        program.environment = environment
        let pipe = Pipe()
        program.standardOutput = pipe
        program.standardError = pipe
        let secretPipe = password == nil ? nil : Pipe()
        program.standardInput = secretPipe ?? FileHandle.nullDevice

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var success = false
            var message = ""
            do {
                try program.run()
                if let secretPipe, let password {
                    // The password is never in argv, the environment or logs.
                    secretPipe.fileHandleForWriting.write(Data((password + "\n").utf8))
                    try? secretPipe.fileHandleForWriting.close()
                }
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                program.waitUntilExit()
                success = program.terminationStatus == 0
                message = String(decoding: data.prefix(64 * 1024), as: UTF8.self)
                if message.isEmpty { message = success ? "Operation completed." : "REDXAI command failed." }
            } catch {
                message = "Unable to launch REDXAI: " + error.localizedDescription
            }
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.busy = false
                self.output = message
                self.status = success ? label + " completed." : label + " could not complete. Read the details below."
                completion?(success, message)
            }
        }
    }
}

@MainActor
struct RedXCloudPreview: View {
    let close: () -> Void
    @StateObject private var model = RedXCloudPreviewModel()
    @State private var workspaceName = ""
    @State private var workspaceID = ""
    @State private var objectID = ""
    @State private var sourcePath = ""
    @State private var destinationPath = ""
    @State private var keymapPath = ""
    @State private var password = ""

    private var validWorkspace: Bool {
        workspaceID.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil
    }
    private var validObject: Bool {
        objectID.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Image(systemName: "externaldrive.fill.badge.person.crop")
                        .font(.system(size: 30)).foregroundStyle(.purple)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("GenDragoon · Red-XAI Cloud").font(.system(size: 25, weight: .bold))
                        Text("Private encrypted PNG storage preview · Existing Google cloud stays unchanged")
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Back to Google Sign In", action: close)
                }
                HStack {
                    Label(model.cliVersion, systemImage: "terminal").foregroundStyle(.secondary)
                    Spacer()
                    Button("Check CLI") { model.inspect() }.disabled(model.busy)
                    Button("Check Receiver") {
                        model.run(["GSSD-Status"], label: "Checking Receiver")
                    }.disabled(model.busy)
                }
                .padding(12).background(.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 12))

                GroupBox("1 · Red-XAI account") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Register on the shared Red-XAI website. Connect through browser OAuth; no Red-XAI password is captured by this app.")
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                        HStack {
                            Button("Register Red-XAI Account") {
                                model.run(["INSTALL-GSSD-CLI", "--register"], label: "Opening registration")
                            }
                            Button("Connect Existing Account") {
                                model.run(["INSTALL-GSSD-CLI", "--existing-account"], label: "Linking account and Receiver")
                            }
                            .buttonStyle(.borderedProminent).tint(.purple)
                        }.disabled(model.busy)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                }

                GroupBox("2 · Account-owned workspaces") {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            TextField("New workspace name", text: $workspaceName)
                            Button("Create") {
                                model.run(["GSSD-Workspace-Create", workspaceName],
                                          label: "Creating workspace")
                            }.disabled(model.busy || workspaceName.trimmingCharacters(in: .whitespaces).isEmpty)
                            Button("List Workspaces") {
                                model.run(["GSSD-Workspaces"], label: "Loading workspaces")
                            }.disabled(model.busy)
                        }
                        TextField("Workspace ID (32 lowercase hex characters)", text: $workspaceID)
                            .textFieldStyle(.roundedBorder)
                        Text("Use the workspace ID returned when you create or list your workspaces.")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }.padding(8)
                }

                GroupBox("3 · Encrypted PNG upload") {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            TextField("Source file", text: $sourcePath).textFieldStyle(.roundedBorder)
                            Button("Choose") { selectFile { sourcePath = $0 } }
                        }
                        HStack {
                            TextField("Private keymap path", text: $keymapPath).textFieldStyle(.roundedBorder)
                            Button("Choose") { selectKeymap() }
                        }
                        SecureField("Red-SecretsXAI password", text: $password).textFieldStyle(.roundedBorder)
                        Button("Encrypt and Upload PNG") {
                            let secret = password
                            password = ""
                            model.run(["GSSD-Upload", workspaceID, sourcePath, keymapPath, "--secret-stdin"],
                                      label: "Encrypting and uploading PNG", password: secret)
                        }
                        .buttonStyle(.borderedProminent).tint(.purple)
                        .disabled(model.busy || !validWorkspace || sourcePath.isEmpty || keymapPath.isEmpty || password.count < 8)
                    }.padding(8)
                }

                GroupBox("4 · Download and decrypt") {
                    VStack(alignment: .leading, spacing: 10) {
                        TextField("Object ID returned by upload", text: $objectID)
                            .textFieldStyle(.roundedBorder)
                        HStack {
                            TextField("New output filename", text: $destinationPath).textFieldStyle(.roundedBorder)
                            Button("Choose") { selectOutput() }
                        }
                        Text("The keymap must belong to the original upload. Existing output files are never overwritten.")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                        SecureField("Password for download", text: $password).textFieldStyle(.roundedBorder)
                        Button("Download PNG and Decrypt") {
                            let secret = password
                            password = ""
                            model.run(["GSSD-Download", workspaceID, objectID,
                                        destinationPath, keymapPath, "--secret-stdin"],
                                      label: "Downloading and decrypting", password: secret)
                        }.disabled(model.busy || !validWorkspace || !validObject || destinationPath.isEmpty ||
                                   keymapPath.isEmpty || password.count < 8)
                    }.padding(8)
                }

                VStack(alignment: .leading, spacing: 8) {
                    if model.busy { ProgressView().controlSize(.small) }
                    Text(model.status).font(.system(size: 12, weight: .medium))
                    ScrollView {
                        Text(model.output.isEmpty ? "Command results appear here." : model.output)
                            .textSelection(.enabled).font(.system(size: 11, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }.frame(minHeight: 90, maxHeight: 180)
                }.padding(12).background(.black.opacity(0.3), in: RoundedRectangle(cornerRadius: 12))
                Text("Preview limits: 64 KiB plaintext, up to 8 MiB PNG. The public Red-XAI server and commercial storage plans are not active; do not store irreplaceable files here.")
                    .font(.system(size: 11)).foregroundStyle(.orange)
            }
            .padding(24).frame(maxWidth: 900)
        }
        .background(Color(red: 0.055, green: 0.048, blue: 0.092).ignoresSafeArea())
        .onAppear { model.inspect() }
    }

    private func selectFile(_ select: (String) -> Void) {
        let picker = NSOpenPanel()
        picker.canChooseDirectories = false
        picker.canChooseFiles = true
        picker.allowsMultipleSelection = false
        if picker.runModal() == .OK, let url = picker.url { select(url.path) }
    }
    private func selectKeymap() {
        let picker = NSSavePanel()
        picker.nameFieldStringValue = "gendragoon-keymap.rsx"
        picker.message = "Choose a private keymap path. Select an existing keymap for later uploads."
        if picker.runModal() == .OK, let url = picker.url { keymapPath = url.path }
    }
    private func selectOutput() {
        let picker = NSSavePanel()
        picker.nameFieldStringValue = "restored-file"
        picker.message = "Select a new output filename. REDXAI will not overwrite an existing file."
        if picker.runModal() == .OK, let url = picker.url { destinationPath = url.path }
    }
}
