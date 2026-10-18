import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.js";
import { createKeyEnvelope, establishWorkspaceKey, publishKeyEnvelope, rewrapWorkspaceKey, unwrapWorkspaceKey } from "../src/envelope.js";
import {
  commitManifest,
  manifestUploadRequest,
  mergeManifestFiles,
  putManifestBytes,
  readManifestVersion,
} from "../src/manifest-cas.js";
import { createWorkspaceKey, importWorkspaceKey, MemorySecretStore, openNamedFile, sealNamedFile } from "../src/seal.js";
import { replaceEncryptedObject, uploadEncryptedObject } from "../src/upload.js";
import { presignChallengeGet } from "../src/byo.js";
import { GenDragoonClient } from "../src/api/client.js";

describe("manifest compare-and-swap", () => {
  it("requires ifGeneration and sends x-goog-if-generation-match", async () => {
    expect(manifestUploadRequest()).toEqual({ op: "put", objects: ["manifest"], ifGeneration: "0" });
    expect(() => manifestUploadRequest("-1")).toThrow(expect.objectContaining({ code: "manifest_generation_required" }));
    const headers: Record<string, string> = {};
    await putManifestBytes({
      url: "https://storage.googleapis.com/bucket/manifest",
      ifGeneration: "42",
      bytes: new Uint8Array([1]),
      fetchImpl: async (_input, init) => {
        new Headers(init?.headers).forEach((value, key) => {
          headers[key] = value;
        });
        return new Response(null, { status: 200 });
      },
    });
    expect(headers["x-goog-if-generation-match"]).toBe("42");
    const huge = "9007199254740993";
    expect(manifestUploadRequest(huge).ifGeneration).toBe(huge);
    const hugeHeaders: Record<string, string> = {};
    await putManifestBytes({
      url: "https://storage.googleapis.com/bucket/manifest",
      ifGeneration: huge,
      bytes: new Uint8Array([1]),
      fetchImpl: async (_input, init) => {
        new Headers(init?.headers).forEach((value, key) => {
          hugeHeaders[key] = value;
        });
        return new Response(null, { status: 200 });
      },
    });
    expect(hugeHeaders["x-goog-if-generation-match"]).toBe(huge);
  });

  it("passes a generation above 2^53 through commit without parsing it", async () => {
    const huge = "9007199254740993";
    let seen = "";
    await commitManifest({
      workspaceId: "ws-huge",
      store: new MemorySecretStore(),
      local: { version: 1, files: [] },
      sourceName: "Here",
      download: async () => ({ generation: huge, manifest: { version: 1, files: [] } }),
      upload: async (_manifest, generation) => {
        seen = generation;
      },
    });
    expect(seen).toBe(huge);
  });

  it("retries a 412, unions by object id, and stores the monotonic version", async () => {
    const store = new MemorySecretStore();
    const local = {
      version: 2,
      files: [{ fileId: "fa", oid: "a", path: "a.txt", plaintextBytes: 1, chunkBytes: 8, chunkCount: 1, totalSize: 1, wrappedKey: "AA==", wrapIv: "AA==" }],
    };
    const remote = {
      version: 3,
      files: [{ fileId: "fb", oid: "b", path: "a.txt", plaintextBytes: 1, chunkBytes: 8, chunkCount: 1, totalSize: 1, wrappedKey: "AA==", wrapIv: "AA==" }],
    };
    let uploads = 0;
    const saved = await commitManifest({
      workspaceId: "ws",
      store,
      local,
      sourceName: "Other",
      download: async () => ({ generation: "9", manifest: remote }),
      upload: async (manifest, generation) => {
        uploads += 1;
        expect(generation).toBe("9");
        if (uploads === 1) throw new ApiError(412, "stale_version", "stale");
        expect(manifest.files.map((file) => file.oid).sort()).toEqual(["a", "b"]);
        expect(manifest.files.find((file) => file.oid === "a")?.path).toBe("a.txt (from Other)");
        expect(manifest.version).toBeGreaterThan(remote.version);
      },
    });
    expect(uploads).toBe(2);
    expect(await readManifestVersion(store, "ws")).toBe(saved.version);
    await expect(commitManifest({
      workspaceId: "ws",
      store,
      local: { ...local, version: 1 },
      sourceName: "Other",
      download: async () => ({ generation: "9", manifest: remote }),
      upload: async () => undefined,
    })).rejects.toThrow(/older/);
  });

  it("renames a path clash and keeps one row per object id", () => {
    const merged = mergeManifestFiles(
      { version: 1, files: [{ fileId: "fs", oid: "same", path: "a.txt", plaintextBytes: 1, chunkBytes: 8, chunkCount: 1, totalSize: 1, wrappedKey: "AA==", wrapIv: "AA==" }] },
      { version: 1, files: [
        { fileId: "fs", oid: "same", path: "other.txt", plaintextBytes: 1, chunkBytes: 8, chunkCount: 1, totalSize: 1, wrappedKey: "AA==", wrapIv: "AA==" },
        { fileId: "fn", oid: "new", path: "a.txt", plaintextBytes: 1, chunkBytes: 8, chunkCount: 1, totalSize: 1, wrappedKey: "AA==", wrapIv: "AA==" },
      ] },
      "Source",
    );
    expect(merged.files).toHaveLength(2);
    expect(merged.files.find((file) => file.oid === "new")?.path).toBe("a.txt (from Source)");
  });
});

