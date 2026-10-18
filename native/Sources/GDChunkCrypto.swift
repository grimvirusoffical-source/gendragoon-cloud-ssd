import CryptoKit
import Foundation
import Security

/// Chunked AES-256-GCM. Each chunk has its own nonce. Plaintext is copied one chunk at a time.
enum GDChunkCrypto {
    static let magic = Data("GDCK".utf8)
    static let defaultChunkBytes = 1024 * 1024

    static func seal(plaintext: Data, key: SymmetricKey, chunkBytes: Int = defaultChunkBytes) throws -> Data {
        let output = Output()
        try writeHeader(chunkBytes, to: output)
        var offset = 0
        while offset < plaintext.count {
            let end = min(offset + chunkBytes, plaintext.count)
            try writeChunk(plaintext.subdata(in: offset..<end), key: key, to: output)
            offset = end
        }
        if plaintext.isEmpty { try writeChunk(Data(), key: key, to: output) }
        return output.data
    }

    static func open(sealed: Data, key: SymmetricKey) throws -> Data {
        var offset = 0
        _ = try readHeader(sealed, offset: &offset)
        var plain = Data()
        while offset < sealed.count {
            plain.append(try readChunk(sealed, offset: &offset, key: key))
        }
        return plain
    }

    static func sealFile(source: URL, destination: URL, key: SymmetricKey, chunkBytes: Int = defaultChunkBytes) throws -> String {
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        FileManager.default.createFile(atPath: destination.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }
        let writer = Output()
        try writeHeader(chunkBytes, to: writer)
        try output.write(contentsOf: writer.data)
        var crc = GDChunkChecksum()
        var wrote = false
        while true {
            let chunk = try input.read(upToCount: chunkBytes) ?? Data()
            if chunk.isEmpty { break }
            wrote = true
            crc.update(chunk)
            let framed = Output()
            try writeChunk(chunk, key: key, to: framed)
            try output.write(contentsOf: framed.data)
        }
        if !wrote {
            let framed = Output()
            try writeChunk(Data(), key: key, to: framed)
            try output.write(contentsOf: framed.data)
        }
        return crc.hex
    }

    static func openFile(source: URL, destination: URL, key: SymmetricKey) throws -> String {
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        let header = try input.read(upToCount: 9) ?? Data()
        var offset = 0
        _ = try readHeader(header, offset: &offset)
        FileManager.default.createFile(atPath: destination.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }
        var crc = GDChunkChecksum()
        while true {
            let lengthPrefix = try input.read(upToCount: 4) ?? Data()
            if lengthPrefix.isEmpty { break }
            guard lengthPrefix.count == 4 else { throw GDStorageContractError.message("Sealed file ended early.") }
            let length = Int(readUInt32(lengthPrefix, 0))
            let combined = try input.read(upToCount: length + 28) ?? Data()
            guard combined.count == length + 28 else { throw GDStorageContractError.message("Sealed file ended early.") }
            let box = try AES.GCM.SealedBox(combined: combined)
            let plain = try AES.GCM.open(box, using: key)
            crc.update(plain)
            try output.write(contentsOf: plain)
        }
        return crc.hex
    }

    private final class Output {
        var data = Data()
        func append(_ value: Data) { data.append(value) }
        func append(_ value: UInt32) {
            var little = value.littleEndian
            data.append(Data(bytes: &little, count: 4))
        }
        func append(_ value: UInt8) { data.append(value) }
    }

    private static func writeHeader(_ chunkBytes: Int, to output: Output) throws {
        guard (1...8 * 1024 * 1024).contains(chunkBytes) else {
            throw GDStorageContractError.message("Chunk size is outside the supported range.")
        }
        output.append(magic)
        output.append(UInt8(1))
        output.append(UInt32(chunkBytes))
    }

    private static func writeChunk(_ plain: Data, key: SymmetricKey, to output: Output) throws {
        let sealed = try AES.GCM.seal(plain, using: key)
        guard let combined = sealed.combined, combined.count == plain.count + 28 else {
            throw GDStorageContractError.message("The file could not be sealed on this Mac.")
        }
        output.append(UInt32(plain.count))
        output.append(combined)
    }

