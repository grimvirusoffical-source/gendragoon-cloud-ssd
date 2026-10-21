import {
  LIBRARY_OBJECT_ID,
  ApiError,
  MemorySecretStore,
  assertKeyEnvelope,
  bytesToBase64Url,
  commitManifest,
  createKeyEnvelope,
  createWorkspaceKey,
  importWorkspaceKey,
  mergeSealedManifest,
  openWorkspaceKey,
  sealNamedFile,
  storageOperations,
  treeNode,
  workspaceKeyId,
  type LibraryManifest,
  type SealedName,
  type SecretStore,
} from "@gendragoon/core";
import { render } from "@testing-library/react-native";
import { createEncryptedWorkspace, replaceEncryptedFile } from "../src/encryptedWorkspace";
import { ENCRYPTED_WORKSPACE_ENABLED } from "../src/flags";
import { FileTree } from "../src/screens";
import { FIXTURE_SOURCE_SHA_BY_AREA, loadFixture } from "./loadFixture";

const WORKSPACE = "11111111-1111-4111-8111-000000000001";
const ARGON_FLOOR_BYTES = 19 * 1024 * 1024;

interface EnvelopeError {
  error: string;
}

function tracingStore(events: string[]): SecretStore {
  const inner = new MemorySecretStore();
  return {
    async get(name) {
      return inner.get(name);
    },
    async set(name, bytes) {
      events.push(`set:${name}`);
      await inner.set(name, bytes);
    },
    async delete(name) {
      events.push(`delete:${name}`);
      await inner.delete(name);
    },
  };
}

function sealed(fileId: string, path: string): SealedName {
  return {
    fileId,
    oid: fileId,
    path,
    plaintextBytes: 1,
    chunkBytes: 1024,
    chunkCount: 1,
    totalSize: 1,
    wrappedKey: "aa",
    wrapIv: "bb",
  };
}

function unpaddedBase64Url(value: string): void {
  expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
}

