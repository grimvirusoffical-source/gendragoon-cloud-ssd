/**
 * Deletion contract test: drives core's delete-account client with the REAL
 * response shapes from gendragoon-cloud-ssd PR #6 (native/Backend/account_delete.js
 * at 8a4a64c / blob 249c47c):
 *   202  {status:"deleting", jobId, statusToken}          (statusToken since 84f6fff)
 *   GET  /v2/account/deletions/:jobId -> {jobId, status, retryable}, status in queued|running|done|failed
 *   401  {error:"reauth_required"} | {error:"invalid_token"}   (key is `error`, there is no `code`)
 *   410  {error:"account_deleted", jobId, statusToken}    (fresh statusToken since 84f6fff)
 *   404  {error:"not_found"}
 * Every case here passes on core (PR #1 at 93b2fdf and later). None is marked
 * it.fails, skip or todo; a regression must fail the suite. Earlier revisions of
 * this file tracked core gaps as it.fails "BUG(contract)" cases with core
 * file:line in the title; those fixes landed and the markers were removed.
 *
 * Final rulings (Avery + Riley, Oct 18): `error` wins over `code` when both are set
 * and differ, and `failed` is not terminal for the client (keep jobId+statusToken,
 * Retry when `retryable`, clear only on `done` or dismiss, wipe only on `done`).
 * See the last two describe blocks.
 *
 * The older cases below still use the PR #6 shapes written in this file. The
 * invalid_token ruling cases at the end load Riley's generated bodies from
 * fixtures/server-pr6/account-deletion (PR #6 fff0a84, see SOURCE.json there).
 */
