/**
 * Deletion support request (core side). Server: gendragoon-cloud-ssd PR #6,
 * 56b7f6b (head d33970c). Final spec (Avery, Riley, Casey):
 *   POST /v2/account/deletions/:jobId/support-request
 *   Authorization: Bearer <statusToken>   (never the Firebase token; works signed out)
 *   no body, no uid (the server reads the uid from the job)
 *   202 {status:"received", requestId}    repeat -> 202, same requestId
 *   409 {error:"support_not_needed"}      job is not failed -> refresh status
 *   429 {error:"rate_limited", retryAfterSec}  -> "already sent"
 *   404 {error:"not_found"}               bad/expired/other-job token -> fallback contact, never sign-in
 *   401 {error:"unauthorized"}            missing header (account_delete.js:1001) -> same as 404
 *                                         pending Avery's pin
 *   network error / 5xx                   -> fallback SUPPORT_CONTACT
 * Server bodies are Riley's generated fixtures (fixtures/server-pr6/account-deletion,
 * support-*.json from d33970c). Bodies marked DERIVED have no fixture.
 *
 * `requestDeletionSupport` is the core export. Each case checks its setup, then
 * calls that function. Assertions below are Morgan's contract from 12d5024.
 *
 * Shape (core export, see the CoreSupport type below):
 *   requestDeletionSupport(jobId, { client, secureStore, onAuthFailure?, clearSession? })
 *     -> { kind: "received", requestId }
 *      | { kind: "already_sent", retryAfterSec? }
 *      | { kind: "not_needed", status }          // status refreshed with the statusToken
 *      | { kind: "fallback", contact: SUPPORT_CONTACT }
 *   The statusToken is the one saved in SecureStore for that job id.
 */
import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";
import { GenDragoonClient, MemorySecretStore, SUPPORT_CONTACT } from "../src/index.js";
import type { AccountDeletionStatus } from "../src/index.js";
import { loadDeletionFixture } from "./fixtures/server-pr6/load.js";
import { loadServerFixture } from "./fixtures/server/load.js";

type SupportResult =
  | { kind: "received"; requestId: string }
  | { kind: "already_sent"; retryAfterSec?: number }
  | { kind: "not_needed"; status: AccountDeletionStatus }
  | { kind: "fallback"; contact: typeof SUPPORT_CONTACT };
type CoreSupport = (
  jobId: string,
  deps: {
    client: GenDragoonClient;
    secureStore: MemorySecretStore;
    onAuthFailure?: (signal: string, error: unknown) => void;
    clearSession?: () => void;
  },
) => Promise<SupportResult>;

const BASE = "https://api.example.test";
const STATUS_TOKEN = "StatusTokenForSupport_0123456789abcdefghijk"; // 43 chars, client state
const JOB_KEY = "account-deletion:job-id";
const TOKEN_KEY = "account-deletion:status-token";
const SUPPORT_RE = /^\/v2\/account\/deletions\/([^/]+)\/support-request$/;
const STATUS_RE = /^\/v2\/account\/deletions\/([^/]+)$/;

const fx = (name: string) => loadDeletionFixture(name);
const jobOf = (name: string) => SUPPORT_RE.exec(fx(name).request.path)![1]!;
const reply = (name: string): Reply => ({ status: fx(name).response.status, body: fx(name).response.body });

type Reply = { status: number; body?: unknown } | "network";
interface Call { method: string; path: string; search: string; headers: Record<string, string>; body: unknown }

function requestDeletionSupport(): CoreSupport {
  const fn = (core as Record<string, unknown>).requestDeletionSupport;
  if (typeof fn !== "function") throw new TypeError("core does not export requestDeletionSupport");
  return fn as CoreSupport;
}

