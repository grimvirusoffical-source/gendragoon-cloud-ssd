import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { UpdateState } from "@gendragoon/updater";
import { createDesktopUpdater, feedFromEnv } from "../src/main/updater-service.js";

const installerBytes = new TextEncoder().encode("MZ-fake-installer");
const sha = createHash("sha256").update(installerBytes).digest("hex");

/** A mock GitHub releases feed. */
function mockFetch(version: string, opts: { sha?: string; failDownload?: boolean } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/releases")) {
      return new Response(JSON.stringify([{ tag_name: `v${version}`, prerelease: false, body: "notes", assets: [
        { name: "GenDragoon-Cloud-SSD-Setup.exe", browser_download_url: "https://example.test/Setup.exe" },
        { name: "SHA256SUMS", browser_download_url: "https://example.test/SHA256SUMS" },
      ] }]));
    }
    if (url.endsWith("SHA256SUMS")) return new Response(`${opts.sha ?? sha}  GenDragoon-Cloud-SSD-Setup.exe\n`);
    if (opts.failDownload) return new Response("", { status: 500 });
    return new Response(installerBytes, { headers: { "content-length": String(installerBytes.length) } });
  }) as typeof fetch;
}

async function setup(over: { version?: string; feedVersion?: string; sha?: string; transfer?: boolean; platform?: NodeJS.Platform; failDownload?: boolean } = {}) {
  const userData = await mkdtemp(path.join(tmpdir(), "gd-desktop-"));
  const states: UpdateState[] = [];
  const log: string[] = [];
  let transfer = over.transfer ?? false;
  const updater = createDesktopUpdater({
    userData,
    version: over.version ?? "0.1.0",
    platform: over.platform ?? "win32",
    send: (s) => states.push(s),
    quit: () => { log.push("quit"); },
    transferActive: () => transfer,
    fetch: mockFetch(over.feedVersion ?? "0.2.0", { sha: over.sha, failDownload: over.failDownload }),
    startInstaller: async (file) => { log.push(`installer:${path.basename(file)}`); },
    feed: { repo: "o/r", assetPattern: "\\.exe$", channel: "stable" },
  });
  return { updater, userData, states, log, setTransfer: (v: boolean) => { transfer = v; } };
}

describe("desktop updater service (mock feed)", () => {
  it("manual check downloads, verifies, writes the pending marker BEFORE starting the installer, then quits", async () => {
    const { updater, userData, states, log } = await setup();
    const final = await updater.check(true);
    expect(final.status).toBe("relaunching");
    expect(states.map((s) => s.status)).toContain("downloading");
    expect(log).toEqual(["installer:GenDragoon-Cloud-SSD-Setup-0.2.0.exe", "quit"]);
    const pending = JSON.parse(await readFile(path.join(userData, "pending-update.json"), "utf8"));
    expect(pending.version).toBe("0.2.0");
    expect((await readFile(pending.location)).equals(Buffer.from(installerBytes))).toBe(true);
  });

  it("up to date: no installer, no quit, clear state", async () => {
    const { updater, log } = await setup({ feedVersion: "0.1.0" });
    expect((await updater.check(true)).status).toBe("up_to_date");
    expect(log).toEqual([]);
  });

  it("bad checksum: error state, nothing runs, no pending marker", async () => {
    const { updater, log, userData } = await setup({ sha: "c".repeat(64) });
    expect(await updater.check(true)).toMatchObject({ status: "error", stage: "verify" });
    expect(log).toEqual([]);
    await expect(readFile(path.join(userData, "pending-update.json"))).rejects.toThrow();
  });

  it("download failure is a clear error", async () => {
    const { updater } = await setup({ failDownload: true });
    expect(await updater.check(true)).toMatchObject({ status: "error", stage: "download" });
  });

  it("installer that cannot start clears the marker and reports an install error", async () => {
    const userData = await mkdtemp(path.join(tmpdir(), "gd-desktop-"));
    const updater = createDesktopUpdater({
      userData, version: "0.1.0", platform: "win32", send: () => undefined, quit: () => { throw new Error("must not quit"); },
      transferActive: () => false, fetch: mockFetch("0.2.0"), feed: { repo: "o/r", assetPattern: "\\.exe$", channel: "stable" },
      startInstaller: async () => { throw new Error("spawn EACCES"); },
    });
    expect(await updater.check(true)).toMatchObject({ status: "error", stage: "install" });
    await expect(readFile(path.join(userData, "pending-update.json"))).rejects.toThrow();
  });

  it("defers during an upload/backup and installs when the transfer ends", async () => {
    const { updater, log, setTransfer } = await setup({ transfer: true });
    expect((await updater.check(false)).status).toBe("deferred");
    expect(log).toEqual([]);
    setTransfer(false);
    expect((await updater.onTransferIdle()).status).toBe("relaunching");
    expect(log).toEqual(["installer:GenDragoon-Cloud-SSD-Setup-0.2.0.exe", "quit"]);
  });

  it("non-Windows: reports the update and its download link instead of silently installing", async () => {
    const { updater, log } = await setup({ platform: "linux" });
    expect(await updater.check(true)).toMatchObject({ status: "available", version: "0.2.0", url: "https://example.test/Setup.exe" });
    expect(log).toEqual([]);
  });

  it("settleOnLaunch keeps a healthy update (marker cleared, previous installer remembered)", async () => {
    const { updater, userData } = await setup();
    await updater.check(true);
    const outcome = await updater.settleOnLaunch(async () => true);
    expect(outcome).toBe("healthy");
    await expect(readFile(path.join(userData, "pending-update.json"))).rejects.toThrow();
    expect(await readFile(path.join(userData, "previous-installer.txt"), "utf8")).toContain("Setup-0.2.0.exe");
  });

  it("settleOnLaunch rolls back an unhealthy update: reinstalls the previous installer, remembers the version, quits", async () => {
    const { updater, userData, log } = await setup();
    await writeFile(path.join(userData, "previous-installer.txt"), path.join(userData, "installers", "Setup-0.1.0.exe"));
    await updater.check(true);
    log.length = 0;
    expect(await updater.settleOnLaunch(async () => false)).toBe("rolled_back");
    expect(log).toEqual(["installer:Setup-0.1.0.exe", "quit"]);
    expect((await readFile(path.join(userData, "rolled-back-version.txt"), "utf8")).trim()).toBe("0.2.0");
    // And that version is not offered again.
    const again = createDesktopUpdater({
      userData, version: "0.1.0", platform: "win32", send: () => undefined, quit: () => undefined, transferActive: () => false,
      fetch: mockFetch("0.2.0"), feed: { repo: "o/r", assetPattern: "\\.exe$", channel: "stable" }, startInstaller: async () => undefined,
    });
    expect((await again.check(false)).status).toBe("up_to_date");
  });

  it("feedFromEnv reads a local test feed without rebuilding", () => {
    expect(feedFromEnv({}).repo).toBe("grimvirusoffical-source/gendragoon-cloud-ssd");
    expect(feedFromEnv({ GENDRAGOON_UPDATE_REPO: "a/b", GENDRAGOON_UPDATE_API_BASE: "http://127.0.0.1:9" })).toMatchObject({ repo: "a/b", apiBase: "http://127.0.0.1:9" });
  });
});
