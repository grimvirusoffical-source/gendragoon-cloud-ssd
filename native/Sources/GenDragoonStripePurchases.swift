import SwiftUI
import AppKit
import Foundation
import CryptoKit

private struct GDBillingEndpoint: Decodable { let endpoint: String }
private struct GDBillingStatus: Decodable { let checkoutEnabled: Bool; let stripeMode: String }
private struct GDCheckoutResponse: Decodable { let url: String?; let complimentary: Bool?; let message: String? }
private struct GDWorkspaceDraft: Decodable { let workspaceId: String }
struct GDRemoteWorkspace: Decodable, Identifiable {
    let id: String; let name: String; let kind: String
    let storageActive: Bool; let provisioned: Bool
    let byoActive: Bool?; let manualProviderConfigured: Bool?
    var supportsPerformance: Bool {
        (storageActive && provisioned) || (kind == "byo" && byoActive == true && manualProviderConfigured == true)
    }
}
private struct GDWorkspacesResponse: Decodable { let workspaces: [GDRemoteWorkspace]; let ownerBenefits: Bool? }
struct GDServerBillingCatalog: Decodable {
    struct Storage: Decodable { let gb: Int; let monthlyCents: Int; let yearlyCents: Int; let bundleMonthlyCents: Int; let bundleYearlyCents: Int; let bundleWorkers: Int? }
    struct Performance: Decodable { let workers: Int; let monthlyCents: Int; let yearlyCents: Int }
    struct BYO: Decodable { let monthlyCents: Int; let yearlyCents: Int }
    struct Ads: Decodable { let oneTimeCents: Int }
    let workspaceFeeMonthlyCents: Int
    let storage: [String: Storage]; let performance: [String: Performance]
    let byo: BYO; let removeAds: Ads
}
private struct GDBillingSelection: Codable, Equatable {
    var storageTier = "100GB"
    var performanceTier = "boost"
    var workspaceName = "My Cloud Project"
    var yearly = false
    var workspaceID = ""
    var provider = "s3"
    var remote = ""
    var intentID = UUID().uuidString.lowercased()
}

