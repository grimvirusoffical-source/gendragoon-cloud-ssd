/**
 * Drives GenDragoonClient with Riley's vendored fixtures
 * (gendragoon-cloud-ssd fix/backend-workspace-policy @ da392762).
 * Deletion, storage-urls, and key-envelope are not in this export.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError, GenDragoonClient, WorkspaceLockedError, byoErrorMessage } from "../src/index.js";
import { listServerFixtures, loadServerFixture, type ServerFixture } from "./fixtures/server/load.js";

const source = JSON.parse(readFileSync(new URL("./fixtures/server/SOURCE.json", import.meta.url), "utf8")) as {
  commit: string;
  repository: string;
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
    expect(source.commit).toBe("da3927627fee76103981714f9f8ffa954843b74b");
  });

  const cases = listServerFixtures();
  it("covers lock, workspaces, merge, byo, and ownership", () => {
    expect(new Set(cases.map((item) => item.area))).toEqual(new Set([
      "workspace-lock",
      "workspaces",
      "merge",
      "byo",
      "ownership",
    ]));
  });

  it("verify drops readBack and a missing URL is presigned_url_required", async () => {
    const fixture = loadServerFixture("byo", "verify-missing-url");
    const { client, seen } = clientFor(fixture);
    const id = fixture.request.path.split("/")[3] ?? "";
    const error = await client.verifyByo(id, { readBack: "nonce" } as unknown as { presignedUrl: string }).catch((caught: unknown) => caught);
    expect(seen[0]?.body).toEqual({});
    expect(seen[0]?.body).not.toHaveProperty("readBack");
    expect(error).toMatchObject({ status: 400, code: "presigned_url_required" });
    expect(byoErrorMessage(error)).toMatch(/presigned URL/i);
  });

  for (const { area, name, fixture } of cases) {
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
