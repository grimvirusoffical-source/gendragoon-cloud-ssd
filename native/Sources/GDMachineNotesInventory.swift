import Foundation
import SwiftUI

final class GDMachineNotesRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct GDMachineNoteLibraryItem: Decodable {
    let name: String
    let kind: String?
    let archiveBytes: Int64
    let generation: Int
    let updatedMs: Int64
}

struct GDMachineNoteMetadata: Decodable {
    let id: String
    let receiverId: String
    let name: String
    let status: String
    let active: Bool
    let readOnly: Bool
    let quotaBytes: Int64
    let usedBytes: Int64
    let workers: Int
    let storageTier: String?
    let performanceTier: String?
    let subscriptionStatus: String?
    let feeWaived: Bool
    let workspaceMonthlyCents: Int?
    let createdMs: Int64
    let entitlementsCheckedMs: Int64
    let libraryItemCount: Int
    let libraryItems: [GDMachineNoteLibraryItem]
    let libraryItemsTruncated: Bool

    var inventoryID: String { receiverId + "/" + id }
}

struct GDMachineNotesInventoryPage: Decodable {
    let schema: Int
    let scope: String
    let ownerAdmin: Bool
    let receiverId: String?
    let storageEngine: String
    let storageFormat: String
    let machineNotes: [GDMachineNoteMetadata]
    let receiversScanned: Int?
    let nextCursor: String?

    func validate(allAccounts: Bool, receiverID: String) throws {
        let hex32 = "^[a-f0-9]{32}$", hex64 = "^[a-f0-9]{64}$"
        guard schema == 1, scope == (allAccounts ? "all" : "own"), storageEngine == "redx",
              storageFormat == "redsecretsxai-png-v1", machineNotes.count <= 800,
              allAccounts ? ownerAdmin : receiverId == receiverID else {
            throw GDTransferError(message: "MachineNotes inventory failed validation.", status: 0)
        }
        if let nextCursor {
            guard allAccounts, nextCursor.range(of: "^[0-9]{1,16}$", options: .regularExpression) != nil,
                  let cursor = UInt64(nextCursor), cursor <= 0x000F_FFFF_FFFF_FFFF else {
                throw GDTransferError(message: "MachineNotes returned an invalid page cursor.", status: 0)
            }
        }
        if allAccounts {
            guard let receiversScanned, (0...20).contains(receiversScanned) else {
                throw GDTransferError(message: "MachineNotes returned an invalid account page.", status: 0)
            }
        }
        var seen = Set<String>()
        for note in machineNotes {
            guard note.id.range(of: hex32, options: .regularExpression) != nil,
                  note.receiverId.range(of: hex64, options: .regularExpression) != nil,
                  allAccounts || note.receiverId == receiverID,
                  seen.insert(note.inventoryID).inserted,
                  !note.name.isEmpty, note.name.count <= 80, note.status.count <= 80,
                  note.quotaBytes >= 0, note.usedBytes >= 0, (0...24).contains(note.workers),
                  note.createdMs >= 0, note.entitlementsCheckedMs >= 0,
                  note.libraryItemCount >= 0, note.libraryItems.count <= 50,
                  note.libraryItems.count <= note.libraryItemCount,
                  note.libraryItems.allSatisfy({ $0.name.count <= 255 && $0.archiveBytes >= 0 && $0.generation >= 0 && $0.updatedMs >= 0 }) else {
                throw GDTransferError(message: "MachineNotes returned invalid item metadata.", status: 0)
            }
        }
    }
}

@MainActor
struct GDMachineNotesInventoryPanel: View {
    @ObservedObject private var redX = GDRedXAIAuthSession.shared
    @State private var ownNotes: [GDMachineNoteMetadata] = []
    @State private var accountNotes: [GDMachineNoteMetadata] = []
    @State private var ownerAdmin = false
    @State private var viewingAll = false
    @State private var nextCursor: String?
    @State private var busy = false
    @State private var status = "Loading MachineNotes…"

    private var visibleNotes: [GDMachineNoteMetadata] { viewingAll ? accountNotes : ownNotes }

