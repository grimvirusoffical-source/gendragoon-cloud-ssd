import { describe, expect, it } from "vitest";
import {
  MemorySecretStore,
  createWorkspaceKey,
  importWorkspaceKey,
  loadOrCreateWorkspaceKey,
  openBytes,
  openLibrary,
  openNamedFile,
  sealLibrary,
  sealNamedFile,
  sealStream,
  wipeWorkspaceKeys,
  workspaceKeyId,
} from "../src/seal.js";
import { assertStorageUrlResponse, putSignedObject, reauthIsRecent, SIGNED_URL_MAX_MS, storageOperations } from "../src/storage.js";
import { WorkspaceLockedError } from "../src/api/errors.js";

const encoder = new TextEncoder();

describe("client-side encryption", () => {
  it("round-trips a chunked file and keeps the name only inside the sealed manifest", async () => {
    const path = "Pictures/super-secret-vacation-name.jpg";
    const plaintext = encoder.encode("frame-one-hello-frame-two");
    const raw = await createWorkspaceKey();
    const workspaceKey = await importWorkspaceKey(raw);
    const sealed = await sealNamedFile({ path, plaintext, workspaceKey, chunkBytes: 8 });
    expect(sealed.oid).not.toContain("vacation");
    expect(new TextDecoder().decode(sealed.ciphertext)).not.toContain(path);
    expect(sealed.entry.path).toBe(path);
    expect(sealed.entry.wrappedKey.length).toBeGreaterThan(0);
    expect(sealed.entry.plaintextBytes).toBe(plaintext.byteLength);
    const opened = await openNamedFile(sealed.ciphertext, sealed.entry, workspaceKey);
    expect(new TextDecoder().decode(opened)).toBe("frame-one-hello-frame-two");

    const library = await sealLibrary({ version: 1, files: [sealed.entry] }, workspaceKey);
    expect(new TextDecoder().decode(library)).not.toContain(path);
    const manifest = await openLibrary(library, workspaceKey);
    expect(manifest.files[0]?.path).toBe(path);
  });

  it("streams chunks without holding the whole plaintext as one cipher block", async () => {
    const raw = await createWorkspaceKey();
    const key = await importWorkspaceKey(raw);
    async function* source() {
      yield encoder.encode("abcdefghij");
      yield encoder.encode("klmnop");
    }
    const parts: Uint8Array[] = [];
    for await (const part of sealStream(source(), key, 8)) parts.push(part);
    expect(parts.length).toBeGreaterThan(1);
    const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    const opened = await openBytes(joined, key);
    expect(new TextDecoder().decode(opened)).toBe("abcdefghijklmnop");
    const swapped = swapFirstFrames(joined);
    await expect(openBytes(swapped, key)).rejects.toThrow();
  });

  it("stores the workspace key in the secret store and wipes it with BYO secrets", async () => {
    const store = new MemorySecretStore();
    const first = await loadOrCreateWorkspaceKey(store, "ws-1");
    const second = await loadOrCreateWorkspaceKey(store, "ws-1");
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
    await store.set("byo-secret:ws-1", encoder.encode("local-only"));
    await wipeWorkspaceKeys(store, ["ws-1"]);
    expect(await store.get(workspaceKeyId("ws-1"))).toBeNull();
    expect(await store.get("byo-secret:ws-1")).toBeNull();
  });
});

describe("storage links", () => {
  const now = Date.parse("2026-10-18T00:00:00.000Z");
  const prefix = "customers/abc/workspaces/ws-1/";
  const expiresAt = new Date(now + 10 * 60 * 1000).toISOString();

  it("rejects upload links when the workspace is locked and rejects long-lived URLs", () => {
    expect(() => storageOperations({ intent: "upload", oid: "oid", locked: true })).toThrow(WorkspaceLockedError);
    expect(storageOperations({ intent: "download", oid: "oid", locked: true }).op).toBe("get");
    expect(storageOperations({ intent: "delete", oid: "oid", locked: false })).toEqual({ op: "delete", objects: ["oid"] });
    expect(() => assertStorageUrlResponse({
      prefix,
      mode: "write",
      op: "put",
      expiresAt: new Date(now + SIGNED_URL_MAX_MS + 1000).toISOString(),
      urls: [{
        object: "oid",
        method: "PUT",
        url: `https://storage.googleapis.com/${prefix}oid?X-Goog-Signature=abc`,
        expiresAt: new Date(now + SIGNED_URL_MAX_MS + 1000).toISOString(),
      }],
    }, now)).toThrow(/15 minutes/);
    expect(() => assertStorageUrlResponse({
      prefix,
      mode: "read",
      op: "get",
      expiresAt,
      urls: [{
        object: "oid",
        method: "PUT",
        url: `https://storage.googleapis.com/${prefix}oid?X-Goog-Signature=abc`,
        expiresAt,
      }],
    }, now)).toThrow(/download-only/);
  });

  it("accepts a prefix-scoped download link and uploads ciphertext without a bearer token", async () => {
    const link = {
      object: "oid",
      method: "PUT" as const,
      url: `https://storage.googleapis.com/${prefix}oid?X-Goog-Algorithm=GOOG4-RSA-SHA256`,
      expiresAt,
    };
    assertStorageUrlResponse({ prefix, expiresAt, mode: "write", op: "put", urls: [link] }, now);
    let authorization: string | null = "unset";
    await putSignedObject(link, new Uint8Array([1, 2, 3]), async (_input, init) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return new Response(null, { status: 200 });
    });
    expect(authorization).toBeNull();
    expect(reauthIsRecent(new Date(now - 4 * 60 * 1000).toISOString(), now)).toBe(true);
    expect(reauthIsRecent(new Date(now - 6 * 60 * 1000).toISOString(), now)).toBe(false);
  });
});

function swapFirstFrames(ciphertext: Uint8Array): Uint8Array {
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (offset < ciphertext.byteLength) {
    const length = new DataView(ciphertext.buffer, ciphertext.byteOffset + offset, 4).getUint32(0);
    const next = offset + 4 + length;
    frames.push(ciphertext.slice(offset, next));
    offset = next;
  }
  const first = frames[0];
  const second = frames[1];
  if (!first || !second) throw new Error("expected two frames");
  frames[0] = second;
  frames[1] = first;
  const size = frames.reduce((sum, frame) => sum + frame.byteLength, 0);
  const out = new Uint8Array(size);
  let cursor = 0;
  for (const frame of frames) {
    out.set(frame, cursor);
    cursor += frame.byteLength;
  }
  return out;
}
