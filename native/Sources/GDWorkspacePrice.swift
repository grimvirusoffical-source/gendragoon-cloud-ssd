import CoreFoundation
import Foundation

/// Workspace prices and lock scope. Dollar amounts come from a server field.
/// Free wins over Included. Included wins over a formatted monthly price.
enum GDWorkspacePriceLabel {
    static func cents(_ value: Any?) -> Int? {
        if let number = value as? Int { return number }
        if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            return number.intValue
        }
        return nil
    }

    /// Free, then Included (`grandfathered` or `feeWaived`), then the formatted monthly price.
    /// A zero price is `isFree || grandfathered || feeWaived`.
    static func label(isFree: Bool, grandfathered: Bool, feeWaived: Bool, monthlyPriceCents: Int?) -> String {
        if isFree { return "Free" }
        if grandfathered || feeWaived { return "Included" }
        guard let monthlyPriceCents else { return "Price pending" }
        return format(monthlyPriceCents)
    }

    static func isZeroPrice(isFree: Bool, grandfathered: Bool, feeWaived: Bool) -> Bool {
        isFree || grandfathered || feeWaived
    }

    static func format(_ cents: Int) -> String {
        let sign = cents < 0 ? "-" : ""
        let value = abs(cents)
        if value % 100 == 0 { return "\(sign)$\(value / 100)/mo" }
        return String(format: "\(sign)$%.2f/month", Double(value) / 100)
    }

    /// BYO on a grandfathered workspace ends Included access.
    static func requiresGrandfatheredBYOConfirmation(isFree: Bool, grandfathered: Bool) -> Bool {
        grandfathered && !isFree
    }

    static func byoConfirmationAllowsSubmit(isFree: Bool, grandfathered: Bool, acknowledged: Bool) -> Bool {
        !requiresGrandfatheredBYOConfirmation(isFree: isFree, grandfathered: grandfathered) || acknowledged
    }

    /// The price in a BYO register response. `grandfatheringEnded` means Included access is over.
    static func byoRegisterPrice(_ json: [String: Any]) -> Int? {
        guard json["grandfatheringEnded"] as? Bool == true, json["grandfathered"] as? Bool == false else { return nil }
        return cents(json["monthlyPriceCents"])
    }

    static func grandfatheredBYONotice(response: [String: Any]) -> String? {
        guard let price = byoRegisterPrice(response) else { return nil }
        return "This workspace will no longer be Included. It will cost \(format(price))."
    }

    static func byoRegisteredStatus(_ json: [String: Any]) -> String {
        let isFree = json["isFree"] as? Bool ?? false
        let grandfathered = json["grandfathered"] as? Bool ?? false
        let feeWaived = json["feeWaived"] as? Bool ?? false
        let price = label(isFree: isFree, grandfathered: grandfathered, feeWaived: feeWaived, monthlyPriceCents: cents(json["monthlyPriceCents"]))
        let status = (json["projectStatus"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "active"
        let lapsed = json["lapsed"] as? Bool == true
        let payment = lapsed ? " Payment is required for this workspace." : ""
        return "Bring-your-own storage registered. This workspace is \(price). Status: \(status).\(payment)"
    }

    static func workspaceID(in path: String) -> String? {
        let parts = path.split(separator: "/").map(String.init)
        for marker in ["workspaces", "projects", "cloud"] {
            guard let index = parts.firstIndex(of: marker), parts.count > index + 1 else { continue }
            let id = parts[index + 1]
            if id == "free" || UUID(uuidString: id) != nil { return id }
        }
        return nil
    }

    /// A 423 locks only the workspace the request addressed. It never locks the app.
    static func lockedWorkspaceIDs(requestWorkspaceID: String?, reason: String, unpaid: [String]) -> [String] {
        if let requestWorkspaceID, !requestWorkspaceID.isEmpty { return [requestWorkspaceID] }
        if reason == "lapsed" || reason == "over_cap_and_lapsed" { return unpaid }
        return []
    }

    static func transferLockMessage(reason: String, scopedWorkspace: Bool) -> String {
        let base: String
        switch reason {
        case "merge_in_progress":
            base = "A workspace merge is still in progress. Wait for it to finish before uploading."
        case "lapsed", "over_cap_and_lapsed":
            base = "This workspace needs payment before uploads can continue."
        default:
            base = scopedWorkspace
                ? "This workspace is outside the current allowance."
                : "This account is over its workspace limit. Delete or merge the extra workspaces."
        }
        if scopedWorkspace {
            return base + " This lock applies only to this workspace. Free and paid workspaces stay available. Downloads stay available."
        }
        return base + " Downloads stay available."
    }

    static func graceEnd(_ json: [String: Any]) -> Date? {
        if let text = json["graceEndsAt"] as? String { return parseDate(text) }
        if let date = epochDate(json["graceEndsAt"]) { return date }
        return epochDate(json["graceEndsAtMs"])
    }

    /// Millisecond clocks from Riley stay on `doubleValue`. `intValue` overflows them.
    static func epochDate(_ value: Any?) -> Date? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let raw = number.doubleValue
        guard raw > 0 else { return nil }
        return Date(timeIntervalSince1970: raw > 10_000_000_000 ? raw / 1000 : raw)
    }

    /// `make-hosted` and merge share this object. The banner is only for `demoted.workspaceId`.
    struct GDDemotedWorkspace: Equatable {
        var workspaceID: String
        var graceEndsAt: Date
        var monthlyPriceCents: Int?
        var checkoutURL: URL?
    }

    static func demotedWorkspace(_ json: [String: Any]) -> GDDemotedWorkspace? {
        guard let demoted = json["demoted"] as? [String: Any],
              let workspaceID = demoted["workspaceId"] as? String, !workspaceID.isEmpty,
              let graceEndsAt = graceEnd(demoted) else { return nil }
        var checkout: URL?
        if let text = demoted["checkoutUrl"] as? String, let url = URL(string: text),
           url.scheme == "https", url.host == "checkout.stripe.com" {
            checkout = url
        }
        return GDDemotedWorkspace(workspaceID: workspaceID, graceEndsAt: graceEndsAt,
                                  monthlyPriceCents: cents(demoted["workspaceMonthlyCents"]), checkoutURL: checkout)
    }

    static func paymentBannerTitle(workspaceName: String, graceEndsAt: Date?) -> String {
        graceEndsAt == nil ? "\(workspaceName) needs payment" : "Payment due"
    }

    static func paymentButtonTitle(graceEndsAt: Date?) -> String {
        graceEndsAt == nil ? "Pay this workspace" : "Pay"
    }

    /// Demotion grace does not block uploads. A later 423 does.
    static let graceBlocksTransfers = false
    static let deletingTitle = "Deleting…"

    static func actionsEnabled(projectStatus: String?) -> Bool {
        projectStatus != "deleting"
    }

    static func graceCountdown(until end: Date, now: Date) -> String? {
        let remaining = end.timeIntervalSince(now)
        if remaining <= 0 { return "Grace period ended." }
        let total = Int(remaining)
        let days = total / 86_400
        let hours = (total % 86_400) / 3_600
        let minutes = (total % 3_600) / 60
        if days > 0 { return "Grace period: \(days)d \(hours)h remaining." }
        if hours > 0 { return "Grace period: \(hours)h \(minutes)m remaining." }
        return "Grace period: \(max(1, minutes))m remaining."
    }

    /// 409 while a merge, upload, or checkout is still running.
    static func deletionBlocked(status: Int, json: [String: Any]) -> String? {
        guard status == 409 else { return nil }
        switch GDServerCode.read(json).uppercased() {
        case "WORKSPACE_BUSY":
            return "This workspace is busy, try again."
        case "MERGE_IN_PROGRESS":
            return "Finish or cancel the merge first."
        case "PROJECT_HAS_PENDING_UPLOADS", "UPLOAD_IN_PROGRESS":
            return "Finish or cancel the upload first."
        case "CHECKOUT_BUSY", "PAYMENT_PENDING", "CHECKOUT_IN_PROGRESS":
            return "Finish or cancel checkout first."
        default:
            break
        }
        switch ((json["blocking"] as? String) ?? (json["inProgress"] as? String) ?? "").lowercased() {
        case "merge": return "Finish or cancel the merge first."
        case "upload": return "Finish or cancel the upload first."
        case "checkout": return "Finish or cancel checkout first."
        default: return nil
        }
    }

    private static func parseDate(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }
}
