import { describe, expect, it } from "vitest";
import {
  accountFromAssessment,
  applyApiFailure,
  deleteAccountAndWipe,
  MemorySecretStore,
  reduceAccount,
  viewAfterFailure,
  WorkspaceLockedError,
  workspaceKeyId,
  type LockAssessment,
} from "../src/index.js";

const ready = accountFromAssessment({ locked: false, overCap: false, unpaidIds: [] });

const clear: LockAssessment = {
  locked: false,
  cap: 10,
  activeCount: 1,
  overCap: false,
  unpaidIds: [],
  lapsedIds: [],
  readable: true,
  downloadsAllowed: true,
  uploadsBlocked: false,
  normalUseBlocked: false,
  highTier: false,
};

describe("account state machine", () => {
  it("moves a ready account to delete-or-merge when a write returns workspace_lock", () => {
    const next = applyApiFailure(ready, new WorkspaceLockedError());
    expect(next).toEqual({ phase: "delete_or_merge", reason: "server_lock" });
    expect(viewAfterFailure("files", new WorkspaceLockedError())).toBe("workspaces");
  });

  it("leaves the phase alone for reads, deletes, and unrelated failures", () => {
    const locked = reduceAccount(ready, { type: "write_locked" });
    expect(reduceAccount(locked, { type: "read_ok" })).toEqual(locked);
    expect(reduceAccount(locked, { type: "delete_ok" })).toEqual(locked);
    expect(reduceAccount(ready, { type: "read_ok" })).toEqual(ready);
    expect(applyApiFailure(ready, new Error("Request failed"))).toEqual(ready);
    expect(viewAfterFailure("files", new Error("Request failed"))).toBe("files");
  });

  it("clears the lock only from a server assessment that is no longer locked", () => {
    const locked = applyApiFailure(ready, new WorkspaceLockedError());
    const cleared = reduceAccount(locked, { type: "assessment", assessment: clear });
    expect(cleared).toEqual({ phase: "ready", reason: "clear" });
  });

  it("keeps over-cap as the reason when another write is rejected", () => {
    const over = accountFromAssessment({ locked: true, overCap: true, unpaidIds: [] });
    expect(over.reason).toBe("over_cap");
    expect(reduceAccount(over, { type: "write_locked" }).reason).toBe("over_cap");
  });
});

describe("delete account polling", () => {
  it("polls GET status until the job is done, then wipes local keys", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("w1"), new Uint8Array([1]));
    const states = ["accepted", "running", "done"] as const;
    let reads = 0;
    const client = {
      deleteAccount: async () => ({ jobId: "job-1" }),
      deletionStatus: async (jobId: string) => {
        expect(jobId).toBe("job-1");
        const status = states[Math.min(reads, states.length - 1)] ?? "done";
        reads += 1;
        return { jobId, status };
      },
    };
    const result = await deleteAccountAndWipe({
      client,
      reauthenticatedAt: new Date().toISOString(),
      workspaceIds: ["w1"],
      secrets,
      sleep: async () => undefined,
    });
    expect(result.status).toBe("done");
    expect(reads).toBe(3);
    expect(await secrets.get(workspaceKeyId("w1"))).toBeNull();
  });

  it("stops on failed without wiping and times out while the job is still running", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("w1"), new Uint8Array([1]));
    const failed = await deleteAccountAndWipe({
      client: {
        deleteAccount: async () => ({ jobId: "job-2" }),
        deletionStatus: async () => ({ jobId: "job-2", status: "failed" as const }),
      },
      reauthenticatedAt: new Date().toISOString(),
      workspaceIds: ["w1"],
      secrets,
      sleep: async () => undefined,
    });
    expect(failed.status).toBe("failed");
    expect(await secrets.get(workspaceKeyId("w1"))).not.toBeNull();

    await expect(deleteAccountAndWipe({
      client: {
        deleteAccount: async () => ({ jobId: "job-3" }),
        deletionStatus: async () => ({ jobId: "job-3", status: "running" as const }),
      },
      reauthenticatedAt: new Date().toISOString(),
      workspaceIds: ["w1"],
      secrets,
      sleep: async () => undefined,
      timeoutMs: 300,
      backoffMs: [200, 200],
    })).rejects.toMatchObject({ code: "DELETION_TIMEOUT" });
  });
});
