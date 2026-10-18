import AppKit
import Foundation

// Red-XAI Updater watches grim-apps-manifest.json. GenDragoon Cloud SSD is first.
// The signed parent build compiles this into Contents/Resources/Red-XAI Updater.app.
// Replacement itself is performed by redxai_updater.py so the same rules run in tests.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let manifest = Bundle.main.url(forResource: "grim-apps-manifest", withExtension: "json")
fputs(manifest == nil ? "Red-XAI Updater is waiting for a manifest.\n" : "Red-XAI Updater is watching updates.\n", stderr)
DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { app.terminate(nil) }
app.run()
