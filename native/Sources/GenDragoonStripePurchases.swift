import SwiftUI
import AppKit
import Foundation
import CryptoKit

private struct GDBillingEndpoint: Decodable { let endpoint: String }
private struct GDBillingStatus: Decodable { let checkoutEnabled: Bool; let stripeMode: String }
private struct GDCheckoutResponse: Decodable { let url: String?; let complimentary: Bool?; let message: String?; let alreadyActivated: Bool? }
private struct GDWorkspaceDraft: Decodable { let workspaceId: String }
struct GDRemotePlanSelection: Codable, Equatable {
    let storageTier: String?; let storageMode: String?; let storageInterval: String?
    let performanceTier: String?; let performanceInterval: String?; let byoInterval: String?
}
struct GDRemoteWorkspace: Decodable, Identifiable, Equatable {
    let id: String; let name: String; let kind: String
    let storageActive: Bool; let provisioned: Bool
    let byoActive: Bool?; let manualProviderConfigured: Bool?
    let storageTier: String?; let storageMode: String?; let storageInterval: String?
    let performanceTier: String?; let performanceInterval: String?; let workers: Int?; let quotaGB: Int?
    let performanceActive: Bool?
    let projectStatus: String?; let projectFeeStatus: String?; let projectBillingVersion: Int?
    let intendedSelection: GDRemotePlanSelection?
    /// "plans" when the workspace's storage + performance plans are billed together (no separate fee).
    let billingModel: String?; let customStorage: Bool?
    var plansManaged: Bool { billingModel == "plans" }
    var isAvailable: Bool {
        if let projectStatus { return projectStatus == "active" }
        return (kind == "free" && provisioned) || (storageActive && provisioned) || (kind == "byo" && byoActive == true && manualProviderConfigured == true)
    }
    // Plans workspaces change plans together through their own checkout, not these separate pickers.
    var supportsStorage: Bool { !plansManaged && ["free", "paid"].contains(kind) && isAvailable && provisioned }
    var supportsPerformance: Bool {
        !plansManaged && isAvailable && (supportsStorage || (kind == "byo" && byoActive == true && manualProviderConfigured == true))
    }
    var needsCustomSetup: Bool { plansManaged && customStorage == true && projectStatus == "active" && manualProviderConfigured != true }
}
private struct GDWorkspacesResponse: Decodable { let workspaces: [GDRemoteWorkspace]; let ownerBenefits: Bool? }
private struct GDBillingProjectsResponse: Decodable { let projects: [GDRemoteWorkspace]; let ownerBenefits: Bool? }
struct GDServerBillingCatalog: Decodable {
    struct Storage: Decodable { let gb: Int; let monthlyCents: Int; let yearlyCents: Int; let bundleMonthlyCents: Int; let bundleYearlyCents: Int; let bundleWorkers: Int? }
    struct Performance: Decodable { let workers: Int; let monthlyCents: Int; let yearlyCents: Int }
    struct BYO: Decodable { let monthlyCents: Int; let yearlyCents: Int }
    struct Ads: Decodable { let oneTimeCents: Int }
    struct Projects: Decodable {
        let firstFree: Bool; let additionalOneTimeCents: Int; let defaultLimit: Int; let qualifiedLimit: Int
        let qualificationLabel: String; let paymentAvailable: Bool
    }
    let catalogVersion: Int?
    let workspaceFeeMonthlyCents: Int
    let storage: [String: Storage]; let performance: [String: Performance]
    let byo: BYO?; let removeAds: Ads
    let projects: Projects?
}
private struct GDBillingSelection: Codable, Equatable {
    var accountScope: String?
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
    private var selectionSaveTask: Task<Void, Never>?
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
            selectionSaveTask?.cancel()
            ownerBenefits = false; workspaces = []; ready = false; checkoutPending = false
        }
        login = session; accountID = session.userID
    }
    func workspaceForSelection(_ id: String, accountID expected: String) -> GDRemoteWorkspace? {
        guard accountID == expected, login?.userID == expected else { return nil }
        return workspaces.first { $0.id == id }
    }
    private func loadWorkspaces() async throws {
        if (catalog?.catalogVersion ?? 1) >= 2 {
            let result = try JSONDecoder().decode(GDBillingProjectsResponse.self, from: await send("v2/projects"))
            workspaces = result.projects; ownerBenefits = result.ownerBenefits == true
        } else {
            let result = try JSONDecoder().decode(GDWorkspacesResponse.self, from: await send("v2/workspaces"))
            workspaces = result.workspaces; ownerBenefits = result.ownerBenefits == true
        }
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
        if result.complimentary == true || result.alreadyActivated == true { status = result.message ?? "Included access is already active."; return }
        guard let raw = result.url, let url = URL(string: raw), url.scheme == "https", url.user == nil, url.password == nil,
              ["checkout.stripe.com", "billing.stripe.com"].contains(url.host ?? "") else {
            throw GDTransferError(message: "The billing service returned an invalid checkout address.", status: 0)
        }
        guard NSWorkspace.shared.open(url) else { throw GDTransferError(message: "Your browser could not open Checkout. Retry to resume this purchase.", status: 0) }
        checkoutPending = true
        status = "Checkout opened. Your selected plan is retained; return here after payment to refresh verified access."
    }
    func buyStorage(login session: GDLoginSession, workspaceID: String, tier: String, mode: String, yearly: Bool) {
        guard (catalog?.catalogVersion ?? 1) >= 2 else { status = "Project activation pricing is waiting for the service update. Your selected plan is saved."; return }
        guard workspaces.contains(where: { $0.id == workspaceID && $0.supportsStorage }) else { status = "Choose an active project. Create or activate a project in Cloud first."; return }
        begin(login: session) {
            try self.openCheckout(await self.send("v2/workspaces/" + workspaceID + "/checkout/storage", method: "POST", payload: ["tier": tier, "mode": mode, "interval": yearly ? "year" : "month"]))
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
    /// Last step of the custom storage wizard. The provider's credentials stay in the local rclone
    /// configuration on this Mac; the server only records the tested remote's label. No checkout:
    /// the workspace was paid for by its performance plan when it was created.
    func connectCustomStorage(login session: GDLoginSession, workspaceID: String, remote: String, provider: String, onSuccess: @escaping () -> Void) {
        guard workspaces.contains(where: { $0.id == workspaceID && $0.needsCustomSetup }) else { status = "Choose a paid custom storage workspace first."; return }
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
            _ = try await self.send("v2/workspaces/" + workspaceID + "/manual-provider", method: "POST", payload: ["provider": provider, "label": remote, "connectionTested": true])
            try await self.loadWorkspaces()
            self.status = "Custom storage connected. Your provider bills its own storage and transfer charges."
            onSuccess()
        }
    }
    func retainSelection(login session: GDLoginSession, workspaceID: String, payload: [String: String]) {
        selectionSaveTask?.cancel()
        guard !workspaceID.isEmpty, !session.userID.isEmpty, accountID == session.userID, (catalog?.catalogVersion ?? 1) >= 2,
              workspaces.contains(where: { $0.id == workspaceID && $0.projectStatus != "archived" }) else { return }
        connect(session)
        let expected = session.userID
        selectionSaveTask = Task {
            do {
                try await Task.sleep(for: .milliseconds(400))
                guard !Task.isCancelled, self.accountID == expected, session.userID == expected,
                      GDUpdateActivity.shared.canStart(excluding: self) else { return }
                GDUpdateActivity.shared.set(self, key: "selection", active: true)
                defer { GDUpdateActivity.shared.set(self, key: "selection", active: false) }
                _ = try await self.send("v2/projects/" + workspaceID + "/selection", method: "PUT", payload: payload)
            } catch is CancellationError { }
            catch { if self.accountID == expected && !Task.isCancelled { self.status = "Your selection is saved on this Mac. Refresh to retry cloud synchronization." } }
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
    @State private var setupStep = 0
    private var accountScope: String { SHA256.hash(data: Data(login.userID.utf8)).map { String(format: "%02x", $0) }.joined() }
    private func persistenceKey(workspaceID: String) -> String {
        GDProjectPreferences.key(accountID: login.userID, workspaceID: workspaceID, setting: "billing.selection." + focus)
    }
    private var legacyPersistenceKey: String {
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
    private func restoreSelection(workspaceID: String? = nil, refresh: Bool = true) {
        selectionAccount = login.userID
        let projectID = workspaceID ?? GDProjectPreferences.selected(accountID: login.userID)
        if let data = UserDefaults.standard.data(forKey: persistenceKey(workspaceID: projectID)), let saved = try? JSONDecoder().decode(GDBillingSelection.self, from: data) { selected = saved }
        else {
            var fallback = GDBillingSelection()
            if let data = UserDefaults.standard.data(forKey: legacyPersistenceKey), let saved = try? JSONDecoder().decode(GDBillingSelection.self, from: data), saved.workspaceID.isEmpty || saved.workspaceID == projectID { fallback = saved }
            if let project = billing.workspaceForSelection(projectID, accountID: login.userID) {
                let intention = project.intendedSelection
                fallback.storageTier = intention?.storageTier ?? project.storageTier ?? fallback.storageTier
                fallback.performanceTier = intention?.performanceTier ?? project.performanceTier ?? fallback.performanceTier
                let interval = focus == "performance" ? (intention?.performanceInterval ?? project.performanceInterval) : focus == "byo" ? intention?.byoInterval : (intention?.storageInterval ?? project.storageInterval)
                if let interval { fallback.yearly = interval == "year" }
            }
            selected = fallback
        }
        selected.accountScope = accountScope
        selected.workspaceID = projectID
        if refresh { billing.refresh(login: login) }
    }
    private func storeSelection(_ value: GDBillingSelection) {
        guard !login.userID.isEmpty, !value.workspaceID.isEmpty, value.accountScope == accountScope else { return }
        if let data = try? JSONEncoder().encode(value) { UserDefaults.standard.set(data, forKey: persistenceKey(workspaceID: value.workspaceID)) }
    }
    private func synchronizeSelection() {
        let interval = selected.yearly ? "year" : "month"
        let payload: [String: String]
        if focus == "performance" { payload = ["performanceTier": selected.performanceTier, "performanceInterval": interval] }
        else if focus == "standard" || focus == "bundle" { payload = ["storageTier": selected.storageTier, "storageMode": focus, "storageInterval": interval] }
        else { return }
        billing.retainSelection(login: login, workspaceID: selected.workspaceID, payload: payload)
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
    private var projectPicker: some View {
        VStack(alignment: .leading, spacing: 7) {
            Picker("Project", selection: $selected.workspaceID) {
                Text("Choose an existing project").tag("")
                if !selected.workspaceID.isEmpty && !billing.workspaces.contains(where: { $0.id == selected.workspaceID }) {
                    Text("Selected project unavailable — refresh or choose a project").tag(selected.workspaceID)
                }
                ForEach(billing.workspaces) { project in
                    Text(project.name + (project.isAvailable ? "" : " · activation pending")).tag(project.id)
                }
            }.disabled(billing.busy)
            if let project = billing.workspaces.first(where: { $0.id == selected.workspaceID }) {
                if project.isAvailable {
                    let storage = project.storageActive ? (project.storageTier ?? "Paid storage") : "2 GB basic storage"
                    let performance = project.performanceActive == true ? (project.performanceTier?.capitalized ?? "Performance") : project.storageMode == "bundle" && project.storageActive ? "Bundle performance" : "Basic performance"
                    Text("Verified for \(project.name): \(storage) · \(performance) · \(project.workers ?? 1) transfer worker(s)").font(.system(size: 11)).foregroundStyle(.secondary)
                } else {
                    Text("This project's activation is pending. Finish activation or restore it in Cloud before adding a subscription.").font(.system(size: 11)).foregroundStyle(.orange)
                }
            } else {
                Text("Create or restore a project in Cloud, then choose it here. Your tier selection is saved for each project.").font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
    }
    private static let customSteps = ["Provider", "Connection", "Test", "Finish"]
    @ViewBuilder private var customStorageWizard: some View {
        let ready = billing.workspaces.filter { $0.needsCustomSetup }
        if ready.isEmpty {
            Text("No custom storage workspace is waiting for setup. In Files choose New Project, then Custom storage and a performance plan. Setup continues here after payment.").font(.system(size: 12)).foregroundStyle(.secondary)
        } else {
            HStack(spacing: 6) {
                ForEach(Array(Self.customSteps.enumerated()), id: \.offset) { index, name in
                    Text("\(index + 1). \(name)").font(.system(size: 11, weight: index == setupStep ? .bold : .regular))
                        .padding(.horizontal, 9).padding(.vertical, 5)
                        .background(index <= setupStep ? Color.purple.opacity(0.22) : Color.white.opacity(0.05), in: Capsule())
                }
            }.animation(.easeInOut(duration: 0.2), value: setupStep)
            Picker("Workspace", selection: $selected.workspaceID) {
                Text("Choose a workspace").tag("")
                ForEach(ready) { project in Text(project.name).tag(project.id) }
            }.disabled(billing.busy)
            if setupStep == 0 {
                Picker("Provider", selection: $selected.provider) { ForEach(["s3", "gcs", "r2", "b2", "sftp", "webdav", "google-drive", "onedrive", "other"], id: \.self) { Text($0.uppercased()).tag($0) } }
                Button("Next") { setupStep = 1 }.disabled(selected.workspaceID.isEmpty)
            } else if setupStep == 1 {
                Text("Add the connection in My Cloud. Its credentials are saved only in this Mac's provider configuration and never sent to GenDragoon. Then enter the remote name.").font(.system(size: 12)).foregroundStyle(.secondary)
                TextField("Remote name", text: $selected.remote).textFieldStyle(.roundedBorder)
                HStack { Button("Back") { setupStep = 0 }; Button("Next") { setupStep = 2 }.disabled(selected.remote.isEmpty) }
            } else {
                Text(setupStep == 2 ? "Test the connection. GenDragoon lists the remote from this Mac with a 45-second limit." : "Connected.").font(.system(size: 12)).foregroundStyle(.secondary)
                HStack {
                    Button("Back") { setupStep = 1 }.disabled(setupStep == 3)
                    Button("Test connection and finish") {
                        billing.connectCustomStorage(login: login, workspaceID: selected.workspaceID, remote: selected.remote, provider: selected.provider) { setupStep = 3 }
                    }.buttonStyle(.borderedProminent).tint(.purple).disabled(blocked || setupStep == 3)
                }
            }
        }
    }
    @ViewBuilder private func purchaseContent(_ catalog: GDServerBillingCatalog) -> some View {
        if focus == "standard" || focus == "bundle" {
            projectPicker
            periodPicker
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 165), spacing: 10)], spacing: 10) {
                ForEach(catalog.storage.keys.sorted { (catalog.storage[$0]?.gb ?? 0) < (catalog.storage[$1]?.gb ?? 0) }, id: \.self) { tier in
                    if let item = catalog.storage[tier] {
                        let base = focus == "bundle" ? (selected.yearly ? item.bundleYearlyCents : item.bundleMonthlyCents) : (selected.yearly ? item.yearlyCents : item.monthlyCents)
                        selectedCard(tier, detail: focus == "bundle" ? "Includes \(item.bundleWorkers ?? 1) performance workers" : "Storage plan · workspace fee included", cents: base, isSelected: selected.storageTier == tier) { selected.storageTier = tier }
                    }
                }
            }
            if let plan = catalog.storage[selected.storageTier] {
                let base = focus == "bundle" ? (selected.yearly ? plan.bundleYearlyCents : plan.bundleMonthlyCents) : (selected.yearly ? plan.yearlyCents : plan.monthlyCents)
                Text("Selected: \(selected.storageTier) \(focus == "bundle" ? "Storage + Performance" : "Storage") · \(money(base))/\(period) for the chosen project").font(.system(size: 12, weight: .semibold))
                Button(billing.ownerBenefits ? "Activate selected plan — included" : "Continue with selected plan · " + money(base) + "/" + period) {
                    billing.buyStorage(login: login, workspaceID: selected.workspaceID, tier: selected.storageTier, mode: focus, yearly: selected.yearly)
                }.buttonStyle(.borderedProminent).tint(.cyan).disabled(blocked || (catalog.catalogVersion ?? 1) < 2 || !billing.workspaces.contains { $0.id == selected.workspaceID && $0.supportsStorage })
            } else { Text("Choose an available storage plan.").foregroundStyle(.orange) }
        } else if focus == "performance" {
            projectPicker
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
            Text("For your free workspace. Additional workspaces choose their performance plan when they are created.").font(.system(size: 11)).foregroundStyle(.secondary)
        } else if focus == "custom" {
            customStorageWizard
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
            if focus != "ads", let policy = billing.catalog?.projects {
                Text("One project is free. Each new project after that costs \(money(policy.additionalOneTimeCents)) once and starts with 2 GB basic storage. Up to \(policy.defaultLimit) projects, or \(policy.qualifiedLimit) with \(policy.qualificationLabel.lowercased()).").font(.system(size: 11)).foregroundStyle(.secondary)
                Text("Existing subscriptions keep their current billing terms. Use Manage Billing to change or cancel an active subscription.").font(.system(size: 11)).foregroundStyle(.secondary)
            }
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
                if old.workspaceID != new.workspaceID {
                    storeSelection(old)
                    GDProjectPreferences.select(new.workspaceID, accountID: login.userID)
                    restoreSelection(workspaceID: new.workspaceID, refresh: false)
                    return
                }
                guard billing.workspaces.contains(where: { $0.id == new.workspaceID }) else { return }
                storeSelection(new); synchronizeSelection()
            }
            .onChange(of: billing.workspaces) { _, _ in
                if selectionAccount == login.userID {
                    let key = persistenceKey(workspaceID: selected.workspaceID)
                    if UserDefaults.standard.data(forKey: key) == nil { restoreSelection(workspaceID: selected.workspaceID, refresh: false) }
                    synchronizeSelection()
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: GDProjectPreferences.selectionChanged)) { notification in
                guard notification.userInfo?["accountID"] as? String == login.userID,
                      let workspaceID = notification.userInfo?["workspaceID"] as? String,
                      workspaceID != selected.workspaceID else { return }
                storeSelection(selected); restoreSelection(workspaceID: workspaceID)
            }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in if billing.checkoutPending { billing.refresh(login: login) } }
    }
}
