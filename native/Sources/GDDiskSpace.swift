import Foundation
import SwiftUI

@MainActor struct GDDiskSpaceNotice: View {
    @State private var freeBytes: Int64?
    private let reserve: Int64 = 10 * 1024 * 1024 * 1024
    private var low: Bool { freeBytes.map { $0 < reserve } ?? false }
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: low ? "externaldrive.badge.exclamationmark" : "internaldrive")
                .foregroundStyle(low ? Color.orange : Color.secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(freeBytes.map { "Local free space: " + ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) } ?? "Checking local free space…")
                    .font(.caption.weight(.semibold))
                Text("We recommend keeping 10 GB free while using GenDragoon. You can continue below this amount when there is enough space for the selected operation. Originals stay in place until their cloud copy is verified.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(12).background(low ? Color.orange.opacity(0.10) : Color.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
        .task {
            while !Task.isCancelled {
                let attributes = try? FileManager.default.attributesOfFileSystem(forPath: FileManager.default.homeDirectoryForCurrentUser.path)
                freeBytes = (attributes?[.systemFreeSize] as? NSNumber)?.int64Value
                do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
            }
        }
    }
}
