import Foundation

// Only collaboration metadata crosses the embedded Teams boundary. Storage,
// API keys, device registration, and account administration are not permitted.
enum GDTeamsBridgePolicy {
    static func permits(path: String, method: String) -> Bool {
        guard path.utf8.count <= 4096, path.hasPrefix("/v1/receivers/"),
              !path.contains(".."), !path.contains("\\"), !path.contains("#"),
              !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              let components = URLComponents(string: path), components.scheme == nil,
              components.host == nil, components.fragment == nil else { return false }
        let route = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? ""
        guard !route.contains("%") else { return false }
        if route == "/v1/receivers/me/dev-community" || route == "/v1/receivers/me/dev-profile" {
            return ["GET", "PUT"].contains(method) && components.query == nil
        }
        if route == "/v1/receivers/me/dev-teams" { return method == "GET" }
        let rules: [(String, Set<String>)] = [
            (#"^/v1/receivers/me/workspaces/[a-f0-9]{32}/team$"#, ["POST"]),
            (#"^/v1/receivers/me/dev-reports$"#, ["GET"]),
            (#"^/v1/receivers/me/dev-reports/[a-f0-9]{32}$"#, ["GET", "PATCH"]),
            (#"^/v1/receivers/teams/join$"#, ["POST"]),
            (#"^/v1/receivers/teams/[a-f0-9]{32}$"#, ["GET", "PATCH", "DELETE"]),
            (#"^/v1/receivers/teams/[a-f0-9]{32}/(?:members|messages|signals|invites|reports)$"#, ["GET", "POST"]),
            (#"^/v1/receivers/teams/[a-f0-9]{32}/(?:members|invites)/[a-f0-9]{32}$"#, ["GET", "PATCH", "DELETE"]),
            (#"^/v1/receivers/teams/[a-f0-9]{32}/reports/[a-f0-9]{32}$"#, ["GET", "PATCH"]),
            (#"^/v1/receivers/teams/[a-f0-9]{32}/presence$"#, ["PUT"]),
            (#"^/v1/receivers/teams/[a-f0-9]{32}/membership$"#, ["DELETE"]),
            (#"^/v1/receivers/teams/[a-f0-9]{32}/blocks(?:/[a-f0-9]{32})?$"#, ["GET", "PUT", "DELETE"])
        ]
        return rules.contains { pattern, methods in
            methods.contains(method) && route.range(of: pattern, options: .regularExpression) != nil &&
                (method == "GET" || components.query == nil)
        }
    }
}
