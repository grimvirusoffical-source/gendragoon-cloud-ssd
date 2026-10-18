import SwiftUI

@main
struct GenDragoonCloudSSDApp: App {
    @NSApplicationDelegateAdaptor(GDAppLifetime.self) private var appLifetime
    var body: some Scene {
        WindowGroup { GenDragoonStartupRoot() }
            .windowStyle(.titleBar)
    }
}