describe("encrypted workspace flag", () => {
  it("stays off until Casey clears the manifest merge bugs", async () => {
    expect(ENCRYPTED_WORKSPACE_ENABLED).toBe(false);
    const file = treeNode({ path: "Pictures/vacation.jpg", directory: false });
    const screen = await render(
      <FileTree
        mode="upload"
        nodes={[file]}
        locked={false}
        selected={file}
        onSelect={() => undefined}
        onRefresh={() => undefined}
        onUpload={() => undefined}
      />,
    );
    expect(screen.queryByTestId("upload-button")).toBeNull();
    expect(screen.getByTestId("file-vacation.jpg")).toBeTruthy();
  });

  it("key-envelope fixtures return unpadded base64url and a nested kdf", () => {
    const created = loadFixture<{
      kdf: { alg: string; memoryKiB: number; iterations: number; parallelism: number };
      iv: string;
      salt: string;
      wrappedKey: string;
    }>("key-envelope/create.json");
    const fetched = loadFixture<{ salt: string; iv: string; wrappedKey: string }>("key-envelope/get.json");
    const mismatch = loadFixture<{ error: string }>("key-envelope/version-mismatch.json");
    const tooLarge = loadFixture<{ error: string }>("key-envelope/payload-too-large.json");
    expect(created.sourceSha).toBe(FIXTURE_SOURCE_SHA_BY_AREA["key-envelope"]);
    expect(created.response.body.kdf).toEqual({ alg: "argon2id", memoryKiB: 19456, iterations: 2, parallelism: 1 });
    for (const field of [created.response.body.salt, created.response.body.iv, created.response.body.wrappedKey]) {
      unpaddedBase64Url(field);
    }
    for (const field of [fetched.response.body.salt, fetched.response.body.iv, fetched.response.body.wrappedKey]) {
      unpaddedBase64Url(field);
    }
    expect(mismatch.response.status).toBe(412);
    expect(mismatch.request.headers["if-match"]).toBe("\"1\"");
    expect(tooLarge.response).toEqual({ status: 413, body: { error: "payload_too_large" } });
  });

  it("scrypt N must be a power of two from 2^14 through 2^20", async () => {
    const key = await createWorkspaceKey();
    await expect(createKeyEnvelope(key, "correct horse", {
      kdf: "scrypt",
      scrypt: { N: 3, r: 8, p: 1 },
    })).rejects.toMatchObject({ status: 422, code: "kdf_params_invalid" });
    await expect(createKeyEnvelope(key, "correct horse", {
      kdf: "scrypt",
      scrypt: { N: 2 ** 13, r: 8, p: 1 },
    })).rejects.toMatchObject({ status: 422 });
    await expect(createKeyEnvelope(key, "correct horse", {
      kdf: "scrypt",
      scrypt: { N: 2 ** 21, r: 8, p: 1 },
    })).rejects.toMatchObject({ status: 422 });
  });

  it("a 409 on envelope create leaves no new key and adopts the fetched key", async () => {
    const conflict = loadFixture<EnvelopeError>("key-envelope/conflict.json");
    const fetched = loadFixture<{ kdf: { alg: string } }>("key-envelope/get.json");
    expect(conflict.response.status).toBe(409);
    expect(conflict.response.body.error).toBe("envelope_exists");
    expect(conflict.request.headers["if-none-match"]).toBe("*");
    expect(fetched.response.status).toBe(200);
    expect(fetched.response.body.kdf.alg).toBe("argon2id");

    const passphrase = "correct horse";
    const remoteKey = await createWorkspaceKey();
    const remoteEnvelope = await createKeyEnvelope(remoteKey, passphrase, { opsLimit: 2, memLimit: ARGON_FLOOR_BYTES });
    const events: string[] = [];
    const secrets = tracingStore(events);
    const methods: string[] = [];
    const client = {
      async putKeyEnvelope() {
        events.push("put-409");
        methods.push("PUT");
        throw new ApiError(conflict.response.status, conflict.response.body.error, "This workspace already has a key envelope.");
      },
      async getKeyEnvelope() {
        events.push("get");
        methods.push("GET");
        return remoteEnvelope;
      },
    };

    const key = await createEncryptedWorkspace({
      client,
      secrets,
      workspaceId: WORKSPACE,
      passphrase,
    });
    const stored = await secrets.get(workspaceKeyId(WORKSPACE));
    const setAt = events.findIndex((event) => event.startsWith("set:"));
    const rejectedAt = events.indexOf("put-409");
    expect(methods).toEqual(["PUT", "GET"]);
    expect(setAt).toBeGreaterThan(rejectedAt);
    expect(stored).toEqual(key);
    expect(key).toEqual(remoteKey);
  }, 60000);

  it("replacing a file is a signed put, a manifest ifGeneration string, then delete", async () => {
    const put = loadFixture<{
      prefix: string;
      mode: "write";
      op: "put";
      expiresAt: string;
      urls: { expiresAt: string; method: "PUT"; object: string; url: string }[];
    }>("storage-urls/put.json");
    const manifest = loadFixture("storage-urls/manifest-put.json");
    const huge = loadFixture("storage-urls/manifest-put-generation-string.json");
    const remove = loadFixture("storage-urls/delete.json");
    const manifestBody = manifest.request.body as { ifGeneration?: unknown; objects: string[]; op: string };
    expect(manifestBody.ifGeneration).toBe(0);
    expect(String(manifestBody.ifGeneration)).toBe("0");
    expect((huge.request.body as { ifGeneration: string }).ifGeneration).toBe("9223372036854775807");
    expect(remove.request.body).toMatchObject({ op: "delete" });
    expect(storageOperations({
      intent: "upload",
      oid: LIBRARY_OBJECT_ID,
      locked: false,
      ifGeneration: (huge.request.body as { ifGeneration: string }).ifGeneration,
    })).toEqual({
      op: "put",
      objects: [LIBRARY_OBJECT_ID],
      ifGeneration: "9223372036854775807",
    });

    const workspaceKey = await importWorkspaceKey(await createWorkspaceKey());
    const previous = await sealNamedFile({ path: "a.txt", plaintext: new Uint8Array([1]), workspaceKey });
    const steps: string[] = [];
    const bodies: unknown[] = [];
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await replaceEncryptedFile({
      workspaceId: WORKSPACE,
      previous: previous.entry,
      path: "a.txt",
      plaintext: new Uint8Array([2]),
      workspaceKey,
      storageUrls: async (_id, body) => {
        steps.push("storage-url");
        bodies.push(body);
        const link = put.response.body.urls[0];
        if (!link) throw new Error("fixture url missing");
        return {
          ...put.response.body,
          expiresAt,
          urls: [{ ...link, object: body.objects[0] ?? "", expiresAt }],
        };
      },
      fetchImpl: async () => {
        steps.push("signed-put");
        return new Response(null, { status: 200 });
      },
      commit: async () => {
        steps.push("manifest");
        bodies.push(storageOperations({ intent: "put", oid: "manifest", locked: false, ifGeneration: "0" }));
      },
      deleteOld: async (oid) => {
        steps.push("delete");
        bodies.push(storageOperations({ intent: "delete", oid, locked: false }));
      },
    });
    expect(steps).toEqual(["storage-url", "signed-put", "manifest", "delete"]);
    expect(bodies[1]).toEqual({ op: "put", objects: ["manifest"], ifGeneration: "0" });
    expect(bodies[2]).toEqual({ op: "delete", objects: [previous.oid] });
    expect(bodies[0]).toMatchObject({ op: "put", objects: [expect.any(String)] });
  });

  it("openWorkspaceKey create does not store the key before the server returns 201", async () => {
    const events: string[] = [];
    const store = tracingStore(events);
    const opened = await openWorkspaceKey({
      store,
      workspaceId: WORKSPACE,
      passphrase: "correct horse",
      create: true,
      opsLimit: 2,
      memLimit: ARGON_FLOOR_BYTES,
    });
    expect(opened.key).toBeInstanceOf(Uint8Array);
    expect(opened.envelope?.kdf).toMatchObject({ alg: "argon2id", memoryKiB: 19456 });
    expect(events.some((event) => event.startsWith("set:"))).toBe(false);
    expect(await store.get(workspaceKeyId(WORKSPACE))).toBeNull();
  }, 60000);

  it("a file deleted at the same moment is not restored by the manifest merge", () => {
    const nowMs = 1_700_000_000_000;
    const merged = mergeSealedManifest({
      local: {
        version: 2,
        prunedThroughVersion: 0,
        files: [{ fileId: "kept", path: "kept.txt", writtenAtVersion: 1 }],
        tombstones: [{ fileId: "gone", deletedAtVersion: 2, deletedAtMs: nowMs }],
      },
      remote: {
        version: 2,
        prunedThroughVersion: 0,
        files: [
          { fileId: "kept", path: "kept.txt", writtenAtVersion: 1 },
          { fileId: "gone", path: "gone.txt", writtenAtVersion: 1 },
        ],
        tombstones: [],
      },
      lastSyncedVersion: 2,
      nowMs,
    });
    expect(merged.files.map((file) => file.fileId)).toEqual(["kept"]);
  });

  it("an empty remote manifest is not overwritten by local files", async () => {
    const local: LibraryManifest = { version: 1, files: [sealed("local", "local.txt")] };
    const store = new MemorySecretStore();
    let uploaded: LibraryManifest | undefined;
    const result = await commitManifest({
      workspaceId: WORKSPACE,
      store,
      local,
      sourceName: "phone",
      download: async () => ({ generation: "1", manifest: { version: 2, files: [] } }),
      upload: async (manifest) => {
        uploaded = manifest;
      },
    });
    expect(uploaded?.files ?? []).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.version).toBe(3);
  });

  it("argon2id memory below 19456 KiB is rejected", () => {
    const envelope = {
      version: 1,
      kdf: { alg: "argon2id" as const, memoryKiB: 8192, iterations: 2, parallelism: 1 },
      salt: bytesToBase64Url(new Uint8Array(16)),
      iv: bytesToBase64Url(new Uint8Array(12)),
      wrappedKey: bytesToBase64Url(new Uint8Array(48)),
    };
    expect(() => assertKeyEnvelope(envelope)).toThrow();
  });
});
