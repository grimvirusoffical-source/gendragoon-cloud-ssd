import SwiftUI

/// Add this section to the application's About / Account view.
public enum GendragoonAbout {
    public static let ownership = "Gendragoon is developed and maintained by Red-XAI LLC. Red-XAI LLC is wholly owned by GRIM-VIRUS, an independent recording artist who leads development under the alias MainDirectory. © Red-XAI LLC. All rights reserved."
    public static let copyright = "© Red-XAI LLC"
}

@MainActor
public struct AboutSection: View {
    public init() {}
    public var body: some View {
        Section("About") {
            Text(GendragoonAbout.ownership)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .accessibilityIdentifier("about-ownership")
        }
    }
}
