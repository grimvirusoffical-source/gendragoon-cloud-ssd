import { describe, expect, it } from "vitest";
import {
  AccountDeletedError,
  GenDragoonClient,
  InvalidTokenError,
  MemorySecretStore,
  ReauthRequiredError,
  authTimeMsFromIdToken,
  deleteAccountAndWipe,
  deletionAuthFailure,
  readAccountDeletion,
  reauthIsRecent,
  reauthenticatedAtForDelete,
  workspaceKeyId,
} from "../src/index.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function unsignedToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("DELETE /v2/account contract", () => {
  it("sends exactly {confirm:DELETE} and accepts a 202 that is only {jobId}", async () => {
    const seen: { method?: string; url?: string; body?: unknown }[] = [];
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "fresh-token",
      fetch: async (input, init) => {
        seen.push({
          method: init?.method,
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return jsonResponse(202, { jobId: "job-1" });
      },
    });
    const accepted = await client.deleteAccount({
      reauthenticatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      idToken: unsignedToken({
        auth_time: Math.floor(Date.now() / 1000) - 60,
        iat: Math.floor(Date.now() / 1000),
      }),
    });
    expect(accepted).toEqual({ jobId: "job-1" });
    expect(seen[0]?.body).toEqual({ confirm: "DELETE" });
    expect(JSON.stringify(seen[0]?.body)).not.toContain("idToken");
    expect(JSON.stringify(seen[0]?.body)).not.toContain("reauthenticatedAt");
  });

  it("uses auth_time and ignores a fresh iat and a fresh reauthenticatedAt", () => {
    const now = Date.parse("2026-10-18T12:00:00.000Z");
    const fresh = unsignedToken({
      auth_time: Math.floor((now - 4 * 60_000) / 1000),
      iat: Math.floor(now / 1000),
    });
    const stale = unsignedToken({
      auth_time: Math.floor((now - 6 * 60_000) / 1000),
      iat: Math.floor(now / 1000),
    });
    const refreshedOnly = unsignedToken({ iat: Math.floor(now / 1000) });
    expect(reauthIsRecent(reauthenticatedAtForDelete({ idToken: fresh, reauthenticatedAt: "" }), now)).toBe(true);
    expect(reauthIsRecent(reauthenticatedAtForDelete({
      idToken: stale,
      reauthenticatedAt: new Date(now).toISOString(),
    }), now)).toBe(false);
    expect(authTimeMsFromIdToken(refreshedOnly)).toBeNull();
    expect(reauthenticatedAtForDelete({
      idToken: refreshedOnly,
      reauthenticatedAt: new Date(now).toISOString(),
    })).toBe("");
    expect(reauthIsRecent(reauthenticatedAtForDelete({
      idToken: refreshedOnly,
      reauthenticatedAt: new Date(now).toISOString(),
    }), now)).toBe(false);
  });

  it("polls the plural deletions path until done and does not wipe on succeeded", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("w1"), new Uint8Array([1]));
    const states = ["succeeded", "done"] as const;
    let reads = 0;
    const result = await deleteAccountAndWipe({
      client: {
        deleteAccount: async () => ({ jobId: "job-9" }),
        deletionStatus: async (jobId) => {
          expect(jobId).toBe("job-9");
          const status = states[reads] ?? "done";
          reads += 1;
          if (status !== "done") expect(await secrets.get(workspaceKeyId("w1"))).not.toBeNull();
          return { jobId, status };
        },
      },
      reauthenticatedAt: new Date().toISOString(),
      workspaceIds: ["w1"],
      secrets,
      sleep: async () => undefined,
    });
    expect(result.status).toBe("done");
    expect(reads).toBe(2);
    expect(await secrets.get(workspaceKeyId("w1"))).toBeNull();
  });

  it("sends the user to sign in again on reauth_required and does not wipe", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("w1"), new Uint8Array([1]));
    let calls = 0;
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "fresh-token",
      fetch: async () => {
        calls += 1;
        return jsonResponse(401, { code: "reauth_required", error: "sign in again" });
      },
    });
    const error = await deleteAccountAndWipe({
      client,
      reauthenticatedAt: new Date().toISOString(),
      workspaceIds: ["w1"],
      secrets,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReauthRequiredError);
    expect(deletionAuthFailure(error)).toBe("reauth");
    expect(calls).toBe(1);
    expect(await secrets.get(workspaceKeyId("w1"))).not.toBeNull();
  });

  it("signs out on invalid_token without wiping keys", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("w1"), new Uint8Array([1]));
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "stale-token",
      fetch: async () => jsonResponse(401, { code: "invalid_token", error: "expired" }),
    });
    const error = await deleteAccountAndWipe({
      client,
      reauthenticatedAt: new Date().toISOString(),
      workspaceIds: ["w1"],
      secrets,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidTokenError);
    expect(deletionAuthFailure(error)).toBe("sign-out");
    expect(await secrets.get(workspaceKeyId("w1"))).not.toBeNull();
  });

  it("polls a 410 account_deleted job and wipes only after done", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("w1"), new Uint8Array([9]));
    const states = ["accepted", "done"] as const;
    let reads = 0;
    const seen: string[] = [];
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "fresh-token",
      fetch: async (input, init) => {
        const url = String(input);
        seen.push(`${init?.method} ${url}`);
        if (init?.method === "DELETE") {
          expect(JSON.parse(String(init.body))).toEqual({ confirm: "DELETE" });
          expect(await secrets.get(workspaceKeyId("w1"))).not.toBeNull();
          return jsonResponse(410, { code: "account_deleted", jobId: "job-410", error: "already gone" });
        }
        const status = states[reads] ?? "done";
        reads += 1;
        expect(await secrets.get(workspaceKeyId("w1"))).not.toBeNull();
        return jsonResponse(200, { jobId: "job-410", status });
      },
    });
    const result = await deleteAccountAndWipe({
      client,
      reauthenticatedAt: new Date().toISOString(),
      workspaceIds: ["w1"],
      secrets,
      sleep: async () => undefined,
    });
    expect(result.status).toBe("done");
    expect(seen[0]).toBe("DELETE https://api.example.test/v2/account");
    expect(seen[1]).toBe("GET https://api.example.test/v2/account/deletions/job-410");
    expect(await secrets.get(workspaceKeyId("w1"))).toBeNull();
  });

  it("does not wipe when a 410 account_deleted job reports failed", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("w1"), new Uint8Array([9]));
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "fresh-token",
      fetch: async (_input, init) => {
        if (init?.method === "DELETE") {
          return jsonResponse(410, { code: "account_deleted", jobId: "job-411" });
        }
        return jsonResponse(200, { jobId: "job-411", status: "failed" });
      },
    });
    const result = await deleteAccountAndWipe({
      client,
      reauthenticatedAt: new Date().toISOString(),
      workspaceIds: ["w1"],
      secrets,
      sleep: async () => undefined,
    });
    expect(result.status).toBe("failed");
    expect(await secrets.get(workspaceKeyId("w1"))).not.toBeNull();
  });

  it("does not wipe or poll when 410 account_deleted has no job id", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("w1"), new Uint8Array([9]));
    let calls = 0;
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "fresh-token",
      fetch: async () => {
        calls += 1;
        return jsonResponse(410, { code: "account_deleted" });
      },
    });
    await expect(deleteAccountAndWipe({
      client,
      reauthenticatedAt: new Date().toISOString(),
      workspaceIds: ["w1"],
      secrets,
    })).rejects.toMatchObject({ status: 410, code: "account_deleted" });
    expect(calls).toBe(1);
    expect(await secrets.get(workspaceKeyId("w1"))).not.toBeNull();
  });

  it("still polls when the client throws AccountDeletedError", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("w1"), new Uint8Array([3]));
    const result = await deleteAccountAndWipe({
      client: {
        deleteAccount: async () => {
          throw new AccountDeletedError("job-from-error");
        },
        deletionStatus: async (jobId) => {
          expect(jobId).toBe("job-from-error");
          expect(await secrets.get(workspaceKeyId("w1"))).not.toBeNull();
          return { jobId, status: "done" as const };
        },
      },
      reauthenticatedAt: new Date().toISOString(),
      workspaceIds: ["w1"],
      secrets,
      sleep: async () => undefined,
    });
    expect(result.status).toBe("done");
    expect(await secrets.get(workspaceKeyId("w1"))).toBeNull();
  });

  it("saves the account uid with the job and does not poll a different account", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("w1"), new Uint8Array([1]));
    const now = Math.floor(Date.now() / 1000) - 30;
    let polls = 0;
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "fresh-token",
      fetch: async (_input, init) => {
        if (init?.method === "DELETE") {
          return jsonResponse(202, { jobId: "job-uid", statusToken: "token-uid" });
        }
        polls += 1;
        return jsonResponse(401, {});
      },
    });
    const error = await deleteAccountAndWipe({
      client,
      reauthenticatedAt: "",
      idToken: unsignedToken({ auth_time: now, sub: "user-1" }),
      workspaceIds: ["w1"],
      secrets,
    }).catch((caught: unknown) => caught);
    expect(deletionAuthFailure(error)).toBe("sign-out");
    expect(await readAccountDeletion(secrets)).toEqual({
      jobId: "job-uid",
      statusToken: "token-uid",
      uid: "user-1",
    });
    expect(await secrets.get(workspaceKeyId("w1"))).not.toBeNull();
    const pollsAfterSave = polls;
    await expect(deleteAccountAndWipe({
      client,
      reauthenticatedAt: "",
      idToken: unsignedToken({ auth_time: now, sub: "user-2" }),
      workspaceIds: ["w1"],
      secrets,
    })).rejects.toMatchObject({ status: 409, code: "account_mismatch" });
    expect(polls).toBe(pollsAfterSave);
    expect(await readAccountDeletion(secrets)).toEqual({
      jobId: "job-uid",
      statusToken: "token-uid",
      uid: "user-1",
    });
    expect(await secrets.get(workspaceKeyId("w1"))).not.toBeNull();
  });
});
