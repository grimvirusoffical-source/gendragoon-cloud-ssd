import Foundation

/// Catalog labels are client-reported hints. They never replace validation of
/// the restored bundle, its signature, architecture or supported platforms.
struct GDDeviceOrigin: Decodable {
    let schema: Int
    let platform: String
    let architecture: String
    let deviceId: String
    var platformCode: String { schema == 1 && GDApplicationPlatform.codes.contains(platform) ? platform : "unknown" }
    var label: String {
        let name = GDApplicationPlatform.label(platformCode)
        guard deviceId.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else { return name }
        return name + " · " + String(deviceId.prefix(6))
    }
}

enum GDApplicationPlatform {
    static let codes = ["macos", "windows", "linux", "android", "ios", "unknown"]
    static func label(_ code: String) -> String {
        switch code {
        case "macos": return "Mac"
        case "windows": return "Windows"
        case "linux": return "Linux"
        case "android": return "Android"
        case "ios": return "iOS"
        default: return "Unknown device"
        }
    }
    static func hint(name: String, kind: String?, declared: String?) -> String? {
        guard kind == "app" || kind == "file" else { return nil }
        let inferred: String?
        let suffix = URL(fileURLWithPath: name).pathExtension.lowercased()
        switch suffix {
        case "exe", "msi", "msix", "appx", "msixbundle", "appxbundle": inferred = "windows"
        case "appimage", "deb", "rpm": inferred = "linux"
        case "apk": inferred = "android"
        case "ipa": inferred = "ios"
        default: inferred = kind == "app" ? "macos" : nil
        }
        guard let declared else { return inferred }
        guard codes.contains(declared), inferred == nil || declared == inferred else { return "unknown" }
        return declared
    }
    static func mayRestoreOnMac(_ hint: String?) -> Bool { hint == nil || hint == "macos" }
}
