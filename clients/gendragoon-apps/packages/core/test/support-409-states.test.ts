/**
 * Casey, PR #3 at 50edb6b: core's 409 refresh rule is "queued, running and done
 * are not_needed; failed, cancelled, an empty or missing status, and another or
 * missing jobId are the email fallback". Reverting the known-state set to accept
 * `cancelled` or `""` broke no core test, so each case is pinned here.
 */
import { describe, expect, it } from "vitest";
import { GenDragoonClient, MemorySecretStore, SUPPORT_CONTACT, requestDeletionSupport } from "../src/index.js";

const JOB = "00000000-0000-4000-8000-0000000000c5";
const FALLBACK = { kind: "fallback", contact: SUPPORT_CONTACT };

async function ask(refreshBody: unknown) {
  const store = new MemorySecretStore();
  await store.set("account-deletion:status-token", new TextEncoder().encode("status-token"));
  await store.set("account-deletion:job-id", new TextEncoder().encode(JOB));
  const methods: string[] = [];
  const client = new GenDragoonClient({
    baseUrl: "https://api.example.test",
    getToken: () => { throw new Error("signed out"); },
    fetch: async (_url, init) => {
      methods.push(init?.method ?? "GET");
      return init?.method === "POST"
        ? new Response(JSON.stringify({ error: "support_not_needed" }), { status: 409 })
        : new Response(JSON.stringify(refreshBody), { status: 200 });
    },
  });
  const result = await requestDeletionSupport(JOB, { client, secureStore: store });
  return { result, methods };
}

describe("409 support_not_needed: which refreshed states count", () => {
  it.each(["queued", "running", "done"])("refresh %s -> not_needed with that status", async (status) => {
    const { result, methods } = await ask({ jobId: JOB, status });
    expect(result).toEqual({ kind: "not_needed", status: { jobId: JOB, status } });
    expect(methods).toEqual(["POST", "GET"]);
  });

  it.each([
    ["failed", { jobId: JOB, status: "failed", retryable: false }],
    ["cancelled", { jobId: JOB, status: "cancelled" }],
    ["empty status", { jobId: JOB, status: "" }],
    ["missing status", { jobId: JOB }],
    ["another jobId", { jobId: "00000000-0000-4000-8000-0000000000ff", status: "running" }],
    ["missing jobId", { status: "running" }],
  ])("refresh %s -> email fallback", async (_label, body) => {
    const { result, methods } = await ask(body);
    expect(result).toEqual(FALLBACK);
    expect(methods).toEqual(["POST", "GET"]);
  });
});
