/**
 * Workspace prices from gendragoon-cloud-ssd PR #5 @ 0715b1a.
 * List items and create `project` objects always include `grandfathered` and `feeWaived`.
 */
import { describe, expect, it } from "vitest";
import { GenDragoonClient, WorkspaceLockedError, accountFromAssessment, applyApiFailure, parseWorkspacePrice, workspaceAcceptsWrites, workspacePriceLabel } from "../src/index.js";
import { listServerFixtures, loadServerFixture } from "./fixtures/server/load.js";

function workspaceItems(body: unknown): Record<string, unknown>[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const found: Record<string, unknown>[] = [];
  if (Array.isArray(record.workspaces)) found.push(...record.workspaces as Record<string, unknown>[]);
  if (Array.isArray(record.projects)) found.push(...record.projects as Record<string, unknown>[]);
  if (record.project && typeof record.project === "object") found.push(record.project as Record<string, unknown>);
  return found;
}

const workspaceFixtures = listServerFixtures().filter((item) => item.area === "workspaces" && item.fixture.response.status < 400);
const priced = workspaceFixtures.filter((item) => workspaceItems(item.fixture.response.body).length > 0);

describe("workspace prices pass through the server fixtures", () => {
  it("includes every list and create fixture, including grandfathered-plus-new", () => {
    expect(priced.map((item) => item.name).sort()).toEqual([
      "concurrent-create-one-free",
      "create",
      "delete-free-then-create",
      "free-first",
      "grandfathered-plus-new",
      "list",
      "list-byo-only",
      "list-hosted-plus-byo",
      "owner-fee-waived",
      "second-paid",
    ]);
  });

  for (const { name, fixture } of priced) {
    it(`${name} keeps isFree, monthlyPriceCents, and grandfathered`, () => {
      const rows = workspaceItems(fixture.response.body);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const before = structuredClone(row);
        const price = parseWorkspacePrice(row);
        expect(row).toEqual(before);
        expect(price.isFree).toBe(row.isFree);
        expect(price.monthlyPriceCents).toBe(row.monthlyPriceCents);
        expect(price.grandfathered).toBe(row.grandfathered);
        expect(typeof row.feeWaived).toBe("boolean");
        expect(price.feeWaived).toBe(row.feeWaived);
        expect(price.monthlyPriceCents === 0).toBe(price.isFree || price.grandfathered || price.feeWaived);
        if (price.isFree) expect(workspacePriceLabel(price)).toBe("Free");
        else if (price.grandfathered || price.feeWaived) expect(workspacePriceLabel(price)).toBe("Included");
        else expect(workspacePriceLabel(price)).toBe(`$${(price.monthlyPriceCents / 100).toFixed(2)}`);
      }
    });
  }

  it("labels Free only for isFree, Included for grandfathered, and formats every other cent amount", () => {
    expect(workspacePriceLabel({ isFree: true, grandfathered: true, feeWaived: false, monthlyPriceCents: 0 })).toBe("Free");
    expect(workspacePriceLabel({ isFree: false, grandfathered: true, feeWaived: false, monthlyPriceCents: 0 })).toBe("Included");
    expect(workspacePriceLabel({ isFree: false, grandfathered: false, feeWaived: false, monthlyPriceCents: 500 })).toBe("$5.00");
    expect(workspacePriceLabel({ isFree: false, grandfathered: false, feeWaived: false, monthlyPriceCents: 0 })).toBe("$0.00");
    expect(workspacePriceLabel({ isFree: false, grandfathered: false, feeWaived: false, monthlyPriceCents: 1250 })).toBe("$12.50");
    expect(workspacePriceLabel({ isFree: false, grandfathered: false, feeWaived: true, monthlyPriceCents: 0 })).toBe("Included");
    expect(workspacePriceLabel({ isFree: true, grandfathered: false, feeWaived: true, monthlyPriceCents: 0 })).toBe("Free");
  });

  it("refuses to invent feeWaived when the server omitted it", () => {
    const raw = { isFree: false, grandfathered: false, monthlyPriceCents: 500 };
    expect(() => parseWorkspacePrice(raw)).toThrow(/feeWaived/);
    expect(raw).toEqual({ isFree: false, grandfathered: false, monthlyPriceCents: 500 });
  });

  it("BYO register fixtures copy grandfatheringEnded and the price flags", () => {
    for (const name of ["byo-first-paid", "free-to-byo-billable", "byo-register-ends-grandfathered"]) {
      const body = loadServerFixture("workspaces", name).response.body as Record<string, unknown>;
      const before = structuredClone(body);
      const price = parseWorkspacePrice(body);
      expect(body).toEqual(before);
      expect(price.feeWaived).toBe(body.feeWaived);
      expect(price.monthlyPriceCents === 0).toBe(price.isFree || price.grandfathered || price.feeWaived);
      expect(typeof body.grandfatheringEnded).toBe("boolean");
    }
    const ended = loadServerFixture("workspaces", "byo-register-ends-grandfathered").response.body as { grandfatheringEnded: boolean };
    expect(ended.grandfatheringEnded).toBe(true);
  });

  it("copies grandfatheringEnded through a BYO register response", async () => {
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "fixture-token",
      fetch: async () => new Response(JSON.stringify({
        isFree: false,
        monthlyPriceCents: 500,
        grandfatheringEnded: true,
        byoRegistered: true,
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const registered = await client.registerByo("ws", {
      provider: "s3",
      endpoint: "https://bucket.s3.us-east-1.amazonaws.com",
      bucketFingerprint: "ab",
    });
    expect(registered.grandfatheringEnded).toBe(true);
    expect(registered.isFree).toBe(false);
    expect(registered.monthlyPriceCents).toBe(500);
  });

  it("refuses to invent isFree, monthlyPriceCents, or grandfathered", () => {
    expect(() => parseWorkspacePrice({ monthlyPriceCents: 0, grandfathered: true })).toThrow(/isFree/);
    expect(() => parseWorkspacePrice({ isFree: false, grandfathered: false })).toThrow(/monthlyPriceCents/);
    expect(() => parseWorkspacePrice({ isFree: false, monthlyPriceCents: 0 })).toThrow(/grandfathered/);
    expect(() => parseWorkspacePrice({ isFree: false, monthlyPriceCents: 1.5, grandfathered: false })).toThrow(/monthlyPriceCents/);
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
    const state = applyApiFailure(accountFromAssessment({ locked: false, overCap: false, unpaidIds: [] }), error);
    expect(workspaceAcceptsWrites(state, "11111111-1111-4111-8111-000000000001")).toBe(false);
    expect(workspaceAcceptsWrites(state, "11111111-1111-4111-8111-000000000024")).toBe(true);
  });

  it("byo-lapsed locks only that workspace and byo-lapsed-others-open still uploads", async () => {
    const locked = loadServerFixture("workspace-lock", "byo-lapsed");
    const open = loadServerFixture("workspaces", "byo-lapsed-others-open");
    const grace = loadServerFixture("workspaces", "byo-in-grace");
    const lockedId = locked.request.path.split("/")[3] ?? "";
    const openId = open.request.path.split("/")[3] ?? "";
    const graceId = grace.request.path.split("/")[3] ?? "";
    const failing = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "fixture-token",
      fetch: async () => new Response(JSON.stringify(locked.response.body), { status: locked.response.status }),
    });
    const error = await failing.createUpload(lockedId, { name: "blocked.txt", sizeBytes: 4 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceLockedError);
    expect(error).toMatchObject({ reason: "lapsed", unpaidWorkspaceIds: [lockedId] });
    const state = applyApiFailure(accountFromAssessment({ locked: false, overCap: false, unpaidIds: [] }), error);
    expect(state.phase).toBe("ready");
    expect(workspaceAcceptsWrites(state, lockedId)).toBe(false);
    expect(workspaceAcceptsWrites(state, openId)).toBe(true);
    expect(workspaceAcceptsWrites(state, graceId)).toBe(true);

    const openClient = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "fixture-token",
      fetch: async () => new Response(JSON.stringify(open.response.body), { status: open.response.status }),
    });
    await expect(openClient.createUpload(openId, { name: "sibling.txt", sizeBytes: 4 })).resolves.toEqual(open.response.body);
    const graceClient = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "fixture-token",
      fetch: async () => new Response(JSON.stringify(grace.response.body), { status: grace.response.status }),
    });
    await expect(graceClient.createUpload(graceId, { name: "open.txt", sizeBytes: 4 })).resolves.toEqual(grace.response.body);
  });

  it("make-hosted returns the server body, including the demoted checkout", async () => {
    const fixture = loadServerFixture("workspaces", "make-hosted");
    const id = fixture.request.path.split("/")[3] ?? "";
    const client = new GenDragoonClient({
      baseUrl: "https://api.example.test",
      getToken: () => "fixture-token",
      fetch: async () => new Response(JSON.stringify(fixture.response.body), { status: fixture.response.status }),
    });
    await expect(client.makeHosted(id)).resolves.toEqual(fixture.response.body);
  });
});
