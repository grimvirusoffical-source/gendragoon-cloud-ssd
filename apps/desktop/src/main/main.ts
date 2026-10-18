import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  chooseRelease,
  fetchReleaseManifests,
  relaunchIfIdle,
  runUpdate,
  settleHealth,
  type InstalledVersion,
  type ReleaseManifest,
} from "@gendragoon/updater";

const here = __dirname;

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

let transferActive = false;
let deferredInstall: InstalledVersion | null = null;
let shell: BrowserWindow | null = null;

function notifyUpdating(): void {
  shell?.webContents.send("updater-notice", "Updating...");
}

async function relaunchInstalled(installed: InstalledVersion): Promise<void> {
  notifyUpdating();
  await writeFile(await pendingPath(), JSON.stringify({ version: installed.version }));
  app.relaunch();
  app.exit(0);
}

async function checkForUpdate(): Promise<void> {
  const manifests = await fetchReleaseManifests({ ...FEED, readToken: readGitHubToken });
  const chosen = chooseRelease(manifests, "stable");
  if (!chosen || chosen.version === app.getVersion()) return;
  const outcome = await runUpdate({
    manifest: chosen,
    download: (manifest) => download(manifest),
    install: async (manifest, bytes) => {
      const location = path.join(app.getPath("temp"), `GenDragoon-Cloud-SSD-Setup-${manifest.version}.exe`);
      await writeFile(location, bytes);
      return { version: manifest.version, location };
    },
    notifyUpdating,
    transferActive: () => transferActive,
    relaunch: async (installed) => {
      await relaunchInstalled(installed);
    },
    healthCheck: async () => true,
    rollback: async () => {
      await clearPending();
    },
  });
  if (outcome.outcome === "deferred") deferredInstall = outcome.installed;
}

function registerIpc(): void {
  ipcMain.on("transfer-active", (_event, active: unknown) => {
    transferActive = active === true;
    if (transferActive || !deferredInstall) return;
    const installed = deferredInstall;
    deferredInstall = null;
    void relaunchIfIdle({
      deferred: installed,
      transferActive: () => transferActive,
      relaunch: (pending) => relaunchInstalled(pending),
    });
  });
  ipcMain.handle("auth:id-token", () => undefined);
  ipcMain.handle("secret:get", async (_event, name: unknown) => {
    const file = secretFile(name);
    if (!file) return null;
    try {
      const encrypted = await readFile(file);
      if (!safeStorage.isEncryptionAvailable()) return null;
      const encoded = safeStorage.decryptString(encrypted);
      return Buffer.from(encoded, "base64");
    } catch {
      return null;
    }
  });
  ipcMain.handle("secret:set", async (_event, name: unknown, bytes: unknown) => {
    const file = secretFile(name);
    if (!file || !safeStorage.isEncryptionAvailable()) return;
    const raw = toBuffer(bytes);
    if (!raw) return;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, safeStorage.encryptString(raw.toString("base64")));
  });
  ipcMain.handle("secret:delete", async (_event, name: unknown) => {
    const file = secretFile(name);
    if (!file) return;
    await rm(file, { force: true });
  });
}

function secretFile(name: unknown): string | null {
  if (typeof name !== "string" || !/^[a-z0-9:_-]{1,80}$/.test(name)) return null;
  return path.join(app.getPath("userData"), "keychain", name.replaceAll(":", "_"));
}

function toBuffer(bytes: unknown): Buffer | null {
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  return null;
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
  registerIpc();
  const window = createWindow();
  shell = window;
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
