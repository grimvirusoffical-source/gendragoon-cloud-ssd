import Foundation

/// Navigation prerequisites only. Authentication and workspace authorization
/// remain enforced by the server; a mount is not proof of identity.
enum GDWorkspaceSetupPolicy {
    enum Stage: String, Equatable {
        case signIn, chooseWorkspace, mount, sign, ready
        var title: String {
            switch self {
            case .signIn: return "Connect your Red-XAI account"
            case .chooseWorkspace: return "Choose or create your workspace"
            case .mount: return "Step 1 · Mount your SSD"
            case .sign: return "Step 2 · Sign this Mac"
            case .ready: return "SSD mounted · Mac signed"
            }
        }
        var explanation: String {
            switch self {
            case .signIn: return "Home and Account stay available so you can sign in and prepare your storage vault."
            case .chooseWorkspace: return "Select a MachineNote owned by this account before mounting."
            case .mount: return "Mount the selected workspace first. Sign this Mac stays disabled until its mount is confirmed."
            case .sign: return "The SSD is mounted. Sign this Mac and wait for server confirmation to unlock Files, Applications, Teams and the other pages."
            case .ready: return "Both setup steps are confirmed for the selected workspace."
            }
        }
    }

    static func stage(linked: Bool, receiver: String, workspace: String?, owned: Set<String>,
                      mounted: Set<String>, signed: Set<String>) -> Stage {
        guard linked, receiver.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { return .signIn }
        guard let workspace, workspace.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
              owned.contains(workspace) else { return .chooseWorkspace }
        guard mounted.contains(workspace) else { return .mount }
        guard signed.contains(workspace) else { return .sign }
        return .ready
    }

    static func mayOpen(page: String, stage: Stage) -> Bool {
        page == "Home" || page == "Account" || stage == .ready
    }
}
