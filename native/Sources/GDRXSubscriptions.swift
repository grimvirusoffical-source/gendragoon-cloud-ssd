import SwiftUI
import AppKit
import Foundation

enum GDRXSubscriptionFocus: String {
    case plans, projects, storage, performance, ads
}

private struct GDRXControlConfig: Decodable {
    let endpoint: String
    let version: Int
}
struct GDRXPricing: Decodable {
    struct Projects: Decodable {
        let firstFree: Bool
        let additionalOneTimeCents: Int
        let defaultLimit: Int
        let qualifiedLimit: Int
        let qualificationLabel: String
    }
    struct Storage: Decodable {
        let gb: Int
        let monthlyCents: Int
        let yearlyCents: Int
    }
    struct Performance: Decodable {
        let workers: Int
        let monthlyCents: Int
        let yearlyCents: Int
    }
    struct RemoveAds: Decodable { let oneTimeCents: Int }
    struct Owner: Decodable {
        let email: String
        let allPlansIncluded: Bool
        let lifetime: Bool
    }
    let catalogVersion: Int
    let projects: Projects
    let storage: [String: Storage]
    let performance: [String: Performance]
    let removeAds: RemoveAds
    let owner: Owner
}
struct GDRXProject: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let status: String
    let active: Bool
    let readOnly: Bool
    let free: Bool
    let owner: Bool
    let storageTier: String?
    let performanceTier: String?
    let interval: String?
    let quotaBytes: Int64
    let workers: Int
    let subscriptionStatus: String?
    let checkoutPending: Bool
    let createdMs: Int64?
}
private struct GDRXProjectsResponse: Decodable {
    let ownerBenefits: Bool
    let projectLimit: Int
    let projects: [GDRXProject]
}
private struct GDRXAccountResponse: Decodable {
    let ownerBenefits: Bool
    let adFree: Bool
    let projectLimit: Int
    let usedProjectSlots: Int
    let email: String
}
private struct GDRXCheckoutResponse: Decodable {
    let url: String?
    let project: GDRXProject?
    let projectId: String?
    let oneTimeCents: Int?
    let complimentary: Bool?
    let alreadyActivated: Bool?
    let message: String?
    let resumed: Bool?
}
private struct GDRXPlanResponse: Decodable { let project: GDRXProject }

@MainActor
final class GDRXSubscriptionModel: ObservableObject {
    @Published var pricing: GDRXPricing?
    @Published var projects: [GDRXProject] = []
    @Published var ownerBenefits = false
    @Published var adFree = false
    @Published var projectLimit = 10
    @Published var usedProjectSlots = 0
    @Published var busy = false
    @Published var checkoutPending = false
    @Published var status = "Loading Red-XAI plans…"

    private var base: URL? {
        guard let file = Bundle.main.url(forResource: "gendragoon_control_api", withExtension: "json"),
              let data = try? Data(contentsOf: file),
              let cfg = try? JSONDecoder().decode(GDRXControlConfig.self, from: data),
              cfg.version == 1,
              let url = URL(string: cfg.endpoint),
              url.scheme == "https", url.host == "api.red-xai.com",
              url.user == nil, url.password == nil,
              url.path == "/gendragoon/" else { return nil }
        return url
    }

    private func endpoint(_ path: String) throws -> URL {
        guard let base,
              let url = URL(string: path, relativeTo: base)?.absoluteURL,
              url.scheme == "https", url.host == "api.red-xai.com",
              url.path.hasPrefix("/gendragoon/") else {
            throw GDTransferError(message: "GenDragoon subscription service configuration is invalid.", status: 0)
        }
        return url
    }

    private func request(_ redX: GDRedXAIAuthSession, _ path: String,
                         method: String = "GET", payload: [String: Any]? = nil,
                         authenticated: Bool = true) async throws -> Data {
        let url = try endpoint(path)
        for attempt in 0...1 {
            var req = URLRequest(url: url)
            req.httpMethod = method
            req.timeoutInterval = 30
            req.cachePolicy = .reloadIgnoringLocalCacheData
            req.setValue("application/json", forHTTPHeaderField: "Accept")
            if authenticated {
                let token = try await redX.accessToken(forceRefresh: attempt == 1)
                req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            }
            if let payload {
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.httpBody = try JSONSerialization.data(withJSONObject: payload)
            }
            let (data, response) = try await URLSession.shared.data(for: req)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if authenticated && code == 401 && attempt == 0 { continue }
            guard (200...299).contains(code) else {
                let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                let message = object?["message"] as? String ?? object?["error"] as? String ?? "Red-XAI subscription service rejected the request."
                throw GDTransferError(message: message.replacingOccurrences(of: "_", with: " "), status: code)
            }
            return data
        }
        throw GDTransferError(message: "Red-XAI session expired. Reconnect GenDragoon.", status: 401)
    }

