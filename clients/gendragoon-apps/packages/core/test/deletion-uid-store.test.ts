/**
 * Core writes and clears the account uid saved with a deletion job
 * (DELETION_UID_KEY). The uid comes from the `idToken` already passed to
 * deleteAccountAndWipe, parsed with accountUidFromIdToken. It only ties the
 * local job to the right account and is never an auth decision.
 *
 * Error handling: uid writes and clears are best effort. A rejecting uid
 * set or delete is swallowed and never fails the deletion; job keys keep
 * their existing behaviour (errors propagate).
 */
import { describe, expect, it } from "vitest";
import {
  DELETION_UID_KEY,
  GenDragoonClient,
  MemorySecretStore,
  SUPPORT_CONTACT,
  deleteAccountAndWipe,
  dismissAccountDeletion,
  readDeletionUid,
  requestDeletionSupport,
  resumeAccountDeletion,
  retryDeletion,
  workspaceKeyId,
} from "../src/index.js";
import type { AccountDeletionStatus } from "../src/index.js";

const JOB_KEY = "account-deletion:job-id";
const TOKEN_KEY = "account-deletion:status-token";
const FALLBACK = { kind: "fallback", contact: SUPPORT_CONTACT };

function idToken(claims: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ auth_time: Math.floor(Date.now() / 1000) - 30, ...claims })}.sig`;
}

/** Scripted deletion client: DELETE accepts `jobId`, polls answer `status`. */
function deletionClient(jobId: string, status: AccountDeletionStatus["status"], statusToken = `token-${jobId}`) {
  const seen = { deletes: 0, polls: 0 };
  return {
    seen,
    client: {
      async deleteAccount() {
        seen.deletes += 1;
        return { jobId, statusToken };
      },
      async deletionStatus(id: string): Promise<AccountDeletionStatus> {
        seen.polls += 1;
        return { jobId: id, status, retryable: true };
      },
    },
  };
}

/** auth_time parses (re-auth passes) but accountUidFromIdToken rejects it: empty signature. */
const unparsableUidToken = (sub: string) => idToken({ sub }).replace(/\.sig$/, ".");

const text = async (store: MemorySecretStore, key: string) => {
  const v = await store.get(key);
  return v ? new TextDecoder().decode(v) : null;
};

async function run(store: MemorySecretStore, client: ReturnType<typeof deletionClient>["client"], token: string | undefined) {
  return deleteAccountAndWipe({
    client,
    reauthenticatedAt: token ? "" : new Date().toISOString(),
    idToken: token,
    workspaceIds: ["w1"],
    secrets: store,
    secureStore: store,
    sleep: async () => {},
  });
}

/** A store whose uid set or delete rejects; everything else is a MemorySecretStore. */
function flakyUidStore(fail: { set?: boolean; delete?: boolean }) {
  const store = new MemorySecretStore();
  const attempts = { set: 0, delete: 0 };
  const realSet = store.set.bind(store);
  const realDelete = store.delete.bind(store);
  store.set = async (key, bytes) => {
    if (key === DELETION_UID_KEY) {
      attempts.set += 1;
      if (fail.set) throw new Error("keychain write failed");
    }
    return realSet(key, bytes);
  };
  store.delete = async (key) => {
    if (key === DELETION_UID_KEY) {
      attempts.delete += 1;
      if (fail.delete) throw new Error("keychain delete failed");
    }
    return realDelete(key);
  };
  return { store, attempts, realSet };
}

describe("deletion job uid: core writes it with the job", () => {
  it("a new job saves the idToken's sub under DELETION_UID_KEY, with the job id and status token", async () => {
    const store = new MemorySecretStore();
    const { client } = deletionClient("job-1", "failed");
    const status = await run(store, client, idToken({ sub: "user-1", user_id: "user-1" }));
    expect(status.status).toBe("failed");
    expect(await text(store, JOB_KEY)).toBe("job-1");
    expect(await text(store, TOKEN_KEY)).toBe("token-job-1");
    expect(await text(store, DELETION_UID_KEY)).toBe("user-1");
    expect(await readDeletionUid(store)).toBe("user-1");
  });

  it.each([
    ["no idToken", undefined],
    ["an idToken with no sub", idToken({})],
    ["an idToken with an invalid sub", idToken({ sub: "user 1" })],
    ["an idToken whose user_id disagrees with sub", idToken({ sub: "user-1", user_id: "user-2" })],
  ])("%s -> the job is saved and no uid key is written", async (_label, token) => {
    const store = new MemorySecretStore();
    const { client } = deletionClient("job-1", "failed");
    expect((await run(store, client, token)).status).toBe("failed");
    expect(await text(store, JOB_KEY)).toBe("job-1");
    expect(await store.get(DELETION_UID_KEY)).toBeNull();
    expect(await readDeletionUid(store)).toBeNull();
  });

  it.each([
    ["an idToken with no sub", idToken({})],
    ["an unparsable idToken (empty signature)", unparsableUidToken("user-1")],
  ])("a new job with %s deletes an older stale uid", async (_label, token) => {
    const store = new MemorySecretStore();
    await store.set(DELETION_UID_KEY, new TextEncoder().encode("stale-user"));
    const { client } = deletionClient("job-1", "failed");
    await deleteAccountAndWipe({
      client,
      reauthenticatedAt: "",
      idToken: token,
      workspaceIds: ["w1"],
      secrets: store,
      secureStore: store,
      sleep: async () => {},
    });
    expect(await store.get(DELETION_UID_KEY)).toBeNull();
  });

  it("a new job with no valid uid removes an older stale uid", async () => {
    const store = new MemorySecretStore();
    await store.set(DELETION_UID_KEY, new TextEncoder().encode("stale-user"));
    const { client } = deletionClient("job-1", "failed");
    await run(store, client, idToken({}));
    expect(await store.get(DELETION_UID_KEY)).toBeNull();
  });

  it("resuming a saved job does not overwrite its uid with another token's sub", async () => {
    const store = new MemorySecretStore();
    const first = deletionClient("job-1", "failed");
    await run(store, first.client, idToken({ sub: "user-1" }));
    // Saved job, caller still signed in (onAuthFailure set): polls with the Firebase token, no DELETE.
    const again = deletionClient("job-1", "failed");
    await deleteAccountAndWipe({
      client: again.client,
      reauthenticatedAt: "",
      idToken: idToken({ sub: "user-2" }),
      workspaceIds: ["w1"],
      secrets: store,
      secureStore: store,
      sleep: async () => {},
      onAuthFailure: () => {},
    });
    expect(again.seen.deletes).toBe(0);
    expect(await text(store, DELETION_UID_KEY)).toBe("user-1");
  });

  it.each([
    ["the retry token's uid", idToken({ sub: "user-2" }), "user-2"],
    ["no uid when the retry token has no sub", idToken({}), null],
    ["no uid when the retry token is unparsable", unparsableUidToken("user-2"), null],
  ])("a job saved by retryDeletion carries %s, never the stale one", async (_label, token, expected) => {
    const store = new MemorySecretStore();
    await run(store, deletionClient("job-1", "failed").client, idToken({ sub: "user-1" }));
    await retryDeletion({
      client: deletionClient("job-1", "failed", "token-2").client,
      reauthenticatedAt: "",
      idToken: token,
      workspaceIds: ["w1"],
      secrets: store,
      secureStore: store,
      sleep: async () => {},
    });
    expect(await text(store, TOKEN_KEY)).toBe("token-2");
    expect(await text(store, DELETION_UID_KEY)).toBe(expected);
  });

  it("a job saved by sign-in recovery (saved job, DELETE again) carries the current uid", async () => {
    const store = new MemorySecretStore();
    await run(store, deletionClient("job-1", "failed").client, idToken({ sub: "user-1" }));
    // No onAuthFailure: the caller is repeating DELETE after signing in.
    await run(store, deletionClient("job-1", "failed", "token-2").client, idToken({ sub: "user-9" }));
    expect(await text(store, TOKEN_KEY)).toBe("token-2");
    expect(await text(store, DELETION_UID_KEY)).toBe("user-9");
  });
});

describe("deletion job uid: core clears it with the job", () => {
  it("dismissAccountDeletion removes the uid with the job keys", async () => {
    const store = new MemorySecretStore();
    await run(store, deletionClient("job-1", "failed").client, idToken({ sub: "user-1" }));
    expect(await text(store, DELETION_UID_KEY)).toBe("user-1");
    await dismissAccountDeletion(store);
    expect(await store.get(JOB_KEY)).toBeNull();
    expect(await store.get(TOKEN_KEY)).toBeNull();
    expect(await store.get(DELETION_UID_KEY)).toBeNull();
  });

  it("a finished (done) job removes the uid with the job keys", async () => {
    const store = new MemorySecretStore();
    await store.set(workspaceKeyId("w1"), new Uint8Array([1]));
    const status = await run(store, deletionClient("job-1", "done").client, idToken({ sub: "user-1" }));
    expect(status.status).toBe("done");
    expect(await store.get(JOB_KEY)).toBeNull();
    expect(await store.get(DELETION_UID_KEY)).toBeNull();
  });

  it("a resumed job that finishes removes the uid too", async () => {
    const store = new MemorySecretStore();
    await run(store, deletionClient("job-1", "failed").client, idToken({ sub: "user-1" }));
    const done = await resumeAccountDeletion({
      client: deletionClient("job-1", "done").client,
      workspaceIds: ["w1"],
      secrets: store,
      secureStore: store,
      sleep: async () => {},
    });
    expect(done?.status).toBe("done");
    expect(await store.get(DELETION_UID_KEY)).toBeNull();
  });

  it("Morgan's concern: after dismiss, a new job for a different account does not fall back", async () => {
    const store = new MemorySecretStore();
    await run(store, deletionClient("job-1", "failed").client, idToken({ sub: "user-1" }));
    await dismissAccountDeletion(store);
    await run(store, deletionClient("job-2", "failed").client, idToken({ sub: "user-2" }));
    expect(await text(store, DELETION_UID_KEY)).toBe("user-2");
    let requests = 0;
    const support = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => { throw new Error("signed out"); },
      fetch: async () => {
        requests += 1;
        return new Response(JSON.stringify({ status: "received", requestId: "req-2" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const result = await requestDeletionSupport("job-2", { client: support, secureStore: store, currentUid: "user-2" });
    expect(result).toEqual({ kind: "received", requestId: "req-2" });
    expect(requests).toBe(1);
    // The old account is now the mismatch.
    expect(await requestDeletionSupport("job-2", { client: support, secureStore: store, currentUid: "user-1" })).toEqual(FALLBACK);
    expect(requests).toBe(1);
  });
});

describe("Morgan's scenario: account A's leftover uid, then account B with a bad token", () => {
  it("B's new job deletes A's uid, so B's support request is not a false fallback", async () => {
    const store = new MemorySecretStore();
    // A's uid left behind (e.g. by today's mobile code, or a failed clear).
    await store.set(DELETION_UID_KEY, new TextEncoder().encode("user-A"));
    // B's token passes re-auth but has no usable uid.
    await run(store, deletionClient("job-B", "failed").client, unparsableUidToken("user-B"));
    expect(await text(store, JOB_KEY)).toBe("job-B");
    expect(await store.get(DELETION_UID_KEY)).toBeNull();
    let requests = 0;
    const support = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => { throw new Error("signed out"); },
      fetch: async () => {
        requests += 1;
        return new Response(JSON.stringify({ status: "received", requestId: "req-B" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      },
    });
    // B signed in with a valid uid later, and B signed out: neither falls back.
    expect(await requestDeletionSupport("job-B", { client: support, secureStore: store, currentUid: "user-B" }))
      .toEqual({ kind: "received", requestId: "req-B" });
    expect(await requestDeletionSupport("job-B", { client: support, secureStore: store, currentUid: null }))
      .toEqual({ kind: "received", requestId: "req-B" });
    expect(requests).toBe(2);
  });
});

describe("deletion job uid: a failed uid write or clear never breaks deletion (best effort)", () => {
  it("a rejecting uid write: the deletion still runs, the job is saved, and no uid is left", async () => {
    const { store, attempts } = flakyUidStore({ set: true });
    const { client, seen } = deletionClient("job-1", "failed");
    const status = await run(store, client, idToken({ sub: "user-1" }));
    expect(status.status).toBe("failed");
    expect(attempts.set).toBe(1);
    expect(seen.polls).toBeGreaterThan(0);
    expect(await text(store, JOB_KEY)).toBe("job-1");
    expect(await store.get(DELETION_UID_KEY)).toBeNull();
  });

  it("a rejecting uid write also removes an older uid, so it cannot make the new job fall back", async () => {
    const { store, realSet } = flakyUidStore({ set: true });
    await realSet(DELETION_UID_KEY, new TextEncoder().encode("stale-user"));
    await run(store, deletionClient("job-1", "failed").client, idToken({ sub: "user-1" }));
    expect(await store.get(DELETION_UID_KEY)).toBeNull();
  });

  it("a rejecting uid write on a done job still wipes keys and returns done", async () => {
    const { store } = flakyUidStore({ set: true });
    await store.set(workspaceKeyId("w1"), new Uint8Array([1]));
    const status = await run(store, deletionClient("job-1", "done").client, idToken({ sub: "user-1" }));
    expect(status.status).toBe("done");
    expect(await store.get(workspaceKeyId("w1"))).toBeNull();
    expect(await store.get(JOB_KEY)).toBeNull();
  });

  it("a rejecting uid clear: dismiss still resolves and clears the job keys", async () => {
    const { store, attempts } = flakyUidStore({ delete: true });
    await run(store, deletionClient("job-1", "failed").client, idToken({ sub: "user-1" }));
    await expect(dismissAccountDeletion(store)).resolves.toBeUndefined();
    expect(attempts.delete).toBeGreaterThan(0);
    expect(await store.get(JOB_KEY)).toBeNull();
    expect(await store.get(TOKEN_KEY)).toBeNull();
    // The stale uid is left behind...
    expect(await text(store, DELETION_UID_KEY)).toBe("user-1");
  });

  it("...and the next job's uid write replaces it, so the new account does not fall back", async () => {
    const { store } = flakyUidStore({ delete: true });
    await run(store, deletionClient("job-1", "failed").client, idToken({ sub: "user-1" }));
    await dismissAccountDeletion(store);
    await run(store, deletionClient("job-2", "failed").client, idToken({ sub: "user-2" }));
    expect(await text(store, DELETION_UID_KEY)).toBe("user-2");
  });

  it("a rejecting uid clear on a done job still returns done", async () => {
    const { store } = flakyUidStore({ delete: true });
    await store.set(workspaceKeyId("w1"), new Uint8Array([1]));
    const status = await run(store, deletionClient("job-1", "done").client, idToken({ sub: "user-1" }));
    expect(status.status).toBe("done");
    expect(await store.get(JOB_KEY)).toBeNull();
  });
});
