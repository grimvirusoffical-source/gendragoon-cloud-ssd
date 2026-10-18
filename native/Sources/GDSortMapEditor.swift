import SwiftUI

/// Type-to-folder editor. Defaults come from extension-map.json. Overrides are
/// the same upload-categories.json file the upload helper already reads.
struct GDSortMapEditor: View {
    @State private var folders: [String: String] = [:]
    @State private var status = "Folder names are shared by upload sorting and the library."

    private var types: [String] {
        ["pictures", "videos", "audio", "documents", "apps", "archives", "other"]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Sort files into folders", systemImage: "folder.badge.gearshape")
                .font(.system(size: 16, weight: .bold))
            Text("Each file type uses the shared extension map. A folder you save here overrides the default for uploads and the library. Drive cleanup keeps its own Media folders.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            ForEach(types, id: \.self) { type in
                HStack {
                    Text(type.capitalized).frame(width: 110, alignment: .leading)
                    TextField("Folder", text: binding(type))
                        .textFieldStyle(.roundedBorder)
                }
            }
            HStack {
                Button("Save sort folders") { save() }
                    .buttonStyle(.borderedProminent)
                    .tint(.purple)
                Button("Use defaults") { folders = Self.defaults(); save() }
            }
            Text(status).font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .onAppear { folders = Self.merged() }
    }

    private func binding(_ type: String) -> Binding<String> {
        Binding(get: { folders[type] ?? "" }, set: { folders[type] = $0 })
    }

    private func save() {
        do {
            let url = try Self.overrideURL()
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: folders, options: [.sortedKeys, .prettyPrinted])
            try data.write(to: url, options: .atomic)
            status = "Saved. Uploads and the library use these folders."
        } catch {
            status = "The sort folders could not be saved."
        }
    }

    static func defaults() -> [String: String] {
        guard let file = Bundle.main.url(forResource: "extension-map", withExtension: "json"),
              let data = try? Data(contentsOf: file),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let folders = root["uploadFolders"] as? [String: String] else {
            return ["pictures": "Pictures", "videos": "Videos", "audio": "Music/Audio",
                    "documents": "Documents", "apps": "Applications", "other": "Other"]
        }
        return folders
    }

    static func overrideURL() throws -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/GenDragoon Cloud SSD/upload-categories.json")
    }

    static func merged() -> [String: String] {
        var folders = defaults()
        guard let url = try? overrideURL(),
              let data = try? Data(contentsOf: url),
              let saved = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { return folders }
        for (key, value) in saved where folders[key] != nil && !value.isEmpty && !value.hasPrefix("/") && !value.contains("..") {
            folders[key] = value
        }
        return folders
    }
}
