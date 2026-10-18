/**
 * Workspace prices from gendragoon-cloud-ssd PR #5 @ 568f223.
 * `grandfathered-plus-new` is included when that fixture is in the export.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GenDragoonClient, WorkspaceLockedError, parseWorkspacePrice, workspacePriceLabel } from "../src/index.js";
import { loadServerFixture } from "./fixtures/server/load.js";

const REQUIRED = [
  "free-first",
  "byo-first-paid",
  "second-paid",
  "delete-free-then-create",
  "free-to-byo-billable",
  "concurrent-create-one-free",
  "list-byo-only",
  "list-hosted-plus-byo",
] as const;

function pricedFixtures(): string[] {
  const names: string[] = [...REQUIRED];
  const extra = new URL("./fixtures/server/workspaces/grandfathered-plus-new.json", import.meta.url);
  if (existsSync(extra)) names.push("grandfathered-plus-new");
  return names;
}

function carriers(body: unknown): Record<string, unknown>[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const found: Record<string, unknown>[] = [];
  if (Array.isArray(record.workspaces)) found.push(...record.workspaces as Record<string, unknown>[]);
  if (Array.isArray(record.projects)) found.push(...record.projects as Record<string, unknown>[]);
  if (record.project && typeof record.project === "object") found.push(record.project as Record<string, unknown>);
  if (typeof record.isFree === "boolean" || typeof record.monthlyPriceCents === "number") found.push(record);
  return found;
}

describe("workspace prices pass through the server fixtures", () => {
  for (const name of pricedFixtures()) {
    it(`${name} keeps isFree, monthlyPriceCents, and grandfathered`, () => {
      const fixture = loadServerFixture("workspaces", name);
      const rows = carriers(fixture.response.body);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const before = structuredClone(row);
        const price = parseWorkspacePrice(row);
        expect(row).toEqual(before);
        expect(price.isFree).toBe(row.isFree);
        expect(price.monthlyPriceCents).toBe(row.monthlyPriceCents);
        expect(price.grandfathered).toBe(row.grandfathered === true);
        expect(price.monthlyPriceCents === 0).toBe(price.isFree || price.grandfathered);
        if (price.isFree) expect(workspacePriceLabel(price)).toBe("Free");
        else if (price.grandfathered) expect(workspacePriceLabel(price)).toBe("Included");
        else expect(workspacePriceLabel(price)).toBe(`$${(price.monthlyPriceCents / 100).toFixed(2)}`);
      }
    });
  }

  it("defaults a missing grandfathered flag to false and leaves the payload alone", () => {
    const raw = { isFree: false, monthlyPriceCents: 500 };
    const price = parseWorkspacePrice(raw);
    expect(price).toEqual({ isFree: false, monthlyPriceCents: 500, grandfathered: false });
    expect(raw).toEqual({ isFree: false, monthlyPriceCents: 500 });
    expect(workspacePriceLabel(price)).toBe("$5.00");
  });

  it("labels Free only for isFree, Included for grandfathered, and formats every other cent amount", () => {
    expect(workspacePriceLabel({ isFree: true, grandfathered: true, monthlyPriceCents: 0 })).toBe("Free");
    expect(workspacePriceLabel({ isFree: false, grandfathered: true, monthlyPriceCents: 0 })).toBe("Included");
    expect(workspacePriceLabel({ isFree: false, grandfathered: false, monthlyPriceCents: 500 })).toBe("$5.00");
    expect(workspacePriceLabel({ isFree: false, monthlyPriceCents: 0 })).toBe("$0.00");
    expect(workspacePriceLabel({ isFree: false, grandfathered: false, monthlyPriceCents: 1250 })).toBe("$12.50");
  });

  it("refuses to invent isFree or monthlyPriceCents when the server omitted them", () => {
    expect(() => parseWorkspacePrice({ monthlyPriceCents: 0, grandfathered: true })).toThrow(/isFree/);
    expect(() => parseWorkspacePrice({ isFree: false })).toThrow(/monthlyPriceCents/);
    expect(() => parseWorkspacePrice({ isFree: false, monthlyPriceCents: 1.5 })).toThrow(/monthlyPriceCents/);
  });

  it("a 423 lapsed write is WorkspaceLockedError with the server reason and unpaid ids", async () => {
    const fixture = loadServerFixture("workspace-lock", "lapsed");
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "fixture-token",
      fetch: async () => new Response(JSON.stringify(fixture.response.body), {
        status: fixture.response.status,
        headers: { "content-type": "application/json" },
      }),
    });
    const error = await client.createUpload("11111111-1111-4111-8111-000000000001", {
      name: "blocked.txt",
      sizeBytes: 4,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceLockedError);
    expect(error).toMatchObject({
      status: 423,
      code: "workspace_lock",
      reason: "lapsed",
      overBy: 0,
      unpaidWorkspaceIds: ["11111111-1111-4111-8111-000000000001"],
    });
  });
});
