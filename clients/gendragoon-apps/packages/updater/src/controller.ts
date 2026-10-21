import { chooseRelease, compareVersions, type ReleaseManifest, type UpdateChannel } from "./manifest.js";
import { updateWouldLoop, verifySha256, type InstalledVersion } from "./update.js";
import type { DownloadProgress } from "./download.js";

/** Every state the Update button and banner can show. */
export type UpdateState =
  | { status: "idle" }
  | { status: "checking"; manual: boolean }
  | { status: "up_to_date"; currentVersion: string; checkedAt: number }
  | { status: "available"; version: string; notes: string; url?: string }
  | { status: "downloading"; version: string; receivedBytes: number; totalBytes: number | null; percent: number | null }
  | { status: "verifying"; version: string }
  | { status: "ready"; version: string }
  /** Verified and waiting because an upload or backup is still moving bytes. Installs when it ends. */
  | { status: "deferred"; version: string }
  | { status: "installing"; version: string }
  | { status: "relaunching"; version: string }
  | { status: "error"; message: string; stage: "check" | "download" | "verify" | "install" };

export interface UpdateControllerDeps {
  currentVersion: string;
  channel?: UpdateChannel;
  loadManifests: () => Promise<ReleaseManifest[]>;
  download: (manifest: ReleaseManifest, onProgress: (progress: DownloadProgress) => void) => Promise<Uint8Array>;
  /** Stage the verified bytes and start the installer. Resolves when the installer has been started (or finished). */
  install: (manifest: ReleaseManifest, bytes: Uint8Array) => Promise<InstalledVersion>;
  /** End this process so the installer can replace it and start the new version. */
  relaunch: (installed: InstalledVersion) => Promise<void>;
  transferActive?: () => boolean | Promise<boolean>;
  rolledBackVersion?: () => Promise<string | null>;
  /** Install and relaunch without a click once a newer version is found. Defaults to true. */
  autoInstall?: boolean;
  now?: () => number;
  onState?: (state: UpdateState) => void;
}

export function friendlyUpdateError(error: unknown, stage: "check" | "download" | "verify" | "install"): string {
  const raw = error instanceof Error ? error.message : "";
  if (stage === "check") {
    if (/\((403|429)\)/.test(raw)) return "Could not check for updates: the update server is rate limiting this device. Try again in a few minutes.";
    return "Could not check for updates. Check your internet connection and try again.";
  }
  if (stage === "download") return "The update could not be downloaded. Check your internet connection and try again.";
  if (stage === "verify") return "The downloaded update failed its integrity check and was not installed.";
  return "The update could not be installed. Your current version is unchanged.";
}

/**
 * The whole update cycle as one state machine: check, download with progress,
 * SHA-256 verify, install, relaunch. The same controller serves the startup check and the
 * manual button. A second call while a cycle runs joins it instead of starting another.
 */
export class UpdateController {
  private state: UpdateState = { status: "idle" };
  private running: Promise<UpdateState> | null = null;
  private deferred: { manifest: ReleaseManifest; bytes: Uint8Array } | null = null;

  constructor(private readonly deps: UpdateControllerDeps) {}

  getState(): UpdateState {
    return this.state;
  }

  /** Manual button and startup both call this. Returns the state the cycle ended in. */
  check(options: { manual?: boolean } = {}): Promise<UpdateState> {
    if (this.running) return this.running;
    this.running = this.cycle(options.manual === true).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Call when an upload or backup finishes. Installs a deferred update right away. */
  async resumeIfIdle(): Promise<UpdateState> {
    if (!this.deferred) return this.state;
    if (await this.deps.transferActive?.()) return this.state;
    const { manifest, bytes } = this.deferred;
    this.deferred = null;
    return this.installNow(manifest, bytes);
  }

  private set(state: UpdateState): UpdateState {
    this.state = state;
    this.deps.onState?.(state);
    return state;
  }

  private async cycle(manual: boolean): Promise<UpdateState> {
    this.set({ status: "checking", manual });
    let manifest: ReleaseManifest | null;
    try {
      const manifests = await this.deps.loadManifests();
      manifest = chooseRelease(manifests, this.deps.channel ?? "stable");
    } catch (error) {
      return this.set({ status: "error", stage: "check", message: friendlyUpdateError(error, "check") });
    }
    const now = (this.deps.now ?? Date.now)();
    if (!manifest || compareVersions(manifest.version, this.deps.currentVersion) <= 0) {
      return this.set({ status: "up_to_date", currentVersion: this.deps.currentVersion, checkedAt: now });
    }
    const rolledBack = (await this.deps.rolledBackVersion?.().catch(() => null)) ?? null;
    if (updateWouldLoop(manifest.version, rolledBack)) {
      return this.set({ status: "up_to_date", currentVersion: this.deps.currentVersion, checkedAt: now });
    }
    this.set({ status: "available", version: manifest.version, notes: manifest.notes, url: manifest.url });
    if (this.deps.autoInstall === false) return this.state;
    return this.downloadVerifyInstall(manifest);
  }

  private async downloadVerifyInstall(manifest: ReleaseManifest): Promise<UpdateState> {
    let bytes: Uint8Array;
    let lastPercent = -1;
    try {
      bytes = await this.deps.download(manifest, (p) => {
        const percent = p.totalBytes ? Math.min(100, Math.floor((p.receivedBytes / p.totalBytes) * 100)) : null;
        // Emit on whole-percent steps so the UI is not flooded by every chunk.
        if (percent !== null && percent === lastPercent && p.receivedBytes !== p.totalBytes) return;
        if (percent !== null) lastPercent = percent;
        this.set({ status: "downloading", version: manifest.version, receivedBytes: p.receivedBytes, totalBytes: p.totalBytes, percent });
      });
    } catch (error) {
      return this.set({ status: "error", stage: "download", message: friendlyUpdateError(error, "download") });
    }
    this.set({ status: "verifying", version: manifest.version });
    if (!verifySha256(bytes, manifest.sha256)) {
      return this.set({ status: "error", stage: "verify", message: friendlyUpdateError(null, "verify") });
    }
    this.set({ status: "ready", version: manifest.version });
    if (await this.deps.transferActive?.()) {
      this.deferred = { manifest, bytes };
      return this.set({ status: "deferred", version: manifest.version });
    }
    return this.installNow(manifest, bytes);
  }

  private async installNow(manifest: ReleaseManifest, bytes: Uint8Array): Promise<UpdateState> {
    this.set({ status: "installing", version: manifest.version });
    let installed: InstalledVersion;
    try {
      installed = await this.deps.install(manifest, bytes);
    } catch (error) {
      return this.set({ status: "error", stage: "install", message: friendlyUpdateError(error, "install") });
    }
    this.set({ status: "relaunching", version: manifest.version });
    try {
      await this.deps.relaunch(installed);
    } catch (error) {
      return this.set({ status: "error", stage: "install", message: friendlyUpdateError(error, "install") });
    }
    return this.state;
  }
}
