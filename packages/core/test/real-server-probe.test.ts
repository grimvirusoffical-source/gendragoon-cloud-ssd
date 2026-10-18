/**
 * Real-server contract probe for packages/core.
 *
 * Feeds the shapes the backend actually serves into the client. Sources
 * (grimvirusoffical-source/gendragoon-cloud-ssd):
 *   - PR #5 @ abe1c21: 423 workspace_lock body, 422 byo_provider_unsupported,
 *     /byo/register + /byo/challenge + /byo/verify {presignedUrl},
 *     POST /v2/workspaces/:id/merge {targetId, confirmName}
 *     (native/Backend/billing_v2.js, projects.js, workspace_policy.js).
 *   - PR #6 @ 8a4a64c, unchanged at 84f6fff: error bodies are {"error":"<code>"}
 *     with no `code` field, e.g. 401 {"error":"reauth_required"}
 *     (native/Backend/account_delete.js).
 *   - PR #7 @ cc1a1e7: POST /v2/workspaces/:id/storage-urls
 *     request {op, objects:[id]}, response {bucket, prefix, mode, op, expiresAt,
 *     urls:[{object, url, method, expiresAt}]}, 409 {"error":"byo_external"}.
 *     Executed directly from fixtures/storage_urls.pr7-cc1a1e7.cjs.
 *
 * Every assertion below states the CORRECT contract. Known client bugs are
 * `it.fails` and titled BUG(<item>) after the PR #1 QA review
 * (runs/apps-pr1-review.md). When a fix lands, that test starts passing,
 * `it.fails` reports it, and the marker should be removed.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { GenDragoonClient, isReauthRequired, WorkspaceLockedError } from "../src/api/client.js";
import { assertKeyEnvelope, createKeyEnvelope, unwrapWorkspaceKey } from "../src/envelope.js";
import { createWorkspaceKey, importWorkspaceKey, LIBRARY_OBJECT_ID, openNamedFile, sealNamedFile } from "../src/seal.js";
import { assertStorageUrlResponse, storageOperations } from "../src/storage.js";
import type { StorageUrlResponse } from "../src/api/types.js";

interface Pr7StorageUrls {
  issueStorageUrls(deps: unknown, req: unknown): Promise<Record<string, unknown>>;
}
const require = createRequire(import.meta.url);
const pr7 = require("./fixtures/storage_urls.pr7-cc1a1e7.cjs") as Pr7StorageUrls;

const HASH = "a".repeat(64);
const WS = "11111111-2222-4333-8444-555555555555";
const OID = "0".repeat(32);
const FRAME = 4 + 12 + 8 + 16; // length prefix + IV + 8-byte chunk + GCM tag

function pr7Deps(kind = "paid") {
  const snap = { exists: true, data: () => ({ accountHash: HASH, kind }) };
  const doc = { get: async () => snap };
  return {
    env: { CUSTOMER_BUCKET: "gd-customer-test" },
    hash: () => HASH,
    db: { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => doc }) }) }) },
    isWriteLocked: async () => false,
    bucket: { name: "gd-customer-test" },
    sign: async ({ objectPath }: { objectPath: string }) =>
      `https://storage.googleapis.com/gd-customer-test/${objectPath}?X-Goog-Signature=test`,
  };
}

function pr7Request(body: unknown) {
  return { body, params: { id: WS }, user: { uid: "test-uid" } };
}

function client(status: number, body: unknown, seen: { url?: string; body?: string } = {}) {
  return new GenDragoonClient({
    baseUrl: "https://api.test",
    getToken: () => "test-token",
    fetch: (async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.body = typeof init.body === "string" ? init.body : undefined;
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
}

describe("fixture sanity (PR #7 code runs as served)", () => {
  it("PR #7 signs a download for {op, objects}", async () => {
    const real = await pr7.issueStorageUrls(pr7Deps(), pr7Request({ op: "download", objects: [OID] }));
    expect(real).toMatchObject({ mode: "read", op: "download" });
    expect(Array.isArray(real.urls)).toBe(true);
  });
  it("PR #7 refuses a BYO workspace with 409 byo_external", async () => {
    await expect(pr7.issueStorageUrls(pr7Deps("byo"), pr7Request({ op: "download", objects: [OID] })))
      .rejects.toMatchObject({ status: 409, code: "byo_external" });
  });
});

describe("storage-urls vs PR #7", () => {
  it.fails("BUG(1) client storage-urls request is accepted by PR #7", async () => {
    const body = storageOperations({ intent: "download", oid: OID, locked: false });
    const real = await pr7.issueStorageUrls(pr7Deps(), pr7Request(body));
    expect(real).toHaveProperty("urls");
  });
  it.fails("BUG(1) PR #7's real storage-urls response passes assertStorageUrlResponse", async () => {
    const real = await pr7.issueStorageUrls(pr7Deps(), pr7Request({ op: "download", objects: [OID] }));
    expect(() => assertStorageUrlResponse(real as unknown as StorageUrlResponse)).not.toThrow();
  });
  it.fails("BUG(2) sealed library object id is a valid PR #7 object id", async () => {
    const real = await pr7.issueStorageUrls(pr7Deps(), pr7Request({ op: "upload", objects: [LIBRARY_OBJECT_ID] }));
    expect(real).toHaveProperty("urls");
  });
  it.fails("BUG(3) 409 {error:'byo_external'} surfaces as code byo_external", async () => {
    const err = await client(409, { error: "byo_external" })
      .storageUrls(WS, { operations: [{ op: "download", oid: OID }] })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: "byo_external" });
  });
});

describe("error envelope vs PR #5 / #6", () => {
  it.fails("BUG(3) 401 {error:'reauth_required'} is recognised", async () => {
    const err = await client(401, { error: "reauth_required" }).deletionStatus("job-1").catch((e: unknown) => e);
    expect(isReauthRequired(err)).toBe(true);
  });
  it.fails("BUG(10) 423 lock error keeps overBy and unpaidWorkspaceIds", async () => {
    const err = await client(423, { error: "workspace_lock", reason: "over_cap", overBy: 2, unpaidWorkspaceIds: ["w1"] })
      .createUpload("w", { name: "a", sizeBytes: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceLockedError);
    expect(err).toMatchObject({ overBy: 2, unpaidWorkspaceIds: ["w1"] });
  });
  it("422 byo_provider_unsupported maps to the coming-soon message", async () => {
    const err = await client(422, { error: "byo_provider_unsupported", code: "byo_provider_unsupported", provider: "sftp" })
      .createByoChallenge("w", { provider: "sftp", endpoint: "https://x.test", bucketFingerprint: "f" })
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/coming soon/);
  });
});

describe("BYO challenge and merge vs PR #5", () => {
  it.fails("BUG(4) BYO proof is POSTed to /byo/verify as {presignedUrl}", async () => {
    const seen: { url?: string; body?: string } = {};
    await client(200, { verified: true }, seen)
      .submitByoProof("w", { challengeId: "c", presignedGetUrl: "https://h.test/.gendragoon-challenge/n" })
      .catch(() => undefined);
    expect(seen.url).toBe("https://api.test/v2/workspaces/w/byo/verify");
    expect(JSON.parse(seen.body ?? "{}")).toHaveProperty("presignedUrl");
  });
  it.fails("BUG(10) merge is POSTed to /v2/workspaces/:sourceId/merge with confirmName", async () => {
    const seen: { url?: string; body?: string } = {};
    await client(200, {}, seen).mergeWorkspaces({ sourceId: "a", targetId: "b" });
    expect(seen.url).toBe("https://api.test/v2/workspaces/a/merge");
    expect(JSON.parse(seen.body ?? "{}")).toHaveProperty("confirmName");
  });
});

describe("chunked AES-GCM", () => {
  it.fails("BUG(11) dropping trailing chunks is rejected", async () => {
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
  it.fails("RISK(15) envelope with a server revision field is still readable", () => {
    expect(() => assertKeyEnvelope({ version: 1, kdf: "argon2id", salt: "AA==", opsLimit: 2, memLimit: 67108864, iv: "AA==", wrappedKey: "AA==", revision: 3 })).not.toThrow();
  });
  it.fails("RISK(15) server-supplied memLimit is bounded", () => {
    expect(() => assertKeyEnvelope({ version: 1, kdf: "argon2id", salt: "AA==", opsLimit: 2, memLimit: 64 * 1024 ** 3, iv: "AA==", wrappedKey: "AA==" })).toThrow();
  });
});
