export {
  parseReleaseManifest,
  manifestChannel,
  isPrerelease,
  chooseRelease,
  compareVersions,
} from "./manifest.js";
export type { ReleaseManifest, UpdateChannel } from "./manifest.js";

export {
  parseSha256Sums,
  manifestsFromGitHub,
  fetchReleaseManifests,
} from "./github.js";
export type { GitHubAsset, GitHubRelease, FeedConfig, FetchLike } from "./github.js";

export { ChecksumError, verifySha256, runUpdate, settleHealth, relaunchIfIdle } from "./update.js";
export type { InstalledVersion, UpdateOutcome, UpdateHooks } from "./update.js";
