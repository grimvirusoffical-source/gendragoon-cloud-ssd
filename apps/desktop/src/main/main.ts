import { app, BrowserWindow, safeStorage } from "electron";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chooseRelease,
  fetchReleaseManifests,
  runUpdate,
  settleHealth,
  type ReleaseManifest,
} from "@gendragoon/updater";

const here = path.dirname(fileURLToPath(import.meta.url));

const FEED = {
  repo: "grimvirusoffical-source/gendragoon-apps",
  assetPattern: "^GenDragoon-Cloud-SSD-Setup-.*\\.exe$",
};

/**
 * Private-repo tokens are read from an OS-encrypted blob in userData.
 * Nothing in the repository supplies a token, and this function never logs one.
 */
export async function readGitHubToken(): Promise<string | undefined> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    const encrypted = await readFile(path.join(app.getPath("userData"), "github-token.bin"));
    const token = safeStorage.decryptString(encrypted).trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

async function pendingPath(): Promise<string> {
  return path.join(app.getPath("userData"), "pending-update.json");
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: "#100e17",
    title: "GenDragoon Cloud SSD",
    webPreferences: {
      preload: path.join(here, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void window.loadFile(path.join(here, "renderer", "index.html"));
  return window;
}

async function hasPending(): Promise<boolean> {
  try {
    const raw = await readFile(await pendingPath(), "utf8");
    return raw.trim().length > 0;
  } catch {
    return false;
  }
}

async function checkForUpdate(): Promise<void> {
  const manifests = await fetchReleaseManifests({ ...FEED, readToken: readGitHubToken });
  const chosen = chooseRelease(manifests, "stable");
  if (!chosen || chosen.version === app.getVersion()) return;
  await runUpdate({
    manifest: chosen,
    download: (manifest) => download(manifest),
    install: async (manifest, bytes) => {
      const location = path.join(app.getPath("temp"), `GenDragoon-Cloud-SSD-Setup-${manifest.version}.exe`);
      await writeFile(location, bytes);
      return { version: manifest.version, location };
    },
    relaunch: async (installed) => {
      await writeFile(await pendingPath(), JSON.stringify({ version: installed.version }));
      app.relaunch();
      app.exit(0);
    },
    healthCheck: async () => true,
    rollback: async () => {
      await clearPending();
    },
  });
}

async function clearPending(): Promise<void> {
  await rm(await pendingPath(), { force: true });
}

async function download(manifest: ReleaseManifest): Promise<Uint8Array> {
  const response = await fetch(manifest.url);
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

void app.whenReady().then(async () => {
  const window = createWindow();
  const settlement = await settleHealth({
    pending: await hasPending(),
    healthCheck: async () => !window.webContents.isCrashed(),
    rollback: async () => {
      await clearPending();
      app.relaunch();
      app.exit(0);
    },
  });
  if (settlement === "rolled_back") return;
  if (settlement === "healthy") await clearPending();
  void checkForUpdate().catch(() => undefined);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