describe("encrypted upload and key envelope", () => {
  it("uploads ciphertext and keeps the plaintext name out of the storage request", async () => {
    const key = await importWorkspaceKey(await createWorkspaceKey());
    const plaintext = new TextEncoder().encode("super-secret-bytes");
    let requestBody: unknown;
    let uploaded = "";
    const entry = await uploadEncryptedObject({
      workspaceId: "ws",
      path: "Notes/secret.txt",
      plaintext,
      workspaceKey: key,
      chunkBytes: 8,
      storageUrls: async (_id, body) => {
        requestBody = body;
        const oid = body.objects[0] ?? "";
        return {
          prefix: "customer/hash/managed/ws/objects/",
          mode: "write",
          op: "put",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          urls: [{
            object: oid,
            method: "PUT",
            url: `https://storage.googleapis.com/customer/hash/managed/ws/objects/${oid}?X-Goog-Signature=1`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }],
        };
      },
      fetchImpl: async (_url, init) => {
        uploaded = Buffer.from(init?.body as Uint8Array).toString("utf8");
        return new Response(null, { status: 200 });
      },
    });
    expect(JSON.stringify(requestBody)).not.toContain("secret.txt");
    expect(uploaded).not.toContain("super-secret-bytes");
    expect(entry.totalSize).toBe(plaintext.byteLength);
    expect(entry.chunkCount).toBeGreaterThan(1);
  });

  it("keeps the workspace key when the envelope upload is 412 stale_version", async () => {
    const store = new MemorySecretStore();
    const key = await createWorkspaceKey();
    const envelope = await createKeyEnvelope(key, "correct horse");
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "token",
      fetch: async () => new Response(JSON.stringify({ error: "stale_version" }), { status: 412, headers: { "content-type": "application/json" } }),
    });
    await expect(publishKeyEnvelope({
      store,
      workspaceId: "ws",
      key,
      envelope,
      put: () => client.putKeyEnvelope("ws", envelope),
    })).rejects.toMatchObject({ status: 412, code: "stale_version" });
    expect(await store.get("workspace-key:ws")).toBeNull();
  });

  it("maps 422 kdf_params_invalid", async () => {
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "token",
      fetch: async () => new Response(JSON.stringify({ error: "kdf_params_invalid" }), { status: 422, headers: { "content-type": "application/json" } }),
    });
    const envelope = await createKeyEnvelope(await createWorkspaceKey(), "correct horse");
    await expect(client.putKeyEnvelope("ws", envelope)).rejects.toMatchObject({ status: 422, code: "kdf_params_invalid" });
  });
});

describe("SigV4 challenge URL", () => {
  it("signs a GET with AWS4 and leaves the secret off the URL", async () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const url = await presignChallengeGet({
      endpoint: "https://s3.amazonaws.com",
      region: "us-east-1",
      bucket: "library",
      key: ".gendragoon-challenge/nonce",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: secret,
      expiresInSeconds: 300,
    });
    expect(url).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(url).toContain(".gendragoon-challenge/nonce");
    expect(url).not.toContain(secret);
    const sealed = await sealNamedFile({
      path: "a.txt",
      plaintext: new Uint8Array([1]),
      workspaceKey: await importWorkspaceKey(await createWorkspaceKey()),
    });
    expect(sealed.entry.chunkCount).toBe(1);
  });
});

