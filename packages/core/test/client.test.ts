import { describe, expect, it } from "vitest";
import { ApiError, GenDragoonClient, hidesWorkspaceExistence } from "../src/index.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GenDragoonClient", () => {
  it("calls the live project route and keeps foreign workspaces as not found", async () => {
    const seen: { url?: string; authorization?: string } = {};
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "firebase-token",
      fetch: async (input, init) => {
        seen.url = String(input);
        seen.authorization = new Headers(init?.headers).get("Authorization") ?? undefined;
        return jsonResponse(404, { error: "Project not found", code: "PROJECT_NOT_FOUND" });
      },
    });
    await expect(client.getProject("someone-elses")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: "Not found",
    });
    expect(seen.url).toBe("https://api.example.test/v2/projects/someone-elses");
    expect(seen.authorization).toBe("Bearer firebase-token");
    expect(hidesWorkspaceExistence({ status: 403, code: "PROJECT_FORBIDDEN" })).toBe(true);
  });

  it("collapses the legacy foreign-workspace 403 without echoing the token", async () => {
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "super-secret-token",
      fetch: async () => jsonResponse(403, { error: "Project access denied", code: "PROJECT_FORBIDDEN" }),
    });
    try {
      await client.getProject("hidden");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(404);
      expect((error as Error).message).not.toContain("super-secret-token");
      expect((error as Error).message).not.toMatch(/access denied/i);
    }
  });

  it("posts merge and BYO challenge bodies without credential fields", async () => {
    const bodies: unknown[] = [];
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => undefined,
      fetch: async (input, init) => {
        bodies.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
        return jsonResponse(200, { ok: true });
      },
    });
    await client.mergeWorkspaces({ sourceId: "a", targetId: "b" });
    await client.createByoChallenge("ws", {
      provider: "b2",
      endpoint: "https://s3.us-west-000.backblazeb2.com",
      bucketFingerprint: "ab".repeat(32),
    });
    expect(bodies[0]).toMatchObject({ url: "https://api.example.test/v2/workspaces/merge" });
    expect(JSON.stringify(bodies[1])).not.toMatch(/secret|password|token/i);
    await expect(client.createByoChallenge("ws", {
      provider: "aws",
      endpoint: "https://s3.amazonaws.com",
      bucketFingerprint: "cd".repeat(32),
      secretAccessKey: "nope",
    } as never)).rejects.toThrow(/credential field/);
  });

  it("starts a v3 upload against the cloud route", async () => {
    let url = "";
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test/",
      getToken: () => "t",
      fetch: async (input) => {
        url = String(input);
        return jsonResponse(201, {
          status: "active",
          uploadId: "up",
          chunkBytes: 8388608,
          totalChunks: 1,
          sizeBytes: 4,
          nextIndex: 0,
          uploadedBytes: 0,
        });
      },
    });
    const status = await client.createUpload("free", { name: "note.txt", sizeBytes: 4, kind: "file" });
    expect(url).toBe("https://api.example.test/v3/cloud/free/uploads");
    expect(status.chunkBytes).toBe(8388608);
  });
});
