import { describe, expect, it } from "vitest";
import {
  FREE_WORKSPACES,
  MAX_WORKSPACES_BASE,
  MAX_WORKSPACES_HIGH,
  WORKSPACE_MONTHLY_CENTS,
  assessLock,
  freeWorkspaceAllowance,
  isGrandfathered,
  isLapsed,
  performanceAddonAllowed,
  qualifiesForHigherLimit,
  quoteAdditionalWorkspace,
  workspaceCap,
  workspaceMonthlyCents,
  type WorkspaceRecord,
} from "../src/index.js";

const NOW = Date.parse("2026-10-18T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function workspace(patch: Partial<WorkspaceRecord> & Pick<WorkspaceRecord, "id" | "name">): WorkspaceRecord {
  return {
    kind: "paid",
    projectStatus: "active",
    provisioned: true,
    storage: { kind: "gendragoon", storageTier: "100GB" },
    ...patch,
  };
}

describe("FREE_WORKSPACES", () => {
  it("defaults to 1 and allows only 0 or 1", () => {
    expect(FREE_WORKSPACES).toBe(1);
    expect(freeWorkspaceAllowance()).toBe(1);
    expect(freeWorkspaceAllowance(0)).toBe(0);
    expect(freeWorkspaceAllowance(1)).toBe(1);
    expect(() => freeWorkspaceAllowance(2)).toThrow(/0 or 1/);
  });

  it("treats the marked free workspace as free when the allowance is 1", () => {
    const free = workspace({ id: "free", name: "Free", kind: "free", projectFeeStatus: "free" });
    const extra = workspace({ id: "paid-1", name: "Extra", projectFeeStatus: "pending" });
    expect(quoteAdditionalWorkspace([], 1).free).toBe(true);
    expect(quoteAdditionalWorkspace([], 1).monthlyCents).toBe(0);
    expect(quoteAdditionalWorkspace([], 1).performanceAddon).toBe(false);
    expect(quoteAdditionalWorkspace([free], 1)).toMatchObject({ free: false, monthlyCents: WORKSPACE_MONTHLY_CENTS });
    const lock = assessLock([free, extra], NOW, 1);
    expect(lock.unpaidIds).toEqual(["paid-1"]);
    expect(lock.locked).toBe(true);
    expect(performanceAddonAllowed(free, new Set(["free"]))).toBe(false);
  });

  it("charges every workspace when the allowance is 0", () => {
    const free = workspace({ id: "free", name: "Free", kind: "free", projectFeeStatus: "free" });
    expect(quoteAdditionalWorkspace([], 0)).toMatchObject({
      free: false,
      monthlyCents: WORKSPACE_MONTHLY_CENTS,
      feeIsOneTime: false,
      performanceAddon: true,
    });
    const lock = assessLock([free], NOW, 0);
    expect(lock.unpaidIds).toEqual(["free"]);
    expect(lock.locked).toBe(true);
  });
});

describe("lapse and grandfathering", () => {
  const periodEnd = new Date(NOW - 10 * DAY).toISOString();

  it("never lapses a one-time buyer", () => {
    const legacy = workspace({
      id: "legacy",
      name: "Legacy",
      feeIsOneTime: true,
      projectFeeStatus: "paid",
      currentPeriodEnd: periodEnd,
    });
    expect(isGrandfathered(legacy)).toBe(true);
    expect(isLapsed(legacy, NOW, new Set())).toBe(false);
    expect(assessLock([legacy], NOW).locked).toBe(false);
    expect(workspaceMonthlyCents(legacy, new Set())).toBe(0);
  });

  it("treats a live one-time payload without feeIsOneTime as grandfathered", () => {
    const paid = workspace({ id: "once", name: "Once", projectFeeStatus: "paid" });
    expect(isGrandfathered(paid)).toBe(true);
    expect(isLapsed(paid, NOW, new Set())).toBe(false);
  });

  it("keeps access through the 3-day grace and locks after it", () => {
    const end = new Date(NOW - 2 * DAY).toISOString();
    const recurring = workspace({
      id: "sub",
      name: "Sub",
      feeIsOneTime: false,
      projectFeeStatus: "paid",
      workspaceSubscriptionId: "sub_123",
      currentPeriodEnd: end,
    });
    expect(isLapsed(recurring, NOW, new Set())).toBe(false);
    expect(assessLock([recurring], NOW).locked).toBe(false);

    const expired = { ...recurring, currentPeriodEnd: new Date(NOW - 4 * DAY).toISOString() };
    const lock = assessLock([expired], NOW);
    expect(isLapsed(expired, NOW, new Set())).toBe(true);
    expect(lock.lapsedIds).toEqual(["sub"]);
    expect(lock.unpaidIds).toEqual(["sub"]);
    expect(lock.locked).toBe(true);
    expect(lock.uploadsBlocked).toBe(true);
    expect(lock.downloadsAllowed).toBe(true);
    expect(lock.readable).toBe(true);
    expect(lock.normalUseBlocked).toBe(true);
  });
});

