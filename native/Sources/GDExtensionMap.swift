import Foundation

/// Extension groups from native/Backend/mobile/extension-map.json.
/// Drive cleanup keeps its Media/… folders; these names are the shared types.
enum GDExtensionMap {
    static let pictures: Set<String> = ["bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "raw", "svg", "tif", "tiff", "webp"]
    static let videos: Set<String> = ["3gp", "avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm"]
    static let audio: Set<String> = ["aac", "aif", "aiff", "flac", "m4a", "mp3", "ogg", "opus", "wav"]
    static let documents: Set<String> = ["csv", "doc", "docx", "json", "key", "md", "numbers", "pages", "pdf", "ppt", "pptx", "rtf", "txt", "xls", "xlsx"]
    static let apps: Set<String> = ["app", "dmg", "pkg"]
    static let archives: Set<String> = ["7z", "aab", "apk", "gz", "ipa", "rar", "tar", "zip"]

    static func kind(_ name: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        if pictures.contains(ext) { return "pictures" }
        if videos.contains(ext) { return "videos" }
        if audio.contains(ext) { return "audio" }
        if documents.contains(ext) { return "documents" }
        if apps.contains(ext) { return "apps" }
        if archives.contains(ext) { return "archives" }
        return "other"
    }
}