    private func bytes(_ value: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: value, countStyle: .file)
    }

    private func clear() {
        ownNotes = []; accountNotes = []; ownerAdmin = false
        viewingAll = false; nextCursor = nil
    }

    private func loadOwn() async {
        guard redX.linked else { clear(); status = "Connect Red-XAI to view your MachineNotes."; return }
        busy = true
        defer { busy = false }
        do {
            let page = try await redX.machineNotesInventory()
            try Task.checkCancellation()
            ownNotes = page.machineNotes
            ownerAdmin = page.ownerAdmin
            viewingAll = false; accountNotes = []; nextCursor = nil
            status = page.machineNotes.isEmpty ? "Your MachineNotes will appear here after creation." : "\(page.machineNotes.count) MachineNote(s) in your account."
        } catch {
            clear()
            status = error.localizedDescription
        }
    }

    private func loadAll(append: Bool = false) async {
        guard ownerAdmin, redX.linked, !busy else { return }
        if append && nextCursor == nil { return }
        busy = true
        defer { busy = false }
        let requestedCursor = append ? nextCursor : nil
        do {
            let page = try await redX.machineNotesInventory(allAccounts: true, cursor: requestedCursor)
            try Task.checkCancellation()
            if let requestedCursor, let next = page.nextCursor,
               let before = UInt64(requestedCursor), let after = UInt64(next), after <= before {
                throw GDTransferError(message: "MachineNotes returned a repeated page. Refresh the inventory.", status: 0)
            }
            let combined = (append ? accountNotes : []) + page.machineNotes
            var seen = Set<String>()
            accountNotes = combined.filter { seen.insert($0.inventoryID).inserted }
            ownerAdmin = page.ownerAdmin; viewingAll = true; nextCursor = page.nextCursor
            status = "\(accountNotes.count) MachineNote(s) loaded across accounts." + (nextCursor == nil ? "" : " More accounts are available.")
        } catch {
            // Clear another account's metadata immediately if the identity or
            // owner permission can no longer be verified.
            accountNotes = []; viewingAll = false; nextCursor = nil; ownerAdmin = false
            status = error.localizedDescription
        }
    }

    private func noteRow(_ note: GDMachineNoteMetadata) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top) {
                Image(systemName: "externaldrive.badge.icloud")
                    .foregroundStyle(note.active ? Color.green : Color.orange)
                    .font(.title3)
                VStack(alignment: .leading, spacing: 3) {
                    Text(note.name).font(.headline)
                    Text(note.status.replacingOccurrences(of: "_", with: " ").capitalized)
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text(note.active && !note.readOnly ? "Active" : "Read only")
                    .font(.caption.bold())
                    .foregroundStyle(note.active && !note.readOnly ? Color.green : Color.orange)
            }
            Text("\(bytes(note.usedBytes)) used · \(bytes(note.quotaBytes)) storage · \(note.workers) worker(s)")
                .font(.caption.monospaced()).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Text(note.storageTier ?? "Storage plan required")
                Text((note.performanceTier ?? "No performance plan").capitalized)
                if note.feeWaived {
                    Text("MachineNote fee included")
                } else if let fee = note.workspaceMonthlyCents {
                    Text((Double(fee) / 100).formatted(.currency(code: "USD")) + "/month MachineNote")
                }
            }.font(.caption).foregroundStyle(.secondary)
            if viewingAll {
                Text("Account Receiver: " + note.receiverId)
                    .font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            if note.entitlementsCheckedMs > 0 {
                Text("Plan status checked " + Date(timeIntervalSince1970: Double(note.entitlementsCheckedMs) / 1000)
                    .formatted(date: .abbreviated, time: .shortened))
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if note.libraryItemCount > 0 {
                DisclosureGroup("Stored item metadata (\(note.libraryItemCount))") {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(note.libraryItems.enumerated()), id: \.offset) { _, item in
                            HStack {
                                Text(item.name).lineLimit(1).help(item.name)
                                Spacer()
                                Text(bytes(item.archiveBytes)).foregroundStyle(.secondary)
                            }.font(.caption)
                        }
                        if note.libraryItemsTruncated {
                            Text("Showing the first \(note.libraryItems.count) stored items.").font(.caption2).foregroundStyle(.secondary)
                        }
                    }.padding(.top, 6)
                }.font(.caption)
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(viewingAll ? "All account MachineNotes" : "My MachineNotes").font(.headline)
                    Text("Storage usage, plan status and stored item metadata.").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Button("Refresh") { Task { await loadOwn() } }.disabled(busy || !redX.linked)
            }
            if ownerAdmin {
                HStack(spacing: 10) {
                    Label("Owner inventory", systemImage: "person.crop.rectangle.stack").font(.caption.bold()).foregroundStyle(gdPurple)
                    Spacer()
                    if viewingAll {
                        Button("My MachineNotes") { viewingAll = false }.disabled(busy)
                    }
                    Button(viewingAll ? "Reload all accounts" : "View all accounts") { Task { await loadAll() } }
                        .buttonStyle(.bordered).disabled(busy)
                }
            }
            Text(status).font(.caption).foregroundStyle(.secondary)
            ForEach(visibleNotes, id: \.inventoryID) { note in noteRow(note) }
            if viewingAll, nextCursor != nil {
                Button("Load more accounts") { Task { await loadAll(append: true) } }
                    .buttonStyle(.bordered).disabled(busy)
            }
        }
        .task(id: "\(redX.linked)-\(redX.subject)") { await loadOwn() }
    }
}
