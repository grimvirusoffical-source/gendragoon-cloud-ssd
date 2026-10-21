// The Swift participant of the cross-language interop check (sdk/contract/run.sh). It opens the shared encrypted
// drive "interop", verifies every file written by the other SDKs and writes its own. Configuration comes from
// GD_SDK_BASE, GD_SDK_KEY, GD_SDK_PASSPHRASE and GD_SDK_LANG; with --init it creates the master key first.
import Foundation
import Gendragoon

let env = ProcessInfo.processInfo.environment
let lang = env["GD_SDK_LANG"] ?? "swift"
do {
    let c = try Client(base: env["GD_SDK_BASE"] ?? "", apiKey: env["GD_SDK_KEY"] ?? "")
    let keys = Keyring(c)
    let pass = env["GD_SDK_PASSPHRASE"] ?? ""
    if CommandLine.arguments.contains("--init") { try await keys.create(pass) } else { try await keys.unlock(pass) }
    let d = try Drive(c, name: "interop", keys: keys)
    var verified: [String] = []
    for e in try await d.list("") where !e.folder && e.name.hasPrefix("from-") {
        var who = String(e.name.dropFirst(5))
        if who.hasSuffix(".txt") { who.removeLast(4) }
        let got = String(decoding: try await d.readFile(e.path), as: UTF8.self)
        guard got == "hello from \(who)\n" else { FileHandle.standardError.write(Data("\(e.path): unexpected content\n".utf8)); exit(1) }
        verified.append(who)
    }
    try await d.writeFile("from-\(lang).txt", Data("hello from \(lang)\n".utf8))
    let out = try JSONSerialization.data(withJSONObject: ["lang": lang, "verified": verified], options: [.sortedKeys])
    print(String(decoding: out, as: UTF8.self))
} catch {
    FileHandle.standardError.write(Data("gd-interop: \(error)\n".utf8))
    exit(1)
}
