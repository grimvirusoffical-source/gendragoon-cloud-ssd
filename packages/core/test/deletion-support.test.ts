/**
 * POST /v2/account/deletions/:jobId/support-request from PR #6 @ d33970c.
 * The status token is the only credential. 404 and 401 unauthorized use the
 * support email and do not start sign-in.
 */
import { describe, expect, it } from "vitest";
import { GenDragoonClient, SUPPORT_CONTACT } from "../src/index.js";
import { loadServerFixture } from "./fixtures/server/load.js";

const JOB = "00000000-0000-4000-8000-00000000000a";
const TOKEN = "<redacted>";

function clientFor(status: number, body: unknown, network = false) {
  const seen: { method?: string; url?: string; authorization?: string; body?: string | null; tokenReads: number } = { tokenReads: 0 };
  const signals: string[] = [];
  const client = new GenDragoonClient({
    baseUrl: "https://api.example.test",
    getToken: () => {
      seen.tokenReads += 1;
      throw new Error("signed out");
    },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.method = init?.method;
      seen.url = String(input);
      seen.authorization = headers.get("authorization") ?? undefined;
      seen.body = init?.body === undefined ? null : String(init.body);
      if (network) throw new TypeError("network down");
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, seen, signals };
}

describe("deletion support request", () => {
  it("support-received and support-repeat send no body and return sent with the same requestId", async () => {
    const received = loadServerFixture("account-deletion", "support-received");
    const repeat = loadServerFixture("account-deletion", "support-repeat");
    expect(received.request.body).toBeNull();
    expect(repeat.request.body).toBeNull();
    expect((received.response.body as { requestId: string }).requestId).toBe((repeat.response.body as { requestId: string }).requestId);
    for (const fixture of [received, repeat]) {
      const { client, seen, signals } = clientFor(fixture.response.status, fixture.response.body);
      const jobId = fixture.request.path.split("/")[4] ?? "";
      const result = await client.requestDeletionSupport(jobId, TOKEN, {
        onAuthFailure: (signal) => signals.push(signal),
      });
      expect(seen.method).toBe("POST");
      expect(seen.url).toBe(`https://api.example.test${fixture.request.path}`);
      expect(seen.authorization).toBe(`Bearer ${TOKEN}`);
      expect(seen.body).toBeNull();
      expect(seen.tokenReads).toBe(0);
      expect(signals).toEqual([]);
      expect(result).toEqual({
        result: "sent",
        requestId: (fixture.response.body as { requestId: string }).requestId,
      });
    }
  });

  it("support-bad-token is use_fallback_email and does not sign in", async () => {
    const fixture = loadServerFixture("account-deletion", "support-bad-token");
    const { client, seen, signals } = clientFor(fixture.response.status, fixture.response.body);
    const result = await client.requestDeletionSupport(JOB, TOKEN, {
      onAuthFailure: (signal) => signals.push(signal),
    });
    expect(seen.tokenReads).toBe(0);
    expect(signals).toEqual([]);
    expect(result).toEqual({ result: "use_fallback_email", supportContact: SUPPORT_CONTACT });
  });

  it("a 401 unauthorized is use_fallback_email and does not call onAuthFailure", async () => {
    const { client, seen, signals } = clientFor(401, { error: "unauthorized" });
    const result = await client.requestDeletionSupport(JOB, TOKEN, {
      onAuthFailure: (signal) => signals.push(signal),
    });
    expect(seen.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen.tokenReads).toBe(0);
    expect(signals).toEqual([]);
    expect(result).toEqual({ result: "use_fallback_email", supportContact: SUPPORT_CONTACT });
  });

  it("support-rate-limited is already_sent and support-not-needed refreshes status", async () => {
    const limited = loadServerFixture("account-deletion", "support-rate-limited");
    const limitedResult = await clientFor(limited.response.status, limited.response.body).client.requestDeletionSupport(JOB, TOKEN);
    expect(limitedResult).toEqual({ result: "already_sent" });
    const unneeded = loadServerFixture("account-deletion", "support-not-needed");
    const jobId = unneeded.request.path.split("/")[4] ?? "";
    const unneededResult = await clientFor(unneeded.response.status, unneeded.response.body).client.requestDeletionSupport(jobId, TOKEN);
    expect(unneededResult).toEqual({ result: "refresh_status" });
  });

  it("a network error and a 500 use the support email", async () => {
    const offline = await clientFor(0, {}, true).client.requestDeletionSupport(JOB, TOKEN);
    expect(offline).toEqual({ result: "use_fallback_email", supportContact: SUPPORT_CONTACT });
    const failed = await clientFor(500, { error: "internal" }).client.requestDeletionSupport(JOB, TOKEN);
    expect(failed).toEqual({ result: "use_fallback_email", supportContact: SUPPORT_CONTACT });
  });
});
