import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import {
  GenDragoonClient,
  connectRedirect,
  formatBytes,
  parseConnectRequest,
  parseProviderBindings,
  parseProviderGrant,
  providerErrorMessage,
  providerQuota,
  scopeLabel,
} from "../src/index.js";

const ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("parseProviderBindings", () => {
  it("keeps documented fields and sorts active first, newest first", () => {
    const list = parseProviderBindings({ bindings: [
      { id: "1".repeat(8) + "-1111-4111-8111-" + "1".repeat(12), workspaceId: "w1", client: { name: "Old", host: "a" }, scopes: ["blobs:r"], usedBytes: 1, quotaBytes: 10, objectCount: 1, createdAt: "2026-01-01T00:00:00Z", lastUsedAt: null, lastError: null, active: false },
      { id: ID, workspaceId: "w2", client: { name: "RedX", host: "mac" }, scopes: ["blobs:rw", "bogus"], usedBytes: 5, quotaBytes: 10, objectCount: 2, createdAt: "2026-02-01T00:00:00Z", lastUsedAt: "2026-02-02T00:00:00Z", lastError: null, active: true, extra: "dropped" },
    ] });
    expect(list.map((b) => b.client.name)).toEqual(["RedX", "Old"]);
    expect(list[0]).not.toHaveProperty("extra");
    expect(list[0]?.scopes).toEqual(["blobs:rw"]);
  });
  it("drops records that carry anything key-like and rejects malformed bodies", () => {
    expect(parseProviderBindings({ bindings: [{ id: ID, client: { name: "x" }, apiKey: "gdpk_0123456789abcdef_" + "a".repeat(43) }] })).toEqual([]);
    expect(parseProviderBindings({ bindings: [{ id: "../etc" }, null, 4] })).toEqual([]);
    expect(() => parseProviderBindings({})).toThrow();
  });
  it("validates grant shapes", () => {
    expect(parseProviderGrant({ grant: "gdpg_" + "A".repeat(43), expiresAt: "2026-10-19T00:05:00Z", ttlSeconds: 300 }).ttlSeconds).toBe(300);
    expect(() => parseProviderGrant({ grant: "nope" })).toThrow();
  });
});

describe("quota display", () => {
  it("levels and labels", () => {
    expect(providerQuota({ usedBytes: 0, quotaBytes: 1_000_000_000 })).toMatchObject({ level: "ok", fraction: 0, label: "0 B of 1 GB" });
    expect(providerQuota({ usedBytes: 850_000_000, quotaBytes: 1_000_000_000 }).level).toBe("warn");
    expect(providerQuota({ usedBytes: 1_200_000_000, quotaBytes: 1_000_000_000 })).toMatchObject({ level: "full", fraction: 1 });
    expect(providerQuota({ usedBytes: 0, quotaBytes: 0 }).level).toBe("ok");
    expect(formatBytes(1_500_000)).toBe("1.5 MB");
    expect(formatBytes(12_340_000_000)).toBe("12.3 GB");
    expect(formatBytes(999)).toBe("999 B");
  });
  it("scope labels and error text", () => {
    expect(scopeLabel(["blobs:rw"])).toBe("Read and write");
    expect(scopeLabel(["blobs:r"])).toBe("Read only");
    expect(providerErrorMessage({ status: 429, code: "rate_limited" })).toMatch(/Too many/);
    expect(providerErrorMessage({ status: 0, code: "NETWORK" })).toMatch(/reach/);
  });
});

describe("connect links", () => {
  const link = (over: Record<string, string> = {}) => {
    const q = new URLSearchParams({ client: "RedX", host: "josh-mac", scope: "blobs:rw", code_challenge: CHALLENGE, code_challenge_method: "S256", redirect_uri: "http://127.0.0.1:53682/cb", state: "s1", ...over });
    return `gendragoon://connect?${q}`;
  };
  it("accepts a loopback PKCE request and builds the redirect", () => {
    const req = parseConnectRequest(link());
    expect(req).toMatchObject({ requester: { name: "RedX", host: "josh-mac" }, scopes: ["blobs:rw"], codeChallengeMethod: "S256" });
    const back = new URL(connectRedirect(req, { code: "gdpc_" + "b".repeat(43), expiresAt: "" }));
    expect(back.host).toBe("127.0.0.1:53682");
    expect(back.searchParams.get("state")).toBe("s1");
  });
  it.each([
    ["remote redirect", { redirect_uri: "https://evil.example/cb" }],
    ["loopback without port", { redirect_uri: "http://127.0.0.1/cb" }],
    ["localhost name", { redirect_uri: "http://localhost:5000/cb" }],
    ["plain method", { code_challenge_method: "plain" }],
    ["short challenge", { code_challenge: "abc" }],
    ["unknown scope", { scope: "admin" }],
    ["no state", { state: "" }],
    ["no client", { client: "" }],
  ])("rejects %s", (_name, over) => {
    expect(() => parseConnectRequest(link(over))).toThrow();
  });
  it("rejects other schemes", () => {
    expect(() => parseConnectRequest("https://gendragoon.app/connect?x=1")).toThrow();
  });
});

