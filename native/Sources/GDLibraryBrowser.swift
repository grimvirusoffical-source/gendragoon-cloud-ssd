import AppKit
import SwiftUI

private struct GDLibraryClipboard: Codable {
    let destination: String
    let keys: [String]
    let cut: Bool
    static let type = NSPasteboard.PasteboardType("app.gendragoon.library-items.v1")
}

private enum GDLibraryAction { case open, download, rename, delete, copy, cut, paste, newFolder, upload, evict, refresh }

/// A native outline keeps desktop selection, disclosure triangles, keyboard
/// navigation and drag feedback consistent while the backing snapshot changes.
private final class GDLibraryNode: NSObject {
    let item: StoredApp
    var children: [GDLibraryNode] = []
    init(_ item: StoredApp) { self.item = item }
}

private final class GDLibraryOutlineView: NSOutlineView {
    var actionHandler: ((GDLibraryAction) -> Void)?
    var menuHandler: ((NSEvent) -> NSMenu?)?
    override func menu(for event: NSEvent) -> NSMenu? { menuHandler?(event) }
    override func keyDown(with event: NSEvent) {
        let command = event.modifierFlags.contains(.command)
        if command {
            switch event.charactersIgnoringModifiers?.lowercased() {
            case "c": actionHandler?(.copy); return
            case "x": actionHandler?(.cut); return
            case "v": actionHandler?(.paste); return
            case "n" where event.modifierFlags.contains(.shift): actionHandler?(.newFolder); return
            case "o": actionHandler?(.open); return
            default: break
            }
        }
        if event.keyCode == 51 || event.keyCode == 117 { actionHandler?(.delete); return }
        if event.keyCode == 36 { actionHandler?(.rename); return }
        super.keyDown(with: event)
    }
}

