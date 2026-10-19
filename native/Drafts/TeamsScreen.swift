// DRAFT. NOT COMPILED. NOT IN THE MAC BUILD.
// Written on Linux without Xcode or a Swift toolchain (Josh's Mac was not reachable).
// build_macos.py only compiles native/Sources/*.swift, so this file can't break the build.
// Before using it: move it to native/Sources/, compile, fix whatever the compiler finds,
// and add it to the sidebar in GenDragoonApp.swift. API contract: Backend/docs/API-teams.md.
//
// Scope: list teams, open one, chat (polls GET /v2/teams/:id/chat?after=seq every 3 s),
// send text, members with colors, set my name. Create, join, moderation, roles and
// workspace cards stay in the desktop/web app for now. Team workspace files need no new
// code here: GDTransferClient.list/upload/download take the team workspace id
// (/v3/cloud/<id>) and the server enforces the team role.

import SwiftUI
import Foundation

struct GDTeamMember: Decodable, Identifiable, Hashable {
    let memberId: String
    let displayName: String
    let color: String?
    let colorHex: String?
    let role: String
    var id: String { memberId }
}

struct GDTeam: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let memberCount: Int
    let memberLimit: Int
    let subscriptionActive: Bool
    let role: String
    let me: GDTeamMember
    let members: [GDTeamMember]?
}

struct GDTeamMessage: Decodable, Identifiable, Hashable {
    let seq: Int
    let displayName: String
    let colorHex: String?
    let kind: String
    let text: String
    let mine: Bool
    var id: Int { seq }
}

private struct GDTeamList: Decodable { let teams: [GDTeam] }
private struct GDTeamView: Decodable { let team: GDTeam }
private struct GDTeamChat: Decodable { let messages: [GDTeamMessage] }
private struct GDTeamPost: Decodable { let message: GDTeamMessage }

@MainActor
final class GDTeamsModel: ObservableObject {
    @Published var teams: [GDTeam] = []
    @Published var team: GDTeam?
    @Published var messages: [GDTeamMessage] = []
    @Published var error: String?
    private let client: GDTransferClient
    private var poll: Task<Void, Never>?

    init(client: GDTransferClient) { self.client = client }

    /// Default chat name: the Mac's own name (System Settings > General > Sharing).
    static var deviceName: String {
        let name = (Host.current().localizedName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "Member" : String(name.prefix(40))
    }

    func load() async {
        do { teams = try JSONDecoder().decode(GDTeamList.self, from: try await client.jsonData("v2/teams")).teams }
        catch { self.error = error.localizedDescription }
    }

    func open(_ id: String) async {
        poll?.cancel()
        do {
            team = try JSONDecoder().decode(GDTeamView.self, from: try await client.jsonData("v2/teams/" + id)).team
            messages = try JSONDecoder().decode(GDTeamChat.self, from: try await client.jsonData("v2/teams/" + id + "/chat")).messages
            poll = Task { [weak self] in await self?.follow(id) }
        } catch { self.error = error.localizedDescription }
    }

    private func follow(_ id: String) async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            let after = messages.last?.seq ?? 0
            guard let data = try? await client.jsonData("v2/teams/" + id + "/chat", query: [URLQueryItem(name: "after", value: String(after))]),
                  let page = try? JSONDecoder().decode(GDTeamChat.self, from: data) else { continue }
            merge(page.messages)
        }
    }

    private func merge(_ incoming: [GDTeamMessage]) {
        var bySeq = Dictionary(uniqueKeysWithValues: messages.map { ($0.seq, $0) })
        for m in incoming { bySeq[m.seq] = m }
        messages = bySeq.values.sorted { $0.seq < $1.seq }
    }

    func send(_ text: String) async {
        guard let team, !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        do {
            let body = try JSONSerialization.data(withJSONObject: ["text": text])
            let posted = try JSONDecoder().decode(GDTeamPost.self, from: try await client.jsonData("v2/teams/" + team.id + "/chat", method: "POST", payload: body))
            merge([posted.message])
        } catch { self.error = error.localizedDescription }
    }

    func rename(_ name: String) async {
        guard let team else { return }
        do {
            let body = try JSONSerialization.data(withJSONObject: ["displayName": name])
            _ = try await client.jsonData("v2/teams/" + team.id + "/me", method: "PATCH", payload: body)
            await open(team.id)
        } catch { self.error = error.localizedDescription }
    }

    func close() { poll?.cancel(); team = nil; messages = [] }
}

private func swatch(_ hex: String?) -> Color {
    guard let hex, hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16) else { return .purple }
    return Color(red: Double((value >> 16) & 0xff) / 255, green: Double((value >> 8) & 0xff) / 255, blue: Double(value & 0xff) / 255)
}

struct GDTeamsScreen: View {
    @StateObject var model: GDTeamsModel
    @State private var draft = ""
    @State private var name = ""

    var body: some View {
        Group {
            if let team = model.team {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Button("All teams") { model.close() }
                        Text(team.name).font(.title2.bold())
                        Spacer()
                        Text("\(team.memberCount)/\(team.memberLimit) members").foregroundStyle(.secondary)
                    }
                    HSplitView {
                        ScrollViewReader { proxy in
                            List(model.messages) { m in
                                HStack(alignment: .top) {
                                    Circle().fill(swatch(m.colorHex)).frame(width: 8, height: 8).padding(.top, 6)
                                    VStack(alignment: .leading) {
                                        Text(m.displayName).font(.caption.bold()).foregroundStyle(swatch(m.colorHex))
                                        Text(m.kind == "removed" ? "Message removed" : m.text).foregroundStyle(m.kind == "removed" ? .secondary : .primary)
                                    }
                                }.id(m.seq)
                            }
                            .onChange(of: model.messages.count) { _ in if let last = model.messages.last { proxy.scrollTo(last.seq) } }
                        }
                        List {
                            Section("You") {
                                TextField("Name in chat", text: $name).onSubmit { Task { await model.rename(name) } }
                            }
                            Section("Members") {
                                ForEach(team.members ?? []) { m in
                                    HStack { Circle().fill(swatch(m.colorHex)).frame(width: 10, height: 10); Text(m.displayName); Spacer()
                                        Text(m.role.capitalized).foregroundStyle(.secondary) }
                                }
                            }
                        }.frame(minWidth: 200, maxWidth: 260)
                    }
                    HStack {
                        TextField(team.subscriptionActive ? "Message" : "Team subscription needed", text: $draft)
                            .disabled(!team.subscriptionActive)
                            .onSubmit { let t = draft; draft = ""; Task { await model.send(t) } }
                        Button("Send") { let t = draft; draft = ""; Task { await model.send(t) } }.disabled(draft.isEmpty || !team.subscriptionActive)
                    }
                }
                .onAppear { name = team.me.displayName }
            } else {
                List(model.teams) { t in
                    Button { Task { await model.open(t.id) } } label: {
                        HStack { Text(t.name).bold(); Spacer(); Text(t.role.capitalized).foregroundStyle(.secondary) }
                    }.buttonStyle(.plain)
                }
                .overlay { if model.teams.isEmpty { Text("No teams yet. Create or join one in the GenDragoon app.").foregroundStyle(.secondary) } }
            }
        }
        .padding()
        .task { await model.load() }
        .alert("Teams", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(model.error ?? "") }
    }
}
