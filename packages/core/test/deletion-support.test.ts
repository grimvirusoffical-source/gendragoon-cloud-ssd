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

/**
 * Unexpected statuses and unreadable bodies on the support request. The
 * contract is that requestDeletionSupport never throws: each of these gives
 * the email fallback after exactly one request, with no sign-in signal and the
 * saved job and status token left alone. All DERIVED: no fixture for them.
 */
describe("requestDeletionSupport never throws on an unexpected status or body error", () => {
  const settle = (fn: CoreSupport, jobId: string, deps: Parameters<CoreSupport>[1]) =>
    fn(jobId, deps).then(
      (r): SupportResult | { threw: string } => r,
      (e: unknown) => ({ threw: `${(e as Error)?.name}: ${(e as Error)?.message}` }),
    );

  /** Records the call through the scripted server, then answers with `respond()` instead. */
  async function withRawResponse(jobId: string, respond: () => Response) {
    const t = setup(jobId, { support: [{ status: 500 }] });
    let firebaseCalls = 0;
    const client = new GenDragoonClient({
      baseUrl: BASE,
      getToken: () => { firebaseCalls += 1; throw new Error("signed out"); },
      fetch: async (input, init) => {
        await t.srv.fetchImpl(input, init);
        return respond();
      },
    });
    const deps = { ...(await t.deps()), client };
    return { t, deps, firebaseCalls: () => firebaseCalls };
  }

  const unexpected: Array<[string, Reply]> = [
    ["200 with a received-shaped body", { status: 200, body: { status: "received", requestId: "req-200" } }],
    ["204 with no body", { status: 204 }],
    ["302 redirect", { status: 302, body: { error: "moved" } }],
  ];
  for (const [label, r] of unexpected) {
    it(`support request ${label} -> fallback SUPPORT_CONTACT, no throw, one request`, async () => {
      const jobId = jobOf("support-received");
      const t = setup(jobId, { support: [r] });
      const deps = await t.deps();
      expect(await read(deps.secureStore, TOKEN_KEY)).toBe(STATUS_TOKEN);
      const result = await settle(requestDeletionSupport(), jobId, deps);
      expect(result).toEqual({ kind: "fallback", contact: SUPPORT_CONTACT });
      expect(t.srv.calls).toHaveLength(1);
      expect(t.srv.calls[0]!.method).toBe("POST");
      await expectNoSignInAndJobKept(t, deps.secureStore, jobId);
    });
  }

  it("202 with a malformed JSON body -> fallback SUPPORT_CONTACT, no throw, one request", async () => {
    const jobId = jobOf("support-received");
    const { t, deps, firebaseCalls } = await withRawResponse(
      jobId,
      () => new Response("{\"status\":\"received\",\"requestId\":", { status: 202, headers: { "content-type": "application/json" } }),
    );
    const result = await settle(requestDeletionSupport(), jobId, deps);
    expect(result).toEqual({ kind: "fallback", contact: SUPPORT_CONTACT });
    expect(t.srv.calls).toHaveLength(1);
    expect(firebaseCalls()).toBe(0);
    await expectNoSignInAndJobKept(t, deps.secureStore, jobId);
  });

  it("a 202 whose body read rejects -> fallback SUPPORT_CONTACT, no throw, one request", async () => {
    const jobId = jobOf("support-received");
    const { t, deps, firebaseCalls } = await withRawResponse(jobId, () => {
      const response = new Response(null, { status: 202 });
      Object.defineProperty(response, "text", { value: () => Promise.reject(new TypeError("body stream already read")) });
      return response;
    });
    const result = await settle(requestDeletionSupport(), jobId, deps);
    expect(result).toEqual({ kind: "fallback", contact: SUPPORT_CONTACT });
    expect(t.srv.calls).toHaveLength(1);
    expect(firebaseCalls()).toBe(0);
    await expectNoSignInAndJobKept(t, deps.secureStore, jobId);
  });
});