    private func openCheckout(_ data: Data) throws {
        let result = try JSONDecoder().decode(GDRXCheckoutResponse.self, from: data)
        if result.complimentary == true || result.alreadyActivated == true {
            status = result.message ?? "Included access is active."
            return
        }
        guard let raw = result.url,
              let url = URL(string: raw),
              url.scheme == "https",
              url.user == nil, url.password == nil,
              ["checkout.stripe.com", "billing.stripe.com"].contains(url.host ?? "") else {
            if let project = result.project, project.active {
                status = "Project created and ready."
                return
            }
            throw GDTransferError(message: "The billing service returned an invalid Checkout address.", status: 0)
        }
        guard NSWorkspace.shared.open(url) else {
            throw GDTransferError(message: "Your browser could not open Stripe Checkout.", status: 0)
        }
        checkoutPending = true
        status = "Stripe Checkout opened. Return to GenDragoon after payment; access is verified by the server."
    }

    func refresh(_ redX: GDRedXAIAuthSession) {
        guard redX.linked, !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                pricing = try JSONDecoder().decode(GDRXPricing.self,
                    from: await request(redX, "v2/pricing", authenticated: false))
                let p = try JSONDecoder().decode(GDRXProjectsResponse.self,
                    from: await request(redX, "v2/projects"))
                let a = try JSONDecoder().decode(GDRXAccountResponse.self,
                    from: await request(redX, "v2/account"))
                projects = p.projects
                ownerBenefits = a.ownerBenefits || p.ownerBenefits
                adFree = a.adFree
                projectLimit = a.projectLimit
                usedProjectSlots = a.usedProjectSlots
                checkoutPending = projects.contains(where: { $0.checkoutPending })
                status = ownerBenefits
                    ? "Owner lifetime access active · all storage and performance plans included."
                    : "Red-XAI plans verified · \(usedProjectSlots) of \(projectLimit) project slots used."
                await redX.refreshWorkspaces()
            } catch {
                status = error.localizedDescription
            }
        }
    }

    func createProject(_ redX: GDRedXAIAuthSession, name: String,
                       storageTier: String, performanceTier: String, yearly: Bool) {
        guard !busy else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3 else { status = "Enter a project name with at least 3 characters."; return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let data = try await request(redX, "v2/projects", method: "POST", payload: [
                    "name": trimmed,
                    "storageTier": storageTier,
                    "performanceTier": performanceTier,
                    "interval": yearly ? "year" : "month"
                ])
                try openCheckout(data)
                await redX.refreshWorkspaces()
                let p = try JSONDecoder().decode(GDRXProjectsResponse.self, from: await request(redX, "v2/projects"))
                projects = p.projects; ownerBenefits = p.ownerBenefits; projectLimit = p.projectLimit
                usedProjectSlots = projects.count
            } catch { status = error.localizedDescription }
        }
    }

    func resumeCheckout(_ redX: GDRedXAIAuthSession, project: GDRXProject) {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do { try openCheckout(await request(redX, "v2/projects/\(project.id)/checkout", method: "POST", payload: [:])) }
            catch { status = error.localizedDescription }
        }
    }

    func changePlan(_ redX: GDRedXAIAuthSession, projectID: String,
                    storageTier: String, performanceTier: String, yearly: Bool) {
        guard !busy, !projectID.isEmpty else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let result = try JSONDecoder().decode(GDRXPlanResponse.self,
                    from: await request(redX, "v2/projects/\(projectID)/plan", method: "PUT", payload: [
                        "storageTier": storageTier,
                        "performanceTier": performanceTier,
                        "interval": yearly ? "year" : "month"
                    ]))
                if let index = projects.firstIndex(where: { $0.id == result.project.id }) { projects[index] = result.project }
                status = ownerBenefits ? "Owner plan changed at no charge." : "Plan updated. Stripe applies any verified proration."
                await redX.refreshWorkspaces()
            } catch { status = error.localizedDescription }
        }
    }

    func removeAds(_ redX: GDRedXAIAuthSession) {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try openCheckout(await request(redX, "v2/remove-ads/checkout", method: "POST", payload: [:]))
                if ownerBenefits { adFree = true }
            } catch { status = error.localizedDescription }
        }
    }

    func manageBilling(_ redX: GDRedXAIAuthSession) {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let data = try await request(redX, "v2/billing/portal", method: "POST", payload: [:])
                let result = try JSONDecoder().decode(GDRXCheckoutResponse.self, from: data)
                guard let raw = result.url, let url = URL(string: raw),
                      url.scheme == "https", url.host == "billing.stripe.com",
                      NSWorkspace.shared.open(url) else {
                    throw GDTransferError(message: "No Stripe billing portal is available for this account yet.", status: 404)
                }
                status = "Stripe billing portal opened."
            } catch { status = error.localizedDescription }
        }
    }
}

