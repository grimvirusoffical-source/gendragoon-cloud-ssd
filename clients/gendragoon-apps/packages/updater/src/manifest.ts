/**
 * Interchange format shared with other apps (including a later LumiAI swap).
 * Required: version, url, sha256, notes. Optional: channel.
 * No other fields are accepted.
 */

export type UpdateChannel = "stable" | "beta";

export interface ReleaseManifest {
  version: string;
  url: string;
  sha256: string;
  notes: string;
  channel?: UpdateChannel;
}

const REQUIRED = ["version", "url", "sha256", "notes"] as const;
const ALLOWED = new Set<string>(["version", "url", "sha256", "notes", "channel"]);
const SHA256 = /^[a-f0-9]{64}$/;
const PRERELEASE = /-(?:alpha|beta|rc|pre|preview|dev|snapshot)(?:[.\d]|$)|-[0-9a-z.]+$/i;

export function parseReleaseManifest(input: unknown): ReleaseManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Release manifest must be an object");
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED.has(key)) throw new Error(`Release manifest field ${key} is not allowed`);
  }
  for (const key of REQUIRED) {
    if (typeof record[key] !== "string") throw new Error(`Release manifest requires ${key}`);
  }
  const version = (record.version as string).trim().replace(/^v/, "");
  if (!version) throw new Error("Release manifest requires version");
  const url = parseHttpsUrl(record.url as string);
  const sha256 = (record.sha256 as string).trim().toLowerCase();
  if (!SHA256.test(sha256)) throw new Error("Release manifest sha256 must be 64 hex characters");
  const notes = record.notes as string;
  const manifest: ReleaseManifest = { version, url, sha256, notes };
  if ("channel" in record) {
    if (record.channel !== "stable" && record.channel !== "beta") {
      throw new Error("Release manifest channel must be stable or beta");
    }
    manifest.channel = record.channel;
  }
  return manifest;
}

export function manifestChannel(manifest: ReleaseManifest): UpdateChannel {
  if (manifest.channel) return manifest.channel;
  return isPrerelease(manifest.version) ? "beta" : "stable";
}

export function isPrerelease(version: string): boolean {
  const bare = version.trim().replace(/^v/, "");
  const tag = bare.split("+")[0] ?? bare;
  return tag.includes("-") && PRERELEASE.test(tag);
}

/**
 * Stable is the highest non-prerelease whose channel is stable.
 * Beta is the highest version on either channel, including prereleases.
 */
export function chooseRelease(manifests: readonly ReleaseManifest[], channel: UpdateChannel): ReleaseManifest | null {
  const eligible = manifests.filter((manifest) => {
    if (channel === "beta") return true;
    return manifestChannel(manifest) === "stable" && !isPrerelease(manifest.version);
  });
  if (eligible.length === 0) return null;
  return eligible.reduce((best, candidate) => (compareVersions(candidate.version, best.version) > 0 ? candidate : best));
}

export function compareVersions(left: string, right: string): number {
  const a = splitVersion(left);
  const b = splitVersion(right);
  const length = Math.max(a.numbers.length, b.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

function splitVersion(version: string): { numbers: number[]; prerelease: string } {
  const bare = version.trim().replace(/^v/, "").split("+")[0] ?? "";
  const [core, prerelease = ""] = bare.split("-", 2) as [string, string?];
  const numbers = core.split(".").map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
  return { numbers, prerelease };
}

function parseHttpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Release manifest url must be https");
  }
  if (url.protocol !== "https:" && !isLoopbackHttp(url)) throw new Error("Release manifest url must be https");
  if (url.username || url.password) throw new Error("Release manifest url must not include credentials");
  return url.toString();
}

/**
 * Plain http is accepted only for a loopback host (a local test feed). The
 * SHA-256 check still applies, and nothing off this machine is ever fetched over http.
 */
function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
}