describe("caps", () => {
  it("uses 10 until a project has 2 TB and Turbo, then 20", () => {
    expect(MAX_WORKSPACES_BASE).toBe(10);
    expect(MAX_WORKSPACES_HIGH).toBe(20);
    const small = workspace({
      id: "small",
      name: "Small",
      feeIsOneTime: true,
      projectFeeStatus: "paid",
      storageActive: true,
      storageTier: "100GB",
      performanceActive: true,
      performanceTier: "turbo",
    });
    expect(qualifiesForHigherLimit(small)).toBe(false);
    expect(workspaceCap([small])).toBe(10);

    const qualified = workspace({
      id: "big",
      name: "Big",
      feeIsOneTime: true,
      projectFeeStatus: "paid",
      projectBillingVersion: 2,
      storageActive: true,
      storageTier: "2TB",
      storageMode: "standard",
      performanceActive: true,
      performanceTier: "turbo",
    });
    expect(qualifiesForHigherLimit(qualified)).toBe(true);
    expect(workspaceCap([qualified])).toBe(20);

    const bundle = { ...qualified, id: "bundle", storageMode: "bundle" as const, performanceActive: false, performanceTier: null };
    expect(qualifiesForHigherLimit(bundle)).toBe(true);
  });

  it("locks on downgrade instead of keeping the old cap", () => {
    const crowd = Array.from({ length: 12 }, (_, index) => workspace({
      id: `w${index}`,
      name: `Workspace ${index}`,
      feeIsOneTime: true,
      projectFeeStatus: "paid",
      storageActive: true,
      storageTier: index === 0 ? "2TB" : "100GB",
      storageMode: "standard",
      performanceActive: index === 0,
      performanceTier: index === 0 ? "turbo" : null,
      projectBillingVersion: 2,
    }));
    expect(assessLock(crowd, NOW).locked).toBe(false);
    expect(assessLock(crowd, NOW).cap).toBe(20);

    const downgraded = crowd.map((item) => item.id === "w0"
      ? { ...item, storageTier: "100GB", performanceTier: "lite" }
      : item);
    const lock = assessLock(downgraded, NOW);
    expect(lock.cap).toBe(10);
    expect(lock.overCap).toBe(true);
    expect(lock.locked).toBe(true);
    expect(lock.uploadsBlocked).toBe(true);
    expect(lock.downloadsAllowed).toBe(true);
  });

  it("bills BYO and managed workspaces the same monthly fee", () => {
    const managed = workspace({ id: "m", name: "Managed", feeIsOneTime: false, projectFeeStatus: "pending" });
    const byo = workspace({
      id: "b",
      name: "BYO",
      kind: "byo",
      feeIsOneTime: false,
      projectFeeStatus: "pending",
      storage: { kind: "byo", storageTier: null, provider: "r2", endpoint: "https://example", bucketFingerprint: "abc" },
    });
    expect(workspaceMonthlyCents(managed, new Set())).toBe(WORKSPACE_MONTHLY_CENTS);
    expect(workspaceMonthlyCents(byo, new Set())).toBe(workspaceMonthlyCents(managed, new Set()));
    expect(performanceAddonAllowed(byo, new Set())).toBe(true);
  });
});
