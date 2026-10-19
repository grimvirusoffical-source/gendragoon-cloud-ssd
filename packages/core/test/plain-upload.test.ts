import { describe, expect, it } from "vitest";
import { CHUNK_BYTES, uploadPlainFile } from "../src/index.js";

describe("uploadPlainFile (team and personal workspaces)", () => {
  it("creates the session, sends ordered chunks with SHA-256, and retries finalize while assembling", async () => {
    const calls: string[] = [];
    let finals = 0;
    const client = {
      createUpload: async (ws: string, body: { name: string; sizeBytes: number; requestId?: string }) => {
        calls.push(`create ${ws} ${body.name} ${body.sizeBytes} ${typeof body.requestId}`);
        return { uploadId: "u1", status: "active", chunkBytes: CHUNK_BYTES, totalChunks: 2, sizeBytes: body.sizeBytes, receivedRanges: [], nextIndex: 0, uploadedBytes: 0 };
      },
      uploadChunk: async (_ws: string, _u: string, index: number, bytes: Uint8Array, sha: string) => { calls.push(`chunk ${index} ${bytes.length} ${sha.length}`); return { saved: true, index }; },
      finalizeUpload: async () => { finals++; return finals < 2 ? { saved: false } : { saved: true, fileId: "f1" }; },
    };
    const progress: number[] = [];
    const size = CHUNK_BYTES + 10;
    const result = await uploadPlainFile(client as never, "team-ws", { name: "big.bin", bytes: new Uint8Array(size) },
      { onProgress: (sent) => progress.push(sent), waitMs: 1 });
    expect(result).toEqual({ fileId: "f1" });
    expect(calls).toEqual([`create team-ws big.bin ${size} string`, `chunk 0 ${CHUNK_BYTES} 64`, "chunk 1 10 64"]);
    expect(progress).toEqual([CHUNK_BYTES, size]);
    expect(finals).toBe(2);
  });
  it("hex SHA-256 matches a known vector", async () => {
    let sha = "";
    const client = { createUpload: async () => ({ uploadId: "u" }), uploadChunk: async (_a: string, _b: string, _i: number, _x: Uint8Array, s: string) => { sha = s; return { saved: true, index: 0 }; },
      finalizeUpload: async () => ({ saved: true, fileId: "f" }) };
    await uploadPlainFile(client as never, "w", { name: "abc", bytes: new TextEncoder().encode("abc") });
    expect(sha).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