struct GDRXSubscriptionsPanel: View {
    @EnvironmentObject private var redX: GDRedXAIAuthSession
    @StateObject private var model = GDRXSubscriptionModel()
    let focus: GDRXSubscriptionFocus
    @State private var projectName = "My Cloud"
    @State private var storageTier = "100GB"
    @State private var performanceTier = "boost"
    @State private var yearly = false
    @State private var selectedProjectID = ""

    private func money(_ cents: Int) -> String {
        (Double(cents) / 100).formatted(.currency(code: "USD"))
    }
    private var selectedProject: GDRXProject? {
        model.projects.first(where: { $0.id == selectedProjectID })
    }
    private var storageKeys: [String] {
        model.pricing?.storage.keys.sorted {
            (model.pricing?.storage[$0]?.gb ?? 0) < (model.pricing?.storage[$1]?.gb ?? 0)
        } ?? []
    }
    private var performanceKeys: [String] {
        model.pricing?.performance.keys.sorted {
            (model.pricing?.performance[$0]?.workers ?? 0) < (model.pricing?.performance[$1]?.workers ?? 0)
        } ?? []
    }

    @ViewBuilder private var projectCreation: some View {
        if let pricing = model.pricing {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("CREATE PROJECT").font(.system(size: 10, weight: .heavy, design: .monospaced)).tracking(2).foregroundStyle(gdPurple)
                    Spacer()
                    Text("\(model.usedProjectSlots) / \(model.projectLimit) slots").font(.caption.monospaced()).foregroundStyle(.secondary)
                }
                TextField("Project name", text: $projectName).textFieldStyle(.roundedBorder)
                Picker("Storage", selection: $storageTier) {
                    ForEach(storageKeys, id: \.self) { key in
                        if let p = pricing.storage[key] { Text("\(key) · \(money(yearly ? p.yearlyCents : p.monthlyCents))/\(yearly ? "yr" : "mo")").tag(key) }
                    }
                }
                Picker("Performance", selection: $performanceTier) {
                    ForEach(performanceKeys, id: \.self) { key in
                        if let p = pricing.performance[key] { Text("\(key.capitalized) · \(p.workers) workers · \(money(yearly ? p.yearlyCents : p.monthlyCents))/\(yearly ? "yr" : "mo")").tag(key) }
                    }
                }
                Picker("Billing", selection: $yearly) { Text("Monthly").tag(false); Text("Yearly · 2 months free").tag(true) }.pickerStyle(.segmented)
                Text(model.ownerBenefits
                     ? "Owner account: every project and every storage/performance tier is included for life."
                     : model.projects.isEmpty
                       ? "Your first project is free with 2 GB and 1 worker. Plan choices start on paid projects."
                       : "New paid project: \(money(pricing.projects.additionalOneTimeCents)) once + selected storage + selected performance.")
                    .font(.caption).foregroundStyle(.secondary)
                Button(model.ownerBenefits ? "Create Project · Included" : model.projects.isEmpty ? "Create Free Project" : "Create Project & Open Checkout") {
                    model.createProject(redX, name: projectName, storageTier: storageTier, performanceTier: performanceTier, yearly: yearly)
                }.buttonStyle(.borderedProminent).tint(gdPurple)
                    .disabled(model.busy || model.usedProjectSlots >= model.projectLimit)
            }
        }
    }

    @ViewBuilder private var projectList: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("PROJECTS").font(.system(size: 10, weight: .heavy, design: .monospaced)).tracking(2).foregroundStyle(gdPurple)
                Spacer()
                Button("Refresh") { model.refresh(redX) }.disabled(model.busy)
            }
            if model.projects.isEmpty {
                Text("No projects yet. Create the first one above.").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(model.projects) { p in
                    HStack(spacing: 12) {
                        Image(systemName: p.active ? "checkmark.shield.fill" : "clock.badge.exclamationmark.fill")
                            .foregroundStyle(p.active ? .green : .orange)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(p.name).font(.system(size: 13, weight: .bold))
                            Text(p.owner ? "Owner · 6 TB · Max" :
                                 p.free ? "Free · 2 GB · 1 worker" :
                                 "\(p.storageTier ?? "—") · \((p.performanceTier ?? "—").capitalized) · \(p.workers) workers")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if p.checkoutPending {
                            Button("Resume Checkout") { model.resumeCheckout(redX, project: p) }.buttonStyle(.bordered)
                        } else {
                            Text(p.status.replacingOccurrences(of: "_", with: " ").capitalized).font(.caption2).foregroundStyle(.secondary)
                        }
                    }.padding(10).background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
                }
            }
        }
    }

    @ViewBuilder private var planEditor: some View {
        if let pricing = model.pricing {
            VStack(alignment: .leading, spacing: 12) {
                Picker("Project", selection: $selectedProjectID) {
                    Text("Choose project").tag("")
                    ForEach(model.projects.filter { !$0.free }) { p in Text(p.name).tag(p.id) }
                }
                if focus == .storage || focus == .plans {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 9)], spacing: 9) {
                        ForEach(storageKeys, id: \.self) { key in
                            if let p = pricing.storage[key] {
                                Button {
                                    storageTier = key
                                } label: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        HStack { Text(key).bold(); Spacer(); Image(systemName: storageTier == key ? "checkmark.circle.fill" : "circle") }
                                        Text("\(money(yearly ? p.yearlyCents : p.monthlyCents))/\(yearly ? "yr" : "mo")").font(.caption)
                                    }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                                        .background(gdPurple.opacity(storageTier == key ? 0.18 : 0.06), in: RoundedRectangle(cornerRadius: 10))
                                }.buttonStyle(.plain)
                            }
                        }
                    }
                }
                if focus == .performance || focus == .plans {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 9)], spacing: 9) {
                        ForEach(performanceKeys, id: \.self) { key in
                            if let p = pricing.performance[key] {
                                Button {
                                    performanceTier = key
                                } label: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        HStack { Text(key.capitalized).bold(); Spacer(); Image(systemName: performanceTier == key ? "checkmark.circle.fill" : "circle") }
                                        Text("\(p.workers) workers · \(money(yearly ? p.yearlyCents : p.monthlyCents))/\(yearly ? "yr" : "mo")").font(.caption)
                                    }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                                        .background(gdPurple.opacity(performanceTier == key ? 0.18 : 0.06), in: RoundedRectangle(cornerRadius: 10))
                                }.buttonStyle(.plain)
                            }
                        }
                    }
                }
                Picker("Billing", selection: $yearly) { Text("Monthly").tag(false); Text("Yearly").tag(true) }.pickerStyle(.segmented)
                Button(model.ownerBenefits ? "Apply Included Plan" : "Apply Plan Change") {
                    model.changePlan(redX, projectID: selectedProjectID, storageTier: storageTier, performanceTier: performanceTier, yearly: yearly)
                }.buttonStyle(.borderedProminent).tint(.cyan)
                    .disabled(model.busy || selectedProjectID.isEmpty)
                if let p = selectedProject {
                    Text("Current: \(p.storageTier ?? "—") · \((p.performanceTier ?? "—").capitalized) · \(p.workers) workers")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder private var adsSection: some View {
        if let pricing = model.pricing {
            VStack(alignment: .leading, spacing: 10) {
                Label(model.adFree || model.ownerBenefits ? "Ad-free access active" : "Remove Ads", systemImage: "megaphone.slash.fill")
                    .font(.headline).foregroundStyle(model.adFree || model.ownerBenefits ? .green : .primary)
                Text(model.ownerBenefits ? "Included with lifetime owner access." : "\(money(pricing.removeAds.oneTimeCents)) once for this Red-XAI account.")
                    .font(.caption).foregroundStyle(.secondary)
                if !(model.adFree || model.ownerBenefits) {
                    Button("Remove Ads · " + money(pricing.removeAds.oneTimeCents)) { model.removeAds(redX) }
                        .buttonStyle(.borderedProminent).tint(gdPurple).disabled(model.busy)
                }
            }
        }
    }

    var body: some View {
        GDPanel {
            HStack {
                Label(model.ownerBenefits ? "Red-XAI Owner · Lifetime Included" : "Red-XAI subscriptions", systemImage: "creditcard.fill")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(model.ownerBenefits ? .green : gdPurple)
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
            }
            if focus == .projects || focus == .plans { projectCreation; Divider(); projectList }
            if focus == .storage || focus == .performance || focus == .plans {
                if focus != .plans { projectList; Divider() }
                planEditor
            }
            if focus == .ads { adsSection }
            Text(model.status).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            HStack {
                Button("Refresh verified access") { model.refresh(redX) }.disabled(model.busy)
                Spacer()
                if !model.ownerBenefits { Button("Manage Billing") { model.manageBilling(redX) }.disabled(model.busy) }
            }.font(.caption)
        }
        .task {
            if redX.linked { model.refresh(redX) }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            if redX.linked && model.checkoutPending { model.refresh(redX) }
        }
        .onChange(of: selectedProjectID) { _, newValue in
            guard let p = model.projects.first(where: { $0.id == newValue }) else { return }
            storageTier = p.storageTier ?? storageTier
            performanceTier = p.performanceTier ?? performanceTier
            yearly = p.interval == "year"
        }
        .onChange(of: model.projects) { _, value in
            if selectedProjectID.isEmpty, let first = value.first(where: { !$0.free }) { selectedProjectID = first.id }
        }
    }
}
