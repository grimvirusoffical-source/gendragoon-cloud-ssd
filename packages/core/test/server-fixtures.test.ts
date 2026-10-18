/**
 * Drives GenDragoonClient with Riley's vendored fixtures
 * (gendragoon-cloud-ssd fix/backend-workspace-policy @ 568f223).
 * Deletion, storage-urls, and key-envelope are not in this export.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError, DeletionNotRetryableError, GenDragoonClient, InvalidTokenError, ReauthRequiredError, WorkspaceLockedError, assertKeyEnvelope, byoErrorMessage } from "../src/index.js";
import { listServerFixtures, loadServerFixture, type ServerFixture } from "./fixtures/server/load.js";

const source = JSON.parse(readFileSync(new URL("./fixtures/server/SOURCE.json", import.meta.url), "utf8")) as {
  commit: string;
  repository: string;
  sources?: { commit: string }[];
};

function clientFor(fixture: ServerFixture) {
  const seen: { method?: string; url?: string; body?: unknown }[] = [];
  const client = new GenDragoonClient({
    baseUrl: "https://api.example.test",
    getToken: () => "fixture-token",
    fetch: async (input, init) => {
      seen.push({
        method: init?.method,
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) as unknown : null,
      });
      return new Response(JSON.stringify(fixture.response.body), {
        status: fixture.response.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, seen };
}

async function invoke(client: GenDragoonClient, fixture: ServerFixture): Promise<unknown> {
  const { method, path, body } = fixture.request;
  const id = path.split("/")[3] ?? "";
  if (method === "POST" && path === "/v2/projects") {
    return client.createProject(body as { name: string; intentId: string });
  }
  if (method === "GET" && path === "/v2/workspaces") return client.listWorkspaces();
  if (method === "GET" && /^\/v2\/projects\/[^/]+$/.test(path)) return client.getProject(id);
  if (method === "POST" && path.endsWith("/cloud/uploads")) {
    return client.createUpload(id, body as { name: string; sizeBytes: number });
  }
  if (method === "POST" && path.endsWith("/merge/preview")) {
    const fields = body as { targetId: string; confirmName: string };
    return client.previewMerge({ sourceId: id, ...fields });
  }
  if (method === "POST" && path.endsWith("/merge")) {
    const fields = body as { targetId: string; confirmName: string };
    return client.mergeWorkspaces({ sourceId: id, ...fields });
  }
  if (method === "GET" && path.endsWith("/cloud/files")) return client.listFiles(id);
  if (method === "POST" && path.endsWith("/byo/register")) {
    return client.registerByo(id, body as { provider: string; endpoint: string; bucketFingerprint: string });
  }
  if (method === "POST" && path.endsWith("/byo/challenge")) return client.createByoChallenge(id);
  if (method === "POST" && path.endsWith("/byo/verify")) {
    return client.verifyByo(id, body as { presignedUrl: string });
  }
  throw new Error(`No client call for ${method} ${path}`);
}

describe("vendored server fixtures", () => {
  it("records the source repo and commit", () => {
    expect(source.repository).toBe("grimvirusoffical-source/gendragoon-cloud-ssd");
    expect(source.commit).toBe("568f2236ffe2520758fb8f20cf22566aefc14cf3");
    expect(source.sources?.[0]?.commit).toBe("568f2236ffe2520758fb8f20cf22566aefc14cf3");
  });

  const cases = listServerFixtures();
  it("covers lock, workspaces, merge, byo, ownership, deletion, storage-urls, and key-envelope", () => {
    expect(new Set(cases.map((item) => item.area))).toEqual(new Set([
      "workspace-lock",
      "workspaces",
      "merge",
      "byo",
      "ownership",
      "account-deletion",
      "storage-urls",
      "key-envelope",
      "errors",
    ]));
  });

  it("records the later fixture commits", () => {
    const sources = source.sources ?? [];
    const commits = sources.map((item) => item.commit);
    expect(commits).toContain("fff0a84b6d75acb3a79cff7f146450c486efbe56");
    expect(commits).toContain("8267784a790bbe8418b3cbe36e8a4b91849b0e81");
    expect(commits).toContain("ee4f76f07bc798635002ae2c272fb47d83db7698");
  });

  it("a blank presignedUrl is omitted and verify-missing-url is presigned_url_required", async () => {
    const fixture = loadServerFixture("byo", "verify-missing-url");
    const { client, seen } = clientFor(fixture);
    const id = fixture.request.path.split("/")[3] ?? "";
    const error = await client.verifyByo(id, { presignedUrl: "   " }).catch((caught: unknown) => caught);
    expect(seen[0]?.body).toEqual({});
    expect(error).toMatchObject({ status: 400, code: "presigned_url_required" });
    expect(byoErrorMessage(error)).toMatch(/presigned URL/i);
  });

  it("SFTP register sends hostFingerprint as bucketFingerprint", async () => {
    const fixture = loadServerFixture("byo", "provider-unsupported");
    const { client, seen } = clientFor(fixture);
    const id = fixture.request.path.split("/")[3] ?? "";
    const fields = fixture.request.body as { provider: string; endpoint: string; bucketFingerprint: string };
    const error = await client.registerByo(id, {
      provider: fields.provider,
      endpoint: fields.endpoint,
      hostFingerprint: fields.bucketFingerprint,
    }).catch((caught: unknown) => caught);
    expect(seen[0]?.body).toEqual(fixture.request.body);
    expect(error).toMatchObject({ status: 422, code: "byo_provider_unsupported" });
  });

  it("retry-after-failed keeps a non-empty status token and retry-not-retryable carries jobId", async () => {
    const retry = loadServerFixture("account-deletion", "retry-after-failed");
    const { client } = clientFor(retry);
    const accepted = await client.deleteAccount({ reauthenticatedAt: new Date().toISOString() });
    expect(accepted.jobId).toBe((retry.response.body as { jobId: string }).jobId);
    expect(accepted.statusToken).toBe("<redacted>");
    expect(accepted.statusToken && accepted.statusToken.length > 0).toBe(true);
    const denied = loadServerFixture("account-deletion", "retry-not-retryable");
    const error = await clientFor(denied).client.deleteAccount({ reauthenticatedAt: new Date().toISOString() }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeletionNotRetryableError);
    expect(error).toMatchObject({ status: 409, code: "deletion_not_retryable", jobId: (denied.response.body as { jobId: string }).jobId });
  });

  it("status-invalid-token is a Firebase invalid_token and status-unauthorized is not sign-out", async () => {
    const invalid = loadServerFixture("account-deletion", "status-invalid-token");
    const jobId = invalid.request.path.split("/").pop() ?? "";
    const invalidError = await clientFor(invalid).client.deletionStatus(jobId).catch((caught: unknown) => caught);
    expect(invalidError).toBeInstanceOf(InvalidTokenError);
    const unauthorized = loadServerFixture("account-deletion", "status-unauthorized");
    const unauthorizedError = await clientFor(unauthorized).client.deletionStatus(jobId).catch((caught: unknown) => caught);
    expect(unauthorizedError).toBeInstanceOf(ApiError);
    expect(unauthorizedError).not.toBeInstanceOf(InvalidTokenError);
    expect(unauthorizedError).not.toBeInstanceOf(ReauthRequiredError);
    expect(unauthorizedError).toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("payload-too-large is HTTP 413 and short salt or iv is envelope_invalid", async () => {
    const tooLarge = loadServerFixture("errors", "payload-too-large");
    expect(tooLarge.response).toEqual({ status: 413, body: { error: "payload_too_large" } });
    const error = await clientFor(tooLarge).client.deleteAccount({ reauthenticatedAt: new Date().toISOString() }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 413, code: "payload_too_large" });
    expect(() => assertKeyEnvelope(loadServerFixture("key-envelope", "salt-wrong-length").request.body)).toThrow(expect.objectContaining({ code: "envelope_invalid" }));
    expect(() => assertKeyEnvelope(loadServerFixture("key-envelope", "iv-wrong-length").request.body)).toThrow(expect.objectContaining({ code: "envelope_invalid" }));
  });

  const driven = new Set(["workspace-lock", "workspaces", "merge", "byo", "ownership"]);
  for (const { area, name, fixture } of cases.filter((item) => driven.has(item.area))) {
    it(`${area}/${name} is sent and read as the fixture`, async () => {
      const { client, seen } = clientFor(fixture);
      let result: unknown;
      let error: unknown;
      try {
        result = await invoke(client, fixture);
      } catch (caught) {
        error = caught;
      }
      expect(seen[0]?.method).toBe(fixture.request.method);
      expect(seen[0]?.url).toBe(`https://api.example.test${fixture.request.path}`);
      expect(seen[0]?.body ?? null).toEqual(fixture.request.body);
      const body = fixture.response.body as { error?: string; reason?: string; overBy?: number; unpaidWorkspaceIds?: string[] };
      if (fixture.response.status >= 400) {
        expect(error).toBeInstanceOf(ApiError);
        if (area === "workspace-lock") {
          expect(error).toBeInstanceOf(WorkspaceLockedError);
          expect(error).toMatchObject({
            reason: body.reason,
            overBy: body.overBy,
            unpaidWorkspaceIds: body.unpaidWorkspaceIds,
          });
        } else if (area === "ownership") {
          expect(error).toMatchObject({ status: 404, code: "NOT_FOUND" });
        } else if (name === "provider-unsupported") {
          expect(error).toMatchObject({ status: 422, code: "byo_provider_unsupported" });
          expect(byoErrorMessage(error)).toMatch(/coming soon/);
        } else if (typeof body.error === "string") {
          expect(error).toMatchObject({ status: fixture.response.status, code: body.error });
        }
        return;
      }
      expect(error).toBeUndefined();
      expect(result).toEqual(fixture.response.body);
    });
  }
});