    private static func readHeader(_ data: Data, offset: inout Int) throws -> Int {
        guard data.count >= offset + 9, data.subdata(in: offset..<offset + 4) == magic, data[offset + 4] == 1 else {
            throw GDStorageContractError.message("Sealed file header is not recognized.")
        }
        let size = Int(readUInt32(data, offset + 5))
        offset += 9
        guard (1...8 * 1024 * 1024).contains(size) else {
            throw GDStorageContractError.message("Sealed file header is not recognized.")
        }
        return size
    }

    private static func readChunk(_ data: Data, offset: inout Int, key: SymmetricKey) throws -> Data {
        guard offset + 4 <= data.count else { throw GDStorageContractError.message("Sealed file ended early.") }
        let length = Int(readUInt32(data, offset))
        offset += 4
        let combinedLength = length + 28
        guard offset + combinedLength <= data.count else { throw GDStorageContractError.message("Sealed file ended early.") }
        let combined = data.subdata(in: offset..<offset + combinedLength)
        offset += combinedLength
        let box = try AES.GCM.SealedBox(combined: combined)
        return try AES.GCM.open(box, using: key)
    }

    private static func readUInt32(_ data: Data, _ offset: Int) -> UInt32 {
        data.subdata(in: offset..<offset + 4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).littleEndian }
    }
}

struct GDChunkChecksum {
    private static let table: [UInt32] = {
        (0..<256).map { index in
            var crc = UInt32(index)
            for _ in 0..<8 {
                crc = (crc & 1) == 1 ? (0x82F63B78 ^ (crc >> 1)) : (crc >> 1)
            }
            return crc
        }
    }()
    private var value: UInt32 = 0xFFFFFFFF
    mutating func update(_ data: Data) {
        for byte in data {
            value = Self.table[Int((value ^ UInt32(byte)) & 0xFF)] ^ (value >> 8)
        }
    }
    var hex: String { String(format: "%08x", value ^ 0xFFFFFFFF) }
}

enum GDWorkspaceKeyEnvelope {
    struct Envelope: Equatable {
        var version: Int
        var kdf: String
        var memoryKiB: Int
        var iterations: Int
        var parallelism: Int
        var salt: Data
        var nonce: Data
        var wrappedKey: Data
    }

    static func wrap(workspaceKey: Data, passphrase: String, parameters: GDArgon2.Parameters, version: Int = 1) throws -> Envelope {
        guard workspaceKey.count == 32, !passphrase.isEmpty else {
            throw GDStorageContractError.message("A workspace key and a recovery passphrase are required.")
        }
        var salt = Data(count: 16)
        let saltStatus = salt.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        guard saltStatus == errSecSuccess else {
            throw GDStorageContractError.message("A recovery salt could not be generated.")
        }
        let derived = GDArgon2.derive(password: Data(passphrase.utf8), salt: salt, parameters: parameters)
        let sealingKey = SymmetricKey(data: derived.prefix(32))
        let sealed = try AES.GCM.seal(workspaceKey, using: sealingKey)
        guard let combined = sealed.combined else {
            throw GDStorageContractError.message("The workspace key could not be wrapped.")
        }
        let nonce = sealed.nonce.withUnsafeBytes { Data($0) }
        return Envelope(version: version, kdf: "argon2id", memoryKiB: parameters.memoryKiB,
                        iterations: parameters.iterations, parallelism: parameters.parallelism,
                        salt: salt, nonce: nonce, wrappedKey: combined)
    }

    static func unwrap(envelope: Envelope, passphrase: String) throws -> Data {
        guard envelope.kdf == "argon2id", envelope.version >= 1, envelope.salt.count == 16 else {
            throw GDStorageContractError.message("This recovery envelope is not an Argon2id workspace key.")
        }
        let parameters = GDArgon2.Parameters(memoryKiB: envelope.memoryKiB, iterations: envelope.iterations,
                                             parallelism: envelope.parallelism, tagLength: 32)
        let derived = GDArgon2.derive(password: Data(passphrase.utf8), salt: envelope.salt, parameters: parameters)
        let box = try AES.GCM.SealedBox(combined: envelope.wrappedKey)
        let key = try AES.GCM.open(box, using: SymmetricKey(data: derived.prefix(32)))
        guard key.count == 32 else {
            throw GDStorageContractError.message("The unwrapped workspace key is not 256 bits.")
        }
        return key
    }
}
