/**
 * Tests ahead of the uid-check PR (Avery's review of gendragoon-apps PR #4).
 * Cut from PR #1 tip ccde5bf. Morgan (QA).
 *
 * ASSUMED SIGNATURE (adapt `callWithUid` below if the PR picks another shape):
 *   requestDeletionSupport(jobId, { client, secureStore, currentUid?: string | null, onAuthFailure?, clearSession? })
 *   core-owned saved uid key: "account-deletion:uid" (UID_KEY below)
 * Rules:
 *   - saved uid present and !== currentUid -> fallback, 0 requests, store byte-identical
 *   - currentUid omitted -> today's behaviour (control, passes now)
 *   - the uid read sits inside the existing keychain try/catch: rejecting read -> fallback, 0 requests
 *   - never throws, never signs out (onAuthFailure/clearSession never called, Firebase token never read)
 * Each case checks its setup first. The it.fails markers were removed in the uid-check PR,
 * which implements the rule; these are required passes now.
 *
 * Also: passing probes pinning Avery's 409 refresh rule on ccde5bf (client.ts:327-334).
 */
import { describe, expect, it } from "vitest";
import { DELETION_UID_KEY, GenDragoonClient, MemorySecretStore, SUPPORT_CONTACT, requestDeletionSupport } from "../src/index.js";

const BASE = "https://api.example.test";
const JOB = "00000000-0000-4000-8000-0000000000u1";
const STATUS_TOKEN = "StatusTokenForSupport_0123456789abcdefghijk";
const JOB_KEY = "account-deletion:job-id";
const TOKEN_KEY = "account-deletion:status-token";
const UID_KEY = "account-deletion:uid";
const FALLBACK = { kind: "fallback", contact: SUPPORT_CONTACT };
const enc = (t: string) => new TextEncoder().encode(t);
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function harness(replies: Response[]) {
  const queue = [...replies];
  const seen = { requests: 0, firebase: 0, authFailures: 0, sessionClears: 0, paths: [] as string[] };
  const client = new GenDragoonClient({
    baseUrl: BASE,
    getToken: () => { seen.firebase += 1; throw new Error("signed out"); },
    fetch: async (input) => {
      seen.requests += 1;
      seen.paths.push(new URL(String(input instanceof Request ? input.url : input)).pathname);
      return queue.shift() ?? json(500, { error: "unscripted" });
    },
  });
  return { client, seen };
}

async function savedStore(uid: string | null) {
  const store = new MemorySecretStore();
  await store.set(JOB_KEY, enc(JOB));
  await store.set(TOKEN_KEY, enc(STATUS_TOKEN));
  if (uid !== null) await store.set(UID_KEY, enc(uid));
  return store;
}

async function snapshot(store: MemorySecretStore) {
  const out: Record<string, string | null> = {};
  for (const key of [JOB_KEY, TOKEN_KEY, UID_KEY]) {
    const v = (await store.get(key)) as Uint8Array | string | null;
    out[key] = v == null ? null : typeof v === "string" ? `s:${v}` : `b:${Buffer.from(v).toString("hex")}`;
  }
  return out;
}

/** Single place to adapt the assumed parameter shape. */
function callWithUid(
  store: MemorySecretStore,
  h: ReturnType<typeof harness>,
  currentUid?: string | null,
): Promise<unknown> {
  const deps: Record<string, unknown> = {
    client: h.client,
    secureStore: store,
    onAuthFailure: () => { h.seen.authFailures += 1; },
    clearSession: () => { h.seen.sessionClears += 1; },
  };
  if (currentUid !== undefined) deps.currentUid = currentUid;
  return (requestDeletionSupport as unknown as (j: string, d: unknown) => Promise<unknown>)(JOB, deps).then(
    (r) => r,
    (e: unknown) => ({ threw: String(e) }),
  );
}

const noSignOut = (seen: ReturnType<typeof harness>["seen"]) => {
  expect(seen.firebase).toBe(0);
  expect(seen.authFailures).toBe(0);
  expect(seen.sessionClears).toBe(0);
};