@MainActor final class GDBillingModel: ObservableObject {
    @Published var ownerBenefits = false
    @Published var ready = false
    @Published var mode = "unconfigured"
    @Published var busy = false { didSet { GDUpdateActivity.shared.set(self, key: "busy", active: busy) } }
    @Published var status = "Loading the current billing catalog…"
    @Published var workspaces: [GDRemoteWorkspace] = []
    @Published var catalog: GDServerBillingCatalog?
    @Published var checkoutPending = false
    private weak var login: GDLoginSession?
    private var accountID = ""
    private var api: URL? {
        guard let file = Bundle.main.url(forResource: "gendragoon_free_api", withExtension: "json"),
              let data = try? Data(contentsOf: file),
              let cfg = try? JSONDecoder().decode(GDBillingEndpoint.self, from: data),
              let url = URL(string: cfg.endpoint), url.scheme == "https",
              url.user == nil, url.password == nil, url.host?.hasSuffix(".run.app") == true else { return nil }
        return url
    }
    private func send(_ path: String, authenticated: Bool = true, method: String = "GET", payload: [String: Any]? = nil) async throws -> Data {
        guard let base = api else { throw GDTransferError(message: "Cloud billing endpoint is missing.", status: 0) }
        let expected = accountID
        for attempt in 0...1 {
            var request = URLRequest(url: base.appendingPathComponent(path))
            request.httpMethod = method; request.timeoutInterval = 30; request.cachePolicy = .reloadIgnoringLocalCacheData
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if authenticated {
                guard let login, !expected.isEmpty, login.userID == expected else { throw GDTransferError(message: "Your account changed. Sign in again.", status: 401) }
                let token = try await login.tokenForTransfer(forceRefresh: attempt == 1)
                guard login.userID == expected else { throw GDTransferError(message: "Your account changed.", status: 401) }
                request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            }
            if let payload {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: payload)
            }
            let (data, response) = try await URLSession.shared.data(for: request)
            if authenticated && login?.userID != expected { throw GDTransferError(message: "Your account changed. Refresh billing.", status: 401) }
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if authenticated && code == 401 && attempt == 0 { continue }
            guard (200...299).contains(code) else {
                let reason = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["error"] as? String
                throw GDTransferError(message: reason ?? "Billing is temporarily unavailable. Please retry.", status: code)
            }
            return data
        }
        throw GDTransferError(message: "Please sign in again.", status: 401)
    }
    private func connect(_ session: GDLoginSession) {
        if accountID != session.userID {
            ownerBenefits = false; workspaces = []; ready = false; checkoutPending = false
        }
        login = session; accountID = session.userID
    }
    private func loadWorkspaces() async throws {
        let result = try JSONDecoder().decode(GDWorkspacesResponse.self, from: await send("v2/workspaces"))
        workspaces = result.workspaces; ownerBenefits = result.ownerBenefits == true
        if ownerBenefits { ready = true; status = "Owner access: plans and ad removal are included at no charge." }
    }
    func refresh(login session: GDLoginSession) {
        guard !busy, !GDUpdateActivity.shared.isMaintenancePending else { return }
        connect(session); busy = true
        Task {
            defer { busy = false }
            do {
                let result = try JSONDecoder().decode(GDBillingStatus.self, from: await send("v2/billing/status", authenticated: false))
                catalog = try JSONDecoder().decode(GDServerBillingCatalog.self, from: await send("v2/pricing", authenticated: false))
                ready = result.checkoutEnabled; mode = result.stripeMode
                status = ready ? (mode == "test" ? "Stripe test checkout is active; no real charges." : "Your selection will open in secure Stripe Checkout.") : "Billing is completing its cloud and payment verification. Your selection is retained."
                if !accountID.isEmpty { try await loadWorkspaces() }
                session.checkAdEntitlement()
            } catch { ready = false; status = error.localizedDescription }
        }
    }
    private func begin(login session: GDLoginSession, _ action: @escaping () async throws -> Void) {
        guard ready, !busy, GDUpdateActivity.shared.canStart(excluding: self) else { status = "Wait for the current operation to finish, then retry."; return }
        connect(session)
        guard !accountID.isEmpty else { status = "Sign in first."; return }
        busy = true; status = "Preparing your selected plan…"
        Task {
            defer { busy = false }
            do { try await action() } catch { status = error.localizedDescription }
        }
    }
    private func openCheckout(_ data: Data) throws {
        let result = try JSONDecoder().decode(GDCheckoutResponse.self, from: data)
        if result.complimentary == true { status = result.message ?? "Included owner access activated."; return }
        guard let raw = result.url, let url = URL(string: raw), url.scheme == "https", url.user == nil, url.password == nil,
              ["checkout.stripe.com", "billing.stripe.com"].contains(url.host ?? "") else {
            throw GDTransferError(message: "The billing service returned an invalid checkout address.", status: 0)
        }
        guard NSWorkspace.shared.open(url) else { throw GDTransferError(message: "Your browser could not open Checkout. Retry to resume this purchase.", status: 0) }
        checkoutPending = true
        status = "Checkout opened. Your selected plan is retained; return here after payment to refresh verified access."
    }
    func buyStorage(login session: GDLoginSession, name: String, tier: String, mode: String, yearly: Bool, intentID: String) {
        begin(login: session) {
            let draft = try JSONDecoder().decode(GDWorkspaceDraft.self, from: await self.send("v2/workspaces/draft", method: "POST", payload: ["name": name, "tier": tier, "mode": mode, "interval": yearly ? "year" : "month", "intentId": intentID]))
            try self.openCheckout(await self.send("v2/workspaces/" + draft.workspaceId + "/checkout/storage", method: "POST"))
            if self.ownerBenefits { try await self.loadWorkspaces() }
        }
    }
    func buyPerformance(login session: GDLoginSession, workspaceID: String, tier: String, yearly: Bool) {
        guard workspaces.contains(where: { $0.id == workspaceID && $0.supportsPerformance }) else { status = "Choose an active managed or BYO workspace first."; return }
        begin(login: session) {
            try self.openCheckout(await self.send("v2/workspaces/" + workspaceID + "/checkout/performance", method: "POST", payload: ["tier": tier, "interval": yearly ? "year" : "month"]))
            if self.ownerBenefits { try await self.loadWorkspaces() }
        }
    }
    func buyRemoveAds(login session: GDLoginSession) {
        begin(login: session) { try self.openCheckout(await self.send("v2/remove-ads/checkout", method: "POST")); session.checkAdEntitlement() }
    }
    func portal(login session: GDLoginSession) {
        begin(login: session) { try self.openCheckout(await self.send("billing/customer-portal", method: "POST")) }
    }
    func buyManualBYO(login session: GDLoginSession, name: String, remote: String, provider: String, yearly: Bool, intentID: String) {
        guard remote.range(of: "^[A-Za-z0-9_-]{3,40}$", options: .regularExpression) != nil else { status = "Enter an existing remote name using 3–40 letters, numbers, dashes or underscores."; return }
        guard let root = Bundle.main.resourceURL, FileManager.default.isExecutableFile(atPath: root.appendingPathComponent("rclone").path) else { status = "The local provider tool is unavailable."; return }
        begin(login: session) {
            self.status = "Checking your locally configured provider…"
            let process = Process()
            process.executableURL = root.appendingPathComponent("rclone")
            let config = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/GenDragoon Cloud SSD/gendragoon-rclone.conf")
            process.arguments = ["--config", config.path, "lsd", remote + ":", "--timeout", "20s", "--contimeout", "10s", "--retries", "1", "--low-level-retries", "1"]
            // Discard output to avoid retaining provider identifiers or filling pipes.
            process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                process.terminationHandler = { _ in continuation.resume() }
                do { try process.run() } catch { process.terminationHandler = nil; continuation.resume(throwing: error); return }
                DispatchQueue.global().asyncAfter(deadline: .now() + 45) { if process.isRunning { process.terminate() } }
            }
            guard process.terminationStatus == 0 else { throw GDTransferError(message: "The provider check failed or timed out. Verify the remote in My Cloud and retry.", status: 0) }
            let draft = try JSONDecoder().decode(GDWorkspaceDraft.self, from: await self.send("v2/workspaces/draft", method: "POST", payload: ["name": name, "mode": "byo", "interval": yearly ? "year" : "month", "intentId": intentID]))
            _ = try await self.send("v2/workspaces/" + draft.workspaceId + "/manual-provider", method: "POST", payload: ["provider": provider, "label": remote, "connectionTested": true])
            try self.openCheckout(await self.send("v2/workspaces/" + draft.workspaceId + "/checkout/byo", method: "POST"))
            if self.ownerBenefits { try await self.loadWorkspaces() }
        }
    }
}

