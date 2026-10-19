import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { UpdateController, parseReleaseManifest, type ReleaseManifest, type UpdateState } from "../src/index.js";

const bytes = new TextEncoder().encode("installer-bytes-v2");
const goodSha = createHash("sha256").update(bytes).digest("hex");

function manifest(version = "0.2.0", sha256 = goodSha): ReleaseManifest {
  return parseReleaseManifest({ version, url: "https://example.test/Setup.exe", sha256, notes: "n", channel: "stable" });
}

function harness(over: Partial<ConstructorParameters<typeof UpdateController>[0]> = {}) {
  const states: UpdateState[] = [];
  const calls: string[] = [];
  const controller = new UpdateController({
    currentVersion: "0.1.0",
    loadManifests: async () => [manifest()],
    download: async (_m, onProgress) => {
      onProgress({ receivedBytes: 0, totalBytes: bytes.length });
      onProgress({ receivedBytes: bytes.length / 2, totalBytes: bytes.length });
      onProgress({ receivedBytes: bytes.length, totalBytes: bytes.length });
      return bytes;
    },
    install: async (m) => {
      calls.push("install");
      return { version: m.version, location: "x" };
    },
    relaunch: async () => {
      calls.push("relaunch");
    },
    onState: (s) => states.push(s),
    now: () => 1000,
    ...over,
  });
  return { controller, states, calls };
}

describe("UpdateController", () => {
  it("runs check -> download (progress) -> verify -> install -> relaunch automatically", async () => {
    const { controller, states, calls } = harness();
    const final = await controller.check({ manual: true });
    expect(states.map((s) => s.status)).toEqual([
      "checking", "available", "downloading", "downloading", "downloading", "verifying", "ready", "installing", "relaunching",
    ]);
    const mid = states.filter((s) => s.status === "downloading").map((s) => (s as { percent: number | null }).percent);
    expect(mid).toEqual([0, 50, 100]);
    expect(calls).toEqual(["install", "relaunch"]);
    expect(final.status).toBe("relaunching");
  });

  it("reports up_to_date when the feed has nothing newer, and never downgrades", async () => {
    const same = harness({ loadManifests: async () => [manifest("0.1.0")] });
    expect((await same.controller.check({ manual: true })).status).toBe("up_to_date");
    const older = harness({ loadManifests: async () => [manifest("0.0.9")] });
    expect((await older.controller.check()).status).toBe("up_to_date");
    expect(older.calls).toEqual([]);
    const empty = harness({ loadManifests: async () => [] });
    const s = await empty.controller.check();
    expect(s).toEqual({ status: "up_to_date", currentVersion: "0.1.0", checkedAt: 1000 });
  });

  it("a feed error becomes a clear error state, and the next check works again", async () => {
    let fail = true;
    const { controller } = harness({
      loadManifests: async () => {
        if (fail) throw new Error("GitHub releases request failed (429)");
        return [];
      },
    });
    const first = await controller.check({ manual: true });
    expect(first).toMatchObject({ status: "error", stage: "check" });
    expect((first as { message: string }).message).toMatch(/rate limiting/);
    fail = false;
    expect((await controller.check({ manual: true })).status).toBe("up_to_date");
  });

  it("a checksum mismatch never installs or relaunches", async () => {
    const { controller, calls } = harness({ loadManifests: async () => [manifest("0.2.0", "b".repeat(64))] });
    const s = await controller.check();
    expect(s).toMatchObject({ status: "error", stage: "verify" });
    expect(calls).toEqual([]);
  });

  it("a download failure and an install failure are reported, with no relaunch", async () => {
    const dl = harness({ download: async () => { throw new Error("Download failed (500)"); } });
    expect(await dl.controller.check()).toMatchObject({ status: "error", stage: "download" });
    const inst = harness({ install: async () => { throw new Error("Installer exited 2"); } });
    expect(await inst.controller.check()).toMatchObject({ status: "error", stage: "install" });
    expect(inst.calls).toEqual([]);
  });

  it("defers while an upload is active and installs when it ends", async () => {
    let active = true;
    const { controller, calls } = harness({ transferActive: () => active });
    expect((await controller.check()).status).toBe("deferred");
    expect(calls).toEqual([]);
    expect((await controller.resumeIfIdle()).status).toBe("deferred");
    active = false;
    expect((await controller.resumeIfIdle()).status).toBe("relaunching");
    expect(calls).toEqual(["install", "relaunch"]);
  });

  it("joins a running check instead of starting a second one (double click)", async () => {
    const load = vi.fn(async () => [] as ReleaseManifest[]);
    const { controller } = harness({ loadManifests: load });
    await Promise.all([controller.check({ manual: true }), controller.check({ manual: true })]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not offer a version that was just rolled back", async () => {
    const { controller, calls } = harness({ rolledBackVersion: async () => "0.2.0" });
    expect((await controller.check()).status).toBe("up_to_date");
    expect(calls).toEqual([]);
  });

  it("autoInstall:false stops at available", async () => {
    const { controller, calls } = harness({ autoInstall: false });
    expect(await controller.check()).toMatchObject({ status: "available", version: "0.2.0" });
    expect(calls).toEqual([]);
  });
});
