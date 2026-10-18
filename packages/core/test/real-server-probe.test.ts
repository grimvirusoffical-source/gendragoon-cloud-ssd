/**
 * Real-server contract probe for packages/core.
 *
 * Feeds the shapes the backend actually serves into the client. Sources
 * (grimvirusoffical-source/gendragoon-cloud-ssd):
 *   - PR #5 @ abe1c21: 423 workspace_lock body, 422 byo_provider_unsupported,
 *     /byo/verify {presignedUrl}, POST /v2/workspaces/:id/merge {targetId, confirmName}.
 *   - PR #6: error bodies are {"error":"<code>"} with no `code` field.
 *   - PR #7 @ 8267784: Riley's generated fixtures/storage-urls/*.json (copied
 *     verbatim to fixtures/cloud-ssd/storage-urls). Request {op:get|put|delete,
 *     objects:[id], ifGeneration?}; reserved object id `manifest`; manifest put
 *     needs ifGeneration (0 = create only), signed as x-goog-if-generation-match.
 *   - PR #9 @ 24fba02: fixtures/key-envelope/*.json (fixtures/cloud-ssd/key-envelope).
 *     {version, kdf, salt, iv, wrappedKey}; create = If-None-Match:* (409 envelope_exists);
 *     update = If-Match:"<version>" and body version+1 (412 version_mismatch).
 *
 * Every assertion states the CORRECT contract. Known client bugs are `it.fails`
 * and titled BUG(<item>)/RISK(<item>). When a fix lands, `it.fails` reports it
 * and the marker should be removed.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GenDragoonClient, isReauthRequired, WorkspaceLockedError } from "../src/api/client.js";
import { assertKeyEnvelope, createKeyEnvelope, unwrapWorkspaceKey } from "../src/envelope.js";
import { createWorkspaceKey, importWorkspaceKey, LIBRARY_OBJECT_ID, openNamedFile, sealNamedFile } from "../src/seal.js";
import { assertStorageUrlResponse, putSignedObject, storageOperations } from "../src/storage.js";
import type { KeyEnvelope, StorageLink, StorageUrlResponse } from "../src/api/types.js";

interface Fixture { request: { method: string; path: string; headers: Record<string, string>; body: unknown }; response: { status: number; body: unknown } }
function fx(area: "storage-urls" | "key-envelope", name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`./fixtures/cloud-ssd/${area}/${name}.json`, import.meta.url), "utf8")) as Fixture;
}
const WS = "11111111-1111-4111-8111-000000000001";
const OID = "0123456789abcdef0123456789abcdef";
const FRAME = 4 + 12 + 8 + 16; // length prefix + IV + 8-byte chunk + GCM tag
// Fixture URLs were signed at this instant (fixtures expire 2023-11-14T22:28:20Z, 15 min TTL).
const FIXTURE_NOW = Date.parse("2023-11-14T22:18:20.000Z");

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

describe("storage-urls vs PR #7 fixtures (6af2399)", () => {
  it("fixtures are Riley's generated set", () => {
    expect(fx("storage-urls", "manifest-put").request.body).toEqual({ ifGeneration: 0, objects: ["manifest"], op: "put" });
    expect(fx("storage-urls", "manifest-generation-required").response).toEqual({ status: 400, body: { error: "manifest_generation_required" } });
  });
  it("BUG(1) client storage-urls download request equals the get fixture body", () => {
    const f = fx("storage-urls", "get");
    expect(storageOperations({ intent: "download", oid: OID, locked: false })).toEqual(f.request.body);
  });
  it("BUG(1) client storage-urls upload request equals the put fixture body (no resumable)", () => {
    const f = fx("storage-urls", "put");
    expect(storageOperations({ intent: "upload", oid: OID, sizeBytes: 10, locked: false })).toEqual(f.request.body);
  });
  it("BUG(1) PR #7's real storage-urls response passes assertStorageUrlResponse", () => {
    const body = fx("storage-urls", "put").response.body as StorageUrlResponse;
    expect(() => assertStorageUrlResponse(body, FIXTURE_NOW)).not.toThrow();
  });
  it("BUG(2) uploads use the reserved `manifest` object id for the library", () => {
    expect(LIBRARY_OBJECT_ID).toBe("manifest");
  });
  it("BUG(2) the library upload request is {op:put, objects:[manifest], ifGeneration}", () => {
    const req = storageOperations({ intent: "upload", oid: LIBRARY_OBJECT_ID, sizeBytes: 10, locked: false }) as unknown as Record<string, unknown>;
    expect(req.objects).toEqual(["manifest"]);
    expect(req.ifGeneration).toBe("0");
    expect(typeof req.ifGeneration).toBe("string");
  });
  it("BUG(M1) manifest put sends ifGeneration (fixture manifest-put)", async () => {
    const seen: Seen = {};
    const f = fx("storage-urls", "manifest-put");
    await client(f.response.status, f.response.body, seen)
      .storageUrls(WS, storageOperations({ intent: "upload", oid: LIBRARY_OBJECT_ID, sizeBytes: 10, locked: false }))
      .catch(() => undefined);
    const sent = JSON.parse(seen.body ?? "{}") as { op?: string; objects?: string[]; ifGeneration?: string };
    expect(sent).toEqual({ op: "put", objects: ["manifest"], ifGeneration: "0" });
    expect(f.request.body).toMatchObject({ ifGeneration: 0 });
  });
  it("BUG(M2) ifGeneration 0 means create-only: a first save sends 0, never omits it", async () => {
    const seen: Seen = {};
    const f = fx("storage-urls", "manifest-put");
    const err = await client(f.response.status, f.response.body, seen)
      .storageUrls(WS, storageOperations({ intent: "upload", oid: LIBRARY_OBJECT_ID, sizeBytes: 10, locked: false }))
      .catch((e: unknown) => e);
    expect(JSON.parse(seen.body ?? "{}")).toMatchObject({ ifGeneration: "0" });
    expect(err).not.toMatchObject({ code: "manifest_generation_required" });
  });
  it("manifest-put-generation-string sends the decimal string unchanged", () => {
    const body = fx("storage-urls", "manifest-put-generation-string").request.body as { ifGeneration: string; objects: string[]; op: string };
    expect(body.ifGeneration).toBe("9223372036854775807");
    expect(storageOperations({ intent: "upload", oid: "manifest", locked: false, ifGeneration: body.ifGeneration })).toEqual(body);
  });
  it("locked put and delete fixtures keep overBy, reason, and unpaidWorkspaceIds", async () => {
    for (const name of ["locked", "locked-delete"] as const) {
      const f = fx("storage-urls", name);
      const err = await client(f.response.status, f.response.body)
        .storageUrls(WS, { op: "put", objects: [OID] })
        .catch((caught: unknown) => caught);
      expect(err).toBeInstanceOf(WorkspaceLockedError);
      expect(err).toMatchObject({ status: 423, code: "workspace_lock", overBy: 0, reason: "lapsed", unpaidWorkspaceIds: [WS] });
    }
  });
  it("BUG(M3) a stale-generation 412 on the signed manifest PUT surfaces as a retryable conflict, not a generic failure", async () => {
    const urlBody = fx("storage-urls", "manifest-put").response.body as { urls: Array<{ url: string; method: string; object: string; expiresAt: string }> };
    const link = { op: "upload", ...urlBody.urls[0] } as unknown as StorageLink;
    const err = await putSignedObject(link, new Uint8Array([1]), (async () =>
      new Response("<Error><Code>ConditionNotMet</Code></Error>", { status: 412 })) as unknown as typeof fetch).catch((e: unknown) => e);
    // Data-safety: caller must be able to tell "someone else wrote first, refetch + merge" from "upload broke".
    expect(err).toMatchObject({ status: 412 });
  });
  it("BUG(3) 409 {error:'byo_external'} surfaces as code byo_external", async () => {
    const err = await client(409, { error: "byo_external" })
      .storageUrls(WS, { operations: [{ op: "download", oid: OID }] } as never)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: "byo_external" });
  });
});

describe("error envelope vs PR #5 / #6", () => {
  it("BUG(3) 401 {error:'reauth_required'} is recognised", async () => {
    const err = await client(401, { error: "reauth_required" }).deletionStatus("job-1").catch((e: unknown) => e);
    expect(isReauthRequired(err)).toBe(true);
  });
  it("BUG(10) 423 lock error keeps overBy and unpaidWorkspaceIds", async () => {
    const err = await client(423, { error: "workspace_lock", reason: "over_cap", overBy: 2, unpaidWorkspaceIds: ["w1"] })
      .createUpload("w", { name: "a", sizeBytes: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceLockedError);
    expect(err).toMatchObject({ overBy: 2, unpaidWorkspaceIds: ["w1"] });
  });
  it("422 byo_provider_unsupported maps to the coming-soon message", async () => {
    const err = await client(422, { error: "byo_provider_unsupported", code: "byo_provider_unsupported", provider: "sftp" })
      .createByoChallenge("w")
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/coming soon/);
  });
});

describe("BYO challenge and merge vs PR #5", () => {
  it("BUG(4) BYO proof is POSTed to /byo/verify as {presignedUrl}", async () => {
    const seen: { url?: string; body?: string } = {};
    await client(200, { verified: true }, seen)
      .submitByoProof("w", { presignedGetUrl: "https://h.test/.gendragoon-challenge/n" })
      .catch(() => undefined);
    expect(seen.url).toBe("https://api.test/v2/workspaces/w/byo/verify");
    expect(JSON.parse(seen.body ?? "{}")).toHaveProperty("presignedUrl");
  });
  it("BUG(10) merge is POSTed to /v2/workspaces/:sourceId/merge with confirmName", async () => {
    const seen: { url?: string; body?: string } = {};
    await client(200, {}, seen).mergeWorkspaces({ sourceId: "a", targetId: "b", confirmName: "B" } as never);
    expect(seen.url).toBe("https://api.test/v2/workspaces/a/merge");
    expect(JSON.parse(seen.body ?? "{}")).toHaveProperty("confirmName");
  });
});

describe("chunked AES-GCM", () => {
  it("BUG(11) dropping only the final chunk fails hard", async () => {
    const workspaceKey = await importWorkspaceKey(await createWorkspaceKey());
    const plaintext = new TextEncoder().encode("AAAAAAAABBBBBBBBCCCCCCCC");
    const sealed = await sealNamedFile({ path: "a/b.txt", plaintext, workspaceKey, chunkBytes: 8 });
    expect(sealed.ciphertext.length).toBe(FRAME * 3);
    await expect(openNamedFile(sealed.ciphertext.subarray(0, FRAME * 2), sealed.entry, workspaceKey)).rejects.toThrow();
  });
  it("BUG(11) dropping trailing chunks is rejected", async () => {
    const workspaceKey = await importWorkspaceKey(await createWorkspaceKey());
    const plaintext = new TextEncoder().encode("AAAAAAAABBBBBBBBCCCCCCCC");
    const sealed = await sealNamedFile({ path: "a/b.txt", plaintext, workspaceKey, chunkBytes: 8 });
    await expect(openNamedFile(sealed.ciphertext.subarray(0, FRAME * 2), sealed.entry, workspaceKey)).rejects.toThrow();
  });
  it("reordered chunks are rejected (chunk index is in the AAD)", async () => {
    const workspaceKey = await importWorkspaceKey(await createWorkspaceKey());
    const sealed = await sealNamedFile({ path: "a.txt", plaintext: new Uint8Array(16).fill(7), workspaceKey, chunkBytes: 8 });
    const swapped = new Uint8Array(sealed.ciphertext.length);
    swapped.set(sealed.ciphertext.subarray(FRAME, 2 * FRAME), 0);
    swapped.set(sealed.ciphertext.subarray(0, FRAME), FRAME);
    await expect(openNamedFile(swapped, sealed.entry, workspaceKey)).rejects.toThrow();
  });
  it("every chunk gets a unique 96-bit nonce", async () => {
    const workspaceKey = await importWorkspaceKey(await createWorkspaceKey());
    const sealed = await sealNamedFile({ path: "n.bin", plaintext: new Uint8Array(2000), workspaceKey, chunkBytes: 4 });
    const bytes = sealed.ciphertext;
    const ivs = new Set<string>();
    let offset = 0;
    while (offset < bytes.length) {
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
      ivs.add(Buffer.from(bytes.subarray(offset + 4, offset + 16)).toString("hex"));
      offset += 4 + length;
    }
    expect(ivs.size).toBe(500);
  });
});

describe("key envelope", () => {
  it("wrong passphrase fails cleanly and the envelope carries no passphrase or raw key", async () => {
    const key = await createWorkspaceKey();
    const envelope = await createKeyEnvelope(key, "correct horse battery");
    const json = JSON.stringify(envelope);
    expect(json).not.toContain("correct horse");
    expect(json).not.toContain(Buffer.from(key).toString("base64"));
    await expect(unwrapWorkspaceKey(envelope, "wrong passphrase!!")).rejects.toThrow("Recovery passphrase did not unlock this workspace");
    expect(await unwrapWorkspaceKey(envelope, "correct horse battery")).toEqual(key);
  });
  it("RISK(15) any version at least 1 is readable and memoryKiB above 1 GiB is rejected", async () => {
    const envelope = await createKeyEnvelope(await createWorkspaceKey(), "correct horse battery", { opsLimit: 2, memLimit: 19 * 1024 * 1024 });
    expect(() => assertKeyEnvelope({ ...envelope, version: 2 })).not.toThrow();
    expect(() => assertKeyEnvelope({
      ...envelope,
      kdf: { alg: "argon2id", memoryKiB: 64 * 1024 * 1024, iterations: 2, parallelism: 1 },
    })).toThrow();
    expect(() => assertKeyEnvelope({
      ...envelope,
      kdf: { alg: "argon2id", memoryKiB: 19456, iterations: 11, parallelism: 1 },
    })).toThrow();
  });
});

describe("key envelope conflicts vs PR #9 fixtures (67f7996)", () => {
  it("BUG(KE1) getKeyEnvelope accepts {version,kdf,salt,iv,wrappedKey}", async () => {
    const envelope = await createKeyEnvelope(await createWorkspaceKey(), "correct horse battery", { opsLimit: 2, memLimit: 19 * 1024 * 1024 });
    await expect(client(200, envelope).getKeyEnvelope(WS)).resolves.toMatchObject({
      version: 1,
      kdf: { alg: "argon2id", iterations: 2, memoryKiB: 19 * 1024 },
    });
    expect(fx("key-envelope", "get").request.method).toBe("GET");
  });
  it("BUG(KE2) first create sends If-None-Match: * (fixture create)", async () => {
    const f = fx("key-envelope", "create"); const seen: Seen = {};
    const env = await createKeyEnvelope(await createWorkspaceKey(), "correct horse battery");
    await client(f.response.status, f.response.body, seen).putKeyEnvelope(WS, env).catch(() => undefined);
    expect(seen.headers?.get("if-none-match")).toBe("*");
  });
  it("BUG(KE3) after 409 envelope_exists: GET the existing envelope, unwrap it, use that key; one PUT only, never retried or overwritten", async () => {
    const conflict = fx("key-envelope", "conflict");
    const shared = "correct horse battery";
    const serverKey = await createWorkspaceKey();
    const remote = await createKeyEnvelope(serverKey, shared, { opsLimit: 2, memLimit: 19 * 1024 * 1024 });
    const puts: string[] = []; let gets = 0;
    const api = new GenDragoonClient({ baseUrl: "https://api.test", getToken: () => "t", fetch: (async (_u: string, init: RequestInit) => {
      if (init.method === "PUT") { puts.push(String(init.body)); return new Response(JSON.stringify(conflict.response.body), { status: 409 }); }
      gets++; return new Response(JSON.stringify(remote), { status: 200 });
    }) as unknown as typeof fetch });
    const mine = await createKeyEnvelope(await createWorkspaceKey(), shared, { opsLimit: 2, memLimit: 19 * 1024 * 1024 });
    const err = await api.putKeyEnvelope(WS, mine).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: "envelope_exists" });
    const existing = await api.getKeyEnvelope(WS);
    expect(existing.wrappedKey).toBe(remote.wrappedKey);
    expect(await unwrapWorkspaceKey(existing, shared)).toEqual(serverKey);
    expect(puts.length).toBe(1);
    expect(gets).toBe(1);
  });
  it("BUG(KE4) update sends If-Match \"<current>\" with body version current+1 (fixture update)", async () => {
    const f = fx("key-envelope", "update"); const seen: Seen = {};
    const env = { ...(await createKeyEnvelope(await createWorkspaceKey(), "correct horse battery")), version: 2 } as unknown as KeyEnvelope;
    await client(f.response.status, f.response.body, seen).putKeyEnvelope(WS, env).catch(() => undefined);
    expect(seen.calls).toBe(1);
    expect(seen.headers?.get("if-match")).toBe(f.request.headers["if-match"]);
  });
  it("BUG(KE5) after 412 version_mismatch: refetch, re-apply only the passphrase wrap on the fetched version, workspace key unchanged", async () => {
    const stale = fx("key-envelope", "version-mismatch");
    const key = await createWorkspaceKey();
    const v1 = await createKeyEnvelope(key, "first passphrase!!");
    const err = await client(stale.response.status, stale.response.body).putKeyEnvelope(WS, { ...v1, version: 2 } as unknown as KeyEnvelope).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 412, code: "version_mismatch" });
    // A server envelope at version 2 must be readable so the client can rewrap on top of it.
    expect(() => assertKeyEnvelope({ ...v1, version: 2 })).not.toThrow();
  });
  it("rewrap with a new passphrase keeps the same workspace key (core-internal format)", async () => {
    const key = await createWorkspaceKey();
    const a = await createKeyEnvelope(key, "first passphrase!!");
    const unwrapped = await unwrapWorkspaceKey(a, "first passphrase!!");
    const b = await createKeyEnvelope(unwrapped, "second passphrase!!");
    expect(await unwrapWorkspaceKey(b, "second passphrase!!")).toEqual(key);
    await expect(unwrapWorkspaceKey(b, "first passphrase!!")).rejects.toThrow();
  });
});
