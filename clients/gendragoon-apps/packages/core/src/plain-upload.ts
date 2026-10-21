import type { GenDragoonClient } from "./api/client.js";
import { planChunks } from "./transfer.js";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Upload one file to a workspace the caller can write (personal or team; the server
 * resolves the id and enforces the team role). Chunks are sent in order with their
 * SHA-256; finalize is retried while the server is still assembling.
 */
export async function uploadPlainFile(client: Pick<GenDragoonClient, "createUpload" | "uploadChunk" | "finalizeUpload">,
  workspaceId: string, file: { name: string; bytes: Uint8Array },
  options: { requestId?: string; onProgress?: (sentBytes: number, totalBytes: number) => void; digest?: (b: Uint8Array) => Promise<string>; waitMs?: number } = {}): Promise<{ fileId: string }> {
  const digest = options.digest ?? sha256Hex;
  const requestId = options.requestId ?? globalThis.crypto.randomUUID();
  const session = await client.createUpload(workspaceId, { name: file.name, sizeBytes: file.bytes.length, requestId });
  const plan = planChunks(file.bytes.length);
  let sent = 0;
  for (const chunk of plan.chunks) {
    const part = file.bytes.subarray(chunk.offset, chunk.offset + chunk.length);
    await client.uploadChunk(workspaceId, session.uploadId, chunk.index, part, await digest(part));
    sent += chunk.length;
    options.onProgress?.(sent, file.bytes.length);
  }
  for (let attempt = 0; attempt < 120; attempt++) {
    const done = await client.finalizeUpload(workspaceId, session.uploadId);
    if (done.saved) return { fileId: done.fileId ?? session.uploadId };
    await new Promise((r) => setTimeout(r, options.waitMs ?? 1000));
  }
  throw new Error("The server is still assembling the file. Check the file list in a minute.");
}