private struct GDLibraryOutline: NSViewRepresentable {
    let items: [StoredApp]
    let destination: String
    let canEdit: Bool
    let busy: Bool
    @Binding var selection: Set<String>
    let action: (GDLibraryAction, [String], String?) -> Void
    let droppedFiles: ([URL], String?) -> Void
    let movedItems: ([String], String?, Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = true
        scroll.borderType = .noBorder; scroll.drawsBackground = false
        let outline = GDLibraryOutlineView()
        outline.backgroundColor = .clear
        outline.allowsMultipleSelection = true
        outline.allowsEmptySelection = true
        outline.rowSizeStyle = .medium; outline.rowHeight = 36
        outline.autoresizesOutlineColumn = true
        outline.columnAutoresizingStyle = .firstColumnOnlyAutoresizingStyle
        outline.indentationPerLevel = 20
        let name = NSTableColumn(identifier: .init("name"))
        name.title = "Name"; name.width = 430; name.minWidth = 190
        let kind = NSTableColumn(identifier: .init("kind"))
        kind.title = "Kind"; kind.width = 140; kind.minWidth = 90
        let device = NSTableColumn(identifier: .init("device"))
        device.title = "Uploaded from"; device.width = 170; device.minWidth = 120
        outline.addTableColumn(name); outline.addTableColumn(kind); outline.addTableColumn(device); outline.outlineTableColumn = name
        outline.delegate = context.coordinator; outline.dataSource = context.coordinator
        outline.target = context.coordinator; outline.doubleAction = #selector(Coordinator.doubleClick(_:))
        outline.registerForDraggedTypes([GDLibraryClipboard.type, .fileURL])
        outline.setDraggingSourceOperationMask([.copy, .move], forLocal: true)
        outline.actionHandler = { [weak coordinator = context.coordinator] action in coordinator?.perform(action) }
        outline.menuHandler = { [weak coordinator = context.coordinator] event in coordinator?.menu(event) }
        scroll.documentView = outline; context.coordinator.outline = outline
        context.coordinator.rebuild(items)
        return scroll
    }
    func updateNSView(_ view: NSScrollView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.rebuild(items)
    }
    final class Coordinator: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate {
        var parent: GDLibraryOutline
        weak var outline: GDLibraryOutlineView?
        var roots: [GDLibraryNode] = []
        var nodes: [String: GDLibraryNode] = [:]
        var signature = ""
        var rebuilding = false
        init(_ parent: GDLibraryOutline) { self.parent = parent }
        func rebuild(_ items: [StoredApp]) {
            guard let outline else { return }
            let next = parent.destination + "|" + items.map { "\($0.key):\($0.label):\($0.parentKey ?? ""): \($0.kind ?? ""): \($0.deviceLabel): \($0.applicationPlatformCode ?? "")" }.joined(separator: "|")
            if signature != next {
                let expanded = Set(nodes.values.filter { outline.isItemExpanded($0) }.map { $0.item.key })
                rebuilding = true
                nodes = Dictionary(items.map { ($0.key, GDLibraryNode($0)) }, uniquingKeysWith: { first, _ in first })
                roots = []
                for node in nodes.values {
                    var ancestor = node.item.parentKey, visited = Set([node.item.key]), valid = true
                    while let key = ancestor {
                        if !visited.insert(key).inserted || visited.count > 128 { valid = false; break }
                        ancestor = nodes[key]?.item.parentKey
                    }
                    if valid, let key = node.item.parentKey, let folder = nodes[key], folder.item.isFolder {
                        folder.children.append(node)
                    } else { roots.append(node) }
                }
                func sorted(_ values: [GDLibraryNode]) -> [GDLibraryNode] {
                    values.sorted { a, b in
                        if a.item.isFolder != b.item.isFolder { return a.item.isFolder }
                        let order = a.item.label.localizedStandardCompare(b.item.label)
                        return order == .orderedSame ? a.item.key < b.item.key : order == .orderedAscending
                    }
                }
                roots = sorted(roots)
                for node in nodes.values { node.children = sorted(node.children) }
                outline.reloadData()
                for key in expanded { if let node = nodes[key] { outline.expandItem(node) } }
                signature = next; rebuilding = false
            }
            rebuilding = true
            var indexes = IndexSet()
            for key in parent.selection { if let node = nodes[key] { let row = outline.row(forItem: node); if row >= 0 { indexes.insert(row) } } }
            if outline.selectedRowIndexes != indexes { outline.selectRowIndexes(indexes, byExtendingSelection: false) }
            rebuilding = false
        }
        func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int { (item as? GDLibraryNode)?.children.count ?? roots.count }
        func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any { ((item as? GDLibraryNode)?.children ?? roots)[index] }
        func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool { (item as? GDLibraryNode)?.children.isEmpty == false }
        func outlineViewSelectionDidChange(_ notification: Notification) {
            guard !rebuilding, let outline else { return }
            parent.selection = Set(outline.selectedRowIndexes.compactMap { (outline.item(atRow: $0) as? GDLibraryNode)?.item.key })
        }
        func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
            guard let node = item as? GDLibraryNode else { return nil }
            let text: String
            if tableColumn?.identifier.rawValue == "device" {
                let field = NSTextField(labelWithString: node.item.deviceLabel)
                field.textColor = .secondaryLabelColor; field.font = .systemFont(ofSize: 11); return field
            }
            if tableColumn?.identifier.rawValue == "kind" {
                text = node.item.isVirtualFolder ? "Folder" : node.item.applicationPlatformCode.map { GDApplicationPlatform.label($0) + " app backup" } ?? (node.item.isFolder ? "Folder backup" : "File")
                let field = NSTextField(labelWithString: text); field.textColor = .secondaryLabelColor
                field.font = .systemFont(ofSize: 11); return field
            }
            let stack = NSStackView()
            stack.orientation = .horizontal; stack.spacing = 9
            let image = NSImageView(image: NSImage(systemSymbolName: node.item.isFolder ? "folder.fill" : node.item.kind == "app" ? "app.fill" : "doc.fill", accessibilityDescription: nil) ?? NSImage())
            image.contentTintColor = .systemPurple
            image.widthAnchor.constraint(equalToConstant: 21).isActive = true
            let name = NSTextField(labelWithString: node.item.label)
            name.lineBreakMode = .byTruncatingMiddle; name.font = .systemFont(ofSize: 13)
            stack.addArrangedSubview(image); stack.addArrangedSubview(name)
            return stack
        }
        var keys: [String] { parent.selection.sorted() }
        var target: String? {
            guard keys.count == 1, let item = nodes[keys[0]]?.item else { return nil }
            return item.isVirtualFolder ? item.key : item.parentKey
        }
        func perform(_ action: GDLibraryAction) { parent.action(action, keys, target) }
        @objc func doubleClick(_ sender: Any?) {
            guard let outline, outline.clickedRow >= 0, let node = outline.item(atRow: outline.clickedRow) as? GDLibraryNode else { return }
            if !node.children.isEmpty { if outline.isItemExpanded(node) { outline.collapseItem(node) } else { outline.expandItem(node) }; return }
            parent.action(.open, [node.item.key], node.item.isVirtualFolder ? node.item.key : node.item.parentKey)
        }
        func menu(_ event: NSEvent) -> NSMenu? {
            guard let outline else { return nil }
            let row = outline.row(at: outline.convert(event.locationInWindow, from: nil))
            if row >= 0, !outline.selectedRowIndexes.contains(row) { outline.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false) }
            if row < 0 { outline.deselectAll(nil) }
            let menu = NSMenu()
            func add(_ title: String, _ action: GDLibraryAction, enabled: Bool = true) {
                let item = NSMenuItem(title: title, action: #selector(menuAction(_:)), keyEquivalent: "")
                item.target = self; item.representedObject = GDMenuActionBox(action); item.isEnabled = enabled
                menu.addItem(item)
            }
            menu.autoenablesItems = false
            let one = keys.count == 1, selected = !keys.isEmpty, editable = parent.canEdit && !parent.busy
            let compatible = keys.allSatisfy { nodes[$0]?.item.canRestoreOnMac == true }
            add("Open", .open, enabled: one && compatible && !parent.busy)
            add("Download", .download, enabled: selected && compatible && !parent.busy)
            menu.addItem(.separator())
            add("Cut", .cut, enabled: selected && editable); add("Copy", .copy, enabled: selected)
            add("Paste", .paste, enabled: editable); add("Rename…", .rename, enabled: one && editable)
            add("Delete…", .delete, enabled: selected && editable)
            menu.addItem(.separator())
            add("New Folder…", .newFolder, enabled: editable)
            add("Select Apps, Files or Folders to Upload…", .upload, enabled: editable)
            add("Clear Managed Local Cache", .evict, enabled: selected && !parent.busy)
            add("Refresh", .refresh, enabled: !parent.busy)
            return menu
        }
        @objc func menuAction(_ sender: NSMenuItem) { if let box = sender.representedObject as? GDMenuActionBox { perform(box.action) } }
        func outlineView(_ outlineView: NSOutlineView, pasteboardWriterForItem item: Any) -> NSPasteboardWriting? {
            guard !parent.busy, parent.canEdit, let node = item as? GDLibraryNode else { return nil }
            let selected = parent.selection.contains(node.item.key) ? keys : [node.item.key]
            let value = GDLibraryClipboard(destination: parent.destination, keys: selected, cut: true)
            guard let data = try? JSONEncoder().encode(value) else { return nil }
            let pasteboard = NSPasteboardItem(); pasteboard.setData(data, forType: GDLibraryClipboard.type); return pasteboard
        }
        func dropTarget(_ item: Any?, _ index: Int) -> (Bool, String?) {
            guard let item else { return (true, nil) }
            guard let node = item as? GDLibraryNode, node.item.isVirtualFolder else { return (false, nil) }
            return (true, node.item.key)
        }
        func outlineView(_ outlineView: NSOutlineView, validateDrop info: NSDraggingInfo, proposedItem item: Any?, proposedChildIndex index: Int) -> NSDragOperation {
            guard parent.canEdit, !parent.busy, dropTarget(item, index).0 else { return [] }
            let board = info.draggingPasteboard
            if let data = board.data(forType: GDLibraryClipboard.type), let value = try? JSONDecoder().decode(GDLibraryClipboard.self, from: data) {
                guard value.destination == parent.destination, !value.keys.isEmpty else { return [] }
                let target = dropTarget(item, index).1
                // Include ancestry checks here for immediate feedback; the server
                // repeats them against its locked, current revision.
                for key in value.keys {
                    var next = target, seen = Set<String>()
                    while let current = next {
                        if current == key || !seen.insert(current).inserted { return [] }
                        next = nodes[current]?.item.parentKey
                    }
                }
                return NSApp.currentEvent?.modifierFlags.contains(.option) == true ? .copy : .move
            }
            return board.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) ? .copy : []
        }
        func outlineView(_ outlineView: NSOutlineView, acceptDrop info: NSDraggingInfo, item: Any?, childIndex index: Int) -> Bool {
            guard parent.canEdit, !parent.busy else { return false }
            let (valid, target) = dropTarget(item, index); guard valid else { return false }
            let board = info.draggingPasteboard
            if let data = board.data(forType: GDLibraryClipboard.type), let value = try? JSONDecoder().decode(GDLibraryClipboard.self, from: data), value.destination == parent.destination {
                parent.movedItems(Array(Set(value.keys)), target, NSApp.currentEvent?.modifierFlags.contains(.option) == true); return true
            }
            let urls = (board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []).filter(\.isFileURL)
            guard !urls.isEmpty else { return false }; parent.droppedFiles(urls, target); return true
        }
    }
}
private final class GDMenuActionBox: NSObject {
    let action: GDLibraryAction
    init(_ action: GDLibraryAction) { self.action = action }
}

