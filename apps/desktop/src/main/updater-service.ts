import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  HEALTH_WINDOW_MS,
  UpdateController,
  chooseRelease,
  downloadWithProgress,
  fetchReleaseManifests,
  publicReleaseFeed,
  settleHealth,
  startInstallerDetached,
  type FeedConfig,
  type InstalledVersion,
  type UpdateState,
} from "@gendragoon/updater";

export interface DesktopUpdaterEnv {
  userData: string;
  version: string;
  platform: NodeJS.Platform;
  /** Tell the renderer. */
  send: (state: UpdateState) => void;
  /** Quit this process. The NSIS installer replaces the files and starts the new version. */
  quit: () => void;
  transferActive: () => boolean;
  feed?: FeedConfig;
  fetch?: typeof fetch;
  startInstaller?: (file: string) => Promise<unknown>;
  autoInstall?: boolean;
}

/** Feed from the environment, so a local test feed or a beta channel needs no rebuild. */
export function feedFromEnv(env: NodeJS.ProcessEnv = process.env): FeedConfig {
  const base = publicReleaseFeed();
  return {
    repo: env.GENDRAGOON_UPDATE_REPO || base.repo,
    assetPattern: base.assetPattern,
    apiBase: env.GENDRAGOON_UPDATE_API_BASE || undefined,
    channel: "stable",
  };
}

/**
 * The desktop updater. Same controller for the startup check and the "Check for updates" button.
 * Install order matters: write the pending marker, start the installer DETACHED, then quit.
 * The installer (run with --updated --force-run) waits for this process to exit, replaces the
 * app, and starts the new version. The new version settles health from the marker.
 */
export function createDesktopUpdater(env: DesktopUpdaterEnv) {
  const file = (name: string) => path.join(env.userData, name);
  const start = env.startInstaller ?? ((installer: string) => startInstallerDetached(installer));
  const feed = env.feed ?? feedFromEnv();

  async function readText(name: string): Promise<string | null> {
    try {
      const text = (await readFile(file(name), "utf8")).trim();
      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  }

  async function readPending(): Promise<InstalledVersion | null> {
    try {
      const parsed = JSON.parse(await readFile(file("pending-update.json"), "utf8")) as { version?: unknown; location?: unknown };
      if (typeof parsed.version !== "string" || parsed.version.length === 0) return null;
      return { version: parsed.version, location: typeof parsed.location === "string" && parsed.location ? parsed.location : undefined };
    } catch {
      return null;
    }
  }

  const clearPending = () => rm(file("pending-update.json"), { force: true });

  const controller = new UpdateController({
    currentVersion: env.version,
    channel: "stable",
    autoInstall: env.autoInstall ?? env.platform === "win32",
    loadManifests: () => fetchReleaseManifests(feed, { fetch: env.fetch }),
    download: (manifest, onProgress) => downloadWithProgress(manifest.url, onProgress, { fetch: env.fetch }),
    transferActive: env.transferActive,
    rolledBackVersion: () => readText("rolled-back-version.txt"),
    onState: env.send,
    install: async (manifest, bytes) => {
      const location = path.join(env.userData, "installers", `GenDragoon-Cloud-SSD-Setup-${manifest.version}.exe`);
      await mkdir(path.dirname(location), { recursive: true });
      await writeFile(location, bytes);
      // Marker first: if the installer relaunches us, the next start knows to check health.
      await writeFile(file("pending-update.json"), JSON.stringify({ version: manifest.version, location }));
      try {
        await start(location);
      } catch (error) {
        await clearPending();
        throw error;
      }
      return { version: manifest.version, location };
    },
    relaunch: async () => {
      env.quit();
    },
  });

  return {
    controller,
    check: (manual: boolean) => controller.check({ manual }),
    /** Hosts call this when an upload or backup ends. */
    onTransferIdle: () => controller.resumeIfIdle(),
    /**
     * Run once at startup after the window exists. If this launch follows an update, keep it only
     * when the shell stays healthy for the window; otherwise reinstall the previous installer.
     */
    async settleOnLaunch(isHealthy: (windowMs: number) => Promise<boolean>): Promise<"idle" | "healthy" | "rolled_back"> {
      const pending = await readPending();
      const result = await settleHealth({
        pending: pending !== null,
        healthCheck: () => isHealthy(HEALTH_WINDOW_MS),
        rollback: async () => {
          if (pending) await writeFile(file("rolled-back-version.txt"), pending.version);
          const previous = await readText("previous-installer.txt");
          await clearPending();
          if (previous) {
            await start(previous);
            env.quit();
          }
        },
      });
      if (result === "healthy") {
        if (pending?.location) await writeFile(file("previous-installer.txt"), pending.location);
        await clearPending();
      }
      return result;
    },
    chooseRelease,
  };
}
