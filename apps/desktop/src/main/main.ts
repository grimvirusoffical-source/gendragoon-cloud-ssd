import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, type IpcMainInvokeEvent } from "electron";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type UpdateState } from "@gendragoon/updater";
import { createDesktopUpdater } from "./updater-service.js";

const here = __dirname;

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
    backgroundColor: "#0d0b14",
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

let transferActive = false;
let shell: BrowserWindow | null = null;

let updaterInstance: ReturnType<typeof createDesktopUpdater> | null = null;
function getUpdater(): ReturnType<typeof createDesktopUpdater> {
  updaterInstance ??= createDesktopUpdater({
  userData: app.getPath("userData"),
  version: app.getVersion(),
  platform: process.platform,
  send: (state: UpdateState) => {
    shell?.webContents.send("updater-state", state);
    if (state.status === "installing" || state.status === "relaunching") shell?.webContents.send("updater-notice", "Updating...");
  },
  quit: () => app.quit(),
  transferActive: () => transferActive,
  });
  return updaterInstance;
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
    if (!transferActive) void getUpdater().onTransferIdle();
  });
  // The manual "Check for updates" button. Joins a check that is already running.
  ipcMain.handle("updater:check", (event) => {
    if (!senderIsShell(event)) throw new Error("Refusing updater IPC from an unknown sender");
    return getUpdater().check(true);
  });
  ipcMain.handle("updater:state", (event) => {
    if (!senderIsShell(event)) throw new Error("Refusing updater IPC from an unknown sender");
    return getUpdater().controller.getState();
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

void app.whenReady().then(async () => {
  requireSafeStorage();
  registerIpc();
  const window = createWindow();
  shell = window;
  // Startup: settle a just-installed update (keep or roll back), then check for the next one.
  void getUpdater().settleOnLaunch(healthyFor).then((settled) => {
    if (settled !== "rolled_back") void getUpdater().check(false);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
