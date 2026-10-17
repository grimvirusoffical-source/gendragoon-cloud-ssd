import Foundation

/// The account's selected project drives native tuning as well as file transfers.
/// The Python helper revalidates this short-lived bearer with the sealed backend.
@MainActor final class GDNativePerformance {
    static let shared = GDNativePerformance()
    private weak var login: GDLoginSession?
    private var workspaceID = "free"
    private var constrained = false

    func configure(login: GDLoginSession, workspaceID: String, constrained: Bool = false) {
        self.login = login
        self.workspaceID = workspaceID
        self.constrained = constrained
    }

    func clear() {
        login = nil
        workspaceID = "free"
        constrained = false
    }

    func helperInput() async -> Data? {
        guard let login, login.stage == .ready else { return nil }
        let account = login.userID, workspace = workspaceID, saver = constrained
        guard let token = try? await login.tokenForTransfer(), login.userID == account,
              workspaceID == workspace, constrained == saver else { return nil }
        return try? JSONSerialization.data(withJSONObject: ["workspaceId": workspace,
            "bearerToken": token, "constrained": saver])
    }
}
