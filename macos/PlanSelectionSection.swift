import Combine
import Foundation
import SwiftUI

public enum PlanCategory: String, Codable, CaseIterable, Identifiable, Sendable {
    case storage, performance, gpu

    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .storage: "Storage"
        case .performance: "Transfer performance"
        case .gpu: "Cloud GPU"
        }
    }
}

public enum PlanBillingInterval: String, Codable, CaseIterable, Sendable {
    case month, year

    public var title: String { self == .month ? "Monthly" : "Yearly" }
}

public struct PlanTierID: Hashable, Codable, Sendable {
    public let rawValue: String

    public init(_ value: String) throws {
        guard !value.isEmpty, value.count <= 128,
              !value.unicodeScalars.contains(where: {
                  CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0)
              }) else {
            throw PlanSelectionError.invalidOffer
        }
        rawValue = value
    }

    public init(from decoder: any Decoder) throws {
        try self.init(decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public struct PlanOfferIdentity: Hashable, Sendable {
    public let category: PlanCategory
    public let tierID: PlanTierID
    public let interval: PlanBillingInterval
}

/// Map authenticated server offers into this model. Local proposed prices must
/// never determine purchase availability or the amount Stripe charges.
public struct ServerPlanOffer: Decodable, Identifiable, Sendable {
    public let category: PlanCategory
    public let tierID: PlanTierID
    public let name: String
    public let priceCents: Int
    public let currency: String
    public let interval: PlanBillingInterval
    public let available: Bool
    public let unavailableReason: String?

    public var id: PlanOfferIdentity {
        PlanOfferIdentity(category: category, tierID: tierID, interval: interval)
    }

    public init(
        category: PlanCategory, tierID: PlanTierID, name: String,
        priceCents: Int, currency: String, interval: PlanBillingInterval,
        available: Bool, unavailableReason: String?
    ) throws {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              name.count <= 200, priceCents >= 0,
              currency.count == 3,
              currency.unicodeScalars.allSatisfy({ (65...90).contains($0.value) }) else {
            throw PlanSelectionError.invalidOffer
        }
        self.category = category
        self.tierID = tierID
        self.name = name
        self.priceCents = priceCents
        self.currency = currency
        self.interval = interval
        self.available = available
        self.unavailableReason = unavailableReason
    }

    enum CodingKeys: String, CodingKey {
        case category, tierID, name, priceCents, currency, interval, available, unavailableReason
    }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            category: values.decode(PlanCategory.self, forKey: .category),
            tierID: values.decode(PlanTierID.self, forKey: .tierID),
            name: values.decode(String.self, forKey: .name),
            priceCents: values.decode(Int.self, forKey: .priceCents),
            currency: values.decode(String.self, forKey: .currency),
            interval: values.decode(PlanBillingInterval.self, forKey: .interval),
            available: values.decode(Bool.self, forKey: .available),
            unavailableReason: values.decodeIfPresent(String.self, forKey: .unavailableReason)
        )
    }
}

public struct ServerPlanCatalog: Sendable {
    public let offers: [ServerPlanOffer]

    public init(offers: [ServerPlanOffer]) throws {
        guard Set(offers.map(\.id)).count == offers.count else {
            throw PlanSelectionError.invalidOffer
        }
        self.offers = offers
    }
}

/// Contains identifiers only. The server resolves its own Stripe Price and
/// validates ownership, provisioning and eligibility for this signed-in user.
public struct PlanCheckoutRequest: Encodable, Sendable {
    public let category: PlanCategory
    public let tierID: PlanTierID
    public let interval: PlanBillingInterval
}

public enum PlanSelectionError: Error {
    case invalidOffer
    case invalidCheckoutURL
}

@MainActor
public final class PlanSelectionModel: ObservableObject {
    @Published public private(set) var interval: PlanBillingInterval
    @Published private var choices: [PlanCategory: PlanTierID]
    private let defaults: UserDefaults
    private let persistenceKey: String

    /// Use a distinct, stable key for each signed-in account and billing
    /// workspace. Do not put an API key or token into this key or this model.
    public init(persistenceKey: String, defaults: UserDefaults = .standard) {
        precondition(!persistenceKey.isEmpty, "A scoped persistence key is required")
        self.defaults = defaults
        self.persistenceKey = persistenceKey
        let saved = defaults.data(forKey: persistenceKey)
            .flatMap { try? JSONDecoder().decode(SavedChoice.self, from: $0) }
        interval = saved?.interval ?? .month
        choices = saved?.choices ?? [:]
    }

    public func selectedTier(for category: PlanCategory) -> PlanTierID? {
        choices[category]
    }

    public func select(_ offer: ServerPlanOffer) {
        choices[offer.category] = offer.tierID
        persist()
    }

    public func setInterval(_ value: PlanBillingInterval) {
        interval = value
        persist()
    }

    private func persist() {
        let saved = SavedChoice(interval: interval, choices: choices)
        if let data = try? JSONEncoder().encode(saved) {
            defaults.set(data, forKey: persistenceKey)
        }
    }

    private struct SavedChoice: Codable {
        let interval: PlanBillingInterval
        let choices: [PlanCategory: PlanTierID]
    }
}

