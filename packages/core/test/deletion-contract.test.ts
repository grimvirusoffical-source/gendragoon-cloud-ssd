/**
 * Deletion contract test: drives core's delete-account client with the REAL
 * response shapes from gendragoon-cloud-ssd PR #6 (native/Backend/account_delete.js
 * at 8a4a64c / blob 249c47c):
 *   202  {status:"deleting", jobId, statusToken}          (statusToken since 84f6fff)
 *   GET  /v2/account/deletions/:jobId -> {jobId, status, retryable}, status in queued|running|done|failed
 *   401  {error:"reauth_required"} | {error:"invalid_token"}   (key is `error`, there is no `code`)
 *   410  {error:"account_deleted", jobId, statusToken}    (fresh statusToken since 84f6fff)
 *   404  {error:"not_found"}
 * `it.fails` + "BUG(contract)" = core does not meet the contract today.
 * `it.fails` + "TODO(contract)" = PR #6 84f6fff ships statusToken; core does not use it yet
 *   (Avery's queued PR #1 push: statusToken polling + injected SecureStore {get,set,delete}).
 * Remove the marker when the fix lands; the test then has to pass for real.
 */
import { describe, expect, it } from "vitest";
import {
  GenDragoonClient,
  MemorySecretStore,
  ReauthRequiredError,
  deleteAccountAndWipe,
  deletionAuthFailure,
  isWorkspaceLockError,
  workspaceKeyId,
} from "../src/index.js";

const BASE = "https://api.example.test";
const JOB = "4f9c2a8e-0000-4000-8000-000000000001";
const WS = ["ws-a", "ws-b"];

type Reply = { status: number; body?: unknown };
interface Call { method: string; path: string; auth: string | null; contentType: string | null; body: unknown }

