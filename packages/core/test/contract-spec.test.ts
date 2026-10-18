/**
 * QA contract spec for packages/core (Morgan). Locked contract, Oct 17 2026.
 *
 * Billing math (caps, FREE_WORKSPACES, $5 fee, lapse at paidThroughMs + 3 days,
 * grandfathering) is decided by the SERVER ONLY. These tests do not re-implement
 * it; they check that core reflects what the server returns.
 *
 * Every case here is required. None of them are expected failures.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import sortMap from "../data/sort-map.json";
import * as core from "../src/index.js";
import {
  ApiError,
  GenDragoonClient,
  MemorySecretStore,
  REAUTH_WINDOW_MS,
  WorkspaceLockedError,
  accountFromAssessment,
  applyApiFailure,
  applySortOverride,
  byoErrorMessage,
  byoSecretId,
  categorize,
  deleteAccountAndWipe,
  hidesWorkspaceExistence,
  isLaunchProvider,
  planMerge,
  planIncomingPath,
  reauthIsRecent,
  storageOperations,
  viewAfterFailure,
  workspaceKeyId,
} from "../src/index.js";
import { listServerFixtures, loadServerFixture } from "./fixtures/server/load.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const clientReturning = (status: number, body: unknown, seen: string[] = []) =>
  new GenDragoonClient({
    baseUrl: "https://api.example.test",
    getToken: () => "test-token",
    fetch: async (input, init) => {
      seen.push(`${init?.method ?? "GET"} ${String(input)}`);
      return json(status, body);
    },
  });
const ready = { phase: "ready", reason: "clear" } as const;

describe("sort-map.json: one shared map", () => {
  it("is the single map core uses and is exported for every client", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.exports["./sort-map.json"]).toBe("./data/sort-map.json");
    expect(readFileSync(new URL("../src/sorting.ts", import.meta.url), "utf8")).toContain('from "../data/sort-map.json"');
    expect(core.SORT_CATEGORIES).toEqual(sortMap.categories);
  });
  it("has a Videos category and every mapped value is a declared category", () => {
    expect(sortMap.categories).toContain("Videos");
    for (const v of [...Object.values(sortMap.extensions), ...Object.values(sortMap.mimeTypes)])
      expect(sortMap.categories).toContain(v);
  });
  // Casey F7: clients disagreed on mp4, 3gp, heif, raw, bmp, opus, aif.
  it.each([
    ["clip.mp4", "Videos"],
    ["photo.heif", "Pictures"],
    ["photo.raw", "Pictures"],
    ["photo.bmp", "Pictures"],
    ["voice.opus", "Audio"],
    ["track.aif", "Audio"],
  ])("Casey F7 type %s resolves to exactly one category (%s)", (name, cat) => {
    expect(categorize({ name })).toBe(cat);
    expect(categorize({ name: name.toUpperCase() })).toBe(cat);
  });
  it("TODO(contract): Casey F7 type .3gp resolves to Videos (missing from sort-map.json, falls to Other)", () => {
    expect(categorize({ name: "phone.3gp" })).toBe("Videos");
  });
  it("Settings override takes precedence over the shared map", () => {
    const o = applySortOverride({}, { extension: "mp4", category: "Documents" });
    expect(categorize({ name: "clip.mp4" }, o)).toBe("Documents");
    expect(categorize({ name: "other.mov" }, o)).toBe("Videos");
  });
  it("unknown extension and dotless names fall back to the default category", () => {
    expect(categorize({ name: "thing.zzqx" })).toBe(sortMap.defaultCategory);
    expect(categorize({ name: "mp3" })).toBe(sortMap.defaultCategory); // Casey F8: dotless name is not an extension
  });
});

describe("server-decided plan and lock are reflected, not recomputed", () => {
  it("client.access() passes server plan fields through unchanged", async () => {
    const seen: string[] = [];
    const body = { locked: false, cap: 20, activeCount: 13, overCap: false, unpaidIds: [], lapsedIds: [],
      readable: true, downloadsAllowed: true, uploadsBlocked: false, normalUseBlocked: false };
    const res = await clientReturning(200, body, seen).access();
    expect(res).toMatchObject({ cap: 20, activeCount: 13, locked: false });
    expect(seen).toEqual(["GET https://api.example.test/v2/access"]);
  });
  it("lock state follows the server flag even when counts look over the cap", () => {
    expect(accountFromAssessment({ locked: false, overCap: false, unpaidIds: [] })).toEqual(ready);
    expect(accountFromAssessment({ locked: true, overCap: true, unpaidIds: [] })).toEqual({ phase: "delete_or_merge", reason: "over_cap" });
    expect(accountFromAssessment({ locked: true, overCap: false, unpaidIds: ["w2"] })).toEqual({ phase: "delete_or_merge", reason: "unpaid" });
  });
  it("TODO(contract): core exposes a plan summary (used/limit, paid-through/renewal date, locked) taken verbatim from the server", () => {
    const summarize = (core as Record<string, unknown>).planSummary as ((x: unknown) => unknown) | undefined;
    expect(typeof summarize).toBe("function");
    expect(summarize!({ cap: 10, activeCount: 4, locked: false, paidThroughMs: 1_800_000_000_000 }))
      .toMatchObject({ used: 4, limit: 10, locked: false, paidThroughMs: 1_800_000_000_000 });
  });
});

describe("423 workspace_lock maps to the delete/merge lock screen", () => {
  const locks = listServerFixtures().filter((item) => item.area === "workspace-lock");
  for (const [label, call] of [
    ["create upload", (c: GenDragoonClient) => c.createUpload("w1", { name: "a.bin", sizeBytes: 1 } as never)],
    ["chunk", (c: GenDragoonClient) => c.uploadChunk("w1", "u1", 0, new Uint8Array([1]), "0".repeat(64))],
    ["finalize", (c: GenDragoonClient) => c.finalizeUpload("w1", "u1")],
  ] as const) {
    for (const lock of locks) {
      it(`a 423 ${lock.name} on ${label} becomes WorkspaceLockedError and enters delete_or_merge`, async () => {
        const body = lock.fixture.response.body as { reason: string; overBy: number; unpaidWorkspaceIds: string[] };
        const err = await call(clientReturning(lock.fixture.response.status, body)).catch((e) => e);
        expect(err).toBeInstanceOf(WorkspaceLockedError);
        expect(err).toMatchObject({ reason: body.reason, overBy: body.overBy, unpaidWorkspaceIds: body.unpaidWorkspaceIds });
        expect(applyApiFailure(ready, err).phase).toBe("delete_or_merge");
        expect(viewAfterFailure("files", err)).toBe("workspaces");
      });
    }
  }
  it("reads and downloads stay allowed while locked; uploads are refused client-side", () => {
    expect(storageOperations({ intent: "download", oid: "f1", locked: true }).operations).toEqual([{ op: "download", oid: "f1" }]);
    expect(() => storageOperations({ intent: "upload", oid: "f1", sizeBytes: 1, locked: true })).toThrow(WorkspaceLockedError);
    const notLock = new ApiError(500, "REQUEST_FAILED", "x");
    expect(applyApiFailure(ready, notLock)).toEqual(ready);
  });
});

describe("ownership: another account's workspace is 404", () => {
  it("404 PROJECT_NOT_FOUND from the ownership fixture surfaces as NOT_FOUND", async () => {
    const fixture = loadServerFixture("ownership", "foreign-workspace");
    const err = await clientReturning(fixture.response.status, fixture.response.body).getProject("other").catch((e) => e);
    expect(err).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(hidesWorkspaceExistence(err)).toBe(true);
  });

  // PENDING FIXTURE: Riley's ownership export has 404 PROJECT_NOT_FOUND only.
  // The legacy 403 PROJECT_FORBIDDEN body is not a server fixture.
  it("PENDING FIXTURE: legacy 403 PROJECT_FORBIDDEN still hides existence", async () => {
    const err = await clientReturning(403, { error: "Project access denied", code: "PROJECT_FORBIDDEN" }).getProject("other").catch((e) => e);
    expect(err).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(hidesWorkspaceExistence(err)).toBe(true);
  });
});

describe("merge naming", () => {
  it("never overwrites: collisions become 'name (from <source>)' then numbered", () => {
    const plan = planMerge([{ path: "a.txt" }, { path: "a.txt" }, { path: "b.txt" }], "Old Stuff", ["a.txt", "a.txt (from Old Stuff)"]);
    expect(plan.map((p) => p.targetPath)).toEqual(["a.txt (from Old Stuff) 2", "a.txt (from Old Stuff) 3", "b.txt"]);
    expect(planIncomingPath("new.txt", "S", new Set(["a.txt"]))).toBe("new.txt");
  });
});

// PENDING FIXTURE: deletion responses come from Morgan's PR #6 shapes until that area is exported.
describe("delete account: DELETE /v2/account", () => {
  it("sends DELETE /v2/account and returns the 202 job id", async () => {
    const seen: string[] = [];
    const res = await clientReturning(202, { jobId: "job-1", status: "accepted" }, seen)
      .deleteAccount({ reauthenticatedAt: new Date().toISOString() });
    expect(res.jobId).toBe("job-1");
    expect(seen).toEqual(["DELETE https://api.example.test/v2/account"]);
  });
  it("TODO(contract): re-auth window is 5 minutes (currently 1 hour; Avery's follow-up push)", () => {
    expect(REAUTH_WINDOW_MS).toBe(5 * 60 * 1000);
    const now = Date.now();
    expect(reauthIsRecent(new Date(now - 4 * 60_000).toISOString(), now)).toBe(true);
    expect(reauthIsRecent(new Date(now - 6 * 60_000).toISOString(), now)).toBe(false);
  });
  it("stale re-auth is refused before any request or local wipe", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(workspaceKeyId("w1"), new Uint8Array([1]));
    let calls = 0;
    const client = { deleteAccount: async () => { calls++; return { jobId: "j" }; }, deletionStatus: async () => { calls++; return { jobId: "j", status: "done" as const }; } };
    await expect(deleteAccountAndWipe({ client, reauthenticatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), workspaceIds: ["w1"], secrets }))
      .rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(0);
    expect(await secrets.get(workspaceKeyId("w1"))).not.toBeNull();
  });
  it("clears local workspace keys and saved BYO cloud keys", async () => {
    const secrets = new MemorySecretStore();
    for (const id of ["w1", "b1"]) { await secrets.set(workspaceKeyId(id), new Uint8Array([1])); await secrets.set(byoSecretId(id), new Uint8Array([2])); }
    const client = { deleteAccount: async () => ({ jobId: "j" }), deletionStatus: async () => ({ jobId: "j", status: "done" as const }) };
    await deleteAccountAndWipe({ client, reauthenticatedAt: new Date().toISOString(), workspaceIds: ["w1", "b1"], secrets });
    for (const id of ["w1", "b1"]) { expect(await secrets.get(workspaceKeyId(id))).toBeNull(); expect(await secrets.get(byoSecretId(id))).toBeNull(); }
  });
  it("TODO(contract): deletion job is polled until it finishes (core reads status once today)", async () => {
    const states = ["accepted", "running", "done"] as const;
    let i = 0;
    const client = { deleteAccount: async () => ({ jobId: "j" }), deletionStatus: async () => ({ jobId: "j", status: states[Math.min(i++, 2)] ?? "done" }) };
    const res = await deleteAccountAndWipe({ client, reauthenticatedAt: new Date().toISOString(), workspaceIds: [], secrets: new MemorySecretStore() });
    expect(res.status).toBe("done");
  });
});

describe("BYO connect: S3-compatible only at launch", () => {
  it("S3-compatible providers are accepted", () => {
    for (const id of ["aws", "r2", "b2", "wasabi", "minio", "gcs-s3"]) expect(isLaunchProvider(id)).toBe(true);
    for (const id of ["azure-blob", "webdav"]) expect(isLaunchProvider(id)).toBe(false);
  });
  it("TODO(contract): SFTP is 'Coming soon', not a launch provider (Avery's follow-up push)", () => {
    expect(isLaunchProvider("sftp")).toBe(false);
  });
  it("422 byo_provider_unsupported from the register fixture maps to the coming-soon message", async () => {
    const fixture = loadServerFixture("byo", "provider-unsupported");
    const unsupported = await clientReturning(fixture.response.status, fixture.response.body)
      .registerByo("b1", fixture.request.body as { provider: string; endpoint: string; bucketFingerprint: string })
      .catch((e) => e);
    expect(byoErrorMessage(unsupported)).toMatch(/coming soon|not supported/i);
  });

  // PENDING FIXTURE: 409 byo_unverifiable is not in Riley's BYO export.
  it("PENDING FIXTURE: 409 byo_unverifiable keeps the fallback verification message", () => {
    expect(byoErrorMessage(new ApiError(409, "byo_unverifiable", "x"))).toMatch(/verif/i);
  });
});