describe("requestDeletionSupport uid check (ahead of the uid-check PR, cut from ccde5bf)", () => {
  it("saved uid differs from currentUid -> fallback, 0 requests, store byte-identical", async () => {
    const store = await savedStore("user-1");
    const before = await snapshot(store);
    expect(before[UID_KEY]).toBe(`b:${Buffer.from("user-1").toString("hex")}`);
    const h = harness([json(202, { status: "received", requestId: "req-1" })]);
    const result = await callWithUid(store, h, "user-2");
    expect(result).toEqual(FALLBACK);
    expect(h.seen.requests).toBe(0);
    expect(await snapshot(store)).toEqual(before);
    noSignOut(h.seen);
  });

  it("rejecting uid read (inside the keychain try/catch) -> fallback, 0 requests, no throw", async () => {
    const store = await savedStore("user-1");
    const realGet = store.get.bind(store);
    let uidReads = 0;
    store.get = (async (key: string) => {
      if (key === UID_KEY) { uidReads += 1; throw new Error("keychain locked"); }
      return realGet(key);
    }) as typeof store.get;
    await expect(store.get(UID_KEY)).rejects.toThrow("keychain locked");
    expect(await realGet(JOB_KEY)).not.toBeNull();
    uidReads = 0;
    const h = harness([json(202, { status: "received", requestId: "req-1" })]);
    const result = await callWithUid(store, h, "user-1");
    expect(result).toEqual(FALLBACK);
    expect(h.seen.requests).toBe(0);
    expect(uidReads).toBeGreaterThan(0);
    noSignOut(h.seen);
  });

  it("control: no currentUid -> today's behaviour (202 received), even with a different saved uid", async () => {
    const store = await savedStore("user-1");
    const before = await snapshot(store);
    const h = harness([json(202, { status: "received", requestId: "req-1" })]);
    expect(await callWithUid(store, h)).toEqual({ kind: "received", requestId: "req-1" });
    expect(h.seen.requests).toBe(1);
    expect(await snapshot(store)).toEqual(before);
    noSignOut(h.seen);
  });

  it("control: currentUid equal to the saved uid -> request goes out as today", async () => {
    const store = await savedStore("user-1");
    const h = harness([json(202, { status: "received", requestId: "req-1" })]);
    expect(await callWithUid(store, h, "user-1")).toEqual({ kind: "received", requestId: "req-1" });
    expect(h.seen.requests).toBe(1);
    noSignOut(h.seen);
  });
});

describe("requestDeletionSupport uid check: edges (uid-check PR)", () => {
  it("core exports the uid key under the name the mobile app already uses", () => {
    expect(DELETION_UID_KEY).toBe(UID_KEY);
  });

  it("currentUid null -> today's behaviour, and the uid key is never read", async () => {
    const store = await savedStore("user-1");
    const realGet = store.get.bind(store);
    const reads: string[] = [];
    store.get = (async (key: string) => { reads.push(key); return realGet(key); }) as typeof store.get;
    const h = harness([json(202, { status: "received", requestId: "req-1" })]);
    expect(await callWithUid(store, h, null)).toEqual({ kind: "received", requestId: "req-1" });
    expect(h.seen.requests).toBe(1);
    expect(reads).not.toContain(UID_KEY);
    noSignOut(h.seen);
  });

  it("no currentUid -> the uid key is never read", async () => {
    const store = await savedStore("user-1");
    const realGet = store.get.bind(store);
    const reads: string[] = [];
    store.get = (async (key: string) => { reads.push(key); return realGet(key); }) as typeof store.get;
    const h = harness([json(202, { status: "received", requestId: "req-1" })]);
    expect(await callWithUid(store, h)).toEqual({ kind: "received", requestId: "req-1" });
    expect(reads).not.toContain(UID_KEY);
  });

  it("no saved uid (job saved before uids) with a currentUid -> request goes out as today", async () => {
    const store = await savedStore(null);
    const h = harness([json(202, { status: "received", requestId: "req-1" })]);
    expect(await callWithUid(store, h, "user-1")).toEqual({ kind: "received", requestId: "req-1" });
    expect(h.seen.requests).toBe(1);
    noSignOut(h.seen);
  });
});

describe("409 refresh rule on ccde5bf (Avery): body must be this jobId with status queued/running/done/failed", () => {
  const run = async (refreshBody: unknown) => {
    const store = await savedStore(null);
    const h = harness([json(409, { error: "support_not_needed" }), json(200, refreshBody)]);
    const r = await callWithUid(store, h);
    expect(h.seen.requests).toBe(2);
    noSignOut(h.seen);
    return r;
  };
  it.each(["queued", "running", "done"])("refresh %s for this jobId -> not_needed", async (status) => {
    expect(await run({ jobId: JOB, status })).toEqual({ kind: "not_needed", status: { jobId: JOB, status } });
  });
  it.each([
    ["failed", { jobId: JOB, status: "failed" }],
    ["unknown status 'cancelled'", { jobId: JOB, status: "cancelled" }],
    ["empty status", { jobId: JOB, status: "" }],
    ["mismatched jobId (running)", { jobId: "00000000-0000-4000-8000-0000000000zz", status: "running" }],
    ["missing jobId", { status: "running" }],
  ])("refresh %s -> fallback", async (_l, body) => {
    expect(await run(body)).toEqual(FALLBACK);
  });
});