struct GenDragoonStripePurchases: View {
    @EnvironmentObject private var login: GDLoginSession
    @StateObject private var billing = GDBillingModel()
    @ObservedObject private var activity = GDUpdateActivity.shared
    let focus: String
    @State private var selected = GDBillingSelection()
    @State private var selectionAccount = ""
    private var persistenceKey: String {
        let account = SHA256.hash(data: Data(login.userID.utf8)).map { String(format: "%02x", $0) }.joined()
        return "gd.checkout.selection." + account + "." + focus
    }
    private var blocked: Bool { !billing.ready || billing.busy || !activity.canStart(excluding: billing) }
    private var period: String { selected.yearly ? "year" : "month" }
    private var checkoutIntent: String {
        let fingerprint = [selected.intentID, focus, selected.workspaceName, selected.storageTier, period, selected.provider, selected.remote].joined(separator: "\0")
        var bytes = Array(SHA256.hash(data: Data(fingerprint.utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        let cuts = [0, 8, 12, 16, 20, 32]
        return (0..<5).map { index in
            String(hex[hex.index(hex.startIndex, offsetBy: cuts[index])..<hex.index(hex.startIndex, offsetBy: cuts[index + 1])])
        }.joined(separator: "-")
    }
    private func money(_ cents: Int) -> String { (Double(cents) / 100).formatted(.currency(code: "USD")) }
    private func restoreSelection() {
        selectionAccount = login.userID
        if let data = UserDefaults.standard.data(forKey: persistenceKey), let saved = try? JSONDecoder().decode(GDBillingSelection.self, from: data) { selected = saved }
        else {
            var fallback = GDBillingSelection()
            fallback.storageTier = UserDefaults.standard.string(forKey: "gd.commercial.preview.selectedTier") ?? "100GB"
            fallback.yearly = UserDefaults.standard.bool(forKey: "gd.commercial.preview.annual")
            selected = fallback
        }
        billing.refresh(login: login)
    }
    private func selectedCard(_ title: String, detail: String, cents: Int, isSelected: Bool, choose: @escaping () -> Void) -> some View {
        Button(action: choose) {
            VStack(alignment: .leading, spacing: 9) {
                HStack { Text(title).font(.system(size: 17, weight: .bold)); Spacer(); Image(systemName: isSelected ? "checkmark.circle.fill" : "circle").foregroundStyle(isSelected ? Color.cyan : Color.secondary) }
                Text(money(cents) + " / " + period).font(.system(size: 15, weight: .semibold))
                Text(detail).font(.system(size: 11)).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
                .background(isSelected ? Color.cyan.opacity(0.14) : Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 13))
                .overlay(RoundedRectangle(cornerRadius: 13).stroke(isSelected ? Color.cyan : Color.white.opacity(0.12), lineWidth: isSelected ? 2 : 1))
        }.buttonStyle(.plain).disabled(billing.busy || activity.isMaintenancePending)
    }
    private var periodPicker: some View {
        Picker("Billing period", selection: $selected.yearly) { Text("Monthly").tag(false); Text("Yearly").tag(true) }.pickerStyle(.segmented).disabled(billing.busy)
    }
    @ViewBuilder private func purchaseContent(_ catalog: GDServerBillingCatalog) -> some View {
        if focus == "standard" || focus == "bundle" {
            TextField("Project name", text: $selected.workspaceName).textFieldStyle(.roundedBorder).disabled(billing.busy)
            periodPicker
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 165), spacing: 10)], spacing: 10) {
                ForEach(catalog.storage.keys.sorted { (catalog.storage[$0]?.gb ?? 0) < (catalog.storage[$1]?.gb ?? 0) }, id: \.self) { tier in
                    if let item = catalog.storage[tier] {
                        let base = focus == "bundle" ? (selected.yearly ? item.bundleYearlyCents : item.bundleMonthlyCents) : (selected.yearly ? item.yearlyCents : item.monthlyCents)
                        let fee = catalog.workspaceFeeMonthlyCents * (selected.yearly ? 10 : 1)
                        selectedCard(tier, detail: focus == "bundle" ? "Includes performance + workspace fee" : "Includes workspace fee", cents: base + fee, isSelected: selected.storageTier == tier) { selected.storageTier = tier }
                    }
                }
            }
            if let plan = catalog.storage[selected.storageTier] {
                let base = focus == "bundle" ? (selected.yearly ? plan.bundleYearlyCents : plan.bundleMonthlyCents) : (selected.yearly ? plan.yearlyCents : plan.monthlyCents)
                let fee = catalog.workspaceFeeMonthlyCents * (selected.yearly ? 10 : 1)
                Text("Selected: \(selected.storageTier) \(focus == "bundle" ? "Storage + Performance" : "Storage") · \(money(base)) + \(money(fee)) workspace fee = \(money(base + fee))/\(period)").font(.system(size: 12, weight: .semibold))
                Button(billing.ownerBenefits ? "Activate selected plan — included" : "Continue with selected plan · " + money(base + fee) + "/" + period) {
                    billing.buyStorage(login: login, name: selected.workspaceName, tier: selected.storageTier, mode: focus, yearly: selected.yearly, intentID: checkoutIntent)
                }.buttonStyle(.borderedProminent).tint(.cyan).disabled(blocked || selected.workspaceName.trimmingCharacters(in: .whitespaces).count < 3)
            } else { Text("Choose an available storage plan.").foregroundStyle(.orange) }
        } else if focus == "performance" {
            Picker("Workspace", selection: $selected.workspaceID) {
                Text("Choose an active workspace").tag("")
                ForEach(billing.workspaces.filter(\.supportsPerformance)) { Text($0.name).tag($0.id) }
            }.disabled(billing.busy)
            periodPicker
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 165), spacing: 10)], spacing: 10) {
                ForEach(catalog.performance.keys.sorted { (catalog.performance[$0]?.workers ?? 0) < (catalog.performance[$1]?.workers ?? 0) }, id: \.self) { tier in
                    if let plan = catalog.performance[tier] {
                        selectedCard(tier.capitalized, detail: "Up to \(plan.workers) parallel transfer workers", cents: selected.yearly ? plan.yearlyCents : plan.monthlyCents, isSelected: selected.performanceTier == tier) { selected.performanceTier = tier }
                    }
                }
            }
            if let plan = catalog.performance[selected.performanceTier] {
                Text("Selected: \(selected.performanceTier.capitalized) · \(money(selected.yearly ? plan.yearlyCents : plan.monthlyCents))/\(period)").font(.system(size: 12, weight: .semibold))
                Button(billing.ownerBenefits ? "Activate selected performance — included" : "Continue with selected performance") { billing.buyPerformance(login: login, workspaceID: selected.workspaceID, tier: selected.performanceTier, yearly: selected.yearly) }
                    .buttonStyle(.borderedProminent).tint(.cyan).disabled(blocked || !billing.workspaces.contains { $0.id == selected.workspaceID && $0.supportsPerformance })
            }
            Text("Performance is billed independently and can be added to an active managed storage or BYO workspace.").font(.system(size: 11)).foregroundStyle(.secondary)
        } else if focus == "byo" {
            Text("Configure your cloud connection in My Cloud, then enter its existing remote name. Provider credentials stay on your Mac.").font(.system(size: 12)).foregroundStyle(.secondary)
            TextField("Project name", text: $selected.workspaceName).textFieldStyle(.roundedBorder)
            Picker("Provider", selection: $selected.provider) { ForEach(["s3", "gcs", "r2", "b2", "sftp", "webdav", "google-drive", "onedrive", "other"], id: \.self) { Text($0.uppercased()).tag($0) } }
            TextField("Existing rclone remote name", text: $selected.remote).textFieldStyle(.roundedBorder)
            periodPicker
            Text("Selected: Bring Your Own Cloud · \(money(selected.yearly ? catalog.byo.yearlyCents : catalog.byo.monthlyCents))/\(period). Your provider's storage and transfer charges are separate.").font(.system(size: 12, weight: .semibold))
            Button(billing.ownerBenefits ? "Verify provider and activate — included" : "Verify provider and continue to Checkout") { billing.buyManualBYO(login: login, name: selected.workspaceName, remote: selected.remote, provider: selected.provider, yearly: selected.yearly, intentID: checkoutIntent) }
                .buttonStyle(.borderedProminent).tint(.cyan).disabled(blocked || selected.remote.isEmpty)
        } else if focus == "ads" {
            Text("Permanent ad removal · " + money(catalog.removeAds.oneTimeCents) + " once").font(.system(size: 16, weight: .semibold))
            Button(billing.ownerBenefits ? "Ad removal included" : "Continue to one-time purchase") { billing.buyRemoveAds(login: login) }.buttonStyle(.borderedProminent).tint(.cyan).disabled(blocked || login.isAdFree)
            if login.isAdFree { Label("Your verified ad-free entitlement is active", systemImage: "checkmark.seal.fill").foregroundStyle(.green) }
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack {
                Label(billing.ownerBenefits ? "Owner · Included access" : "Choose your plan", systemImage: "creditcard.fill").font(.system(size: 16, weight: .bold))
                Spacer()
                if billing.ready { Text(billing.mode == "test" ? "TEST MODE" : "AVAILABLE").font(.system(size: 10, weight: .bold)).foregroundStyle(billing.mode == "test" ? .orange : .green) }
            }
            if let catalog = billing.catalog { purchaseContent(catalog) }
            if billing.busy { ProgressView() }
            Text(billing.status).font(.system(size: 12)).foregroundStyle(billing.ready ? Color.secondary : Color.orange)
            HStack {
                Button("Refresh verified access") { billing.refresh(login: login) }.disabled(billing.busy || activity.isMaintenancePending)
                Spacer()
                Button("Manage billing") { billing.portal(login: login) }.disabled(blocked)
            }.font(.system(size: 12))
        }.padding(17).background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 15))
            .onAppear { restoreSelection() }
            .onChange(of: login.userID) { _, _ in restoreSelection() }
            .onChange(of: selected) { old, new in
                guard selectionAccount == login.userID, !selectionAccount.isEmpty else { return }
                if let data = try? JSONEncoder().encode(selected) { UserDefaults.standard.set(data, forKey: persistenceKey) }
            }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in if billing.checkoutPending { billing.refresh(login: login) } }
    }
}