/// Source component for the native app's billing/account view. The caller owns
/// authenticated catalog refresh and the existing Firebase checkout adapter.
@MainActor
public struct PlanSelectionSection: View {
    @ObservedObject private var selection: PlanSelectionModel
    private let catalog: ServerPlanCatalog
    private let checkout: @MainActor (PlanCheckoutRequest) async throws -> URL
    @Environment(\.openURL) private var openURL
    @State private var isCheckingOut = false
    @State private var checkoutError: String?
    @State private var checkoutTask: Task<Void, Never>?
    @State private var checkoutAttempt: UUID?

    public init(
        selection: PlanSelectionModel,
        catalog: ServerPlanCatalog,
        checkout: @escaping @MainActor (PlanCheckoutRequest) async throws -> URL
    ) {
        self.selection = selection
        self.catalog = catalog
        self.checkout = checkout
    }

    public var body: some View {
        Section("Plans") {
            Picker("Billing", selection: Binding(
                get: { selection.interval }, set: { selection.setInterval($0) }
            )) {
                ForEach(PlanBillingInterval.allCases, id: \.self) { interval in
                    Text(interval.title).tag(interval)
                }
            }
            .pickerStyle(.segmented)
            .disabled(isCheckingOut)

            ForEach(PlanCategory.allCases) { category in
                categoryChoices(category)
            }

            if isCheckingOut {
                ProgressView("Opening checkout…")
                    .controlSize(.small)
            }

            Text("Select a tier, then review your purchase in Stripe. Selecting a tier does not charge you.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .alert("Couldn’t open checkout", isPresented: Binding(
            get: { checkoutError != nil },
            set: { if !$0 { checkoutError = nil } }
        )) {
            Button("OK", role: .cancel) { checkoutError = nil }
        } message: {
            Text(checkoutError ?? "Please try again.")
        }
        .onDisappear { cancelCheckout() }
        .onChange(of: ObjectIdentifier(selection)) { _, _ in cancelCheckout() }
    }

    @ViewBuilder
    private func categoryChoices(_ category: PlanCategory) -> some View {
        let offers = catalog.offers.filter { $0.category == category && $0.interval == selection.interval }
        let selectedID = selection.selectedTier(for: category)
        let selectedOffer = offers.first { $0.tierID == selectedID }

        VStack(alignment: .leading, spacing: 10) {
            Text(category.title).font(.headline)
            ForEach(offers) { offer in
                Button {
                    selection.select(offer)
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: selectedID == offer.tierID ? "checkmark.circle.fill" : "circle")
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(offer.name).fontWeight(.medium)
                                if selectedID == offer.tierID {
                                    Text("Selected").font(.caption).fontWeight(.semibold)
                                }
                            }
                            Text(priceText(offer)).font(.caption)
                            if !offer.available {
                                Text(offer.unavailableReason ?? "Purchasing is currently unavailable.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(
                        selectedID == offer.tierID ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.06),
                        in: RoundedRectangle(cornerRadius: 8)
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isCheckingOut)
                .accessibilityValue(selectedID == offer.tierID ? "Selected" : "Not selected")
            }

            if offers.isEmpty {
                Text("No plans are available for this billing interval.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if selectedID != nil && selectedOffer == nil {
                Text("Your saved selection is kept, but isn’t currently offered for this interval. Choose another tier to change it.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Button(selectedOffer.map { "Buy \($0.name)" } ?? "Select a tier") {
                guard let offer = selectedOffer, offer.available else { return }
                beginCheckout(offer)
            }
            .disabled(selectedOffer?.available != true || isCheckingOut)
        }
        .padding(.vertical, 6)
    }

    private func priceText(_ offer: ServerPlanOffer) -> String {
        // Currency is supplied by the server and cents stay decimal for display.
        let amount = Decimal(offer.priceCents) / 100
        return "\(amount.formatted(.currency(code: offer.currency))) / \(offer.interval == .month ? "month" : "year")"
    }

    private func beginCheckout(_ offer: ServerPlanOffer) {
        guard !isCheckingOut, offer.available else { return }
        isCheckingOut = true
        checkoutError = nil
        let attempt = UUID()
        checkoutAttempt = attempt
        let request = PlanCheckoutRequest(category: offer.category, tierID: offer.tierID, interval: offer.interval)
        checkoutTask = Task { @MainActor in
            defer {
                if checkoutAttempt == attempt {
                    isCheckingOut = false
                    checkoutTask = nil
                    checkoutAttempt = nil
                }
            }
            do {
                let url = try await checkout(request)
                try Task.checkCancellation()
                guard checkoutAttempt == attempt else { return }
                guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
                      parts.scheme?.lowercased() == "https",
                      parts.host?.lowercased() == "checkout.stripe.com",
                      parts.user == nil, parts.password == nil, parts.port == nil,
                      parts.path.hasPrefix("/c/pay/") || parts.path.hasPrefix("/pay/") else {
                    throw PlanSelectionError.invalidCheckoutURL
                }
                openURL(url) { accepted in
                    if !accepted {
                        checkoutError = "The browser couldn’t open Stripe. Please try again."
                    }
                }
            } catch is CancellationError {
                // Leaving the account/workspace must not open a stale checkout.
            } catch {
                // Backend/transport errors can contain credentials or internal
                // URLs. The caller may record a redacted diagnostic separately.
                checkoutError = "Checkout couldn’t be started. Refresh plans and try again."
            }
        }
    }

    private func cancelCheckout() {
        checkoutAttempt = nil
        checkoutTask?.cancel()
        checkoutTask = nil
        isCheckingOut = false
        checkoutError = nil
    }
}
