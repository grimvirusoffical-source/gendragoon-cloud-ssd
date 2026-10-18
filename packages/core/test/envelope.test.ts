import { describe, expect, it } from "vitest";
import {
  GenDragoonClient,
  MemorySecretStore,
  assertKeyEnvelope,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  createKeyEnvelope,
  createWorkspaceKey,
  openWorkspaceKey,
  unwrapWorkspaceKey,
  workspaceKeyId,
} from "../src/index.js";

const PASSPHRASE = "correct horse";
const ARGON_MIN = { opsLimit: 1, memLimit: 8192 };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("workspace key envelope", () => {
  it("generates a 256-bit key on the creating device and wraps it with argon2id", async () => {
    const store = new MemorySecretStore();
    const opened = await openWorkspaceKey({
      store,
      workspaceId: "created",
      passphrase: PASSPHRASE,
      create: true,
      ...ARGON_MIN,
    });
    expect(opened.state).toBe("unlocked");
    expect(opened.key?.byteLength).toBe(32);
    expect(opened.envelope?.kdf.alg).toBe("argon2id");
    expect(opened.envelope?.version).toBe(1);
    const encoded = JSON.stringify(opened.envelope);
    expect(encoded).not.toContain(PASSPHRASE);
    expect(encoded).not.toContain(bytesToBase64(opened.key ?? new Uint8Array()));
    const again = await openWorkspaceKey({ store, workspaceId: "created" });
    expect(again.state).toBe("cached");
    expect(Buffer.from(again.key ?? new Uint8Array()).equals(Buffer.from(opened.key ?? new Uint8Array()))).toBe(true);
  });

  it("round-trips argon2id and an explicit scrypt envelope and does not fall back when argon2 throws", async () => {
    const key = await createWorkspaceKey();
    expect(key.byteLength).toBe(32);
    const argon = await createKeyEnvelope(key, PASSPHRASE, ARGON_MIN);
    expect(Buffer.from(await unwrapWorkspaceKey(argon, PASSPHRASE)).equals(Buffer.from(key))).toBe(true);
    const scrypt = await createKeyEnvelope(key, PASSPHRASE, { kdf: "scrypt" });
    expect(scrypt.kdf.alg).toBe("scrypt");
    expect(Buffer.from(await unwrapWorkspaceKey(scrypt, PASSPHRASE)).equals(Buffer.from(key))).toBe(true);
    await expect(createKeyEnvelope(key, PASSPHRASE, {
      argon2id() {
        throw new Error("argon2 unavailable");
      },
    })).rejects.toThrow(/Argon2id key derivation failed/);
    await expect(createKeyEnvelope(key, PASSPHRASE, { opsLimit: 11, memLimit: 8192 })).rejects.toMatchObject({ status: 422, code: "envelope_invalid" });
    await expect(createKeyEnvelope(key, PASSPHRASE, { opsLimit: 2, memLimit: 1048576 * 1024 + 1024 })).rejects.toMatchObject({ status: 422, code: "envelope_invalid" });
    await expect(createKeyEnvelope(key, PASSPHRASE, { kdf: "scrypt", scrypt: { N: 1, r: 8, p: 1 } })).rejects.toMatchObject({ status: 422, code: "kdf_params_invalid" });
    await expect(createKeyEnvelope(key, PASSPHRASE, { kdf: "scrypt", scrypt: { N: 100, r: 8, p: 1 } })).rejects.toMatchObject({ status: 422, code: "kdf_params_invalid" });
  });

  it("encodes salt, iv, and wrappedKey as unpadded base64url and decodes standard base64", async () => {
    const key = await createWorkspaceKey();
    const envelope = await createKeyEnvelope(key, PASSPHRASE, ARGON_MIN);
    for (const field of [envelope.salt, envelope.iv, envelope.wrappedKey]) {
      expect(field).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(field).not.toMatch(/[=+/]/);
    }
    const raw = Uint8Array.from([251, 239, 190, 173]);
    const standard = bytesToBase64(raw);
    const url = bytesToBase64Url(raw);
    expect(standard).toMatch(/[+/=]/);
    expect(url).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(base64UrlToBytes(standard)).toEqual(raw);
    expect(base64UrlToBytes(url)).toEqual(raw);
    expect(base64UrlToBytes(standard.replace(/=+$/g, ""))).toEqual(raw);
    const asStandard = (value: string) => {
      const text = value.replaceAll("-", "+").replaceAll("_", "/");
      return text + (text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4)));
    };
    const standardEnvelope = {
      ...envelope,
      salt: asStandard(envelope.salt),
      iv: asStandard(envelope.iv),
      wrappedKey: asStandard(envelope.wrappedKey),
    };
    expect(standardEnvelope.salt.endsWith("=")).toBe(true);
    expect(() => assertKeyEnvelope(standardEnvelope)).not.toThrow();
    expect(Buffer.from(await unwrapWorkspaceKey(standardEnvelope, PASSPHRASE)).equals(Buffer.from(key))).toBe(true);
    expect(Buffer.from(await unwrapWorkspaceKey(envelope, PASSPHRASE)).equals(Buffer.from(key))).toBe(true);
  });

  it("asks a new device for the passphrase once and does not cache a wrong one", async () => {
    const key = await createWorkspaceKey();
    const envelope = await createKeyEnvelope(key, PASSPHRASE, ARGON_MIN);
    const store = new MemorySecretStore();
    expect((await openWorkspaceKey({ store, workspaceId: "ws", envelope })).state).toBe("needs-passphrase");
    await expect(openWorkspaceKey({
      store,
      workspaceId: "ws",
      envelope,
      passphrase: "wrong passphrase",
    })).rejects.toThrow(/did not unlock/);
    expect(await store.get(workspaceKeyId("ws"))).toBeNull();
    const unlocked = await openWorkspaceKey({ store, workspaceId: "ws", envelope, passphrase: PASSPHRASE });
    expect(unlocked.state).toBe("unlocked");
    expect((await openWorkspaceKey({ store, workspaceId: "ws" })).state).toBe("cached");
  });

  it("rejects an envelope that carries a passphrase field", async () => {
    const key = await createWorkspaceKey();
    const envelope = await createKeyEnvelope(key, PASSPHRASE, ARGON_MIN);
    expect(() => assertKeyEnvelope({ ...envelope, passphrase: PASSPHRASE })).toThrow(/credential/i);
  });

  it("stores only the envelope at GET and PUT /v2/workspaces/:id/key-envelope", async () => {
    const key = await createWorkspaceKey();
    const envelope = await createKeyEnvelope(key, PASSPHRASE, ARGON_MIN);
    let stored: unknown = null;
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "firebase-token",
      fetch: async (input, init) => {
        const url = String(input);
        expect(url).toBe("https://api.example.test/v2/workspaces/ws/key-envelope");
        if (init?.method === "PUT") {
          stored = JSON.parse(String(init.body ?? ""));
          expect(JSON.stringify(stored)).not.toContain(PASSPHRASE);
          return jsonResponse(200, stored);
        }
        return jsonResponse(200, stored);
      },
    });
    await client.putKeyEnvelope("ws", envelope);
    const loaded = await client.getKeyEnvelope("ws");
    expect(Buffer.from(await unwrapWorkspaceKey(loaded, PASSPHRASE)).equals(Buffer.from(key))).toBe(true);
  });
});
