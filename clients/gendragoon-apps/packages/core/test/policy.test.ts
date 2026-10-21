import { describe, expect, it } from "vitest";
import { planSummary } from "../src/index.js";

describe("plan summary", () => {
  it("copies the server plan and does not invent fields the server omitted", () => {
    expect(planSummary({ cap: 10, activeCount: 4, locked: false, paidThroughMs: 1_800_000_000_000 })).toEqual({
      used: 4,
      limit: 10,
      locked: false,
      paidThroughMs: 1_800_000_000_000,
    });
    expect(planSummary({
      cap: 20,
      activeCount: 13,
      locked: true,
      renewsAtMs: 1_900_000_000_000,
      lifetime: true,
    })).toEqual({
      used: 13,
      limit: 20,
      locked: true,
      renewsAtMs: 1_900_000_000_000,
      lifetime: true,
    });
    const bare = planSummary({ cap: 10, activeCount: 1, locked: false });
    expect(bare).toEqual({ used: 1, limit: 10, locked: false });
    expect(bare).not.toHaveProperty("paidThroughMs");
    expect(bare).not.toHaveProperty("renewsAtMs");
    expect(bare).not.toHaveProperty("lifetime");
  });
});