describe("workspace key adoption and file replacement", () => {
  const passphrase = "correct horse";
  const fast = { opsLimit: 1, memLimit: 8192 };

  it("two devices racing on create adopt the same key and decrypt each other's files", async () => {
    let stored: Awaited<ReturnType<typeof createKeyEnvelope>> | null = null;
    let puts = 0;
    const put = async (envelope: Awaited<ReturnType<typeof createKeyEnvelope>>) => {
      puts += 1;
      if (stored) throw new ApiError(409, "envelope_exists", "exists");
      stored = envelope;
      return envelope;
    };
    const get = async () => {
      if (!stored) throw new ApiError(404, "not_found", "missing");
      return stored;
    };
    const first = await establishWorkspaceKey({
      store: new MemorySecretStore(),
      workspaceId: "ws",
      passphrase,
      get,
      put,
      ...fast,
    });
    const secondStore = new MemorySecretStore();
    const second = await establishWorkspaceKey({
      store: secondStore,
      workspaceId: "ws",
      passphrase,
      get,
      put,
      ...fast,
    });
    expect(puts).toBe(2);
    expect(second.adopted).toBe(true);
    expect(second.key).toEqual(first.key);
    expect(await secondStore.get("workspace-key:ws")).toEqual(first.key);
    const cryptoKey = await importWorkspaceKey(first.key);
    const sealed = await sealNamedFile({
      path: "notes/shared.txt",
      plaintext: new TextEncoder().encode("same-key"),
      workspaceKey: cryptoKey,
    });
    const opened = await openNamedFile(sealed.ciphertext, sealed.entry, await importWorkspaceKey(second.key));
    expect(new TextDecoder().decode(opened)).toBe("same-key");
  });

  it("a 412 refetch re-wraps the same workspace key", async () => {
    const key = await createWorkspaceKey();
    let current = await createKeyEnvelope(key, "first passphrase!!", fast);
    let puts = 0;
    const result = await rewrapWorkspaceKey({
      key,
      passphrase: "second passphrase!!",
      get: async () => current,
      put: async (envelope) => {
        puts += 1;
        if (puts === 1) throw new ApiError(412, "version_mismatch", "stale");
        current = { ...current, version: 3 };
        return envelope;
      },
    });
    expect(result.key).toEqual(key);
    expect(puts).toBe(2);
    expect(result.envelope.version).toBe(2);
    expect(await unwrapWorkspaceKey(result.envelope, "second passphrase!!")).toEqual(key);
  });

  it("chunks cannot be swapped between files", async () => {
    const workspaceKey = await importWorkspaceKey(await createWorkspaceKey());
    const left = await sealNamedFile({ path: "a.txt", plaintext: new Uint8Array(16).fill(1), workspaceKey, chunkBytes: 8 });
    const right = await sealNamedFile({ path: "b.txt", plaintext: new Uint8Array(16).fill(2), workspaceKey, chunkBytes: 8 });
    const mixed = new Uint8Array(left.ciphertext);
    mixed.set(right.ciphertext.subarray(0, 40), 0);
    await expect(openNamedFile(mixed, left.entry, workspaceKey)).rejects.toThrow();
  });

  it("deletes the old object only after the manifest commit succeeds", async () => {
    const workspaceKey = await importWorkspaceKey(await createWorkspaceKey());
    const previous = await sealNamedFile({ path: "a.txt", plaintext: new Uint8Array([1]), workspaceKey });
    const deleted: string[] = [];
    let trashed = false;
    const storageUrls = async (_id: string, body: { objects: string[] }) => ({
      prefix: "customer/hash/managed/ws/objects/",
      mode: "write" as const,
      op: "put" as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      urls: [{
        object: body.objects[0] ?? "",
        method: "PUT" as const,
        url: `https://storage.googleapis.com/customer/hash/managed/ws/objects/${body.objects[0]}?X-Goog-Signature=1`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }],
    });
    await expect(replaceEncryptedObject({
      workspaceId: "ws",
      previous: previous.entry,
      path: "a.txt",
      plaintext: new Uint8Array([2]),
      workspaceKey,
      storageUrls,
      commit: async () => { throw new Error("manifest rejected"); },
      deleteOld: async (oid) => { deleted.push(oid); },
      trashLocal: async () => { trashed = true; },
      fetchImpl: async () => new Response(null, { status: 200 }),
    })).rejects.toThrow(/manifest rejected/);
    expect(deleted).toEqual([]);
    expect(trashed).toBe(false);
    const replaced = await replaceEncryptedObject({
      workspaceId: "ws",
      previous: previous.entry,
      path: "a.txt",
      plaintext: new Uint8Array([2]),
      workspaceKey,
      storageUrls,
      commit: async () => undefined,
      deleteOld: async (oid) => { deleted.push(oid); },
      trashLocal: async () => { trashed = true; },
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    expect(deleted).toEqual([previous.oid]);
    expect(trashed).toBe(true);
    expect(replaced.fileId).toBe(previous.entry.fileId);
    expect(replaced.oid).not.toBe(previous.oid);
  });
});
