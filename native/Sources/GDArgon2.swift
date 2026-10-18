import Foundation
import CryptoKit

/// Argon2id (RFC 9106) as implemented by the PHC reference code.
/// H0 is Blake2b-512 of the parameter block. Variable-length H' prepends the output length.
/// Production envelopes use the second recommended option: 64 MiB, 3 passes, 4 lanes.
enum GDArgon2 {
    struct Parameters: Equatable {
        var memoryKiB: Int
        var iterations: Int
        var parallelism: Int
        var tagLength: Int
        static let production = Parameters(memoryKiB: 65536, iterations: 3, parallelism: 4, tagLength: 32)
        static let interactiveTest = Parameters(memoryKiB: 32, iterations: 3, parallelism: 4, tagLength: 32)
    }

    static func derive(password: Data, salt: Data, secret: Data = Data(), associatedData: Data = Data(), parameters: Parameters) -> Data {
        let lanes = parameters.parallelism
        let passes = parameters.iterations
        let mCost = parameters.memoryKiB
        let tagLength = parameters.tagLength
        precondition(lanes >= 1 && passes >= 1 && tagLength >= 4 && mCost >= 8 * lanes)
        var blob = Data()
        blob.append(le32(lanes))
        blob.append(le32(tagLength))
        blob.append(le32(mCost))
        blob.append(le32(passes))
        blob.append(le32(0x13))
        blob.append(le32(2))
        blob.append(le32(password.count))
        blob.append(password)
        blob.append(le32(salt.count))
        blob.append(salt)
        blob.append(le32(secret.count))
        blob.append(secret)
        blob.append(le32(associatedData.count))
        blob.append(associatedData)
        let h0 = Data(SHA512.blake2b(blob))
        let mPrime = 4 * lanes * (mCost / (4 * lanes))
        let laneLength = mPrime / lanes
        let segmentLength = laneLength / 4
        var memory = Array(repeating: Block.zero, count: mPrime)
        for lane in 0..<lanes {
            var seed = h0
            seed.append(contentsOf: [UInt8](repeating: 0, count: 8))
            seed.replaceSubrange(64..<68, with: le32(0))
            seed.replaceSubrange(68..<72, with: le32(lane))
            memory[lane * laneLength] = Block(raw: hPrime(1024, seed.prefix(72)))
            seed.replaceSubrange(64..<68, with: le32(1))
            memory[lane * laneLength + 1] = Block(raw: hPrime(1024, seed.prefix(72)))
        }
        for pass in 0..<passes {
            for slice in 0..<4 {
                for lane in 0..<lanes {
                    let dataIndependent = pass == 0 && slice < 2
                    var input = Block.zero
                    var address = Block.zero
                    if dataIndependent {
                        input.words[0] = UInt64(pass)
                        input.words[1] = UInt64(lane)
                        input.words[2] = UInt64(slice)
                        input.words[3] = UInt64(mPrime)
                        input.words[4] = UInt64(passes)
                        input.words[5] = 2
                    }
                    let starting = (pass == 0 && slice == 0) ? 2 : 0
                    if dataIndependent && starting == 2 {
                        input.words[6] &+= 1
                        address = fill(Block.zero, input, nil, false)
                        address = fill(Block.zero, address, nil, false)
                    }
                    var current = lane * laneLength + slice * segmentLength + starting
                    var previous = current % laneLength == 0 ? current + laneLength - 1 : current - 1
                    if starting < segmentLength {
                        for index in starting..<segmentLength {
                            if current % laneLength == 1 { previous = current - 1 }
                            let pseudo: UInt64
                            if dataIndependent {
                                if index % 128 == 0 {
                                    input.words[6] &+= 1
                                    address = fill(Block.zero, input, nil, false)
                                    address = fill(Block.zero, address, nil, false)
                                }
                                pseudo = address.words[index % 128]
                            } else {
                                pseudo = memory[previous].words[0]
                            }
                            var refLane = Int((pseudo >> 32) % UInt64(lanes))
                            if pass == 0 && slice == 0 { refLane = lane }
                            let refIndex = indexAlpha(laneLength: laneLength, segmentLength: segmentLength, pass: pass, slice: slice, index: index, pseudo: pseudo, sameLane: refLane == lane)
                            let reference = memory[refLane * laneLength + refIndex]
                            let old = memory[current]
                            memory[current] = fill(memory[previous], reference, old, pass != 0)
                            current += 1
                            previous += 1
                        }
                    }
                }
            }
        }
        var mixed = memory[laneLength - 1]
        if lanes > 1 {
            for lane in 1..<lanes {
                mixed = mixed.xored(memory[lane * laneLength + laneLength - 1])
            }
        }
        return hPrime(tagLength, mixed.raw)
    }