@MainActor struct GDNativeLibrarySection: View {
    @ObservedObject var library: LibraryModel
    let destinationLabel: String
    let content: GDProjectContent
    let upload: UploadWorkspaceModel
    let externalBusy: Bool
    let showUpload: () -> Void
    @ObservedObject private var activity = GDUpdateActivity.shared
    @State private var search = ""
    @State private var platformFilter = "all"
    @State private var selection = Set<String>()
    @State private var editingName = ""
    @State private var editingKey: String?
    @State private var parentForNewFolder: String?
    @State private var showName = false
    @State private var deleting = false
    @State private var deleteKeys: [String] = []
    @State private var deleteNames: [String] = []
    @State private var pendingDestination = ""
    private var busy: Bool { library.busy || !GDUpdateActivity.shared.canStart(excluding: library) }
    private var selectedItems: [StoredApp] { library.apps.filter { selection.contains($0.key) } }
    private var targetFolder: String? {
        guard selectedItems.count == 1, let item = selectedItems.first else { return nil }
        return item.isVirtualFolder ? item.key : item.parentKey
    }
    private var visibleItems: [StoredApp] {
        let all = Dictionary(library.apps.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        var keys = Set(library.apps.filter { item in
            if item.isVirtualFolder && search.isEmpty { return true }
            let platform = content == .applications ? item.applicationPlatformCode ?? "unknown" : item.origin?.platformCode ?? "unknown"
            return (platformFilter == "all" || platform == platformFilter)
                && (search.isEmpty || item.label.localizedCaseInsensitiveContains(search))
        }.map(\.key))
        for key in Array(keys) {
            var parent = all[key]?.parentKey, visited = Set<String>()
            while let key = parent, visited.insert(key).inserted { keys.insert(key); parent = all[key]?.parentKey }
        }
        return library.apps.filter { keys.contains($0.key) }
    }
    private func writeClipboard(keys: [String], cut: Bool) {
        guard !keys.isEmpty, let data = try? JSONEncoder().encode(GDLibraryClipboard(destination: library.destinationIdentity, keys: keys, cut: cut)) else { return }
        let board = NSPasteboard.general; board.clearContents(); board.setData(data, forType: GDLibraryClipboard.type)
        library.message = "\(keys.count) item(s) ready to \(cut ? "move" : "copy"). Select a destination folder and Paste."
    }
    private func paste(into parent: String?) {
        guard !busy, library.canOrganize else { return }
        let board = NSPasteboard.general
        if let data = board.data(forType: GDLibraryClipboard.type), let value = try? JSONDecoder().decode(GDLibraryClipboard.self, from: data) {
            guard value.destination == library.destinationIdentity else { library.message = "Copy and move currently stay inside the same MachineNote. Select its destination again."; return }
            library.organize(value.cut ? "move" : "copy", keys: value.keys, parentKey: parent) { ok in
                if ok && value.cut && NSPasteboard.general.data(forType: GDLibraryClipboard.type) == data { NSPasteboard.general.clearContents() }
            }
        } else {
            let urls = (board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []).filter(\.isFileURL)
            if urls.isEmpty { library.message = "Copy cloud items or local files in Finder before choosing Paste." }
            else { addFiles(urls, parent: parent) }
        }
    }
    private func addFiles(_ urls: [URL], parent: String?) {
        upload.addDroppedURLs(urls, content: nil, externalBusy: externalBusy, parentKey: parent)
        showUpload()
    }
    private func perform(_ action: GDLibraryAction, keys: [String], target: String?) {
        if [.cut, .paste, .rename, .delete, .newFolder, .upload].contains(action), busy || !library.canOrganize { return }
        let items = library.apps.filter { keys.contains($0.key) }
        switch action {
        case .refresh: library.loadApps()
        case .copy: writeClipboard(keys: keys, cut: false)
        case .cut: if library.canOrganize && !busy { writeClipboard(keys: keys, cut: true) }
        case .paste: paste(into: target)
        case .upload:
            upload.setUploadTarget(parentKey: target, displayName: library.apps.first { $0.key == target }?.label)
            showUpload(); upload.chooseSources(startingAt: nil, externalBusy: externalBusy, content: nil)
        case .newFolder:
            pendingDestination = library.destinationIdentity
            parentForNewFolder = target; editingKey = nil; editingName = "New Folder"; showName = true
        case .rename:
            if let item = items.first, items.count == 1 { pendingDestination = library.destinationIdentity; editingKey = item.key; editingName = item.label; showName = true }
        case .delete:
            guard !items.isEmpty else { return }
            pendingDestination = library.destinationIdentity
            deleteKeys = items.map(\.key); deleteNames = items.map(\.label); deleting = true
        case .open:
            if let item = items.first, !busy {
                if item.kind == "app" { library.smartLaunch(item) } else { library.launch(item) }
            }
        case .download:
            if !busy { library.performOnItems("restore", items: items) }
        case .evict:
            if !busy { library.performOnItems("evict", items: items) }
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ViewThatFits(in: .horizontal) {
                HStack {
                    TextField("Find apps, files or folders…", text: $search).textFieldStyle(.roundedBorder).frame(minWidth: 180)
                    toolbar
                }
                VStack(alignment: .leading) { TextField("Find apps, files or folders…", text: $search).textFieldStyle(.roundedBorder); toolbar }
            }
            HStack {
                Picker(content == .applications ? "Application platform" : "Upload device", selection: $platformFilter) {
                    Text("All device types").tag("all")
                    ForEach(GDApplicationPlatform.codes, id: \.self) { Text(GDApplicationPlatform.label($0)).tag($0) }
                }.frame(maxWidth: 280)
                Label(targetFolder.flatMap { key in library.apps.first { $0.key == key }?.label } ?? "MachineNote root", systemImage: "folder")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text("\(library.apps.count) items · \(selection.count) selected").font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            GDLibraryOutline(items: visibleItems, destination: library.destinationIdentity, canEdit: library.canOrganize,
                busy: busy, selection: $selection,
                action: perform,
                droppedFiles: { urls, target in addFiles(urls, parent: target) },
                movedItems: { keys, target, copy in library.organize(copy ? "copy" : "move", keys: keys, parentKey: target) })
                .frame(minHeight: 300, idealHeight: 400, maxHeight: 650)
                .background(.black.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                .overlay { if library.apps.isEmpty { Text(library.busy ? "Loading MachineNote…" : "Select apps, files or folders above, then click Upload. You can also drop them here.").font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).padding().allowsHitTesting(false) } }
            if !library.canOrganize && library.hasDestination && !library.busy {
                Text("Library changes require active upload access and a refreshed MachineNote. Existing backups remain available to download.").font(.caption).foregroundStyle(.secondary)
            }
            if content == .applications { Toggle("Remove managed application cache after the app exits", isOn: $library.cleanupAfterExit).font(.caption) }
            Text("Drag items onto folders to move them; hold Option to copy. Right-click for actions. Folder backups retain their complete archived contents; library folders organize backups.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Text("Applications and installers are separated by platform within this MachineNote. Upload-device labels are reported by the uploading client; older backups show an unknown device. Restore applications on their original platform. Ordinary documents remain available across devices.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if library.busy { ProgressView().controlSize(.small) }
            Label(library.message, systemImage: "info.circle").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
        }
        .onAppear { if content == .applications { platformFilter = "macos" } }
        .onChange(of: platformFilter) { _, _ in selection = [] }
        .onChange(of: library.destinationIdentity) { _, _ in selection = []; upload.setUploadTarget(parentKey: nil) }
        .onChange(of: search) { _, _ in selection = [] }
        .onChange(of: library.apps.map(\.key)) { _, keys in selection.formIntersection(Set(keys)) }
        .onChange(of: selection) { _, _ in upload.setUploadTarget(parentKey: targetFolder, displayName: library.apps.first { $0.key == targetFolder }?.label) }
        .sheet(isPresented: $showName) {
            VStack(alignment: .leading, spacing: 16) {
                Text(editingKey == nil ? "New Folder" : "Rename").font(.title2.bold())
                TextField("Name", text: $editingName).textFieldStyle(.roundedBorder).onSubmit { saveName() }
                Text("Names must be unique inside this folder. Existing files are never silently replaced.").font(.caption).foregroundStyle(.secondary)
                HStack { Spacer(); Button("Cancel") { showName = false }; Button("Save") { saveName() }.keyboardShortcut(.defaultAction).disabled(editingName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy) }
            }.padding(24).frame(width: 430)
        }
        .confirmationDialog("Delete \(deleteKeys.count) cloud item(s)?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete Cloud Items", role: .destructive) {
                guard pendingDestination == library.destinationIdentity else { library.message = "The MachineNote changed. Select the items again before deleting."; return }
                library.organize("delete", keys: deleteKeys) { ok in if ok { selection.subtract(deleteKeys) } }
            }
            Button("Cancel", role: .cancel) { }
        } message: { Text(deleteNames.prefix(5).joined(separator: ", ") + (deleteNames.count > 5 ? " and \(deleteNames.count - 5) more" : "") + ". The selected entries and nested library folders will be removed. Original files on your Mac remain. Encrypted archive objects are retained for shared-copy safety, so this action does not reclaim storage quota. Download anything you need first.") }
    }
    @ViewBuilder private var toolbar: some View {
        HStack {
            Button { perform(.newFolder, keys: [], target: targetFolder) } label: { Label("New Folder", systemImage: "folder.badge.plus") }.disabled(busy || !library.canOrganize)
            Button { paste(into: targetFolder) } label: { Label("Paste", systemImage: "doc.on.clipboard") }.disabled(busy || !library.canOrganize)
            Button { library.loadApps() } label: { Label("Refresh", systemImage: "arrow.clockwise") }.disabled(busy || !library.hasDestination)
            Menu { Button("Open") { perform(.open, keys: selection.sorted(), target: targetFolder) }.disabled(selection.count != 1); Button("Download") { perform(.download, keys: selection.sorted(), target: targetFolder) }; Button("Copy") { writeClipboard(keys: selection.sorted(), cut: false) }; Button("Cut") { perform(.cut, keys: selection.sorted(), target: targetFolder) }.disabled(!library.canOrganize); Button("Rename…") { perform(.rename, keys: selection.sorted(), target: targetFolder) }.disabled(!library.canOrganize || selection.count != 1); Button("Delete…", role: .destructive) { perform(.delete, keys: selection.sorted(), target: targetFolder) }.disabled(!library.canOrganize) } label: { Image(systemName: "ellipsis.circle") }.disabled(busy || selection.isEmpty)
        }
    }
    private func saveName() {
        let name = editingName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !busy else { return }
        guard pendingDestination == library.destinationIdentity else { library.message = "The MachineNote changed. Start this action again."; showName = false; return }
        let key = editingKey
        library.organize(key == nil ? "create-folder" : "rename", keys: key.map { [$0] } ?? [], parentKey: key == nil ? parentForNewFolder : nil, name: name) { ok in if ok { showName = false } }
    }
}
