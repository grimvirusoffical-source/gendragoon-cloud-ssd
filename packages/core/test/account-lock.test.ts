import { describe, expect, it } from "vitest";
import {
  accountFromAssessment,
  applyApiFailure,
  assessLock,
  reduceAccount,
  viewAfterFailure,
  WorkspaceLockedError,
  type WorkspaceRecord,
} from "../src/index.js";

const NOW = Date.parse("2026-10-18T00:00:00.000Z");

function paid(id: string): WorkspaceRecord {
  return {
    id,
    name: id,
    kind: "paid",
    projectStatus: "active",
    projectFeeStatus: "paid",
    feeIsOneTime: true,
    storage: { kind: "gendragoon", storageTier: "100GB" },
  };
}

describe("account state machine", () => {
  const ready = accountFromAssessment(assessLock([paid("a")], NOW));

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
    const cleared = reduceAccount(locked, {
      type: "assessment",
      assessment: assessLock([paid("a")], NOW),
    });
    expect(cleared).toEqual({ phase: "ready", reason: "clear" });
  });

  it("keeps over-cap as the reason when another write is rejected", () => {
    const crowd = Array.from({ length: 11 }, (_, index) => paid(`p-${index}`));
    const over = accountFromAssessment(assessLock(crowd, NOW));
    expect(over.reason).toBe("over_cap");
    expect(reduceAccount(over, { type: "write_locked" }).reason).toBe("over_cap");
  });
});
