/**
 * Simulated update feed on loopback: a fake GitHub releases API plus an "installer" file.
 * Exercises the real feed parsing, streaming download with progress, SHA-256 check,
 * detached installer start (a shell script that records its args and "relaunches"), and the controller.
 */
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UpdateController, downloadWithProgress, fetchReleaseManifests, startInstallerDetached, type UpdateState } from "../src/index.js";

let server: Server;
let base = "";
let dir = "";
let installerScript = "";
const installer = Buffer.from(`#!/bin/sh\necho "$@" > "${"__MARK__"}.args"\necho relaunched > "${"__MARK__"}.relaunched"\n`);
let installerBytes = Buffer.alloc(0);

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "gd-feed-"));
  installerBytes = Buffer.from(installer.toString().replaceAll("__MARK__", path.join(dir, "mark")));
  const sha = createHash("sha256").update(installerBytes).digest("hex");
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/repos/o/r/releases")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([
        { tag_name: "v0.2.0", prerelease: false, body: "Local test release", assets: [
          { name: "Setup-0.2.0.exe", browser_download_url: `${base}/dl/Setup-0.2.0.exe` },
          { name: "SHA256SUMS", browser_download_url: `${base}/dl/SHA256SUMS` },
        ] },
        { tag_name: "v0.1.0", prerelease: false, assets: [] },
      ]));
    } else if (url === "/dl/SHA256SUMS") {
      res.end(`${sha}  Setup-0.2.0.exe\n`);
    } else if (url === "/dl/Setup-0.2.0.exe") {
      res.setHeader("content-length", String(installerBytes.length));
      // Send in two writes so progress reports more than one chunk.
      res.write(installerBytes.subarray(0, 10));
      setTimeout(() => res.end(installerBytes.subarray(10)), 20);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  installerScript = path.join(dir, "Setup.sh");
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("local simulated update feed", () => {
  it("full cycle: feed -> progress download -> verify -> detached installer with --force-run -> relaunch", async () => {
    const states: UpdateState[] = [];
    const controller = new UpdateController({
      currentVersion: "0.1.0",
      loadManifests: () => fetchReleaseManifests({ repo: "o/r", assetPattern: "\\.exe$", apiBase: base, channel: "stable" }),
      download: (m, onProgress) => downloadWithProgress(m.url, onProgress),
      install: async (m, bytes) => {
        await writeFile(installerScript, bytes);
        await chmod(installerScript, 0o755);
        await startInstallerDetached(installerScript);
        return { version: m.version, location: installerScript };
      },
      relaunch: async () => undefined,
      onState: (s) => states.push(s),
    });
    const final = await controller.check({ manual: true });
    expect(final.status).toBe("relaunching");
    expect(states.some((s) => s.status === "downloading" && s.percent === 100)).toBe(true);
    // The "installer" ran detached and was handed the flags that make NSIS restart the app.
    for (let i = 0; i < 50; i += 1) {
      try { await readFile(path.join(dir, "mark.relaunched")); break; } catch { await new Promise((r) => setTimeout(r, 20)); }
    }
    expect((await readFile(path.join(dir, "mark.args"), "utf8")).trim()).toBe("/S --updated --force-run");
    expect((await readFile(path.join(dir, "mark.relaunched"), "utf8")).trim()).toBe("relaunched");
  });

  it("a tampered installer on the feed is rejected before anything runs", async () => {
    const controller = new UpdateController({
      currentVersion: "0.1.0",
      loadManifests: () => fetchReleaseManifests({ repo: "o/r", assetPattern: "\\.exe$", apiBase: base, channel: "stable" }),
      download: async (m, onProgress) => {
        const real = await downloadWithProgress(m.url, onProgress);
        const bad = new Uint8Array(real);
        bad[0] = (bad[0] ?? 0) ^ 0xff;
        return bad;
      },
      install: async () => { throw new Error("must not install"); },
      relaunch: async () => { throw new Error("must not relaunch"); },
    });
    expect(await controller.check({ manual: true })).toMatchObject({ status: "error", stage: "verify" });
  });

  it("a 404 download and a refused apiBase are clean errors", async () => {
    await expect(downloadWithProgress(`${base}/nope`, () => undefined)).rejects.toThrow(/404/);
    await expect(fetchReleaseManifests({ repo: "o/r", assetPattern: "x", apiBase: "http://evil.example" })).rejects.toThrow(/apiBase/);
  });
});
