/**
 * Real-server contract probe for packages/core.
 *
 * Targets core at gendragoon-apps PR #1 (cursor/gendragoon-client-monorepo-808c @ 93b2fdf).
 * Server fixtures are copied verbatim into fixtures/cloud-ssd/ from
 * grimvirusoffical-source/gendragoon-cloud-ssd:
 *   - storage-urls: PR #7 @ 8267784. {op:get|put|delete, objects, ifGeneration?};
 *     response {bucket,prefix,mode,op,expiresAt,urls:[{object,url,method,expiresAt,generation?}]};
 *     reserved object id `manifest`; ifGeneration "0" = create-only, signed as x-goog-if-generation-match.
 *   - key-envelope: PR #9 @ 24fba02. {version, kdf:{alg,memoryKiB,iterations,parallelism}|{alg:"scrypt",N,r,p},
 *     salt(b64url 16-64), iv(b64url 12-32), wrappedKey(standard base64, >=32 bytes)};
 *     create = If-None-Match:* (409 envelope_exists); update = If-Match:"<v>" + body v+1 (412 version_mismatch).
 *   - PR #5/#6: errors are {"error":"<code>"}; 423 workspace_lock carries reason/overBy/unpaidWorkspaceIds.
 *
 * Every assertion states the CORRECT contract. Open client bugs are `it.fails` and titled
 * BUG(<item>)/RISK(<item>). Fixed markers are plain `it` and keep their tag as history.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.js";
import { GenDragoonClient, isReauthRequired, WorkspaceLockedError } from "../src/api/client.js";
import {
  assertKeyEnvelope, createKeyEnvelope, establishWorkspaceKey, openWorkspaceKey, rewrapWorkspaceKey, unwrapWorkspaceKey,
} from "../src/envelope.js";
import { commitManifest, manifestUploadRequest, putManifestBytes } from "../src/manifest-cas.js";
import {
  createWorkspaceKey, importWorkspaceKey, LIBRARY_OBJECT_ID, MemorySecretStore, openNamedFile, sealNamedFile, workspaceKeyId,
  type LibraryManifest, type SealedName,
} from "../src/seal.js";
import { assertStorageUrlResponse, putSignedObject, storageOperations } from "../src/storage.js";
import type { KeyEnvelope, StorageObjectUrl, StorageUrlResponse } from "../src/api/types.js";

interface Fixture { request: { method: string; path: string; headers: Record<string, string>; body: unknown }; response: { status: number; body: unknown } }
function fx(area: "storage-urls" | "key-envelope", name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`./fixtures/cloud-ssd/${area}/${name}.json`, import.meta.url), "utf8")) as Fixture;
}
const WS = "11111111-1111-4111-8111-000000000001";
const OID = "0123456789abcdef0123456789abcdef";
const FRAME = 4 + 12 + 8 + 16;
const FIXTURE_NOW = Date.parse("2023-11-14T22:18:20.000Z");
// Server rule (cloud-ssd key_envelope.js validWrappedKey): standard base64, canonical, >= 32 bytes.
const _SERVER_STD_B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PASS = "correct horse battery";

type Seen = { url?: string; body?: string; method?: string; headers?: Headers; calls?: number };
function client(status: number, body: unknown, seen: Seen = {}) {
  return new GenDragoonClient({
    baseUrl: "https://api.test",
    getToken: () => "test-token",
    fetch: (async (url: string, init: RequestInit) => {
      seen.url = url; seen.method = init.method; seen.headers = new Headers(init.headers);
      seen.calls = (seen.calls ?? 0) + 1;
      seen.body = typeof init.body === "string" ? init.body : undefined;
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
}
function entry(oid: string, path: string): SealedName {
  return { oid, path } as unknown as SealedName;
}

describe("storage-urls vs PR #7 fixtures (8267784)", () => {
  it("fixtures are Riley's generated set at 8267784", () => {
    expect(fx("storage-urls", "manifest-put-generation-string").request.body).toEqual({ ifGeneration: "9223372036854775807", objects: ["manifest"], op: "put" });
    expect(fx("storage-urls", "locked").response.body).toMatchObject({ error: "workspace_lock", reason: "lapsed", overBy: 0 });
  });
  it("BUG(1) download request equals the get fixture body {op:get, objects}", () => {
    expect(storageOperations({ intent: "download", oid: OID, locked: false })).toEqual(fx("storage-urls", "get").request.body);
  });
  it("BUG(1) upload request equals the put fixture body and never sends resumable", () => {
    const req = storageOperations({ intent: "upload", oid: OID, sizeBytes: 10, locked: false });
    expect(req).toEqual(fx("storage-urls", "put").request.body);
    expect(JSON.stringify(req)).not.toContain("resumable");
  });
  it("BUG(1) delete request equals the delete fixture body", () => {
    expect(storageOperations({ intent: "delete", oid: OID, locked: false })).toEqual(fx("storage-urls", "delete").request.body);
  });
  it("BUG(1) real get/put/delete/manifest-get responses pass assertStorageUrlResponse (mode/urls)", () => {
    for (const name of ["get", "put", "delete", "manifest-get", "manifest-put", "manifest-put-generation-string"]) {
      const body = fx("storage-urls", name).response.body as StorageUrlResponse;
      expect(() => assertStorageUrlResponse(body, FIXTURE_NOW), name).not.toThrow();
    }
  });
  it("BUG(2) the library uses the reserved `manifest` object id", () => {
    expect(LIBRARY_OBJECT_ID).toBe("manifest");
  });
  it("BUG(M1) manifest put sends ifGeneration as the exact decimal string (generation-string fixture)", () => {
    const f = fx("storage-urls", "manifest-put-generation-string");
    expect(manifestUploadRequest("9223372036854775807")).toEqual(f.request.body);
    expect(storageOperations({ intent: "upload", oid: LIBRARY_OBJECT_ID, locked: false, ifGeneration: "9223372036854775807" })).toEqual(f.request.body);
    expect(() => manifestUploadRequest("9.2e18")).toThrow();
    expect(() => manifestUploadRequest("007")).toThrow();
  });
  it("BUG(M2) ifGeneration \"0\" means create-only: a first manifest save sends \"0\", never omits it", () => {
    const f = fx("storage-urls", "manifest-put");
    const req = storageOperations({ intent: "upload", oid: LIBRARY_OBJECT_ID, locked: false });
    expect(req).toMatchObject({ op: "put", objects: ["manifest"], ifGeneration: "0" });
    expect(String((f.request.body as { ifGeneration: unknown }).ifGeneration)).toBe(req.ifGeneration);
  });
  it("BUG(M3) a 412 on the signed manifest PUT surfaces as ApiError 412", async () => {
    const link = (fx("storage-urls", "manifest-put").response.body as StorageUrlResponse).urls[0] as StorageObjectUrl;
    const stale = (async () => new Response("<Error><Code>ConditionNotMet</Code></Error>", { status: 412 })) as unknown as typeof fetch;
    await expect(putSignedObject(link, new Uint8Array([1]), stale)).rejects.toMatchObject({ status: 412 });
    const seen: Record<string, string> = {};
    await expect(putManifestBytes({ url: link.url, ifGeneration: "42", bytes: new Uint8Array([1]), fetchImpl: (async (_u: string, init: RequestInit) => {
      seen["x-goog-if-generation-match"] = new Headers(init.headers).get("x-goog-if-generation-match") ?? "";
      return new Response("", { status: 412 });
    }) as unknown as typeof fetch })).rejects.toMatchObject({ status: 412 });
    expect(seen["x-goog-if-generation-match"]).toBe("42");
  });
  it("BUG(M3) 412 is handled as refetch-and-merge: both devices' files survive, retry uses the new generation", async () => {
    const store = new MemorySecretStore();
    let remote: { generation: string; manifest: LibraryManifest } = { generation: "7", manifest: { version: 3, files: [entry("a".repeat(32), "a.txt")] } };
    const uploads: Array<{ gen: string; files: string[] }> = [];
    const result = await commitManifest({
      workspaceId: WS, store, sourceName: "laptop",
      local: { version: 3, files: [entry("b".repeat(32), "b.txt")] },
      download: async () => remote,
      upload: async (m, gen) => {
        uploads.push({ gen, files: m.files.map((f) => f.path).sort() });
        if (uploads.length === 1) {
          // another device wins the race
          remote = { generation: "8", manifest: { version: 4, files: [...remote.manifest.files, entry("c".repeat(32), "c.txt")] } };
          throw new ApiError(412, "stale_version", "stale");
        }
      },
    });
    expect(uploads.map((u) => u.gen)).toEqual(["7", "8"]);
    expect(result.files.map((f) => f.path).sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
  });
  it("BUG(3) 409 {error:'byo_external'} surfaces as code byo_external", async () => {
    const err = await client(409, { error: "byo_external" }).storageUrls(WS, { op: "get", objects: [OID] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: "byo_external" });
  });
  it("423 workspace_lock from the locked fixture keeps reason, overBy and unpaidWorkspaceIds", async () => {
    const f = fx("storage-urls", "locked");
    const err = await client(f.response.status, f.response.body).storageUrls(WS, f.request.body as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceLockedError);
    const { error: _e, ...rest } = f.response.body as Record<string, unknown>;
    expect(err).toMatchObject(rest);
  });
});

describe("error envelope vs PR #5 / #6", () => {
  it("BUG(3) 401 {error:'reauth_required'} is recognised", async () => {
    const err = await client(401, { error: "reauth_required" }).deletionStatus("job-1").catch((e: unknown) => e);
    expect(isReauthRequired(err)).toBe(true);
  });
  it("BUG(10) 423 lock error keeps overBy and unpaidWorkspaceIds", async () => {
    const err = await client(423, { error: "workspace_lock", reason: "over_cap", overBy: 2, unpaidWorkspaceIds: ["w1"] })
      .createUpload("w", { name: "a", sizeBytes: 1 } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceLockedError);
    expect(err).toMatchObject({ overBy: 2, unpaidWorkspaceIds: ["w1"] });
  });
  it("422 byo_provider_unsupported maps to the coming-soon message", async () => {
    const err = await client(422, { error: "byo_provider_unsupported", provider: "sftp" })
      .registerByo("w", { provider: "sftp", endpoint: "https://x.test", bucketFingerprint: "f" } as never)
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/coming soon/);
  });
});

describe("BYO challenge and merge vs PR #5", () => {
  it("BUG(4) BYO proof is POSTed to /byo/verify as {presignedUrl}", async () => {
    const seen: Seen = {};
    await client(200, { verified: true }, seen).submitByoProof("w", { presignedUrl: "https://h.test/.gendragoon-challenge/n" }).catch(() => undefined);
    expect(seen.url).toBe("https://api.test/v2/workspaces/w/byo/verify");
    expect(JSON.parse(seen.body ?? "{}")).toEqual({ presignedUrl: "https://h.test/.gendragoon-challenge/n" });
  });
  it("BUG(10) merge is POSTed to /v2/workspaces/:sourceId/merge with confirmName", async () => {
    const seen: Seen = {};
    await client(200, {}, seen).mergeWorkspaces({ sourceId: "a", targetId: "b", confirmName: "B" } as never);
    expect(seen.url).toBe("https://api.test/v2/workspaces/a/merge");
    expect(JSON.parse(seen.body ?? "{}")).toEqual({ targetId: "b", confirmName: "B" });
  });
});

describe("chunked AES-GCM", () => {
  it("BUG(11) dropping only the final chunk fails to decrypt", async () => {
    const workspaceKey = await importWorkspaceKey(await createWorkspaceKey());
    const sealed = await sealNamedFile({ path: "a/b.txt", plaintext: new TextEncoder().encode("AAAAAAAABBBBBBBBCCCCCCCC"), workspaceKey, chunkBytes: 8 });
    expect(sealed.ciphertext.length).toBe(FRAME * 3);
    await expect(openNamedFile(sealed.ciphertext.subarray(0, FRAME * 2), sealed.entry, workspaceKey)).rejects.toThrow();
  });
  it("BUG(11) dropping the final chunk fails even without the manifest's chunkCount (final flag in AAD)", async () => {
    const workspaceKey = await importWorkspaceKey(await createWorkspaceKey());
    const sealed = await sealNamedFile({ path: "a/b.txt", plaintext: new TextEncoder().encode("AAAAAAAABBBBBBBBCCCCCCCC"), workspaceKey, chunkBytes: 8 });
    const loose = { ...sealed.entry, chunkCount: undefined, totalSize: undefined } as unknown as SealedName;
    await expect(openNamedFile(sealed.ciphertext.subarray(0, FRAME * 2), loose, workspaceKey)).rejects.toThrow();
  });
  it("reordered chunks are rejected (chunk index is in the AAD)", async () => {
    const workspaceKey = await importWorkspaceKey(await createWorkspaceKey());
    const sealed = await sealNamedFile({ path: "a.txt", plaintext: new Uint8Array(16).fill(7), workspaceKey, chunkBytes: 8 });
    const swapped = new Uint8Array(sealed.ciphertext.length);
    swapped.set(sealed.ciphertext.subarray(FRAME, 2 * FRAME), 0);
    swapped.set(sealed.ciphertext.subarray(0, FRAME), FRAME);
    await expect(openNamedFile(swapped, sealed.entry, workspaceKey)).rejects.toThrow();
  });
});

describe("key envelope vs PR #9 fixtures (24fba02)", () => {
  it("wrong passphrase fails cleanly and the envelope carries no passphrase or raw key", async () => {
    const key = await createWorkspaceKey();
    const envelope = await createKeyEnvelope(key, PASS);
    const json = JSON.stringify(envelope);
    expect(json).not.toContain("correct horse");
    expect(json).not.toContain(Buffer.from(key).toString("base64"));
    await expect(unwrapWorkspaceKey(envelope, "wrong passphrase!!")).rejects.toThrow("Recovery passphrase did not unlock this workspace");
    expect(await unwrapWorkspaceKey(envelope, PASS)).toEqual(key);
  });
  it("BUG(KE1) getKeyEnvelope reads the server's nested shape (get fixture)", async () => {
    const f = fx("key-envelope", "get");
    await expect(client(200, f.response.body).getKeyEnvelope(WS)).resolves.toEqual(f.response.body);
  });
  it("BUG(KE1) salt/iv decode as base64url and wrappedKey as standard base64 (with or without padding)", () => {
    const body = fx("key-envelope", "get").response.body as KeyEnvelope;
    const std = { ...body, salt: Buffer.from(Buffer.from(body.salt, "base64url")).toString("base64"), iv: body.iv + "" };
    expect(() => assertKeyEnvelope(body)).not.toThrow();
    expect(() => assertKeyEnvelope(std)).not.toThrow();
    const plus = { ...body, wrappedKey: Buffer.alloc(48, 0xfb).toString("base64") }; // contains '+' '/'
    expect(plus.wrappedKey).toMatch(/[+/]/);
    expect(() => assertKeyEnvelope(plus)).not.toThrow();
  });
  // Server rule copied from cloud-ssd ee4f76f native/Backend/key_envelope.js decodeBinary (both alphabets, canonical bytes).
  const serverDecode = (v: string): Buffer | null => {
    if (typeof v !== "string" || v.length === 0 || /\s/.test(v)) return null;
    const url = v.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    if (!/^[A-Za-z0-9_-]+$/.test(url)) return null;
    const buf = Buffer.from(url, "base64url");
    return buf.toString("base64url") === url ? buf : null;
  };
  it("BUG(KE1b) envelopes core creates are accepted by the server (resolved server-side in ee4f76f: base64url accepted, returned unpadded)", async () => {
    const key = await createWorkspaceKey();
    for (let i = 0; i < 8; i += 1) {
      const env = await createKeyEnvelope(key, PASS);
      for (const f of ["salt", "iv", "wrappedKey"] as const) {
        const buf = serverDecode(env[f]);
        expect(buf, f).not.toBeNull();
        expect(buf!.toString("base64url"), f).toBe(env[f].replace(/=+$/, "")); // server echoes the same string back
      }
      expect(serverDecode(env.wrappedKey)!.length).toBeGreaterThanOrEqual(32);
      expect(await unwrapWorkspaceKey({ ...env, wrappedKey: serverDecode(env.wrappedKey)!.toString("base64url") }, PASS)).toEqual(key);
    }
  });
  it("salt/iv wrong-length fixtures are refused by the client too", () => {
    for (const name of ["salt-wrong-length", "iv-wrong-length"]) {
      expect(() => assertKeyEnvelope(fx("key-envelope", name).request.body)).toThrow();
    }
  });
  it("BUG(KE2) first create sends If-None-Match: * (create fixture)", async () => {
    const f = fx("key-envelope", "create"); const seen: Seen = {};
    await client(f.response.status, f.response.body, seen).putKeyEnvelope(WS, f.request.body as KeyEnvelope);
    expect(seen.headers?.get("if-none-match")).toBe("*");
    expect(seen.headers?.get("if-match")).toBeNull();
  });
  it("BUG(KE4) update sends If-Match \"<current>\" with body version current+1 (update fixture)", async () => {
    const f = fx("key-envelope", "update"); const seen: Seen = {};
    await client(f.response.status, f.response.body, seen).putKeyEnvelope(WS, f.request.body as KeyEnvelope);
    expect(seen.headers?.get("if-match")).toBe(f.request.headers["if-match"]);
    expect(seen.headers?.get("if-none-match")).toBeNull();
  });
  it("BUG(KE3) establishWorkspaceKey: key saved only after 201; a failed create saves nothing", async () => {
    const store = new MemorySecretStore();
    await expect(establishWorkspaceKey({ store, workspaceId: WS, passphrase: PASS, get: async () => { throw new Error("no"); },
      put: async () => { throw new ApiError(503, "unavailable", "x"); } })).rejects.toThrow();
    expect(await store.get(workspaceKeyId(WS))).toBeFalsy();
    let stored: Uint8Array | undefined;
    const ok = await establishWorkspaceKey({ store, workspaceId: WS, passphrase: PASS, get: async () => { throw new Error("no"); },
      put: async () => { stored = await store.get(workspaceKeyId(WS)) ?? undefined; return fx("key-envelope", "create").response.body; } });
    expect(stored).toBeFalsy(); // nothing cached while the PUT is in flight
    expect(await store.get(workspaceKeyId(WS))).toEqual(ok.key);
  });
  it("BUG(KE3) after 409 envelope_exists: fetch, unwrap and use the existing key; one PUT, never overwritten", async () => {
    const store = new MemorySecretStore();
    const theirs = await createWorkspaceKey();
    const existing = await createKeyEnvelope(theirs, PASS);
    const conflict = fx("key-envelope", "conflict");
    const puts: KeyEnvelope[] = []; let gets = 0;
    const api = new GenDragoonClient({ baseUrl: "https://api.test", getToken: () => "t", fetch: (async (_u: string, init: RequestInit) => {
      if (init.method === "PUT") { puts.push(JSON.parse(String(init.body)) as KeyEnvelope); return new Response(JSON.stringify(conflict.response.body), { status: 409 }); }
      gets += 1; return new Response(JSON.stringify(existing), { status: 200 });
    }) as unknown as typeof fetch });
    const out = await establishWorkspaceKey({ store, workspaceId: WS, passphrase: PASS, get: () => api.getKeyEnvelope(WS), put: (e) => api.putKeyEnvelope(WS, e) });
    expect(out.adopted).toBe(true);
    expect(out.key).toEqual(theirs);
    expect(await store.get(workspaceKeyId(WS))).toEqual(theirs);
    expect(puts.length).toBe(1);
    expect(gets).toBe(1);
  });
  it("RISK(KE3) openWorkspaceKey({create:true}) does not cache the new key before the server accepts it (src/envelope.ts:267, store.set before upload)", async () => {
    const store = new MemorySecretStore();
    await openWorkspaceKey({ store, workspaceId: WS, passphrase: PASS, create: true });
    expect(await store.get(workspaceKeyId(WS))).toBeFalsy();
  });
  it("BUG(KE5) after 412 version_mismatch: refetch, re-wrap only the passphrase on the new version, key unchanged", async () => {
    const key = await createWorkspaceKey();
    let current = await createKeyEnvelope(key, "first passphrase!!", { version: 1 });
    const stale = fx("key-envelope", "version-mismatch");
    const sent: Array<{ ifMatch: string | null; version: number }> = []; let gets = 0; let raced = false;
    const api = new GenDragoonClient({ baseUrl: "https://api.test", getToken: () => "t", fetch: (async (_u: string, init: RequestInit) => {
      if (init.method === "GET") { gets += 1; return new Response(JSON.stringify(current), { status: 200 }); }
      const body = JSON.parse(String(init.body)) as KeyEnvelope;
      sent.push({ ifMatch: new Headers(init.headers).get("if-match"), version: body.version });
      if (!raced) { raced = true; current = await createKeyEnvelope(key, "other device pass", { version: 2 }); return new Response(JSON.stringify(stale.response.body), { status: 412 }); }
      current = body; return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch });
    const out = await rewrapWorkspaceKey({ key, passphrase: "second passphrase!!", get: () => api.getKeyEnvelope(WS), put: (e) => api.putKeyEnvelope(WS, e) });
    expect(sent).toEqual([{ ifMatch: "\"1\"", version: 2 }, { ifMatch: "\"2\"", version: 3 }]);
    expect(gets).toBe(2);
    expect(out.key).toEqual(key);
    expect(await unwrapWorkspaceKey(out.envelope, "second passphrase!!")).toEqual(key);
  });
  it("RISK(15) client KDF limits: memoryKiB > 1048576, iterations > 10, scrypt N not a power of two are refused", () => {
    const base = fx("key-envelope", "get").response.body as KeyEnvelope;
    expect(() => assertKeyEnvelope({ ...base, kdf: { alg: "argon2id", memoryKiB: 1048576, iterations: 10, parallelism: 1 } })).not.toThrow();
    expect(() => assertKeyEnvelope({ ...base, kdf: { alg: "argon2id", memoryKiB: 1048577, iterations: 2, parallelism: 1 } })).toThrow();
    expect(() => assertKeyEnvelope({ ...base, kdf: { alg: "argon2id", memoryKiB: 64 * 1024 * 1024, iterations: 2, parallelism: 1 } })).toThrow();
    expect(() => assertKeyEnvelope({ ...base, kdf: { alg: "argon2id", memoryKiB: 19456, iterations: 11, parallelism: 1 } })).toThrow();
    expect(() => assertKeyEnvelope({ ...base, kdf: { alg: "scrypt", N: 2 ** 15, r: 8, p: 1 } })).not.toThrow();
    expect(() => assertKeyEnvelope({ ...base, kdf: { alg: "scrypt", N: 3 * 2 ** 14, r: 8, p: 1 } })).toThrow();
  });
  it("RISK(15b) a server-supplied argon2id memoryKiB below the server minimum (19456) is refused (no KDF downgrade) (src/envelope.ts:224, min is 1)", () => {
    const base = fx("key-envelope", "get").response.body as KeyEnvelope;
    expect(() => assertKeyEnvelope({ ...base, kdf: { alg: "argon2id", memoryKiB: 8, iterations: 1, parallelism: 1 } })).toThrow();
  });
});
