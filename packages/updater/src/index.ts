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

export {
  ChecksumError,
  HEALTH_WINDOW_MS,
  NSIS_SILENT_ARGS,
  NSIS_UPDATE_ARGS,
  publicReleaseFeed,
  relaunchIfIdle,
  runUpdate,
  settleHealth,
  silentInstallPlan,
  updateWouldLoop,
  verifySha256,
} from "./update.js";
export type { InstalledVersion, UpdateOutcome, UpdateHooks } from "./update.js";

export { downloadWithProgress } from "./download.js";
export type { DownloadProgress } from "./download.js";
export { UpdateController, friendlyUpdateError } from "./controller.js";
export type { UpdateState, UpdateControllerDeps } from "./controller.js";
export { startInstallerDetached } from "./installer.js";
