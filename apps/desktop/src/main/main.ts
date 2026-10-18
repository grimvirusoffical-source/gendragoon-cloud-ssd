import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, type IpcMainInvokeEvent } from "electron";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  chooseRelease,
  fetchReleaseManifests,
  publicReleaseFeed,
  relaunchIfIdle,
  runUpdate,
  settleHealth,
  silentInstallPlan,
  updateWouldLoop,
  HEALTH_WINDOW_MS,
  type InstalledVersion,
  type ReleaseManifest,
} from "@gendragoon/updater";

const here = __dirname;

const FEED = { ...publicReleaseFeed(), channel: "stable" as const };
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' https:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

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

function requireSafeStorage(): void {
  if (safeStorage.isEncryptionAvailable()) return;
  dialog.showErrorBox(
    "Secure storage is unavailable",
    "GenDragoon cannot store secrets because the operating system keychain is unavailable.",
  );
  throw new Error("safeStorage is unavailable");
}

function harden(window: BrowserWindow): void {
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [CSP],
      },
    });
  });
}

function senderIsShell(event: IpcMainInvokeEvent): boolean {
  const owner = BrowserWindow.fromWebContents(event.sender);
  return owner !== null && owner === shell;
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
  harden(window);
  void window.loadFile(path.join(here, "renderer", "index.html"));
  return window;
}

async function readPending(): Promise<InstalledVersion | null> {
  try {
    const raw = await readFile(await pendingPath(), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown; location?: unknown };
    if (typeof parsed.version !== "string" || parsed.version.length === 0) return null;
    const location = typeof parsed.location === "string" && parsed.location.length > 0 ? parsed.location : undefined;
    return { version: parsed.version, location };
  } catch {
    return null;
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
  await writeFile(await pendingPath(), JSON.stringify({ version: installed.version, location: installed.location ?? "" }));
  app.relaunch();
  app.exit(0);
}

async function rolledBackVersion(): Promise<string | null> {
  try {
    const raw = await readFile(path.join(app.getPath("userData"), "rolled-back-version.txt"), "utf8");
    const version = raw.trim();
    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

async function rememberRollback(version: string): Promise<void> {
  await writeFile(path.join(app.getPath("userData"), "rolled-back-version.txt"), version);
}

function runSilentInstaller(file: string): Promise<void> {
  const plan = silentInstallPlan(file);
  return new Promise((resolve, reject) => {
    const child = spawn(plan.file, [...plan.args], { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Installer exited ${code ?? "unknown"}`));
    });
  });
}

async function previousInstaller(): Promise<string | null> {
  try {
    const raw = await readFile(path.join(app.getPath("userData"), "previous-installer.txt"), "utf8");
    const location = raw.trim();
    return location.length > 0 ? location : null;
  } catch {
    return null;
  }
}

async function checkForUpdate(): Promise<void> {
  const manifests = await fetchReleaseManifests(FEED);
  const chosen = chooseRelease(manifests, "stable");
  if (!chosen || chosen.version === app.getVersion()) return;
  if (updateWouldLoop(chosen.version, await rolledBackVersion())) return;
  const outcome = await runUpdate({
    manifest: chosen,
    download: (manifest) => download(manifest),
    install: async (manifest, bytes) => {
      const location = path.join(app.getPath("userData"), "installers", `GenDragoon-Cloud-SSD-Setup-${manifest.version}.exe`);
      await mkdir(path.dirname(location), { recursive: true });
      await writeFile(location, bytes);
      await runSilentInstaller(silentInstallPlan(location).file);
      return { version: manifest.version, location };
    },
    notifyUpdating,
    transferActive: () => transferActive,
    relaunch: async (installed) => {
      await relaunchInstalled(installed);
    },
    // The process exits in relaunch. The 60s window runs on the next launch.
    healthCheck: async () => true,
    rollback: async (previous) => {
      await rememberRollback(chosen.version);
      const location = previous?.location;
      if (location) {
        await runSilentInstaller(location);
        await writeFile(path.join(app.getPath("userData"), "previous-installer.txt"), location);
      }
      await clearPending();
    },
    previous: { version: app.getVersion(), location: await previousInstaller() ?? undefined },
  });
  if (outcome.outcome === "deferred") deferredInstall = outcome.installed;
}

async function healthyFor(windowMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < windowMs) {
    if (!shell || shell.isDestroyed() || shell.webContents.isCrashed()) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, windowMs)));
  }
  return Boolean(shell && !shell.isDestroyed() && !shell.webContents.isCrashed());
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
  ipcMain.handle("secret:get", async (event, name: unknown) => {
    if (!senderIsShell(event)) throw new Error("Refusing secret IPC from an unknown sender");
    requireSafeStorage();
    const file = secretFile(name);
    if (!file) return null;
    try {
      const encrypted = await readFile(file);
      const encoded = safeStorage.decryptString(encrypted);
      return Buffer.from(encoded, "base64");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  });
  ipcMain.handle("secret:set", async (event, name: unknown, bytes: unknown) => {
    if (!senderIsShell(event)) throw new Error("Refusing secret IPC from an unknown sender");
    requireSafeStorage();
    const file = secretFile(name);
    if (!file) return;
    const raw = toBuffer(bytes);
    if (!raw) return;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, safeStorage.encryptString(raw.toString("base64")));
  });
  ipcMain.handle("secret:delete", async (event, name: unknown) => {
    if (!senderIsShell(event)) throw new Error("Refusing secret IPC from an unknown sender");
    requireSafeStorage();
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
  requireSafeStorage();
  registerIpc();
  const window = createWindow();
  shell = window;
  const pendingUpdate = await readPending();
  const settlement = await settleHealth({
    pending: pendingUpdate !== null,
    healthCheck: () => healthyFor(HEALTH_WINDOW_MS),
    rollback: async () => {
      if (pendingUpdate) await rememberRollback(pendingUpdate.version);
      const previous = await previousInstaller();
      if (previous) await runSilentInstaller(previous);
      await clearPending();
      app.relaunch();
      app.exit(0);
    },
  });
  if (settlement === "rolled_back") return;
  if (settlement === "healthy") {
    if (pendingUpdate?.location) {
      await writeFile(path.join(app.getPath("userData"), "previous-installer.txt"), pendingUpdate.location);
    }
    await clearPending();
  }
  void checkForUpdate().catch(() => undefined);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