/**
 * Morgan's support-gap findings from fuzzing 3c78d74 (account.ts:443-447,
 * client.ts:303-332). Each case sets up and checks its inputs, then makes one
 * call to the real export. On 3c78d74 each fails at that call: it throws, or
 * returns an out-of-contract value. Remove a marker when its fix lands.
 * Cases 3 and 5 follow Avery's rules (2026-10-18).
 */
describe("requestDeletionSupport gaps on 3c78d74", () => {
  const JOB = "00000000-0000-4000-8000-00000000000a";
  const FALLBACK = { kind: "fallback", contact: SUPPORT_CONTACT };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  /** Signed out client over a fixed list of replies; counts requests and auth hooks. */
  function harness(replies: Response[], get: (key: string) => Promise<unknown>) {
    const queue = [...replies];
    const seen = { requests: 0, firebase: 0, authFailures: 0, sessionClears: 0 };
    const client = new GenDragoonClient({
      baseUrl: BASE,
      getToken: () => { seen.firebase += 1; throw new Error("signed out"); },
      fetch: async () => { seen.requests += 1; return queue.shift() ?? json(500, { error: "unscripted" }); },
    });
    const deps = {
      client,
      secureStore: { get, set: async () => {}, delete: async () => {} } as unknown as MemorySecretStore,
      onAuthFailure: () => { seen.authFailures += 1; },
      clearSession: () => { seen.sessionClears += 1; },
    };
    return { deps, seen };
  }
  const saved = (jobId: string) => async (key: string) =>
    key === JOB_KEY ? new TextEncoder().encode(jobId) : key === TOKEN_KEY ? new TextEncoder().encode(STATUS_TOKEN) : null;
  const settle = (jobId: string, deps: Parameters<CoreSupport>[1]) =>
    requestDeletionSupport()(jobId, deps).then(
      (r): SupportResult | { threw: string } => r,
      (e: unknown) => ({ threw: `${(e as Error)?.name}: ${(e as Error)?.message}` }),
    );
  const noSignIn = (seen: { firebase: number; authFailures: number; sessionClears: number }) => {
    expect(seen.firebase).toBe(0);
    expect(seen.authFailures).toBe(0);
    expect(seen.sessionClears).toBe(0);
  };

  it.fails("1. a secure-store read that rejects (locked keychain) -> fallback, no throw, no request", async () => {
    const { deps, seen } = harness([], async () => { throw new Error("keychain locked"); });
    await expect(deps.secureStore.get(JOB_KEY)).rejects.toThrow("keychain locked");
    const result = await settle(JOB, deps);
    expect(result).toEqual(FALLBACK);
    expect(seen.requests).toBe(0);
    noSignIn(seen);
  });

  it.fails("2. a lone-surrogate jobId that matches the saved one -> fallback, not URIError", async () => {
    const bad = "job-\uD800";
    expect(() => encodeURIComponent(bad)).toThrow(URIError);
    const { deps, seen } = harness([], async (key) => (key === JOB_KEY ? bad : key === TOKEN_KEY ? STATUS_TOKEN : null));
    expect(await deps.secureStore.get(JOB_KEY)).toBe(bad);
    const result = await settle(bad, deps);
    expect(result).toEqual(FALLBACK);
    expect(seen.requests).toBe(0);
    noSignIn(seen);
  });

  /**
   * Avery's rule: retryAfterSec is clamped to 1..86400 seconds, default 60
   * when missing or invalid. Which bound -5, 0 and Infinity land on is not
   * pinned, only that they land in range. Missing or non-numeric is exactly 60;
   * an in-range value (including the fixture's 86400) is kept.
   */
  it.fails("3. 429 retryAfterSec is clamped to 1..86400, default 60 (Avery's rule)", async () => {
    const run = async (raw: string) => {
      const { deps, seen } = harness([new Response(raw, { status: 429, headers: { "content-type": "application/json" } })], saved(JOB));
      const r = await settle(JOB, deps);
      expect(seen.requests).toBe(1);
      noSignIn(seen);
      return r as { kind: string; retryAfterSec?: number };
    };
    for (const raw of ['{"error":"rate_limited","retryAfterSec":-5}', '{"error":"rate_limited","retryAfterSec":0}', '{"error":"rate_limited","retryAfterSec":1e309}']) {
      const r = await run(raw);
      expect(r.kind).toBe("already_sent");
      expect(Number.isFinite(r.retryAfterSec)).toBe(true);
      expect(r.retryAfterSec!).toBeGreaterThanOrEqual(1);
      expect(r.retryAfterSec!).toBeLessThanOrEqual(86400);
    }
    for (const raw of ['{"error":"rate_limited"}', '{"error":"rate_limited","retryAfterSec":"soon"}']) {
      expect(await run(raw)).toEqual({ kind: "already_sent", retryAfterSec: 60 });
    }
    expect(await run('{"error":"rate_limited","retryAfterSec":120}')).toEqual({ kind: "already_sent", retryAfterSec: 120 });
    expect(await run('{"error":"rate_limited","retryAfterSec":86400}')).toEqual({ kind: "already_sent", retryAfterSec: 86400 });
  });

  it.fails("4. 409 support_not_needed, then a refresh body that is not a status object -> fallback", async () => {
    for (const body of [[], "done", null, { status: 42 }]) {
      const { deps, seen } = harness([json(409, { error: "support_not_needed" }), json(200, body)], saved(JOB));
      const result = await settle(JOB, deps);
      expect(result).toEqual(FALLBACK);
      expect(seen.requests).toBe(2);
      noSignIn(seen);
    }
  });

  /** Avery's rule: after 409, a refresh of `failed` means support is needed (fallback); `running` and `queued` stay not_needed. */
  it.fails("5. 409 support_not_needed, then a refresh that says failed -> fallback (Avery's rule)", async () => {
    const refresh = async (status: string) => {
      const { deps, seen } = harness([json(409, { error: "support_not_needed" }), json(200, { jobId: JOB, status })], saved(JOB));
      const result = await settle(JOB, deps);
      expect(seen.requests).toBe(2);
      noSignIn(seen);
      return result;
    };
    expect(await refresh("running")).toEqual({ kind: "not_needed", status: { jobId: JOB, status: "running" } });
    expect(await refresh("queued")).toEqual({ kind: "not_needed", status: { jobId: JOB, status: "queued" } });
    expect(await refresh("failed")).toEqual(FALLBACK);
  });

  /**
   * Passing property check (fixed seed, every status 100-599): the result is one
   * of the 4 kinds, nothing throws or signs in, received only on 202,
   * already_sent only on 429, not_needed only on 409. Store and jobId failures
   * are the it.fails cases above, so this uses a readable store and a plain id.
   */
  it("property: statuses 100-599 x seeded bodies stay inside the result space", async () => {
    let seed = 0x5eed_c0de;
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const pool = ["", "null", "[]", "<html>", "1e309", '{"status":"received","requestId":"req-1"}', '{"status":"received"}',
      '{"error":"support_not_needed"}', '{"error":"rate_limited","retryAfterSec":30}', '{"error":"unauthorized"}', '{"error":"invalid_token"}'];
    const kinds = new Set(["received", "already_sent", "not_needed", "fallback"]);
    const odd: string[] = [];
    for (let status = 100; status <= 599; status += 1) {
      for (let k = 0; k < 4; k += 1) {
        const body = pool[Math.floor(rand() * pool.length)]!;
        const post = { status, ok: status >= 200 && status < 300, headers: new Headers(), text: async () => body } as unknown as Response;
        const { deps, seen } = harness([post, json(200, { jobId: JOB, status: "running" })], saved(JOB));
        const r = await settle(JOB, deps);
        const kind = "kind" in r ? r.kind : "threw";
        const bad = !kinds.has(kind) || seen.firebase > 0 || seen.authFailures > 0 || seen.sessionClears > 0 ||
          (kind === "received" && status !== 202) || (kind === "already_sent" && status !== 429) || (kind === "not_needed" && status !== 409);
        if (bad) odd.push(`${status} ${body} -> ${JSON.stringify(r)}`);
      }
    }
    expect(odd).toEqual([]);
  });
});