function idToken(authTimeSec: number, iatSec = authTimeSec): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc({ auth_time: authTimeSec, iat: iatSec })}.sig`;
}

/** Scripted PR #6 server. Each route pops its next reply; the last one repeats. */
function server(script: { del: Reply[]; status?: Reply[] }) {
  const calls: Call[] = [];
  const queues = { del: [...script.del], status: [...(script.status ?? [])] };
  const take = (q: Reply[]): Reply => (q.length > 1 ? q.shift()! : q[0] ?? { status: 500, body: { error: "unscripted" } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const raw = init?.body ? String(init.body) : null;
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      auth: headers.get("authorization"),
      contentType: headers.get("content-type"),
      body: raw ? JSON.parse(raw) : null,
    });
    let reply: Reply;
    if (init?.method === "DELETE" && url.pathname === "/v2/account") reply = take(queues.del);
    else if (init?.method === "GET" && /^\/v2\/account\/deletions\/[^/]+$/.test(url.pathname)) reply = take(queues.status);
    else reply = { status: 404, body: { error: "not_found" } }; // singular /deletion/:id included
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

const st = (status: string, jobId = JOB): Reply => ({ status: 200, body: { jobId, status, retryable: status === "failed" } });
const accepted = (extra: Record<string, unknown> = {}): Reply => ({ status: 202, body: { status: "deleting", jobId: JOB, ...extra } });

async function seededSecrets() {
  const secrets = new MemorySecretStore();
  for (const id of WS) await secrets.set(workspaceKeyId(id), new Uint8Array(32).fill(7));
  return secrets;
}
async function keysLeft(secrets: MemorySecretStore) {
  let n = 0;
  for (const id of WS) if (await secrets.get(workspaceKeyId(id))) n += 1;
  return n;
}

async function run(script: { del: Reply[]; status?: Reply[] }, opts: { token?: string; authTimeAgoSec?: number; timeoutMs?: number } = {}) {
  const now = Date.now();
  const tok = idToken(Math.floor(now / 1000) - (opts.authTimeAgoSec ?? 30));
  const srv = server(script);
  const client = new GenDragoonClient({ baseUrl: BASE, getToken: () => opts.token ?? tok, fetch: srv.fetchImpl });
  const secrets = await seededSecrets();
  let result: unknown;
  let error: unknown;
  try {
    result = await deleteAccountAndWipe({
      client,
      reauthenticatedAt: "",
      idToken: tok,
      workspaceIds: WS,
      secrets,
      now,
      sleep: async () => {},
      timeoutMs: opts.timeoutMs ?? 60_000,
      backoffMs: [1],
    });
  } catch (e) {
    error = e;
  }
  return { result, error, calls: srv.calls, keys: await keysLeft(secrets) };
}

const statusCalls = (calls: Call[]) => calls.filter((c) => c.method === "GET");

describe("deletion contract vs PR #6 real shapes: request", () => {
  it("DELETE /v2/account sends {confirm:'DELETE'} as application/json", async () => {
    const r = await run({ del: [accepted()], status: [st("done")] });
    const del = r.calls.find((c) => c.method === "DELETE")!;
    expect(del.path).toBe("/v2/account");
    expect(del.body).toEqual({ confirm: "DELETE" });
    expect(del.contentType).toBe("application/json");
  });

  it("reads jobId from the real 202 {status:'deleting', jobId} body", async () => {
    const r = await run({ del: [accepted()], status: [st("done")] });
    expect(r.error).toBeUndefined();
    expect(statusCalls(r.calls)[0]?.path).toBe(`/v2/account/deletions/${JOB}`);
  });

  it("polls only the plural /v2/account/deletions/:jobId, never singular", async () => {
    const r = await run({ del: [accepted()], status: [st("queued"), st("running"), st("done")] });
    const gets = statusCalls(r.calls);
    expect(gets.length).toBe(3);
    for (const g of gets) expect(g.path).toBe(`/v2/account/deletions/${JOB}`);
    expect(r.calls.some((c) => c.path.includes("/account/deletion/"))).toBe(false);
  });
});

describe("deletion contract: terminal states read from `status` (not `state`)", () => {
  it("done -> wipe", async () => {
    const r = await run({ del: [accepted()], status: [st("running"), st("done")] });
    expect(r.error).toBeUndefined();
    expect((r.result as { status: string }).status).toBe("done");
    expect(r.keys).toBe(0);
  });

  it("failed -> stop, no wipe", async () => {
    const r = await run({ del: [accepted()], status: [st("failed")] });
    expect((r.result as { status: string } | undefined)?.status ?? "threw").not.toBe("done");
    expect(statusCalls(r.calls).length).toBe(1);
    expect(r.keys).toBe(2);
  });

  it("queued/running -> keep polling", async () => {
    const r = await run({ del: [accepted()], status: [st("queued"), st("running"), st("running"), st("done")] });
    expect(statusCalls(r.calls).length).toBe(4);
    expect(r.keys).toBe(2 - 2);
  });

  it("a body with `state` instead of `status` never wipes", async () => {
    const r = await run({ del: [accepted()], status: [{ status: 200, body: { jobId: JOB, state: "done", retryable: false } }] }, { timeoutMs: 5 });
    expect(r.keys).toBe(2);
    expect(r.error).toBeDefined();
  });

  it("'completed' -> failure, no wipe (eventually, via timeout)", async () => {
    const r = await run({ del: [accepted()], status: [st("completed")] }, { timeoutMs: 5 });
    expect(r.error).toBeDefined();
    expect(r.keys).toBe(2);
  });

  it.fails("BUG(contract): 'completed'/unknown status fails immediately instead of polling to timeout (account.ts:78-80 treats only done|failed as terminal)", async () => {
    const r = await run({ del: [accepted()], status: [st("completed")] }, { timeoutMs: 500 });
    expect(r.error).toBeDefined();
    expect(statusCalls(r.calls).length).toBe(1);
    expect(r.keys).toBe(2);
  });

  it("unknown status -> failure, no wipe", async () => {
    const r = await run({ del: [accepted()], status: [st("weird")] }, { timeoutMs: 5 });
    expect(r.error).toBeDefined();
    expect(r.keys).toBe(2);
  });
});

describe("deletion contract: 401s with PR #6 bodies ({error}, no `code`)", () => {
  it("401 {error:'reauth_required'} -> no wipe", async () => {
    const r = await run({ del: [{ status: 401, body: { error: "reauth_required" } }] });
    expect(r.error).toBeDefined();
    expect(r.keys).toBe(2);
  });

  it.fails("BUG(contract): 401 {error:'reauth_required'} maps to re-auth (client.ts:301,305 toError reads only `code`)", async () => {
    const r = await run({ del: [{ status: 401, body: { error: "reauth_required" } }] });
    expect(deletionAuthFailure(r.error)).toBe("reauth");
  });

  it("401 {error:'invalid_token'} -> no wipe", async () => {
    const r = await run({ del: [{ status: 401, body: { error: "invalid_token" } }] });
    expect(r.error).toBeDefined();
    expect(r.keys).toBe(2);
  });

  it.fails("BUG(contract): 401 {error:'invalid_token'} maps to sign-out (client.ts:301,306 toError reads only `code`)", async () => {
    const r = await run({ del: [{ status: 401, body: { error: "invalid_token" } }] });
    expect(deletionAuthFailure(r.error)).toBe("sign-out");
  });

  it("401 during polling -> no wipe", async () => {
    const r = await run({ del: [accepted()], status: [st("running"), { status: 401, body: { error: "invalid_token" } }] });
    expect(r.error).toBeDefined();
    expect(r.keys).toBe(2);
  });

  it("401 with no body/code -> no wipe", async () => {
    const r = await run({ del: [{ status: 401 }] });
    expect(r.error).toBeDefined();
    expect(r.keys).toBe(2);
  });
});

describe("deletion contract: 410 account_deleted", () => {
  it("410 does not wipe by itself", async () => {
    const r = await run({ del: [{ status: 410, body: { error: "account_deleted", jobId: JOB } }], status: [st("running")] }, { timeoutMs: 5 });
    expect(r.keys).toBe(2);
  });

  it("BUG(contract): 410 {error:'account_deleted', jobId} polls that job and wipes only on done (client.ts:301,303 needs `code`, so AccountDeletedError is never built)", async () => {
    const r = await run({ del: [{ status: 410, body: { error: "account_deleted", jobId: JOB } }], status: [st("running"), st("done")] });
    expect(statusCalls(r.calls).map((c) => c.path)).toEqual([`/v2/account/deletions/${JOB}`, `/v2/account/deletions/${JOB}`]);
    expect(r.keys).toBe(0);
  });

  it("410 without jobId -> fail, no wipe, no poll", async () => {
    const r = await run({ del: [{ status: 410, body: { error: "account_deleted" } }] });
    expect(r.error).toBeDefined();
    expect(statusCalls(r.calls).length).toBe(0);
    expect(r.keys).toBe(2);
  });

  it("410 with non-string jobId -> fail, no wipe, no poll", async () => {
    const r = await run({ del: [{ status: 410, body: { error: "account_deleted", jobId: 42 } }] });
    expect(r.error).toBeDefined();
    expect(statusCalls(r.calls).length).toBe(0);
    expect(r.keys).toBe(2);
  });
});

describe("deletion contract: statusToken (PR #6 at 84f6fff)", () => {
  // 84f6fff: 202 {status:"deleting", jobId, statusToken}; 410 {error:"account_deleted", jobId, statusToken}
  // (fresh token each time). Status token is 32 random bytes, base64url (43 chars). Polling accepts
  // Authorization: Bearer <statusToken>; another job's / expired / bad token -> 404 {error:"not_found"}.
  const TOKEN_202 = "A".repeat(42) + "1";
  const TOKEN_410 = "B".repeat(42) + "2";

  it("polls with Authorization: Bearer <statusToken> from the 202, not the Firebase token", async () => {
    const r = await run({ del: [accepted({ statusToken: TOKEN_202 })], status: [st("running"), st("done")] });
    const gets = statusCalls(r.calls);
    expect(gets.length).toBe(2);
    for (const g of gets) expect(g.auth).toBe(`Bearer ${TOKEN_202}`);
    expect(r.keys).toBe(0);
  });

  it("410 {error:'account_deleted', jobId, statusToken} polls that job with that statusToken, wipes only on done", async () => {
    const r = await run({
      del: [{ status: 410, body: { error: "account_deleted", jobId: JOB, statusToken: TOKEN_410 } }],
      status: [st("running"), st("done")],
    });
    const gets = statusCalls(r.calls);
    expect(gets.map((g) => g.path)).toEqual([`/v2/account/deletions/${JOB}`, `/v2/account/deletions/${JOB}`]);
    for (const g of gets) expect(g.auth).toBe(`Bearer ${TOKEN_410}`);
    expect(r.keys).toBe(0);
  });

  it("404 {error:'not_found'} while polling (expired/foreign token) never wipes", async () => {
    const r = await run({ del: [accepted({ statusToken: TOKEN_202 })], status: [{ status: 404, body: { error: "not_found" } }] });
    expect(r.error).toBeDefined();
    expect(r.keys).toBe(2);
  });

  /** Avery's planned injected SecureStore: async get/set/delete. Values are opaque to the test. */
  class FakeSecureStore {
    readonly values = new Map<string, unknown>();
    async get(name: string): Promise<unknown> { return this.values.has(name) ? this.values.get(name) : null; }
    async set(name: string, value: unknown): Promise<void> { this.values.set(name, value); }
    async delete(name: string): Promise<void> { this.values.delete(name); }
    dump(): string {
      return JSON.stringify([...this.values.entries()].map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : v]));
    }
  }

  it("jobId+statusToken are saved through the injected SecureStore and polling resumes after a restart (no second DELETE)", async () => {
    const core = (await import("../src/index.js")) as Record<string, unknown>;
    const now = Date.now();
    const tok = idToken(Math.floor(now / 1000) - 30);
    const secureStore = new FakeSecureStore();

    // Run 1: 202, one `running` poll, then the app is killed during the backoff sleep.
    const first = server({ del: [accepted({ statusToken: TOKEN_202 })], status: [st("running")] });
    const secrets = await seededSecrets();
    const killed = new Error("app killed");
    const input1 = {
      client: new GenDragoonClient({ baseUrl: BASE, getToken: () => tok, fetch: first.fetchImpl }),
      reauthenticatedAt: "", idToken: tok, workspaceIds: WS, secrets, secureStore, now,
      sleep: async () => { throw killed; }, timeoutMs: 60_000, backoffMs: [1],
    };
    await expect(deleteAccountAndWipe(input1 as Parameters<typeof deleteAccountAndWipe>[0])).rejects.toBe(killed);
    expect(secureStore.dump()).toContain(JOB);
    expect(secureStore.dump()).toContain(TOKEN_202);
    expect(await keysLeft(secrets)).toBe(2);

    // Run 2 (fresh process): resume from SecureStore only. Firebase user is gone, so getToken fails.
    expect(typeof core.resumeAccountDeletion).toBe("function");
    const second = server({ del: [{ status: 500, body: { error: "unscripted" } }], status: [st("running"), st("done")] });
    const resume = core.resumeAccountDeletion as (i: unknown) => Promise<{ status: string } | null>;
    const result = await resume({
      client: new GenDragoonClient({ baseUrl: BASE, getToken: () => { throw new Error("signed out"); }, fetch: second.fetchImpl }),
      workspaceIds: WS, secrets, secureStore, sleep: async () => {}, timeoutMs: 60_000, backoffMs: [1],
    });
    expect(second.calls.some((c) => c.method === "DELETE")).toBe(false);
    for (const g of statusCalls(second.calls)) {
      expect(g.path).toBe(`/v2/account/deletions/${JOB}`);
      expect(g.auth).toBe(`Bearer ${TOKEN_202}`);
    }
    expect(result?.status).toBe("done");
    expect(await keysLeft(secrets)).toBe(0);
    // Once done, the deletion job secrets are cleared too.
    expect(secureStore.dump()).not.toContain(TOKEN_202);
  });
});

describe("deletion contract: re-auth window and workspace lock", () => {
  it("5-min check uses auth_time: stale auth_time is refused before any request", async () => {
    const r = await run({ del: [accepted()], status: [st("done")] }, { authTimeAgoSec: 6 * 60 });
    expect(r.error).toBeInstanceOf(ReauthRequiredError);
    expect(r.calls.length).toBe(0);
    expect(r.keys).toBe(2);
  });

  it("5-min check ignores a fresh iat when auth_time is stale", async () => {
    const now = Date.now();
    const tok = idToken(Math.floor(now / 1000) - 600, Math.floor(now / 1000));
    const srv = server({ del: [accepted()], status: [st("done")] });
    const client = new GenDragoonClient({ baseUrl: BASE, getToken: () => tok, fetch: srv.fetchImpl });
    const secrets = await seededSecrets();
    await expect(
      deleteAccountAndWipe({ client, reauthenticatedAt: new Date(now).toISOString(), idToken: tok, workspaceIds: WS, secrets, now, sleep: async () => {} }),
    ).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(srv.calls.length).toBe(0);
  });

  it("423 workspace_lock (PR #5 body) is surfaced as a workspace lock, no wipe", async () => {
    const r = await run({ del: [{ status: 423, body: { error: "workspace_lock", reason: "over_cap", overBy: 1, unpaidWorkspaceIds: [] } }] });
    expect(isWorkspaceLockError(r.error)).toBe(true);
    expect(r.keys).toBe(2);
  });
});