/** Scripted server: support route and status GET each pop their next reply. */
function server(script: { support?: Reply[]; status?: Reply[] }) {
  const calls: Call[] = [];
  const queues = { support: [...(script.support ?? [])], status: [...(script.status ?? [])] };
  const take = (q: Reply[]): Reply => (q.length > 1 ? q.shift()! : q[0] ?? { status: 500, body: { error: "unscripted" } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    calls.push({ method: init?.method ?? "GET", path: url.pathname, search: url.search, headers, body: init?.body ?? null });
    let r: Reply;
    if (init?.method === "POST" && SUPPORT_RE.test(url.pathname)) r = take(queues.support);
    else if ((init?.method ?? "GET") === "GET" && STATUS_RE.test(url.pathname)) r = take(queues.status);
    else r = { status: 404, body: { error: "not_found" } };
    if (r === "network") throw new TypeError("fetch failed");
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

async function savedJob(jobId: string, token: string | null = STATUS_TOKEN): Promise<MemorySecretStore> {
  const store = new MemorySecretStore();
  const enc = new TextEncoder();
  await store.set(JOB_KEY, enc.encode(jobId));
  if (token) await store.set(TOKEN_KEY, enc.encode(token));
  return store;
}
const read = async (store: MemorySecretStore, key: string) => {
  const v = await store.get(key);
  return v ? new TextDecoder().decode(v as Uint8Array) : null;
};

/** Signed out: the Firebase hook throws and must never be called. */
function setup(jobId: string, script: { support?: Reply[]; status?: Reply[] }, token: string | null = STATUS_TOKEN) {
  const srv = server(script);
  let firebaseCalls = 0;
  const signals: unknown[] = [];
  let sessionCleared = 0;
  const client = new GenDragoonClient({
    baseUrl: BASE,
    getToken: () => { firebaseCalls += 1; throw new Error("signed out"); },
    fetch: srv.fetchImpl,
  });
  return {
    srv,
    client,
    signals,
    get firebaseCalls() { return firebaseCalls; },
    get sessionCleared() { return sessionCleared; },
    async deps() {
      return {
        client,
        secureStore: await savedJob(jobId, token),
        onAuthFailure: (signal: string) => { signals.push(signal); },
        clearSession: () => { sessionCleared += 1; },
      };
    },
  };
}

async function expectNoSignInAndJobKept(t: ReturnType<typeof setup>, store: MemorySecretStore, jobId: string, token: string | null = STATUS_TOKEN) {
  expect(t.signals).toEqual([]);
  expect(t.sessionCleared).toBe(0);
  expect(t.firebaseCalls).toBe(0);
  expect(t.srv.calls.some((c) => c.method === "DELETE")).toBe(false);
  expect(await read(store, JOB_KEY)).toBe(jobId);
  expect(await read(store, TOKEN_KEY)).toBe(token);
}

describe("deletion support request: setup sanity (passes today)", () => {
  it("the 5 vendored support fixtures load and the scripted server answers them", async () => {
    for (const name of ["support-received", "support-repeat", "support-not-needed", "support-bad-token", "support-rate-limited"]) {
      const f = fx(name);
      expect(f.request.method).toBe("POST");
      expect(f.request.path).toMatch(SUPPORT_RE);
      expect(f.request.body).toBeNull();
    }
    const t = setup(jobOf("support-received"), { support: [reply("support-received")] });
    const res = await t.srv.fetchImpl(`${BASE}${fx("support-received").request.path}`, { method: "POST" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(fx("support-received").response.body);
    const deps = await t.deps();
    expect(await read(deps.secureStore, TOKEN_KEY)).toBe(STATUS_TOKEN);
  });
});

describe("requestDeletionSupport(jobId, { client, secureStore })", () => {
  it("sends POST .../support-request with Bearer statusToken only: no Firebase token, no body, no uid, works signed out", async () => {
    const jobId = jobOf("support-received");
    const t = setup(jobId, { support: [reply("support-received")] });
    const deps = await t.deps();
    await requestDeletionSupport()(jobId, deps);
    const posts = t.srv.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    const call = posts[0]!;
    expect(call.path).toBe(fx("support-received").request.path);
    expect(call.search).toBe("");
    expect(call.headers.authorization).toBe(`Bearer ${STATUS_TOKEN}`);
    expect(Object.keys(call.headers)).toEqual(["authorization"]); // no content-type: there is no body
    expect(call.body).toBeNull();
    expect(JSON.stringify(call)).not.toMatch(/uid/i);
    expect(t.firebaseCalls).toBe(0);
    expect(t.srv.calls).toHaveLength(1);
  });

  it("202 support-received -> { kind: 'received', requestId } and the saved job stays", async () => {
    const jobId = jobOf("support-received");
    const t = setup(jobId, { support: [reply("support-received")] });
    const deps = await t.deps();
    const result = await requestDeletionSupport()(jobId, deps);
    const body = fx("support-received").response.body as { requestId: string };
    expect(result).toEqual({ kind: "received", requestId: body.requestId });
    await expectNoSignInAndJobKept(t, deps.secureStore, jobId);
  });

  it("a repeat (support-repeat) returns the same requestId with the same statusToken", async () => {
    const jobId = jobOf("support-repeat");
    const t = setup(jobId, { support: [reply("support-received"), reply("support-repeat")] });
    const deps = await t.deps();
    const fn = requestDeletionSupport();
    const first = await fn(jobId, deps);
    const again = await fn(jobId, deps);
    expect(first.kind).toBe("received");
    expect(again).toEqual(first);
    const posts = t.srv.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.headers.authorization)).toEqual([`Bearer ${STATUS_TOKEN}`, `Bearer ${STATUS_TOKEN}`]);
    await expectNoSignInAndJobKept(t, deps.secureStore, jobId);
  });

  it("409 support-not-needed refreshes the status with the statusToken and returns it", async () => {
    const jobId = jobOf("support-not-needed");
    // DERIVED: real status-running body with this fixture's job id.
    const running = { ...(fx("status-running").response.body as object), jobId };
    const t = setup(jobId, { support: [reply("support-not-needed")], status: [{ status: 200, body: running }] });
    const deps = await t.deps();
    const result = await requestDeletionSupport()(jobId, deps);
    expect(result).toEqual({ kind: "not_needed", status: running });
    const gets = t.srv.calls.filter((c) => c.method === "GET");
    expect(gets).toHaveLength(1);
    expect(gets[0]!.path).toBe(`/v2/account/deletions/${jobId}`);
    expect(gets[0]!.headers.authorization).toBe(`Bearer ${STATUS_TOKEN}`);
    await expectNoSignInAndJobKept(t, deps.secureStore, jobId);
  });

  it("429 support-rate-limited -> { kind: 'already_sent', retryAfterSec } without throwing or signing in", async () => {
    const jobId = jobOf("support-rate-limited");
    const t = setup(jobId, { support: [reply("support-rate-limited")] });
    const deps = await t.deps();
    const result = await requestDeletionSupport()(jobId, deps);
    const body = fx("support-rate-limited").response.body as { retryAfterSec: number };
    expect(result).toEqual({ kind: "already_sent", retryAfterSec: body.retryAfterSec });
    await expectNoSignInAndJobKept(t, deps.secureStore, jobId);
  });

  it("404 support-bad-token -> fallback SUPPORT_CONTACT, never routes to sign-in (Grok Bot + Casey's 404 rule)", async () => {
    const jobId = jobOf("support-bad-token");
    const t = setup(jobId, { support: [reply("support-bad-token")] });
    const deps = await t.deps();
    const result = await requestDeletionSupport()(jobId, deps);
    expect(result).toEqual({ kind: "fallback", contact: SUPPORT_CONTACT });
    expect((result as { contact: unknown }).contact).toBe(SUPPORT_CONTACT);
    await expectNoSignInAndJobKept(t, deps.secureStore, jobId);
    expect(t.srv.calls).toHaveLength(1);
  });

  it("401 {error:'unauthorized'} and a bare 401 (DERIVED, account_delete.js:1001) are treated like 404: fallback, never sign-in (pending Avery's pin)", async () => {
    const jobId = jobOf("support-bad-token");
    for (const body of [{ error: "unauthorized" }, {}]) {
      const t = setup(jobId, { support: [{ status: 401, body }] });
      const deps = await t.deps();
      const result = await requestDeletionSupport()(jobId, deps);
      expect(result).toEqual({ kind: "fallback", contact: SUPPORT_CONTACT });
      await expectNoSignInAndJobKept(t, deps.secureStore, jobId);
      expect(t.srv.calls).toHaveLength(1);
    }
  });

  it("401 support-unauthorized (no auth header, cloud-ssd 0486412) -> fallback SUPPORT_CONTACT, no throw, never sign-in", async () => {
    const f = fx("support-unauthorized");
    expect(f.request.headers).toEqual({});
    expect(f.response).toEqual({ status: 401, body: { error: "unauthorized" } });
    const jobId = jobOf("support-unauthorized");
    const t = setup(jobId, { support: [reply("support-unauthorized")] });
    const deps = await t.deps();
    const result = await requestDeletionSupport()(jobId, deps);
    expect(result).toEqual({ kind: "fallback", contact: SUPPORT_CONTACT });
    await expectNoSignInAndJobKept(t, deps.secureStore, jobId);
    expect(t.srv.calls).toHaveLength(1);
  });

  it("a network error, 500 or 503 (DERIVED) -> fallback SUPPORT_CONTACT", async () => {
    const jobId = jobOf("support-received");
    for (const r of ["network", { status: 500, body: { error: "internal" } }, { status: 503 }] as Reply[]) {
      const t = setup(jobId, { support: [r] });
      const deps = await t.deps();
      const result = await requestDeletionSupport()(jobId, deps);
      expect(result).toEqual({ kind: "fallback", contact: SUPPORT_CONTACT });
      await expectNoSignInAndJobKept(t, deps.secureStore, jobId);
    }
  });

  it("no saved statusToken -> fallback SUPPORT_CONTACT without any request", async () => {
    const jobId = jobOf("support-received");
    const t = setup(jobId, { support: [reply("support-received")] }, null);
    const deps = await t.deps();
    const result = await requestDeletionSupport()(jobId, deps);
    expect(result).toEqual({ kind: "fallback", contact: SUPPORT_CONTACT });
    expect(t.srv.calls).toHaveLength(0);
    await expectNoSignInAndJobKept(t, deps.secureStore, jobId, null);
  });
});

/**
 * Morgan's support-gap findings from reviewing bcc1c39 (client.ts:299-334,
 * account.ts:433-447): a failed status refresh after 409, other 4xx responses,
 * and a saved job id that does not match. Each case does its setup and checks
 * it, then calls the real export. All are fixed as of 03ce526.
 */
describe("requestDeletionSupport gaps on bcc1c39", () => {
  const fail = (r: SupportResult | { threw: string }) => r;
  const call = (fn: CoreSupport, jobId: string, deps: Parameters<CoreSupport>[1]) =>
    fn(jobId, deps).then(fail, (e: unknown) => fail({ threw: `${(e as Error)?.name}: ${(e as Error)?.message}` }));

  // Refresh failures after 409 support_not_needed. 404: real expired-token status-poll body.
  // 401: real status-invalid-token body. Network: fetch rejects.
  const refreshFailures: Array<[string, Reply]> = [
    ["404 (real expired-token)", reply("expired-token")],
    ["401 invalid_token (real status-invalid-token)", reply("status-invalid-token")],
    ["network error", "network"],
  ];
  for (const [label, refresh] of refreshFailures) {
    it(`409 support_not_needed, then the status refresh fails with ${label} -> fallback SUPPORT_CONTACT, no throw, no sign-in (client.ts:328-330)`, async () => {
      const jobId = jobOf("support-not-needed");
      const t = setup(jobId, { support: [reply("support-not-needed")], status: [refresh] });
      const deps = await t.deps();
      expect(await read(deps.secureStore, TOKEN_KEY)).toBe(STATUS_TOKEN);
      const result = await call(requestDeletionSupport(), jobId, deps);
      expect(result).toEqual({ kind: "fallback", contact: SUPPORT_CONTACT });
      expect(t.srv.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
      expect(t.srv.calls[1]!.headers.authorization).toBe(`Bearer ${STATUS_TOKEN}`);
      await expectNoSignInAndJobKept(t, deps.secureStore, jobId);
    });
  }

  // 413: the server's real /v2 payload_too_large body (fixtures/server/errors, captured on
  // POST /v2/account; v2_errors.js sends the same body for every /v2 route).
  // 400, 403, 422: DERIVED, no fixture for the support route.
  const tooLarge = loadServerFixture("errors", "payload-too-large");
  const otherClientErrors: Array<[string, Reply]> = [
    ["400 (DERIVED)", { status: 400, body: { error: "invalid_json" } }],
    ["403 (DERIVED)", { status: 403, body: { error: "forbidden" } }],
    ["413 (real errors/payload-too-large)", { status: tooLarge.response.status, body: tooLarge.response.body }],
    ["422 (DERIVED)", { status: 422, body: { error: "unprocessable" } }],
  ];
  for (const [label, r] of otherClientErrors) {
    it(`support request ${label} -> fallback SUPPORT_CONTACT, no throw (client.ts:333)`, async () => {
      const jobId = jobOf("support-received");
      const t = setup(jobId, { support: [r] });
      const deps = await t.deps();
      expect(await read(deps.secureStore, TOKEN_KEY)).toBe(STATUS_TOKEN);
      const result = await call(requestDeletionSupport(), jobId, deps);
      expect(result).toEqual({ kind: "fallback", contact: SUPPORT_CONTACT });
      expect(t.srv.calls).toHaveLength(1);
      await expectNoSignInAndJobKept(t, deps.secureStore, jobId);
    });
  }

  it("saved job id differs from the jobId argument -> fallback SUPPORT_CONTACT and NO request to any route (account.ts:444-446)", async () => {
    const savedJobId = jobOf("support-received");
    const otherJobId = jobOf("support-not-needed");
    expect(otherJobId).not.toBe(savedJobId);
    const t = setup(savedJobId, { support: [reply("support-bad-token")], status: [reply("expired-token")] });
    const deps = await t.deps();
    expect(await read(deps.secureStore, JOB_KEY)).toBe(savedJobId);
    const result = await call(requestDeletionSupport(), otherJobId, deps);
    expect(t.srv.calls).toEqual([]);
    expect(result).toEqual({ kind: "fallback", contact: SUPPORT_CONTACT });
    await expectNoSignInAndJobKept(t, deps.secureStore, savedJobId);
  });
});
