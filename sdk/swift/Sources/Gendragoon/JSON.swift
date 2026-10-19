import Foundation

/// An ordered JSON value. Writing keeps key order so documents match the other SDKs byte for byte.
enum JV {
    case null, bool(Bool), int(Int64), str(String), arr([JV]), obj([(String, JV)])

    var text: String { var s = ""; write(&s); return s }
    var data: Data { Data(text.utf8) }

    func write(_ s: inout String) {
        switch self {
        case .null: s += "null"
        case .bool(let b): s += b ? "true" : "false"
        case .int(let n): s += String(n)
        case .str(let v):
            s += "\""
            for u in v.unicodeScalars {
                switch u {
                case "\"": s += "\\\""
                case "\\": s += "\\\\"
                case "\n": s += "\\n"
                case "\r": s += "\\r"
                case "\t": s += "\\t"
                default:
                    if u.value < 0x20 { s += String(format: "\\u%04x", u.value) } else { s.unicodeScalars.append(u) }
                }
            }
            s += "\""
        case .arr(let a):
            s += "["
            for (i, v) in a.enumerated() { if i > 0 { s += "," }; v.write(&s) }
            s += "]"
        case .obj(let o):
            s += "{"
            for (i, kv) in o.enumerated() { if i > 0 { s += "," }; JV.str(kv.0).write(&s); s += ":"; kv.1.write(&s) }
            s += "}"
        }
    }

    static func strs(_ a: [String]) -> JV { .arr(a.map { .str($0) }) }
}

/// Reading helpers over JSONSerialization output.
typealias JObj = [String: Any]

func parseObject(_ data: Data) throws -> JObj {
    guard let o = (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) as? JObj else { throw GendragoonError.corrupt }
    return o
}

extension Dictionary where Key == String, Value == Any {
    func s(_ k: String) -> String { self[k] as? String ?? "" }
    func os(_ k: String) -> String? { self[k] as? String }
    func l(_ k: String) -> Int64 {
        if let n = self[k] as? Int64 { return n }
        if let n = self[k] as? Int { return Int64(n) }
        if let n = self[k] as? Double { return Int64(n) }
        if let n = self[k] as? NSNumber { return n.int64Value }
        return 0
    }
    func b(_ k: String) -> Bool { self[k] as? Bool ?? false }
    func o(_ k: String) -> JObj { self[k] as? JObj ?? [:] }
    func a(_ k: String) -> [Any] { self[k] as? [Any] ?? [] }
    func ss(_ k: String) -> [String] { a(k).compactMap { $0 as? String } }
}