describe("GenDragoonClient provider methods", () => {
  it("calls the documented routes with the Firebase token and never sends keys", async () => {
    const calls: { method: string; url: string; body: unknown; auth: string | null }[] = [];
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test/",
      getToken: () => "firebase-token",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init?.headers).get("Authorization") });
        if (url.endsWith("/connect/grants")) return json(201, { grant: "gdpg_" + "c".repeat(43), expiresAt: "2026-10-19T00:05:00Z", ttlSeconds: 300 });
        if (url.endsWith("/connect/authorize")) return json(201, { code: "gdpc_" + "d".repeat(43), expiresAt: "2026-10-19T00:05:00Z" });
        if (url.includes("/bindings/")) return json(200, { revoked: true, purgedObjects: 3 });
        return json(200, { bindings: [] });
      },
    });
    await client.providerBindings();
    await client.createProviderGrant("w1", { name: "RedX", host: "mac" });
    const req = parseConnectRequest(`gendragoon://connect?client=RedX&code_challenge=${CHALLENGE}&code_challenge_method=S256&redirect_uri=${encodeURIComponent("http://127.0.0.1:9/cb")}&state=z`);
    await client.authorizeProvider("w1", req);
    expect(await client.revokeProviderBinding(ID, true)).toEqual({ revoked: true, purgedObjects: 3 });
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://api.example.test", "")}`)).toEqual([
      "GET /provider/v1/bindings",
      "POST /provider/v1/connect/grants",
      "POST /provider/v1/connect/authorize",
      `DELETE /provider/v1/bindings/${ID}?deleteData=true`,
    ]);
    expect(calls.every((c) => c.auth === "Bearer firebase-token")).toBe(true);
    expect(calls[2]?.body).toEqual({ workspaceId: "w1", scopes: ["blobs:rw"], requester: { name: "RedX", host: "" }, codeChallenge: CHALLENGE, codeChallengeMethod: "S256" });
  });
});

// Real backend routes (memory stores), from the backend branch feature/provider-v1:
// GD_PROVIDER_CONTRACT_SERVER=/path/to/native/Backend/scripts/provider_contract_server.js pnpm --filter @gendragoon/core test
const server = process.env.GD_PROVIDER_CONTRACT_SERVER;
describe.skipIf(!server)("against the backend provider_contract_server", () => {
  it("lists, then revokes, the connected binding", async () => {
    const child = spawn(process.execPath, [server!], { stdio: ["pipe", "pipe", "inherit"] });
    try {
      const line = await new Promise<string>((resolve) => createInterface({ input: child.stdout! }).once("line", resolve));
      const info = JSON.parse(line) as { base: string; key: string; quotaBytes: number };
      const client = new GenDragoonClient({ baseUrl: info.base.replace(/\/provider\/v1$/, ""), getToken: () => "test" });
      const list = await client.providerBindings();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ active: true, quotaBytes: info.quotaBytes, usedBytes: 0 });
      expect(JSON.stringify(list)).not.toContain(info.key);
      const grant = await client.createProviderGrant("free", { name: "RedX", host: "test" });
      expect(grant.grant).toMatch(/^gdpg_/);
      expect((await client.revokeProviderBinding(list[0]!.id, true)).revoked).toBe(true);
      expect((await client.providerBindings())[0]?.active).toBe(false);
      const health = await fetch(`${info.base}/health`, { headers: { Authorization: `Bearer ${info.key}` } });
      expect(health.status).toBe(401);
    } finally {
      child.stdin!.end();
      child.kill();
    }
  });
});
