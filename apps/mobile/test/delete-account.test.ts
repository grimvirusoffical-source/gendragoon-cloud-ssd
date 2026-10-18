import {
  GenDragoonClient,
  MemorySecretStore,
  WorkspaceLockedError,
  workspaceKeyId,
} from "@gendragoon/core";
import { deletionSessionAction, deleteSignedInAccount } from "../src/account/deleteAccount";
import { createExpoSecureStore } from "../src/platform/secureStore";

function idToken(authTimeSeconds: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ auth_time: authTimeSeconds, sub: "user-1" })}.sig`;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientFor(fetchImpl: typeof fetch): GenDragoonClient {
  return new GenDragoonClient({
    baseUrl: "https://api.example.test",
    getToken: () => idToken(Math.floor(Date.now() / 1000) - 30),
    fetch: fetchImpl,
  });
}

describe("delete account uses core and PR #6 error bodies", () => {
  it("sends {confirm:DELETE} and reads status, not state", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([1, 2, 3]));
    const seen: { method?: string; url: string; body: unknown }[] = [];
    let polls = 0;
    const client = clientFor(async (input, init) => {
      const url = String(input);
      seen.push({ method: init?.method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (init?.method === "DELETE") {
        return json(202, { status: "deleting", jobId: "job-1" });
      }
      polls += 1;
      if (polls === 1) {
        expect(await secrets.get(workspaceKeyId("ws-1"))).not.toBeNull();
        return json(200, { jobId: "job-1", state: "done", retryable: false });
      }
      return json(200, { jobId: "job-1", status: "done", retryable: false });
    });
    const status = await deleteSignedInAccount({
      client,
      idToken: idToken(Math.floor(Date.now() / 1000) - 30),
      workspaceIds: ["ws-1"],
      secrets,
    });
    expect(seen[0]?.body).toEqual({ confirm: "DELETE" });
    expect(seen[1]?.url).toContain("/v2/account/deletions/job-1");
    expect(seen.some((call) => call.url.includes("/account/deletion/"))).toBe(false);
    expect(status.status).toBe("done");
    expect(await secrets.get(workspaceKeyId("ws-1"))).toBeNull();
  });

  it("401 {error:reauth_required} does not wipe and asks for sign-in", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([4]));
    const client = clientFor(async () => json(401, { error: "reauth_required" }));
    const error = await deleteSignedInAccount({
      client,
      idToken: idToken(Math.floor(Date.now() / 1000) - 30),
      workspaceIds: ["ws-1"],
      secrets,
    }).catch((caught: unknown) => caught);
    expect(deletionSessionAction(error)).toBe("reauth");
    expect(await secrets.get(workspaceKeyId("ws-1"))).not.toBeNull();
  });

  it("401 {error:invalid_token} signs out and does not wipe", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([5]));
    const client = clientFor(async () => json(401, { error: "invalid_token" }));
    const error = await deleteSignedInAccount({
      client,
      idToken: idToken(Math.floor(Date.now() / 1000) - 30),
      workspaceIds: ["ws-1"],
      secrets,
    }).catch((caught: unknown) => caught);
    expect(deletionSessionAction(error)).toBe("sign-out");
    expect(await secrets.get(workspaceKeyId("ws-1"))).not.toBeNull();
  });

  it("410 {error:account_deleted, jobId} polls that job and wipes only when status is done", async () => {
    const secrets = createExpoSecureStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([9, 9, 9]));
    let polls = 0;
    const client = clientFor(async (input, init) => {
      if (init?.method === "DELETE") {
        expect(await secrets.get(workspaceKeyId("ws-1"))).not.toBeNull();
        return json(410, { error: "account_deleted", jobId: "job-410", statusToken: "status-token-410" });
      }
      expect(String(input)).toBe("https://api.example.test/v2/account/deletions/job-410");
      polls += 1;
      const status = polls === 1 ? "running" : "done";
      if (status === "running") expect(await secrets.get(workspaceKeyId("ws-1"))).not.toBeNull();
      return json(200, { jobId: "job-410", status, retryable: false });
    });
    const result = await deleteSignedInAccount({
      client,
      idToken: idToken(Math.floor(Date.now() / 1000) - 30),
      workspaceIds: ["ws-1"],
      secrets,
    });
    expect(result.status).toBe("done");
    expect(polls).toBe(2);
    expect(await secrets.get(workspaceKeyId("ws-1"))).toBeNull();
  });

  it("410 {error:account_deleted} without jobId wipes nothing and does not poll", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([8]));
    let polls = 0;
    const client = clientFor(async (input, init) => {
      if (init?.method === "DELETE") return json(410, { error: "account_deleted" });
      polls += 1;
      return json(500, { error: "not_found" });
    });
    await expect(deleteSignedInAccount({
      client,
      idToken: idToken(Math.floor(Date.now() / 1000) - 30),
      workspaceIds: ["ws-1"],
      secrets,
    })).rejects.toMatchObject({ status: 410, code: "account_deleted" });
    expect(polls).toBe(0);
    expect(await secrets.get(workspaceKeyId("ws-1"))).not.toBeNull();
  });

  it("404 {error:not_found} on the poll stops without wiping", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([6]));
    const client = clientFor(async (_input, init) => {
      if (init?.method === "DELETE") return json(202, { status: "deleting", jobId: "job-404" });
      return json(404, { error: "not_found" });
    });
    await expect(deleteSignedInAccount({
      client,
      idToken: idToken(Math.floor(Date.now() / 1000) - 30),
      workspaceIds: ["ws-1"],
      secrets,
    })).rejects.toMatchObject({ status: 404 });
    expect(await secrets.get(workspaceKeyId("ws-1"))).not.toBeNull();
  });

  it("423 {error:workspace_lock, reason, overBy, unpaidWorkspaceIds} is a lock and does not wipe", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("ws-1"), new Uint8Array([7]));
    const client = clientFor(async () => json(423, {
      error: "workspace_lock",
      reason: "over_cap",
      overBy: 1,
      unpaidWorkspaceIds: ["overflow"],
    }));
    const error = await deleteSignedInAccount({
      client,
      idToken: idToken(Math.floor(Date.now() / 1000) - 30),
      workspaceIds: ["ws-1"],
      secrets,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceLockedError);
    expect(await secrets.get(workspaceKeyId("ws-1"))).not.toBeNull();
  });
});
