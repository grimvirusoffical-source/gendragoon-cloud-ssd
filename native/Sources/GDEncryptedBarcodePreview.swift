import AppKit
import CryptoKit
import Foundation
import SwiftUI

/// Displays only a currently authenticated, checksum-verified encrypted
/// *root-manifest* PNG. Never embeds tokens, passwords, encryption keys, or
/// plaintext file bytes in the image, a shared URL, or a QR payload.
@MainActor
struct GDEncryptedBarcodePreview: View {
    let item: StoredApp

    @State private var image: NSImage?
    @State private var loading = true
    @State private var message = ""

    private struct PreviewError: LocalizedError {
        let detail: String
        var errorDescription: String? { detail }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Encrypted red-X barcode").font(.title2.bold())
            Text(item.label).font(.headline).lineLimit(2)
            Text("This is the authenticated encrypted root-manifest image for this backup. A large file, folder or app uses additional encrypted PNGs; this is not a conventional scannable QR code.")
                .font(.caption).foregroundStyle(.secondary)
            if loading {
                ProgressView("Retrieving verified encrypted image…")
                    .frame(maxWidth: .infinity, minHeight: 240)
            } else if let image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.none)
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: 390)
                    .background(.black, in: RoundedRectangle(cornerRadius: 8))
                    .privacySensitive()
                Label("Receiver access, content length and SHA-256 verified. Image kept in this window; no public link or key is created.", systemImage: "checkmark.shield")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Label(message, systemImage: "exclamationmark.shield")
                    .font(.caption).foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, minHeight: 160, alignment: .center)
            }
            Text("Only your signed-in account can request this stored image. The barcode itself carries ciphertext, not a decryption key. Do not share a screen containing sensitive account information.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(22)
        .frame(minWidth: 480, idealWidth: 640, maxWidth: 750)
        .task(id: item.key) {
            image = nil
            loading = true
            do { try await retrieve() }
            catch {
                image = nil
                message = error.localizedDescription
            }
            loading = false
        }
    }

    private func retrieve() async throws {
        guard item.format == "redxai", item.virtualFolder != true,
              let id = item.redxManifestId, id.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
              let workspace = item.bucket,
              workspace.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else {
            throw PreviewError(detail: "Choose a stored MachineNote backup with an encrypted manifest.")
        }
        let account = GDRedXAIAuthSession.shared
        let subject = account.subject, receiver = account.receiverID
        guard account.linked, !subject.isEmpty, !receiver.isEmpty,
              account.readableProjects.contains(where: {
                  $0.id == "redxai" && $0.buckets.contains(where: { $0.id == workspace })
              }) else {
            throw PreviewError(detail: "This MachineNote is not available to the currently connected Red-XAI account.")
        }

        let session = URLSession(configuration: .ephemeral,
                                 delegate: GDMachineNotesRedirectDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        guard let url = URL(string: "https://api.red-xai.com/v1/receivers/me/workspaces/\(workspace)/blobs/\(id)") else {
            throw PreviewError(detail: "Invalid encrypted barcode location.")
        }
        var data = Data(), http: HTTPURLResponse?
        for attempt in 0...1 {
            var request = URLRequest(url: url)
            request.httpMethod = "GET"
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.timeoutInterval = 30
            request.setValue("Bearer " + (try await account.accessToken(forceRefresh: attempt == 1)),
                             forHTTPHeaderField: "Authorization")
            request.setValue("image/png", forHTTPHeaderField: "Accept")
            request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
            let reply = try await session.data(for: request)
            data = reply.0
            http = reply.1 as? HTTPURLResponse
            if http?.statusCode != 401 { break }
        }
        guard let response = http, response.statusCode == 200 else {
            throw PreviewError(detail: "The Receiver did not authorize the encrypted barcode request.")
        }
        guard account.linked, account.subject == subject, account.receiverID == receiver else {
            throw PreviewError(detail: "Your account changed during the barcode request; the image was discarded.")
        }
        try Task.checkCancellation()
        guard data.count >= 32, data.count <= 8 * 1024 * 1024,
              data.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]),
              response.value(forHTTPHeaderField: "Content-Type")?.lowercased().hasPrefix("image/png") == true,
              let contentLength = response.value(forHTTPHeaderField: "Content-Length"),
              Int(contentLength) == data.count,
              let digest = response.value(forHTTPHeaderField: "X-Content-SHA256"),
              digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == digest else {
            throw PreviewError(detail: "Encrypted barcode failed content integrity verification.")
        }
        let width = data[16..<20].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        let height = data[20..<24].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        guard width > 0, height > 0, UInt64(width) * UInt64(height) <= 4_000_000 else {
            throw PreviewError(detail: "Encrypted barcode raster exceeds safe display limits.")
        }
        let unencryptedMarker = Data("GenDragoon\u{0000}Unencrypted-v1".utf8)
        if data.count >= 41 + unencryptedMarker.count,
           data.subdata(in: 41..<(41 + unencryptedMarker.count)) == unencryptedMarker {
            throw PreviewError(detail: "This backup was intentionally uploaded without encryption. There is no encrypted barcode to display.")
        }
        guard let decoded = NSImage(data: data) else {
            throw PreviewError(detail: "The encrypted red-X barcode PNG cannot be displayed.")
        }
        image = decoded
    }
}
