import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  chooseRelease,
  fetchReleaseManifests,
  manifestsFromGitHub,
  parseReleaseManifest,
  parseSha256Sums,
  relaunchIfIdle,
  runUpdate,
  settleHealth,
  verifySha256,
} from "../src/index.js";

const HASH_A = "a".repeat(64);

function manifest(patch: Partial<{ version: string; url: string; sha256: string; notes: string; channel: "stable" | "beta" }> = {}) {
  return parseReleaseManifest({
    version: patch.version ?? "1.0.0",
    url: patch.url ?? "https://example.test/app.zip",
    sha256: patch.sha256 ?? HASH_A,
    notes: patch.notes ?? "notes",
    ...(patch.channel ? { channel: patch.channel } : {}),
  });
}

describe("channel selection", () => {
  const releases = [
    manifest({ version: "0.17.0", notes: "stable mac" }),
    manifest({ version: "0.18.0-rc.1", channel: "beta", notes: "mac test" }),
    manifest({ version: "0.19.0-beta.1", notes: "inferred beta" }),
  ];

  it("selects the newest non-prerelease for stable", () => {
    expect(chooseRelease(releases, "stable")?.version).toBe("0.17.0");
    expect(chooseRelease([manifest({ version: "1.2.0-rc.2", channel: "beta" })], "stable")).toBeNull();
  });

  it("selects the newest prerelease for beta", () => {
    expect(chooseRelease(releases, "beta")?.version).toBe("0.19.0-beta.1");
  });

  it("rejects a manifest that is not the interchange shape", () => {
    expect(() => parseReleaseManifest({
      version: "1.0.0",
      url: "https://example.test/a.zip",
      sha256: HASH_A,
      notes: "",
      token: "ghp_secret",
    })).toThrow(/not allowed/);
    expect(() => parseReleaseManifest({
      version: "1.0.0",
      url: "http://example.test/a.zip",
      sha256: HASH_A,
      notes: "",
    })).toThrow(/https/);
  });
});

describe("checksum failure", () => {
  it("does not install or relaunch when the bytes do not match", async () => {
    const install = vi.fn();
    const relaunch = vi.fn();
    const rollback = vi.fn();
    const bytes = new TextEncoder().encode("not-the-archive");
    const outcome = await runUpdate({
      manifest: manifest({ sha256: createHash("sha256").update("other").digest("hex") }),
      download: async () => bytes,
      install,
      relaunch,
      healthCheck: async () => true,
      rollback,
    });
    expect(outcome.outcome).toBe("checksum_failed");
    expect(install).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    expect(verifySha256(bytes, createHash("sha256").update(bytes).digest("hex"))).toBe(true);
  });
});

describe("automatic relaunch", () => {
  it("relaunches after a verified install and defers only while a transfer is active", async () => {
    const bytes = new TextEncoder().encode("archive");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const notify = vi.fn();
    const relaunch = vi.fn();
    const deferred = await runUpdate({
      manifest: manifest({ sha256, version: "1.5.0" }),
      download: async () => bytes,
      install: async () => ({ version: "1.5.0", location: "/next" }),
      relaunch,
      healthCheck: async () => true,
      rollback: async () => undefined,
      transferActive: () => true,
      notifyUpdating: notify,
    });
    expect(deferred.outcome).toBe("deferred");
    expect(notify).toHaveBeenCalledOnce();
    expect(relaunch).not.toHaveBeenCalled();
    if (deferred.outcome !== "deferred") throw new Error("expected deferral");
    await expect(relaunchIfIdle({
      deferred: deferred.installed,
      transferActive: () => true,
      relaunch,
    })).resolves.toBe("waiting");
    await expect(relaunchIfIdle({
      deferred: deferred.installed,
      transferActive: () => false,
      relaunch,
    })).resolves.toBe("relaunched");
    expect(relaunch).toHaveBeenCalledOnce();
  });
});

describe("rollback", () => {
  it("rolls back when the post-launch health check fails", async () => {
    const calls: string[] = [];
    const bytes = new TextEncoder().encode("archive");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const outcome = await runUpdate({
      manifest: manifest({ sha256, version: "1.4.0" }),
      previous: { version: "1.3.0", location: "/previous" },
      download: async () => bytes,
      install: async () => {
        calls.push("install");
        return { version: "1.4.0", location: "/next" };
      },
      relaunch: async () => {
        calls.push("relaunch");
      },
      healthCheck: async () => {
        calls.push("health");
        return false;
      },
      rollback: async (previous) => {
        calls.push(`rollback:${previous?.version ?? "none"}`);
      },
    });
    expect(outcome).toEqual({ outcome: "rolled_back", version: "1.4.0" });
    expect(calls).toEqual(["install", "relaunch", "health", "rollback:1.3.0"]);
  });

  it("rolls back on the next launch when the new process is unhealthy", async () => {
    const rollback = vi.fn();
    await expect(settleHealth({
      pending: true,
      healthCheck: async () => false,
      rollback,
    })).resolves.toBe("rolled_back");
    expect(rollback).toHaveBeenCalledOnce();
    await expect(settleHealth({
      pending: false,
      healthCheck: async () => false,
      rollback,
    })).resolves.toBe("idle");
  });
});

describe("GitHub feed", () => {
  it("builds manifests from the public releases feed and skips assets without a checksum", () => {
    const sums = parseSha256Sums("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  GenDragoon-Cloud-SSD-Mac-v0.18.0.zip\n");
    const manifests = manifestsFromGitHub([
      {
        tag_name: "v0.18.0-rc.1",
        prerelease: true,
        body: "Mac test release",
        assets: [
          {
            name: "GenDragoon-Cloud-SSD-Mac-v0.18.0.zip",
            browser_download_url: "https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/releases/download/v0.18.0-rc.1/GenDragoon-Cloud-SSD-Mac-v0.18.0.zip",
          },
          {
            name: "sha256.txt",
            browser_download_url: "https://example.test/sha256.txt",
          },
        ],
      },
      {
        tag_name: "v0.16.0",
        prerelease: false,
        body: "old",
        assets: [
          {
            name: "GenDragoon-Cloud-SSD-Mac-v0.16.0.zip",
            browser_download_url: "https://example.test/missing-checksum.zip",
          },
        ],
      },
    ], "^GenDragoon-Cloud-SSD-Mac-.*\\.zip$", sums);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({ version: "0.18.0-rc.1", channel: "beta" });
    expect(chooseRelease(manifests, "stable")).toBeNull();
    expect(chooseRelease(manifests, "beta")?.version).toBe("0.18.0-rc.1");
  });

  it("reads a keychain token into the request and keeps it out of errors", async () => {
    const secret = "ghp_super_secret_value";
    const seen = new Headers();
    await expect(fetchReleaseManifests({
      repo: "grimvirusoffical-source/gendragoon-cloud-ssd",
      assetPattern: "\\.zip$",
      readToken: async () => secret,
    }, {
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        headers.forEach((value, key) => seen.set(key, value));
        throw new Error(`network down ${secret}`);
      },
    })).rejects.toThrow("GitHub releases request failed");
    expect(seen.get("Authorization")).toBe(`Bearer ${secret}`);
    try {
      await fetchReleaseManifests({
        repo: "grimvirusoffical-source/gendragoon-cloud-ssd",
        assetPattern: "\\.zip$",
        readToken: async () => secret,
      }, { fetch: async () => { throw new Error(secret); } });
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
