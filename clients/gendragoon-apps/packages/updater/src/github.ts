import { isPrerelease, manifestChannel, parseReleaseManifest, type ReleaseManifest, type UpdateChannel } from "./manifest.js";

export interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

export interface GitHubRelease {
  tag_name: string;
  name?: string;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GitHubAsset[];
}

export interface FeedConfig {
  /** owner/name, for example grimvirusoffical-source/gendragoon-cloud-ssd */
  repo: string;
  /** Regular expression matched against asset file names. */
  assetPattern: string;
  /**
   * Read a private-repo token from the OS keychain. Public feeds omit this.
   * The token must never be logged, bundled, or written into a manifest.
   */
  readToken?: () => Promise<string | undefined>;
  /** GitHub API origin. Defaults to https://api.github.com. Only a loopback http origin is allowed besides https (local test feeds). */
  apiBase?: string;
  /** Public feeds use `stable` and do not pass a token. Prereleases are omitted. */
  channel?: UpdateChannel;
}

export interface FetchLike {
  fetch?: typeof fetch;
}

export function parseSha256Sums(text: string): Record<string, string> {
  const sums: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([a-fA-F0-9]{64})\s+\*?(\S+)$/.exec(trimmed);
    if (!match) continue;
    const hash = match[1];
    const name = match[2];
    if (hash && name) sums[name] = hash.toLowerCase();
  }
  return sums;
}

export function manifestsFromGitHub(
  releases: readonly GitHubRelease[],
  assetPattern: string,
  checksums: Readonly<Record<string, string>>,
): ReleaseManifest[] {
  const pattern = new RegExp(assetPattern);
  const manifests: ReleaseManifest[] = [];
  for (const release of releases) {
    if (release.draft) continue;
    for (const asset of release.assets ?? []) {
      if (!pattern.test(asset.name)) continue;
      const sha256 = checksums[asset.name];
      if (!sha256) continue;
      manifests.push(parseReleaseManifest({
        version: release.tag_name,
        url: asset.browser_download_url,
        sha256,
        notes: release.body ?? release.name ?? "",
        channel: release.prerelease ? "beta" : "stable",
      }));
    }
  }
  return manifests;
}

export async function fetchReleaseManifests(config: FeedConfig, deps: FetchLike = {}): Promise<ReleaseManifest[]> {
  const [owner, name, extra] = config.repo.split("/");
  if (!owner || !name || extra) throw new Error("Feed repo must be owner/name");
  const fetchImpl = deps.fetch ?? fetch;
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "User-Agent": "gendragoon-updater",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  if (config.readToken) {
    const token = await config.readToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  const apiBase = (config.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  if (!/^https:\/\//.test(apiBase) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiBase)) {
    throw new Error("Feed apiBase must be https (or loopback http)");
  }
  const releasesUrl = `${apiBase}/repos/${owner}/${name}/releases?per_page=100`;
  let response: Response;
  try {
    response = await fetchImpl(releasesUrl, { headers });
  } catch {
    throw new Error("GitHub releases request failed");
  }
  if (!response.ok) throw new Error(`GitHub releases request failed (${response.status})`);
  const releases = (await response.json()) as GitHubRelease[];
  const checksums = await loadChecksums(releases, fetchImpl);
  const manifests = manifestsFromGitHub(releases, config.assetPattern, checksums);
  if (config.channel === "stable") {
    return manifests.filter((manifest) => manifestChannel(manifest) === "stable" && !isPrerelease(manifest.version));
  }
  return manifests;
}

/** Release checksum files this feed understands (the Mac packager writes sha256.txt, the release helper SHA256SUMS). */
const CHECKSUM_ASSETS = new Set(["sha256.txt", "sha256sums", "sha256sums.txt"]);

async function loadChecksums(releases: readonly GitHubRelease[], fetchImpl: typeof fetch): Promise<Record<string, string>> {
  const sums: Record<string, string> = {};
  for (const release of releases) {
    const asset = release.assets?.find((item) => CHECKSUM_ASSETS.has(item.name.toLowerCase()));
    if (!asset) continue;
    try {
      const response = await fetchImpl(asset.browser_download_url);
      if (!response.ok) continue;
      Object.assign(sums, parseSha256Sums(await response.text()));
    } catch {
      // A missing checksum drops that asset. It is not an install.
    }
  }
  return sums;
}
