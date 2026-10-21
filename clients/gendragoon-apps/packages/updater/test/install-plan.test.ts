import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  HEALTH_WINDOW_MS,
  NSIS_SILENT_ARGS,
  fetchReleaseManifests,
  publicReleaseFeed,
  silentInstallPlan,
  updateWouldLoop,
} from "../src/index.js";

const require = createRequire(import.meta.url);

describe("silent install, health window, and the public feed", () => {
  it("installs with NSIS /S, waits 60s, and does not offer a rolled-back version again", () => {
    const plan = silentInstallPlan("C:\\Users\\me\\Setup.exe");
    expect(NSIS_SILENT_ARGS).toEqual(["/S"]);
    // --force-run restarts the app after a silent install; --updated makes NSIS wait for the exit.
    expect(plan.args).toEqual(["/S", "--updated", "--force-run"]);
    expect(plan.healthWindowMs).toBe(HEALTH_WINDOW_MS);
    expect(HEALTH_WINDOW_MS).toBe(60_000);
    expect(updateWouldLoop("1.2.0", "1.2.0")).toBe(true);
    expect(updateWouldLoop("1.3.0", "1.2.0")).toBe(false);
    expect(publicReleaseFeed().repo).toBe("grimvirusoffical-source/gendragoon-cloud-ssd");
  });

  it("stable public feed skips prereleases and assets with no sha256, and sends no token", async () => {
    const sha = "a".repeat(64);
    const seenAuth: string[] = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      seenAuth.push(new Headers(init?.headers).get("Authorization") ?? "");
      if (String(input).endsWith("sha256.txt")) return new Response(`${sha}  app.exe\n`);
      return new Response(JSON.stringify([
        { tag_name: "v1.2.0", prerelease: false, assets: [
          { name: "app.exe", browser_download_url: "https://example.test/app.exe" },
          { name: "sha256.txt", browser_download_url: "https://example.test/sha256.txt" },
        ] },
        { tag_name: "v1.3.0-rc.1", prerelease: true, assets: [
          { name: "app.exe", browser_download_url: "https://example.test/rc.exe" },
          { name: "sha256.txt", browser_download_url: "https://example.test/sha256.txt" },
        ] },
        { tag_name: "v1.1.0", prerelease: false, assets: [
          { name: "loose.exe", browser_download_url: "https://example.test/loose.exe" },
        ] },
      ]), { status: 200 });
    }) as typeof fetch;
    const manifests = await fetchReleaseManifests({ ...publicReleaseFeed(), channel: "stable" }, { fetch: fetchImpl });
    expect(manifests.map((item) => item.version)).toEqual(["1.2.0"]);
    expect(seenAuth.every((value) => value === "")).toBe(true);
  });

  it("NSIS signing follows GENDRAGOON_NSIS_CERT and stays off when unset", () => {
    const { signingFromEnv } = require("../../../apps/desktop/nsis-signing.cjs") as {
      signingFromEnv: (env: Record<string, string | undefined>) => { enabled: boolean; certificateFile: string; certificatePassword: string };
    };
    expect(signingFromEnv({})).toEqual({ enabled: false, certificateFile: "", certificatePassword: "" });
    expect(signingFromEnv({ GENDRAGOON_NSIS_CERT: "cert.pfx", GENDRAGOON_NSIS_CERT_PASSWORD: "secret" })).toEqual({
      enabled: true,
      certificateFile: "cert.pfx",
      certificatePassword: "secret",
    });
  });
});
