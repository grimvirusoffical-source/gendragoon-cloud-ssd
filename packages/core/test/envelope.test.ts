import { describe, expect, it } from "vitest";
import {
  GenDragoonClient,
  MemorySecretStore,
  assertKeyEnvelope,
  bytesToBase64,
  createKeyEnvelope,
  createWorkspaceKey,
  openWorkspaceKey,
  unwrapWorkspaceKey,
  workspaceKeyId,
} from "../src/index.js";

const PASSPHRASE = "correct horse";
const ARGON_MIN = { opsLimit: 1, memLimit: 8192 };
const SCRYPT_MIN = { kdf: "scrypt" as const, opsLimit: 32768, memLimit: 16_777_216 };

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
    expect(opened.envelope?.kdf).toBe("argon2id");
    expect(opened.envelope?.version).toBe(1);
    const encoded = JSON.stringify(opened.envelope);
    expect(encoded).not.toContain(PASSPHRASE);
    expect(encoded).not.toContain(bytesToBase64(opened.key ?? new Uint8Array()));
    const again = await openWorkspaceKey({ store, workspaceId: "created" });
    expect(again.state).toBe("cached");
    expect(Buffer.from(again.key ?? new Uint8Array()).equals(Buffer.from(opened.key ?? new Uint8Array()))).toBe(true);
  });

  it("round-trips argon2id and scrypt envelopes and falls back when argon2 throws", async () => {
    const key = await createWorkspaceKey();
    expect(key.byteLength).toBe(32);
    const argon = await createKeyEnvelope(key, PASSPHRASE, ARGON_MIN);
    expect(Buffer.from(await unwrapWorkspaceKey(argon, PASSPHRASE)).equals(Buffer.from(key))).toBe(true);
    const scrypt = await createKeyEnvelope(key, PASSPHRASE, SCRYPT_MIN);
    expect(scrypt.kdf).toBe("scrypt");
    expect(Buffer.from(await unwrapWorkspaceKey(scrypt, PASSPHRASE)).equals(Buffer.from(key))).toBe(true);
    const fallback = await createKeyEnvelope(key, PASSPHRASE, {
      argon2id() {
        throw new Error("argon2 unavailable");
      },
    });
    expect(fallback.kdf).toBe("scrypt");
    expect(Buffer.from(await unwrapWorkspaceKey(fallback, PASSPHRASE)).equals(Buffer.from(key))).toBe(true);
    const encoded = JSON.stringify(fallback);
    expect(encoded).not.toContain(PASSPHRASE);
    expect(encoded).not.toContain(bytesToBase64(key));
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