    private struct Block {
        var words: [UInt64]
        static var zero: Block { Block(words: Array(repeating: 0, count: 128)) }
        init(words: [UInt64]) { self.words = words }
        init(raw: Data) {
            var values = [UInt64]()
            values.reserveCapacity(128)
            raw.withUnsafeBytes { buffer in
                for index in 0..<128 {
                    let offset = index * 8
                    let value = buffer.loadUnaligned(fromByteOffset: offset, as: UInt64.self).littleEndian
                    values.append(value)
                }
            }
            words = values
        }
        var raw: Data {
            var data = Data(count: 1024)
            data.withUnsafeMutableBytes { buffer in
                for index in 0..<128 {
                    buffer.storeBytes(of: words[index].littleEndian, toByteOffset: index * 8, as: UInt64.self)
                }
            }
            return data
        }
        func xored(_ other: Block) -> Block {
            Block(words: zip(words, other.words).map { $0 &^ $1 })
        }
    }

    private static func fill(_ previous: Block, _ reference: Block, _ old: Block?, _ withXOR: Bool) -> Block {
        var blockR = previous.xored(reference)
        var tmp = blockR
        if withXOR, let old {
            tmp = tmp.xored(old)
        }
        for row in 0..<8 {
            round(&blockR.words, Array(row * 16..<(row * 16 + 16)))
        }
        for row in 0..<8 {
            let indexes = [2 * row, 2 * row + 1, 2 * row + 16, 2 * row + 17, 2 * row + 32, 2 * row + 33, 2 * row + 48, 2 * row + 49,
                           2 * row + 64, 2 * row + 65, 2 * row + 80, 2 * row + 81, 2 * row + 96, 2 * row + 97, 2 * row + 112, 2 * row + 113]
            round(&blockR.words, indexes)
        }
        return tmp.xored(blockR)
    }

    private static func round(_ words: inout [UInt64], _ index: [Int]) {
        func g(_ a: Int, _ b: Int, _ c: Int, _ d: Int) {
            let ia = index[a], ib = index[b], ic = index[c], id = index[d]
            words[ia] = blamka(words[ia], words[ib])
            words[id] = rotr(words[id] ^ words[ia], 32)
            words[ic] = blamka(words[ic], words[id])
            words[ib] = rotr(words[ib] ^ words[ic], 24)
            words[ia] = blamka(words[ia], words[ib])
            words[id] = rotr(words[id] ^ words[ia], 16)
            words[ic] = blamka(words[ic], words[id])
            words[ib] = rotr(words[ib] ^ words[ic], 63)
        }
        g(0, 4, 8, 12); g(1, 5, 9, 13); g(2, 6, 10, 14); g(3, 7, 11, 15)
        g(0, 5, 10, 15); g(1, 6, 11, 12); g(2, 7, 8, 13); g(3, 4, 9, 14)
    }

    private static func blamka(_ x: UInt64, _ y: UInt64) -> UInt64 {
        let product = (x & 0xFFFFFFFF) &* (y & 0xFFFFFFFF)
        return x &+ y &+ (product &<< 1)
    }

    private static func rotr(_ x: UInt64, _ n: UInt64) -> UInt64 {
        (x &>> n) | (x &<< (64 - n))
    }

    private static func indexAlpha(laneLength: Int, segmentLength: Int, pass: Int, slice: Int, index: Int, pseudo: UInt64, sameLane: Bool) -> Int {
        let area: UInt64
        if pass == 0 {
            if slice == 0 {
                area = UInt64(bitPattern: Int64(index - 1))
            } else if sameLane {
                area = UInt64(slice * segmentLength + index - 1)
            } else {
                area = UInt64(bitPattern: Int64(slice * segmentLength + (index == 0 ? -1 : 0)))
            }
        } else if sameLane {
            area = UInt64(laneLength - segmentLength + index - 1)
        } else {
            area = UInt64(bitPattern: Int64(laneLength - segmentLength + (index == 0 ? -1 : 0)))
        }
        let truncated = UInt64(UInt32(truncatingIfNeeded: pseudo))
        let relative = (truncated &* truncated) >> 32
        let offset = area &- 1 &- ((area &* relative) >> 32)
        let start = pass == 0 ? 0 : (slice == 3 ? 0 : (slice + 1) * segmentLength)
        return (start + Int(offset)) % laneLength
    }

    private static func hPrime(_ length: Int, _ data: Data) -> Data {
        if length <= 64 {
            var input = le32(length)
            input.append(data)
            return Data(blake2b(input, length: length))
        }
        var output = Data()
        var input = le32(length)
        input.append(data)
        var chain = Data(blake2b(input, length: 64))
        output.append(chain.prefix(32))
        var remaining = length - 32
        while remaining > 64 {
            chain = Data(blake2b(chain, length: 64))
            output.append(chain.prefix(32))
            remaining -= 32
        }
        output.append(blake2b(chain, length: remaining))
        return output.prefix(length)
    }