import { describe, expect, it } from "vitest";
import {
  DeletionNotFoundError,
  GenDragoonClient,
  InvalidTokenError,
  MemorySecretStore,
  ReauthRequiredError,
  deleteAccountAndWipe,
  deletionAuthFailure,
  dismissAccountDeletion,
  isWorkspaceLockError,
  resumeAccountDeletion,
  workspaceKeyId,
} from "../src/index.js";
import { loadServerFixture } from "./fixtures/server/load.js";
import { loadDeletionFixture } from "./fixtures/server-pr6/load.js";

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

  // `failed` stops this poll loop and never wipes. Whether the saved job is kept is
  // covered in "deletion ruling: failed is not terminal" below (it must be kept).
  it("failed -> stop polling, no wipe", async () => {
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

  it("'completed'/unknown status fails immediately instead of polling to timeout", async () => {
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

  it("401 {error:'reauth_required'} maps to re-auth", async () => {
    const r = await run({ del: [{ status: 401, body: { error: "reauth_required" } }] });
    expect(deletionAuthFailure(r.error)).toBe("reauth");
  });

  it("401 {error:'invalid_token'} -> no wipe", async () => {
    const r = await run({ del: [{ status: 401, body: { error: "invalid_token" } }] });
    expect(r.error).toBeDefined();
    expect(r.keys).toBe(2);
  });

  it("401 {error:'invalid_token'} maps to sign-out", async () => {
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

  it("410 {error:'account_deleted', jobId} polls that job and wipes only on done", async () => {
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

  it("423 workspace_lock from the over-cap fixture is surfaced as a workspace lock, no wipe", async () => {
    const lock = loadServerFixture("workspace-lock", "over-cap");
    const r = await run({ del: [{ status: lock.response.status, body: lock.response.body }] });
    expect(isWorkspaceLockError(r.error)).toBe(true);
    expect(r.keys).toBe(2);
  });
});

describe("deletion rulings: bare 401 and poll 404", () => {
  const TOKEN = "C".repeat(43);

  async function savedText(store: MemorySecretStore, name: string): Promise<string | null> {
    const bytes = await store.get(name);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  it("401 with no error code sends the user to sign-in and keeps the saved job", async () => {
    const now = Date.now();
    const tok = idToken(Math.floor(now / 1000) - 30);
    const srv = server({
      del: [accepted({ statusToken: TOKEN })],
      status: [{ status: 401, body: {} }],
    });
    const secrets = await seededSecrets();
    const secureStore = new MemorySecretStore();
    const error = await deleteAccountAndWipe({
      client: new GenDragoonClient({ baseUrl: BASE, getToken: () => tok, fetch: srv.fetchImpl }),
      reauthenticatedAt: "",
      idToken: tok,
      workspaceIds: WS,
      secrets,
      secureStore,
      now,
      sleep: async () => {},
      timeoutMs: 60_000,
      backoffMs: [1],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReauthRequiredError);
    expect(deletionAuthFailure(error)).toBe("reauth");
    expect(await keysLeft(secrets)).toBe(2);
    expect(await savedText(secureStore, "account-deletion:job-id")).toBe(JOB);
    expect(await savedText(secureStore, "account-deletion:status-token")).toBe(TOKEN);
    expect(statusCalls(srv.calls)).toHaveLength(1);
  });

  it("404 while polling is retryable and keeps the saved job until the user dismisses it", async () => {
    const now = Date.now();
    const tok = idToken(Math.floor(now / 1000) - 30);
    const srv = server({
      del: [accepted({ statusToken: TOKEN })],
      status: [{ status: 404, body: { error: "not_found" } }],
    });
    const secrets = await seededSecrets();
    const secureStore = new MemorySecretStore();
    const error = await deleteAccountAndWipe({
      client: new GenDragoonClient({ baseUrl: BASE, getToken: () => tok, fetch: srv.fetchImpl }),
      reauthenticatedAt: "",
      idToken: tok,
      workspaceIds: WS,
      secrets,
      secureStore,
      now,
      sleep: async () => {},
      timeoutMs: 60_000,
      backoffMs: [1],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeletionNotFoundError);
    expect(error).toMatchObject({ status: 404, code: "not_found", retryable: true });
    expect(await keysLeft(secrets)).toBe(2);
    expect(await savedText(secureStore, "account-deletion:job-id")).toBe(JOB);
    expect(await savedText(secureStore, "account-deletion:status-token")).toBe(TOKEN);

    await dismissAccountDeletion(secureStore);
    expect(await savedText(secureStore, "account-deletion:job-id")).toBeNull();
    expect(await savedText(secureStore, "account-deletion:status-token")).toBeNull();
    expect(await keysLeft(secrets)).toBe(2);
  });
});

/**
 * Avery's ruling (Oct 17): a 401 {error:"invalid_token"} on a request made with the owner's
 * Firebase token signs the user out. Sign-out clears only the session. The saved
 * jobId + statusToken stay in SecureStore, and local data is wiped only on `done`.
 * Contrast: reauth_required and a 401 with no code go to sign-in. Neither wipes.
 *
 * Avery's safety-net ruling (final, Oct 18): a status poll made WITH THE statusToken that
 * gets 401 invalid_token must STOP polling (no endless loop), KEEP jobId + statusToken, and
 * signal SIGN-IN (deletionAuthFailure === "reauth"), not sign-out. After the owner signs in,
 * a repeat DELETE gets 410 account_deleted with a fresh statusToken; the client saves it
 * over the old one and resumes polling. Wipe only on `done`. (Riley's server answers a dead
 * statusToken with 404, so this 401 is a safety net.)
 *
 * Poll-side 401s use Riley's status-invalid-token.json (GET /v2/account/deletions/:jobId,
 * 401 {error:"invalid_token"}) and status-unauthorized.json (no Authorization header,
 * 401 {error:"unauthorized"}). Per API-account.md, the server sends invalid_token on a poll only
 * for a bearer that looks like a Firebase ID token; for a statusToken it answers 404. The
 * statusToken + invalid_token tests below are Avery's safety net for a server that ever does.
 *
 * Every server reply here is a body from Riley's generated fixtures (PR #6 fff0a84).
 * The 410 / poll-404 / status-done fixtures share job ...0005, so they chain as one job.
 * The status token in the fixtures is the literal "<redacted>"; it is still the opaque
 * token the client must store and send back.
 *
 * Core has no session object: the sign-out signal is InvalidTokenError and
 * deletionAuthFailure(error) === "sign-out". The shell clears its session on that and
 * nothing else. After sign-out getToken throws, which is how these tests model it.
 */
describe("deletion ruling: 401 invalid_token (Firebase token -> sign-out; statusToken poll -> sign-in safety net) (fixtures fff0a84)", () => {
  const reply = (name: string): Reply => {
    const fx = loadDeletionFixture(name);
    return { status: fx.response.status, body: fx.response.body };
  };
  const INVALID = loadDeletionFixture("invalid-token");
  const STATUS_INVALID = loadDeletionFixture("status-invalid-token");
  const STATUS_UNAUTHORIZED = loadDeletionFixture("status-unauthorized");
  const SINGULAR = loadDeletionFixture("singular-path");
  const GONE = loadDeletionFixture("account-deleted");
  const ACCEPTED = loadDeletionFixture("accepted");
  const DONE = loadDeletionFixture("status-done");
  const GONE_BODY = GONE.response.body as { jobId: string; statusToken: string };
  const ACCEPTED_BODY = ACCEPTED.response.body as { jobId: string; statusToken: string };
  const JOB_KEY = "account-deletion:job-id";
  const TOKEN_KEY = "account-deletion:status-token";
  const signedOut = () => { throw new Error("signed out: no Firebase session"); };

  async function saved(store: MemorySecretStore, name: string): Promise<string | null> {
    const bytes = await store.get(name);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  async function startDeletion(script: { del: Reply[]; status?: Reply[] }, secrets: MemorySecretStore, secureStore: MemorySecretStore) {
    const now = Date.now();
    const tok = idToken(Math.floor(now / 1000) - 30);
    const srv = server(script);
    const error = await deleteAccountAndWipe({
      client: new GenDragoonClient({ baseUrl: BASE, getToken: () => tok, fetch: srv.fetchImpl }),
      reauthenticatedAt: "", idToken: tok, workspaceIds: WS, secrets, secureStore, now,
      sleep: async () => {}, timeoutMs: 60_000, backoffMs: [1],
    }).then(() => undefined, (caught: unknown) => caught);
    return { error, calls: srv.calls };
  }

  it("fixture sanity: invalid-token is the DELETE /v2/account 401 {error:'invalid_token'}", () => {
    expect(INVALID.request.method).toBe("DELETE");
    expect(INVALID.request.path).toBe("/v2/account");
    expect(INVALID.response).toEqual({ status: 401, body: { error: "invalid_token" } });
    expect(DONE.response.body).toMatchObject({ jobId: GONE_BODY.jobId, status: "done" });
  });

  it("fixture sanity: status-invalid-token, status-unauthorized and singular-path are JSON on the poll GET", () => {
    expect(STATUS_INVALID.request.method).toBe("GET");
    expect(STATUS_INVALID.request.path).toMatch(/^\/v2\/account\/deletions\/[0-9a-f-]{36}$/);
    expect(STATUS_INVALID.response).toEqual({ status: 401, body: { error: "invalid_token" } });
    expect(STATUS_UNAUTHORIZED.request.method).toBe("GET");
    expect(STATUS_UNAUTHORIZED.request.path).toMatch(/^\/v2\/account\/deletions\/[0-9a-f-]{36}$/);
    expect(STATUS_UNAUTHORIZED.request.headers ?? {}).not.toHaveProperty("authorization");
    expect(STATUS_UNAUTHORIZED.response).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(SINGULAR.request.path).toMatch(/^\/v2\/account\/deletion\//);
    expect(SINGULAR.response).toEqual({ status: 404, body: { error: "not_found" } });
  });

  it("singular-path: core never polls the singular path, and the real JSON 404 body on a poll is retryable, keeps the job, wipes nothing", async () => {
    const secrets = await seededSecrets();
    const secureStore = new MemorySecretStore();
    const r = await startDeletion({ del: [reply("accepted")], status: [reply("singular-path")] }, secrets, secureStore);
    expect(r.calls.some((c) => c.path.startsWith("/v2/account/deletion/"))).toBe(false);
    expect(r.error).toBeInstanceOf(DeletionNotFoundError);
    expect(r.error).toMatchObject({ status: 404, code: "not_found", retryable: true });
    expect(await keysLeft(secrets)).toBe(2);
    expect(await saved(secureStore, JOB_KEY)).toBe(ACCEPTED_BODY.jobId);
    expect(await saved(secureStore, TOKEN_KEY)).toBe(ACCEPTED_BODY.statusToken);
  });

  /**
   * Avery's ruling (Oct 18): a status GET that gets 401 {error:"unauthorized"} (Riley's
   * status-unauthorized) or a 401 with no code calls onAuthFailure("reauth_required"), never
   * "signed_out", stops polling, keeps jobId + statusToken, and wipes nothing. Only an
   * invalid_token on a Firebase-token request maps to "signed_out".
   * The hook assertions come last so a failure there is the missing signal, not setup.
   */
  async function pollWith401(body: unknown) {
    const secrets = await seededSecrets();
    const secureStore = new MemorySecretStore();
    const now = Date.now();
    const tok = idToken(Math.floor(now / 1000) - 30);
    const srv = server({ del: [reply("accepted")], status: [{ status: 401, body }] });
    const signals: Array<{ signal: unknown; error: unknown }> = [];
    const input = {
      client: new GenDragoonClient({ baseUrl: BASE, getToken: () => tok, fetch: srv.fetchImpl }),
      reauthenticatedAt: "", idToken: tok, workspaceIds: WS, secrets, secureStore, now,
      sleep: async () => {}, timeoutMs: 60_000, backoffMs: [1],
      onAuthFailure: (signal: unknown, error: unknown) => { signals.push({ signal, error }); },
    };
    const error = await deleteAccountAndWipe(input as Parameters<typeof deleteAccountAndWipe>[0])
      .then(() => undefined, (caught: unknown) => caught);
    return { error, calls: srv.calls, secrets, secureStore, signals };
  }

  async function expectReauthStopKeep(r: Awaited<ReturnType<typeof pollWith401>>) {
    const gets = statusCalls(r.calls);
    // The scripted server repeats the 401, so a loop would show up as extra GETs.
    expect(gets).toHaveLength(1);
    expect(gets[0]!.auth).toBe(`Bearer ${ACCEPTED_BODY.statusToken}`);
    expect(r.error).toMatchObject({ status: 401 });
    expect(await keysLeft(r.secrets)).toBe(2);
    expect(await saved(r.secureStore, JOB_KEY)).toBe(ACCEPTED_BODY.jobId);
    expect(await saved(r.secureStore, TOKEN_KEY)).toBe(ACCEPTED_BODY.statusToken);
    expect(r.signals.some((s) => s.signal === "signed_out")).toBe(false);
    expect(r.signals.map((s) => s.signal)).toContain("reauth_required");
  }

  it("status-unauthorized on a poll -> onAuthFailure('reauth_required'), polling stops, job kept, nothing wiped", async () => {
    await expectReauthStopKeep(await pollWith401(STATUS_UNAUTHORIZED.response.body));
  });

  it("bare 401 with no code on a poll (DERIVED body {}) -> onAuthFailure('reauth_required'), polling stops, job kept, nothing wiped", async () => {
    // DERIVED: Riley has no status fixture for a 401 without a code.
    await expectReauthStopKeep(await pollWith401({}));
  });

  it("DELETE -> invalid_token: sign-out signal, no wipe, no poll, no job invented, SecureStore untouched", async () => {
    const secrets = await seededSecrets();
    const secureStore = new MemorySecretStore();
    await secureStore.set("unrelated:byo-secret", new TextEncoder().encode("keep-me"));
    const r = await startDeletion({ del: [reply("invalid-token")] }, secrets, secureStore);

    const del = r.calls.find((c) => c.method === "DELETE")!;
    expect(del.path).toBe(INVALID.request.path);
    expect(del.body).toEqual(INVALID.request.body);
    expect(r.error).toBeInstanceOf(InvalidTokenError);
    expect(deletionAuthFailure(r.error)).toBe("sign-out");
    expect(statusCalls(r.calls)).toHaveLength(0);
    expect(await keysLeft(secrets)).toBe(2);
    expect(await saved(secureStore, JOB_KEY)).toBeNull();
    expect(await saved(secureStore, TOKEN_KEY)).toBeNull();
    expect(await saved(secureStore, "unrelated:byo-secret")).toBe("keep-me");
  });

  it("DELETE -> invalid_token is not the sign-in path: reauth-required fixture and a bare 401 map to 'reauth', none wipe", async () => {
    const invalid = await startDeletion({ del: [reply("invalid-token")] }, await seededSecrets(), new MemorySecretStore());
    const reauthSecrets = await seededSecrets();
    const reauth = await startDeletion({ del: [reply("reauth-required")] }, reauthSecrets, new MemorySecretStore());
    expect(deletionAuthFailure(invalid.error)).toBe("sign-out");
    expect(deletionAuthFailure(reauth.error)).toBe("reauth");
    expect(await keysLeft(reauthSecrets)).toBe(2);
    // Bare 401 (no error code) is covered with a saved job in "deletion rulings: bare 401 and poll 404".
  });

  /** The old saved statusToken that the server rejects. Distinct from the fixtures' "<redacted>" so a replacement is visible. */
  const STALE_TOKEN = "<redacted:stale>";
  async function savedJob(jobId: string, token: string): Promise<MemorySecretStore> {
    const store = new MemorySecretStore();
    await store.set(JOB_KEY, new TextEncoder().encode(jobId));
    await store.set(TOKEN_KEY, new TextEncoder().encode(token));
    return store;
  }

  /**
   * Avery's ruling (final, Oct 18): a status poll made with the owner's Firebase token that gets
   * 401 invalid_token SIGNS OUT, KEEPS the saved job, and polling CONTINUES with the saved
   * statusToken. Wipe only on `done`.
   *
   * The sign-out signal has to reach the shell while polling goes on, so it cannot be a thrown
   * error. Avery's core hook (PR #1): `onAuthFailure(signal, error)` with signal exactly
   * "signed_out" or "reauth_required".
   */
  it("Firebase-token poll -> invalid_token (real status-invalid-token) signs out, keeps the saved job, and polling continues with Bearer statusToken through real status-running -> status-done; done wipes and clears", async () => {
    const secrets = await seededSecrets();
    const secureStore = await savedJob(GONE_BODY.jobId, GONE_BODY.statusToken);
    const now = Date.now();
    const tok = idToken(Math.floor(now / 1000) - 30); // owner's Firebase ID token
    const keysAtEachPoll: number[] = [];
    const srv = server({ del: [{ status: 500, body: { error: "unscripted" } }], status: [reply("status-invalid-token"), reply("status-running"), reply("status-done")] });
    const fetchImpl: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "GET") keysAtEachPoll.push(await keysLeft(secrets));
      return srv.fetchImpl(input, init);
    };
    const signals: Array<{ signal: unknown; error: unknown }> = [];
    const input = {
      client: new GenDragoonClient({ baseUrl: BASE, getToken: () => tok, fetch: fetchImpl }),
      reauthenticatedAt: "", idToken: tok, workspaceIds: WS, secrets, secureStore, now,
      sleep: async () => {}, timeoutMs: 60_000, backoffMs: [1],
      onAuthFailure: (signal: unknown, error: unknown) => { signals.push({ signal, error }); },
    };
    let result: { status: string } | undefined;
    let thrown: unknown;
    try {
      result = await deleteAccountAndWipe(input as Parameters<typeof deleteAccountAndWipe>[0]);
    } catch (caught) {
      thrown = caught;
    }

    const gets = statusCalls(srv.calls);
    expect(srv.calls.some((c) => c.method === "DELETE")).toBe(false);
    // 1. First poll uses the owner's Firebase token and gets invalid_token.
    expect(gets[0]?.auth).toBe(`Bearer ${tok}`);
    // 2. That signals sign-out through onAuthFailure("signed_out", InvalidTokenError).
    const signedOutCall = signals.find((s) => s.signal === "signed_out");
    expect(signedOutCall).toBeDefined();
    expect(signedOutCall!.error).toBeInstanceOf(InvalidTokenError);
    expect(signals.some((s) => s.signal === "reauth_required")).toBe(false);
    // 3. Polling continues with the saved statusToken: status-running, then status-done.
    //    (status-running.json is captured for job ...0003; only its status is used, the GET path is job ...0005.)
    expect(gets).toHaveLength(3);
    for (const g of gets) expect(g.path).toBe(DONE.request.path);
    expect(gets[1]!.auth).toBe(`Bearer ${GONE_BODY.statusToken}`);
    expect(gets[2]!.auth).toBe(`Bearer ${GONE_BODY.statusToken}`);
    // 4. Nothing is wiped before done; done wipes and clears the job.
    expect(keysAtEachPoll).toEqual([2, 2, 2]);
    expect(thrown).toBeUndefined();
    expect(result?.status).toBe("done");
    expect(await keysLeft(secrets)).toBe(0);
    expect(await saved(secureStore, JOB_KEY)).toBeNull();
    expect(await saved(secureStore, TOKEN_KEY)).toBeNull();
  });

  it("poll with the statusToken -> invalid_token (real status-invalid-token, safety net): polling stops after one GET, jobId+statusToken kept, no wipe", async () => {
    const secrets = await seededSecrets();
    const secureStore = new MemorySecretStore();
    // The scripted server keeps answering invalid_token, so a loop would show up as extra GETs.
    const r = await startDeletion({ del: [reply("accepted")], status: [reply("status-invalid-token")] }, secrets, secureStore);
    const gets = statusCalls(r.calls);
    expect(r.error).toBeDefined();
    expect(gets).toHaveLength(1);
    expect(gets[0]!.auth).toBe(`Bearer ${ACCEPTED_BODY.statusToken}`);
    expect(await keysLeft(secrets)).toBe(2);
    expect(await saved(secureStore, JOB_KEY)).toBe(ACCEPTED_BODY.jobId);
    expect(await saved(secureStore, TOKEN_KEY)).toBe(ACCEPTED_BODY.statusToken);
  });

  it("poll with the statusToken -> invalid_token signals SIGN-IN ('reauth'), not sign-out", async () => {
    const secrets = await seededSecrets();
    const secureStore = await savedJob(GONE_BODY.jobId, STALE_TOKEN);
    const srv = server({ del: [reply("account-deleted")], status: [reply("status-invalid-token")] });
    // Avery's core hook (PR #1): onAuthFailure(signal, error), signal "signed_out" | "reauth_required".
    const signals: Array<{ signal: unknown; error: unknown }> = [];
    const input = {
      client: new GenDragoonClient({ baseUrl: BASE, getToken: signedOut, fetch: srv.fetchImpl }),
      workspaceIds: WS, secrets, secureStore, sleep: async () => {}, timeoutMs: 60_000, backoffMs: [1],
      onAuthFailure: (signal: unknown, error: unknown) => { signals.push({ signal, error }); },
    };
    const error = await resumeAccountDeletion(input as Parameters<typeof resumeAccountDeletion>[0])
      .then(() => undefined, (caught: unknown) => caught);

    expect(statusCalls(srv.calls)).toHaveLength(1);
    expect(statusCalls(srv.calls)[0]!.auth).toBe(`Bearer ${STALE_TOKEN}`);
    expect(deletionAuthFailure(error)).toBe("reauth");
    expect(signals.map((s) => s.signal)).toContain("reauth_required");
    expect(signals.some((s) => s.signal === "signed_out")).toBe(false);
    expect(error).not.toBeInstanceOf(InvalidTokenError);
    expect(await keysLeft(secrets)).toBe(2);
    expect(await saved(secureStore, JOB_KEY)).toBe(GONE_BODY.jobId);
    expect(await saved(secureStore, TOKEN_KEY)).toBe(STALE_TOKEN);
  });

  it("after the owner signs in, a repeat DELETE gets the real 410 account_deleted, its fresh statusToken replaces the stale one, polling resumes with it, done wipes and clears", async () => {
    // State left by the safety net: job ...0005 saved with the token the server rejected.
    const secrets = await seededSecrets();
    const secureStore = await savedJob(GONE_BODY.jobId, STALE_TOKEN);
    const killed = new Error("app killed");
    const now = Date.now();
    const tok = idToken(Math.floor(now / 1000) - 30); // fresh owner sign-in
    const input = (fetchImpl: typeof fetch, sleep: (ms: number) => Promise<void>) => ({
      client: new GenDragoonClient({ baseUrl: BASE, getToken: () => tok, fetch: fetchImpl }),
      reauthenticatedAt: "", idToken: tok, workspaceIds: WS, secrets, secureStore, now,
      sleep, timeoutMs: 60_000, backoffMs: [1],
    });

    // 1. Repeat DELETE -> 410 with a fresh token. Killed during the first backoff: the fresh token is already saved.
    const first = server({ del: [reply("account-deleted")], status: [reply("status-running")] });
    await expect(deleteAccountAndWipe(input(first.fetchImpl, async () => { throw killed; }))).rejects.toBe(killed);
    expect(first.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(first.calls[0]!.method).toBe("DELETE");
    expect(GONE_BODY.statusToken).not.toBe(STALE_TOKEN);
    expect(await saved(secureStore, JOB_KEY)).toBe(GONE_BODY.jobId);
    expect(await saved(secureStore, TOKEN_KEY)).toBe(GONE_BODY.statusToken);
    for (const g of statusCalls(first.calls)) expect(g.auth).toBe(`Bearer ${GONE_BODY.statusToken}`);
    expect(await keysLeft(secrets)).toBe(2);

    // 2. Resume from SecureStore with the fresh token; the real status-done for job ...0005 wipes.
    const resumed = server({ del: [{ status: 500, body: { error: "unscripted" } }], status: [reply("status-done")] });
    const result = await resumeAccountDeletion({
      client: new GenDragoonClient({ baseUrl: BASE, getToken: signedOut, fetch: resumed.fetchImpl }),
      workspaceIds: WS, secrets, secureStore, sleep: async () => {}, timeoutMs: 60_000, backoffMs: [1],
    });
    expect(resumed.calls.some((c) => c.method === "DELETE")).toBe(false);
    for (const g of statusCalls(resumed.calls)) {
      expect(g.path).toBe(DONE.request.path);
      expect(g.auth).toBe(`Bearer ${GONE_BODY.statusToken}`);
    }
    expect(result?.status).toBe("done");
    expect(await keysLeft(secrets)).toBe(0);
    expect(await saved(secureStore, JOB_KEY)).toBeNull();
    expect(await saved(secureStore, TOKEN_KEY)).toBeNull();
  });

  it("poll 404 from the other-job-token fixture keeps the job and wipes nothing", async () => {
    const secrets = await seededSecrets();
    const secureStore = new MemorySecretStore();
    const r = await startDeletion({ del: [reply("account-deleted")], status: [reply("other-job-token")] }, secrets, secureStore);
    expect(r.error).toBeInstanceOf(DeletionNotFoundError);
    expect(r.error).toMatchObject({ retryable: true });
    expect(await keysLeft(secrets)).toBe(2);
    expect(await saved(secureStore, JOB_KEY)).toBe(GONE_BODY.jobId);
    expect(await saved(secureStore, TOKEN_KEY)).toBe(GONE_BODY.statusToken);
  });
});

/**
 * Final ruling (Riley + Avery, Oct 18): deletion status `failed` is NOT terminal for the client.
 * - Keep jobId + statusToken in SecureStore.
 * - `retryable: true`: offer Retry. Retry's repeat DELETE returns 202 with the SAME jobId and a
 *   NEW statusToken, and the job goes back to queued. The client replaces the saved statusToken,
 *   keeps the jobId, and resumes polling with the new token.
 * - `retryable: false`: show the error with Dismiss. A repeat DELETE gets
 *   409 {error:"deletion_not_retryable", jobId} with no new token: keep the job, wipe nothing,
 *   surface a non-retryable error; Dismiss clears it.
 * - A status-token poll on a dead token is 404 (keep the job, Retry), not 401.
 * - Clear the saved job only on `done` or when the user dismisses. Wipe local data only on `done`.
 *
 * Real fixtures (PR #6 fff0a84): accepted (job ...0001), status-failed (job ...0004,
 * retryable:true), retry-after-failed (202 {status:"queued"}, job ...0004, new token),
 * status-failed-not-retryable (job ...0009, retryable:false), retry-not-retryable (409
 * {error:"deletion_not_retryable", jobId:...0009}, same permanent-failure job), status-queued /
 * status-running / status-done (jobs ...0002 / ...0003 / ...0005). Each fixture is its own
 * capture, so the jobId inside a poll body can differ from the job being polled; the tests
 * check the request path the client builds, not the jobId echoed in those bodies.
 *
 * Token redaction: every fixture token is the literal "<redacted>", so the retry 202's "new"
 * token is byte-equal to the 202 token it replaces. Core only checks non-empty, so nothing
 * breaks, but a replacement is invisible. The Retry tests therefore seed the client's saved
 * PREVIOUS token as "<redacted:previous>" (client state, not a server body). The server-side
 * "different token" guarantee is covered by Riley's backend test ("retry after failed: same
 * job, queued 202, token set grows").
 *
 * Retry entry point: core.retryDeletion if PR #1 exports it (called with the same input as
 * deleteAccountAndWipe), otherwise a second deleteAccountAndWipe() on the same SecureStore.
 * The Retry tests start from the state the ruling requires after `failed` (the job and its
 * previous token saved), so they exercise only the Retry behavior.
 */
describe("deletion ruling: failed is not terminal (fixtures fff0a84)", () => {
  const fx = (name: string) => loadDeletionFixture(name);
  const reply = (name: string): Reply => ({ status: fx(name).response.status, body: fx(name).response.body });
  const FAILED = fx("status-failed");
  const FAILED_BODY = FAILED.response.body as { jobId: string; status: string; retryable: boolean };
  const ACCEPTED_BODY = fx("accepted").response.body as { jobId: string; status: string; statusToken: string };
  const DONE_BODY = fx("status-done").response.body as { jobId: string; status: string; retryable: boolean };
  const JOB_KEY = "account-deletion:job-id";
  const TOKEN_KEY = "account-deletion:status-token";
  const RETRY = fx("retry-after-failed");
  const RETRY_BODY = RETRY.response.body as { jobId: string; status: string; statusToken: string };
  const NOT_RETRYABLE = fx("retry-not-retryable");
  const NOT_RETRYABLE_BODY = NOT_RETRYABLE.response.body as { error: string; jobId: string };
  const FAILED_NR = fx("status-failed-not-retryable");
  const FAILED_NR_BODY = FAILED_NR.response.body as { jobId: string; status: string; retryable: boolean };
  /** Client-side saved token from before the retry; distinct from "<redacted>" so a replacement is visible. */
  const PREVIOUS_TOKEN = "<redacted:previous>";

  /** The SecureStore state the ruling requires after a `failed` poll: the job and its previous token. */
  async function savedFailedJob(jobId: string = FAILED_BODY.jobId): Promise<MemorySecretStore> {
    const store = new MemorySecretStore();
    await store.set(JOB_KEY, new TextEncoder().encode(jobId));
    await store.set(TOKEN_KEY, new TextEncoder().encode(PREVIOUS_TOKEN));
    return store;
  }

  async function retry(script: { del: Reply[]; status?: Reply[] }, secrets: MemorySecretStore, secureStore: MemorySecretStore) {
    const core = (await import("../src/index.js")) as Record<string, unknown>;
    const entry = (typeof core.retryDeletion === "function" ? core.retryDeletion : deleteAccountAndWipe) as typeof deleteAccountAndWipe;
    const now = Date.now();
    const tok = idToken(Math.floor(now / 1000) - 30);
    const srv = server(script);
    let result: { status: string; retryable?: boolean; jobId?: string } | undefined;
    let error: unknown;
    try {
      result = await entry({
        client: new GenDragoonClient({ baseUrl: BASE, getToken: () => tok, fetch: srv.fetchImpl }),
        reauthenticatedAt: "", idToken: tok, workspaceIds: WS, secrets, secureStore, now,
        sleep: async () => {}, timeoutMs: 60_000, backoffMs: [1],
      });
    } catch (caught) {
      error = caught;
    }
    return { result, error, calls: srv.calls };
  }

  async function saved(store: MemorySecretStore, name: string): Promise<string | null> {
    const bytes = await store.get(name);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  async function attempt(script: { del: Reply[]; status?: Reply[] }, secrets: MemorySecretStore, secureStore: MemorySecretStore) {
    const now = Date.now();
    const tok = idToken(Math.floor(now / 1000) - 30);
    const srv = server(script);
    let result: { status: string; retryable?: boolean; jobId?: string } | undefined;
    let error: unknown;
    try {
      result = await deleteAccountAndWipe({
        client: new GenDragoonClient({ baseUrl: BASE, getToken: () => tok, fetch: srv.fetchImpl }),
        reauthenticatedAt: "", idToken: tok, workspaceIds: WS, secrets, secureStore, now,
        sleep: async () => {}, timeoutMs: 60_000, backoffMs: [1],
      });
    } catch (caught) {
      error = caught;
    }
    return { result, error, calls: srv.calls };
  }

  it("fixture sanity: status-failed is GET /v2/account/deletions/:jobId 200 {status:'failed', retryable:true}", () => {
    expect(FAILED.request.method).toBe("GET");
    expect(FAILED.request.path).toBe(`/v2/account/deletions/${FAILED_BODY.jobId}`);
    expect(FAILED.response.status).toBe(200);
    expect(FAILED_BODY).toMatchObject({ status: "failed", retryable: true });
  });

  it("fixture sanity: retry-after-failed is 202 {jobId, status:'queued', statusToken} for the failed job; retry-not-retryable is 409 {error, jobId} with no token", () => {
    expect(RETRY.request).toMatchObject({ method: "DELETE", path: "/v2/account", body: { confirm: "DELETE" } });
    expect(RETRY.response.status).toBe(202);
    expect(Object.keys(RETRY_BODY).sort()).toEqual(["jobId", "status", "statusToken"]);
    expect(RETRY_BODY.jobId).toBe(FAILED_BODY.jobId);
    expect(RETRY_BODY.status).toBe("queued");
    expect(typeof RETRY_BODY.statusToken).toBe("string");
    expect(RETRY_BODY.statusToken.length).toBeGreaterThan(0);
    expect(NOT_RETRYABLE.request).toMatchObject({ method: "DELETE", path: "/v2/account", body: { confirm: "DELETE" } });
    expect(NOT_RETRYABLE.response.status).toBe(409);
    expect(NOT_RETRYABLE_BODY).toEqual({ error: "deletion_not_retryable", jobId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(NOT_RETRYABLE_BODY).not.toHaveProperty("statusToken");
    expect(FAILED_NR.request).toMatchObject({ method: "GET", path: `/v2/account/deletions/${FAILED_NR_BODY.jobId}` });
    expect(FAILED_NR.response.status).toBe(200);
    expect(FAILED_NR_BODY).toEqual({ jobId: FAILED_NR_BODY.jobId, status: "failed", retryable: false });
    // retry-not-retryable is the repeat DELETE for that same permanently failed job.
    expect(NOT_RETRYABLE_BODY.jobId).toBe(FAILED_NR_BODY.jobId);
  });

  it("failed+retryable: stops polling, returns retryable:true for the Retry button, wipes nothing", async () => {
    const secrets = await seededSecrets();
    const secureStore = new MemorySecretStore();
    const r = await attempt({ del: [reply("accepted")], status: [reply("status-failed")] }, secrets, secureStore);
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ status: "failed", retryable: true });
    expect(statusCalls(r.calls)).toHaveLength(1);
    expect(statusCalls(r.calls)[0]!.path).toBe(`/v2/account/deletions/${ACCEPTED_BODY.jobId}`);
    expect(statusCalls(r.calls)[0]!.auth).toBe(`Bearer ${ACCEPTED_BODY.statusToken}`);
    expect(await keysLeft(secrets)).toBe(2);
  });

  it("failed+retryable keeps jobId+statusToken in SecureStore", async () => {
    const secrets = await seededSecrets();
    const secureStore = new MemorySecretStore();
    await attempt({ del: [reply("accepted")], status: [reply("status-failed")] }, secrets, secureStore);
    expect(await keysLeft(secrets)).toBe(2);
    expect(await saved(secureStore, JOB_KEY)).toBe(ACCEPTED_BODY.jobId);
    expect(await saved(secureStore, TOKEN_KEY)).toBe(ACCEPTED_BODY.statusToken);
  });

  it("Retry on failed+retryable re-sends DELETE; real retry-after-failed 202 keeps the jobId, replaces the saved statusToken, polls with the new token, wipes and clears only on done", async () => {
    const secrets = await seededSecrets();
    const secureStore = await savedFailedJob();
    const r = await retry({ del: [reply("retry-after-failed")], status: [reply("status-queued"), reply("status-running"), reply("status-done")] }, secrets, secureStore);

    expect(r.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(r.calls[0]!.method).toBe("DELETE");
    const gets = statusCalls(r.calls);
    expect(gets.length).toBeGreaterThan(0);
    for (const g of gets) {
      expect(g.path).toBe(`/v2/account/deletions/${RETRY_BODY.jobId}`);
      expect(g.auth).toBe(`Bearer ${RETRY_BODY.statusToken}`);
    }
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ status: "done" });
    expect(await keysLeft(secrets)).toBe(0);
    expect(await saved(secureStore, JOB_KEY)).toBeNull();
    expect(await saved(secureStore, TOKEN_KEY)).toBeNull();
  });

  it("Retry on failed+retryable saves the NEW statusToken over the old one and keeps the jobId before polling", async () => {
    const secrets = await seededSecrets();
    const secureStore = await savedFailedJob();
    const killed = new Error("app killed");
    // The app is killed during the first backoff after the retry is accepted.
    const core = (await import("../src/index.js")) as Record<string, unknown>;
    const entry = (typeof core.retryDeletion === "function" ? core.retryDeletion : deleteAccountAndWipe) as typeof deleteAccountAndWipe;
    const now = Date.now();
    const tok = idToken(Math.floor(now / 1000) - 30);
    const srv = server({ del: [reply("retry-after-failed")], status: [reply("status-queued")] });
    await expect(entry({
      client: new GenDragoonClient({ baseUrl: BASE, getToken: () => tok, fetch: srv.fetchImpl }),
      reauthenticatedAt: "", idToken: tok, workspaceIds: WS, secrets, secureStore, now,
      sleep: async () => { throw killed; }, timeoutMs: 60_000, backoffMs: [1],
    })).rejects.toBe(killed);
    expect(srv.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(await saved(secureStore, JOB_KEY)).toBe(RETRY_BODY.jobId);
    expect(await saved(secureStore, TOKEN_KEY)).toBe(RETRY_BODY.statusToken);
    expect(RETRY_BODY.statusToken).not.toBe(PREVIOUS_TOKEN);
    expect(await keysLeft(secrets)).toBe(2);
  });

  // Avery: the UI shows support contact + Dismiss for this 409. PR #1 will export
  // DeletionNotRetryableError carrying jobId; core has no such class yet.
  it("the client maps 409 {error:'deletion_not_retryable', jobId} (real retry-not-retryable) to DeletionNotRetryableError carrying jobId", async () => {
    const now = Date.now();
    const tok = idToken(Math.floor(now / 1000) - 30);
    const srv = server({ del: [reply("retry-not-retryable")] });
    const client = new GenDragoonClient({ baseUrl: BASE, getToken: () => tok, fetch: srv.fetchImpl });
    const error = await client.deleteAccount({ reauthenticatedAt: new Date(now).toISOString(), idToken: tok }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 409, code: "deletion_not_retryable" });
    const NotRetryable = ((await import("../src/index.js")) as Record<string, unknown>).DeletionNotRetryableError as (new (...args: never[]) => unknown) | undefined;
    expect(typeof NotRetryable).toBe("function");
    expect(error).toBeInstanceOf(NotRetryable!);
    expect(error).toMatchObject({ jobId: NOT_RETRYABLE_BODY.jobId });
  });

  it("Retry on failed+non-retryable -> real 409 retry-not-retryable keeps the job, wipes nothing, surfaces a non-retryable error; Dismiss then clears without wiping", async () => {
    const secrets = await seededSecrets();
    const secureStore = await savedFailedJob(NOT_RETRYABLE_BODY.jobId);
    const r = await retry({ del: [reply("retry-not-retryable")], status: [reply("status-failed")] }, secrets, secureStore);

    expect(r.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(statusCalls(r.calls)).toHaveLength(0);
    expect(r.error).toMatchObject({ status: 409, code: "deletion_not_retryable" });
    // PR #1 will export DeletionNotRetryableError carrying jobId (dynamic lookup so typecheck passes today).
    const NotRetryable = ((await import("../src/index.js")) as Record<string, unknown>).DeletionNotRetryableError as (new (...args: never[]) => unknown) | undefined;
    expect(typeof NotRetryable).toBe("function");
    expect(r.error).toBeInstanceOf(NotRetryable!);
    expect(r.error).toMatchObject({ jobId: NOT_RETRYABLE_BODY.jobId });
    expect((r.error as { retryable?: unknown }).retryable).not.toBe(true);
    expect(await keysLeft(secrets)).toBe(2);
    expect(await saved(secureStore, JOB_KEY)).toBe(NOT_RETRYABLE_BODY.jobId);
    expect(await saved(secureStore, TOKEN_KEY)).toBe(PREVIOUS_TOKEN);

    await dismissAccountDeletion(secureStore);
    expect(await saved(secureStore, JOB_KEY)).toBeNull();
    expect(await saved(secureStore, TOKEN_KEY)).toBeNull();
    expect(await keysLeft(secrets)).toBe(2);
  });

  it("failed+non-retryable (real status-failed-not-retryable) keeps the job until the user dismisses, then clears it without wiping", async () => {
    const secrets = await seededSecrets();
    const secureStore = new MemorySecretStore();
    const r = await attempt({ del: [reply("accepted")], status: [reply("status-failed-not-retryable")] }, secrets, secureStore);
    expect(r.result).toMatchObject({ status: "failed", retryable: false });
    expect(await keysLeft(secrets)).toBe(2);
    expect(await saved(secureStore, JOB_KEY)).toBe(ACCEPTED_BODY.jobId);
    expect(await saved(secureStore, TOKEN_KEY)).toBe(ACCEPTED_BODY.statusToken);

    await dismissAccountDeletion(secureStore);
    expect(await saved(secureStore, JOB_KEY)).toBeNull();
    expect(await saved(secureStore, TOKEN_KEY)).toBeNull();
    expect(await keysLeft(secrets)).toBe(2);
  });

  it("failed+non-retryable (real status-failed-not-retryable) is surfaced as retryable:false and wipes nothing", async () => {
    const secrets = await seededSecrets();
    const r = await attempt({ del: [reply("accepted")], status: [reply("status-failed-not-retryable")] }, secrets, new MemorySecretStore());
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ status: "failed", retryable: false });
    expect(await keysLeft(secrets)).toBe(2);
  });

  it("dismiss clears a saved job and wipes nothing (job saved from the real accepted fixture, then a running poll is interrupted)", async () => {
    const secrets = await seededSecrets();
    const secureStore = new MemorySecretStore();
    const unrelated = new TextEncoder().encode("keep-me");
    await secureStore.set("unrelated:byo-secret", unrelated);
    const now = Date.now();
    const tok = idToken(Math.floor(now / 1000) - 30);
    const srv = server({ del: [reply("accepted")], status: [reply("status-running")] });
    const killed = new Error("app killed");
    await expect(deleteAccountAndWipe({
      client: new GenDragoonClient({ baseUrl: BASE, getToken: () => tok, fetch: srv.fetchImpl }),
      reauthenticatedAt: "", idToken: tok, workspaceIds: WS, secrets, secureStore, now,
      sleep: async () => { throw killed; }, timeoutMs: 60_000, backoffMs: [1],
    })).rejects.toBe(killed);
    expect(await saved(secureStore, JOB_KEY)).toBe(ACCEPTED_BODY.jobId);

    await dismissAccountDeletion(secureStore);
    expect(await saved(secureStore, JOB_KEY)).toBeNull();
    expect(await saved(secureStore, TOKEN_KEY)).toBeNull();
    expect(await saved(secureStore, "unrelated:byo-secret")).toBe("keep-me");
    expect(await keysLeft(secrets)).toBe(2);
  });

  it("done (real status-done body) wipes local keys and clears the saved job", async () => {
    const secrets = await seededSecrets();
    const secureStore = new MemorySecretStore();
    const r = await attempt({ del: [reply("account-deleted")], status: [reply("status-running"), reply("status-done")] }, secrets, secureStore);
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ jobId: DONE_BODY.jobId, status: "done" });
    expect(await keysLeft(secrets)).toBe(0);
    expect(await saved(secureStore, JOB_KEY)).toBeNull();
    expect(await saved(secureStore, TOKEN_KEY)).toBeNull();
  });
});

/**
 * Final ruling (Riley + Avery, Oct 18): when an error body has both `error` and `code`
 * and they differ, `error` wins. Avery: `error` ALWAYS wins when it is non-empty, token-shaped
 * or not (no pattern fallback to `code`).
 *
 * CONTRACT-EDGE CASE, DERIVED BODIES: the server never sends `code` (PR #6 fff0a84 and every
 * fixture in server-pr6/account-deletion carry only `error`), so no real fixture has both.
 * Each body below is a real fixture body with a conflicting `code` added. The request and
 * status come from the fixture unchanged.
 */
describe("deletion ruling: `error` wins over `code` when they differ (contract edge, DERIVED from fff0a84 fixtures)", () => {
  const withCode = (name: string, code: string): Reply => {
    const f = loadDeletionFixture(name);
    return { status: f.response.status, body: { ...(f.response.body as Record<string, unknown>), code } };
  };

  it("control: real invalid-token and reauth-required bodies (error only) map as ruled", async () => {
    const invalid = await run({ del: [{ status: 401, body: loadDeletionFixture("invalid-token").response.body }] });
    const reauth = await run({ del: [{ status: 401, body: loadDeletionFixture("reauth-required").response.body }] });
    expect(invalid.error).toMatchObject({ status: 401, code: "invalid_token" });
    expect(deletionAuthFailure(invalid.error)).toBe("sign-out");
    expect(reauth.error).toMatchObject({ status: 401, code: "reauth_required" });
    expect(deletionAuthFailure(reauth.error)).toBe("reauth");
  });

  it("control: `error` and `code` equal -> that code", async () => {
    const r = await run({ del: [withCode("invalid-token", "invalid_token")] });
    expect(r.error).toBeInstanceOf(InvalidTokenError);
    expect(r.keys).toBe(2);
  });

  it("{error:'invalid_token', code:'reauth_required'} -> invalid_token / sign-out", async () => {
    const r = await run({ del: [withCode("invalid-token", "reauth_required")] });
    expect(r.error).toBeInstanceOf(InvalidTokenError);
    expect(r.error).toMatchObject({ status: 401, code: "invalid_token" });
    expect(deletionAuthFailure(r.error)).toBe("sign-out");
    expect(r.keys).toBe(2);
  });

  it("{error:'reauth_required', code:'invalid_token'} -> reauth_required / sign-in", async () => {
    const r = await run({ del: [withCode("reauth-required", "invalid_token")] });
    expect(r.error).toBeInstanceOf(ReauthRequiredError);
    expect(r.error).toMatchObject({ status: 401, code: "reauth_required" });
    expect(deletionAuthFailure(r.error)).toBe("reauth");
    expect(r.keys).toBe(2);
  });

  it("non-token `error` still wins: 401 {error:'Session expired', code:'invalid_token'} -> ApiError.code 'Session expired', not InvalidTokenError", async () => {
    // DERIVED from the invalid-token fixture: `error` replaced by a sentence, `code` added.
    const f = loadDeletionFixture("invalid-token");
    const r = await run({ del: [{ status: f.response.status, body: { error: "Session expired", code: "invalid_token" } }] });
    expect(r.error).not.toBeInstanceOf(InvalidTokenError);
    expect(r.error).toMatchObject({ status: 401, code: "Session expired" });
    expect(r.keys).toBe(2);
  });

  it("400 {error:'confirm_required', code:'not_found'} keeps ApiError.code = confirm_required", async () => {
    const r = await run({ del: [withCode("confirm-wrong", "not_found")] });
    expect(r.error).toMatchObject({ status: 400, code: "confirm_required" });
    expect(r.keys).toBe(2);
  });
});
