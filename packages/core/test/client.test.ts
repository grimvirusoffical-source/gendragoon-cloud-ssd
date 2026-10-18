import { describe, expect, it } from "vitest";
import { ApiError, GenDragoonClient, WorkspaceLockedError, hidesWorkspaceExistence } from "../src/index.js";

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
    expect(url).toBe("https://api.example.test/v2/workspaces/free/cloud/uploads");
    expect(status.chunkBytes).toBe(8388608);
  });

  it("maps HTTP 423 workspace_lock to WorkspaceLockedError and still allows reads and deletes", async () => {
    const calls: string[] = [];
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "firebase-token",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push(`${init?.method} ${url}`);
        if (init?.method === "POST") {
          return jsonResponse(423, { code: "workspace_lock", error: "over cap" });
        }
        return jsonResponse(200, init?.method === "DELETE" ? { deleted: true } : { files: [], nextCursor: null, quotaBytes: 1, usedBytes: 0, workers: 2 });
      },
    });
    await expect(client.createUpload("ws", { name: "a.txt", sizeBytes: 1, kind: "file" })).rejects.toBeInstanceOf(WorkspaceLockedError);
    try {
      await client.createUpload("ws", { name: "a.txt", sizeBytes: 1, kind: "file" });
    } catch (error) {
      expect(error).toMatchObject({ status: 423, code: "workspace_lock", name: "WorkspaceLockedError" });
      expect((error as Error).message).not.toContain("over cap");
      expect((error as Error).message).not.toContain("firebase-token");
    }
    await expect(client.listFiles("ws")).resolves.toMatchObject({ files: [] });
    await expect(client.deleteFile("ws", "file-1")).resolves.toEqual({ deleted: true });
    expect(calls.map((call) => call.split(" ")[0])).toEqual(["POST", "POST", "GET", "DELETE"]);
  });

  it("requests /v2 storage links and accepts account deletion only after a recent re-auth", async () => {
    const seen: { method?: string; url?: string; body?: unknown }[] = [];
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "fresh-token",
      fetch: async (input, init) => {
        const url = String(input);
        seen.push({ method: init?.method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url.endsWith("/storage-urls")) {
          return jsonResponse(200, {
            prefix: "customers/abc/workspaces/ws/",
            expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            access: "read-only",
            links: [{
              op: "download",
              oid: "oid",
              method: "GET",
              url: "https://storage.googleapis.com/customers/abc/workspaces/ws/oid?X-Goog-Signature=1",
              expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            }],
          });
        }
        if (init?.method === "DELETE") return jsonResponse(202, { jobId: "job-1", status: "accepted" });
        return jsonResponse(200, { jobId: "job-1", status: "succeeded", confirmation: "deleted", firebaseUserDeleted: true });
      },
    });
    const links = await client.storageUrls("ws", { operations: [{ op: "download", oid: "oid" }] });
    expect(links.access).toBe("read-only");
    expect(seen[0]?.url).toBe("https://api.example.test/v2/workspaces/ws/storage-urls");
    await expect(client.deleteAccount({ reauthenticatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() })).rejects.toMatchObject({
      code: "REAUTH_REQUIRED",
    });
    const accepted = await client.deleteAccount({ reauthenticatedAt: new Date().toISOString() });
    expect(accepted).toEqual({ jobId: "job-1", status: "accepted" });
    expect(seen.some((call) => call.method === "DELETE" && call.url === "https://api.example.test/v2/account")).toBe(true);
    const status = await client.deletionStatus("job-1");
    expect(status.status).toBe("succeeded");
    expect(seen.at(-1)?.url).toBe("https://api.example.test/v2/account/deletion/job-1");
  });
});
