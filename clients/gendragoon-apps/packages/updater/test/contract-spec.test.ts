/**
 * QA contract spec for packages/updater (Morgan). Locked contract, Oct 17 2026:
 * manifest {version,url,sha256,notes}; checksum mismatch -> no install, current
 * version keeps running; install -> automatic relaunch (no restart button) ->
 * health check -> rollback on failure; stable gets non-prerelease only; the feed
 * token never reaches a manifest, error, or log.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { chooseRelease, fetchReleaseManifests, parseReleaseManifest, runUpdate } from "../src/index.js";

const bytes = new TextEncoder().encode("release-bytes");
const sha = createHash("sha256").update(bytes).digest("hex");
const manifest = (over: Record<string, unknown> = {}) =>
  parseReleaseManifest({ version: "1.2.0", url: "https://example.test/app.exe", sha256: sha, notes: "n", ...over });
function hooks(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const h = {
    manifest: manifest(),
    download: async () => { calls.push("download"); return bytes; },
    install: async () => { calls.push("install"); return { version: "1.2.0" }; },
    relaunch: async () => { calls.push("relaunch"); },
    healthCheck: async () => { calls.push("health"); return true; },
    rollback: async () => { calls.push("rollback"); },
    previous: { version: "1.1.0" },
    ...over,
  };
  return { h, calls };
}

describe("manifest", () => {
  it("requires exactly version, url, sha256, notes (channel optional) and rejects extras", () => {
    expect(manifest()).toEqual({ version: "1.2.0", url: "https://example.test/app.exe", sha256: sha, notes: "n" });
    for (const key of ["version", "url", "sha256", "notes"]) {
      const m: Record<string, unknown> = { version: "1", url: "https://e.test/a", sha256: sha, notes: "n" };
      delete m[key];
      expect(() => parseReleaseManifest(m)).toThrow();
    }
    expect(() => manifest({ token: "x" })).toThrow(/not allowed/);
    expect(() => manifest({ url: "http://example.test/a" })).toThrow(/https/);
  });
});

describe("install cycle", () => {
  it("checksum mismatch: nothing installed, no relaunch, current version keeps running", async () => {
    const { h, calls } = hooks({ manifest: manifest({ sha256: "0".repeat(64) }) });
    expect((await runUpdate(h)).outcome).toBe("checksum_failed");
    expect(calls).toEqual(["download"]);
  });
  it("install -> automatic relaunch -> health check, no user restart step", async () => {
    const notify = vi.fn();
    const { h, calls } = hooks({ notifyUpdating: notify });
    expect((await runUpdate(h)).outcome).toBe("healthy");
    expect(calls).toEqual(["download", "install", "relaunch", "health"]);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it("failed health check rolls back to the previous version", async () => {
    let rolledTo: unknown;
    const { h, calls } = hooks({ healthCheck: async () => false, rollback: async (p: unknown) => { rolledTo = p; calls.push("rollback"); } });
    expect((await runUpdate(h)).outcome).toBe("rolled_back");
    expect(calls.at(-1)).toBe("rollback");
    expect(rolledTo).toEqual({ version: "1.1.0" });
  });
});

describe("channels", () => {
  it("stable receives non-prerelease releases only", () => {
    const list = [manifest({ version: "1.3.0-beta.1" }), manifest({ version: "1.2.0" }), manifest({ version: "1.4.0-rc.1", channel: "stable" })];
    expect(chooseRelease(list, "stable")?.version).toBe("1.2.0");
    expect(chooseRelease([manifest({ version: "2.0.0-rc.1" })], "stable")).toBeNull();
  });
});

describe("token hygiene", () => {
  it("the feed token is sent only as an Authorization header and never lands in manifests or errors", async () => {
    const token = "ghp_TESTONLY_not_a_real_token";
    const log = vi.spyOn(console, "log"), warn = vi.spyOn(console, "warn"), error = vi.spyOn(console, "error");
    const seenAuth: string[] = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      seenAuth.push(new Headers(init?.headers).get("Authorization") ?? "");
      if (String(input).endsWith("sha256.txt")) return new Response(`${sha}  app.exe\n`);
      return new Response(JSON.stringify([{ tag_name: "v1.2.0", body: "notes", assets: [
        { name: "app.exe", browser_download_url: "https://example.test/app.exe" },
        { name: "sha256.txt", browser_download_url: "https://example.test/sha256.txt" }] }]), { status: 200 });
    }) as typeof fetch;
    const manifests = await fetchReleaseManifests({ repo: "o/r", assetPattern: "\\.exe$", readToken: async () => token }, { fetch: fetchImpl });
    expect(JSON.stringify(manifests)).not.toContain(token);
    expect(seenAuth[0]).toBe(`Bearer ${token}`);
    expect(seenAuth.slice(1).every((v) => !v.includes(token))).toBe(true);
    const failing = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    const err = await fetchReleaseManifests({ repo: "o/r", assetPattern: ".", readToken: async () => token }, { fetch: failing }).catch((e) => e);
    expect(String(err?.message)).not.toContain(token);
    for (const spy of [log, warn, error]) for (const c of spy.mock.calls) expect(JSON.stringify(c)).not.toContain(token);
  });
});