    private static func blake2b(_ data: Data, length: Int) -> Data {
        // CryptoKit has no variable-length Blake2b. hashlib-compatible Blake2b-512 is SHA512? No.
        // Use the same Blake2b parameter block as hashlib via a small implementation for non-64
        // lengths, and CryptoKit is not Blake2b. Implemented below.
        Blake2b.hash(data, digestLength: length)
    }

    private static func le32(_ value: Int) -> Data {
        var little = UInt32(value).littleEndian
        return Data(bytes: &little, count: 4)
    }
}

/// Blake2b (RFC 7693), unkeyed, digest length 1...64.
private enum Blake2b {
    private static let iv: [UInt64] = [
        0x6A09E667F3BCC908, 0xBB67AE8584CAA73B, 0x3C6EF372FE94F82B, 0xA54FF53A5F1D36F1,
        0x510E527FADE682D1, 0x9B05688C2B3E6C1F, 0x1F83D9ABFB41BD6B, 0x5BE0CD19137E2179,
    ]
    private static let sigma: [[Int]] = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
        [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
        [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
        [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
        [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
        [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
        [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
        [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
        [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    ]

    static func hash(_ data: Data, digestLength: Int) -> Data {
        var state = iv
        var parameter = [UInt8](repeating: 0, count: 64)
        parameter[0] = UInt8(digestLength)
        parameter[1] = 0
        parameter[2] = 1
        parameter[3] = 1
        for index in 0..<8 {
            let word = parameter.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: index * 8, as: UInt64.self).littleEndian }
            state[index] ^= word
        }
        var offset = 0
        let count = data.count
        if count == 0 {
            compress(&state, Data(count: 128), bytesHashed: 0, last: true)
        } else {
            while offset < count {
                let end = min(offset + 128, count)
                let last = end == count
                compress(&state, data.subdata(in: offset..<end), bytesHashed: UInt64(end), last: last)
                offset = end
            }
        }
        var out = Data()
        for word in state {
            var little = word.littleEndian
            out.append(Data(bytes: &little, count: 8))
        }
        return out.prefix(digestLength)
    }

    private static func compress(_ state: inout [UInt64], _ block: Data, bytesHashed: UInt64, last: Bool) {
        var message = [UInt64](repeating: 0, count: 16)
        block.withUnsafeBytes { buffer in
            let available = buffer.count / 8
            for index in 0..<available {
                message[index] = buffer.loadUnaligned(fromByteOffset: index * 8, as: UInt64.self).littleEndian
            }
            if buffer.count % 8 != 0 {
                var tail: UInt64 = 0
                let start = available * 8
                for byte in start..<buffer.count {
                    tail |= UInt64(buffer[byte]) << UInt64((byte - start) * 8)
                }
                message[available] = tail
            }
        }
        var v = state + iv
        v[12] ^= bytesHashed
        v[13] ^= 0
        if last { v[14] = ~v[14] }
        for round in 0..<12 {
            let s = sigma[round]
            g(&v, 0, 4, 8, 12, message[s[0]], message[s[1]])
            g(&v, 1, 5, 9, 13, message[s[2]], message[s[3]])
            g(&v, 2, 6, 10, 14, message[s[4]], message[s[5]])
            g(&v, 3, 7, 11, 15, message[s[6]], message[s[7]])
            g(&v, 0, 5, 10, 15, message[s[8]], message[s[9]])
            g(&v, 1, 6, 11, 12, message[s[10]], message[s[11]])
            g(&v, 2, 7, 8, 13, message[s[12]], message[s[13]])
            g(&v, 3, 4, 9, 14, message[s[14]], message[s[15]])
        }
        for index in 0..<8 {
            state[index] ^= v[index] ^ v[index + 8]
        }
    }

    private static func g(_ v: inout [UInt64], _ a: Int, _ b: Int, _ c: Int, _ d: Int, _ x: UInt64, _ y: UInt64) {
        v[a] = v[a] &+ v[b] &+ x
        v[d] = rotr(v[d] ^ v[a], 32)
        v[c] = v[c] &+ v[d]
        v[b] = rotr(v[b] ^ v[c], 24)
        v[a] = v[a] &+ v[b] &+ y
        v[d] = rotr(v[d] ^ v[a], 16)
        v[c] = v[c] &+ v[d]
        v[b] = rotr(v[b] ^ v[c], 63)
    }

    private static func rotr(_ x: UInt64, _ n: UInt64) -> UInt64 {
        (x &>> n) | (x &<< (64 - n))
    }
}

private enum SHA512 {
    /// Named to keep the Argon2 H0 call obvious. This is Blake2b-512, not SHA-512.
    static func blake2b(_ data: Data) -> Data { Blake2b.hash(data, digestLength: 64) }
}
