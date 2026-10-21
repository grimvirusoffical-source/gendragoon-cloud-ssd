/* global process, console, document, getComputedStyle, window, localStorage */
/**
 * Headless-Chrome check of the desktop renderer: default dark, Light/System toggle and persistence,
 * reduced motion, and the manual "Check for updates" button against a stubbed main-process bridge.
 * Writes screenshots. Usage: node scripts/e2e-ui.mjs (after `pnpm build`).
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.SCREENSHOT_DIR || path.join(root, "screenshots");
const chrome = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const port = 4179;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`); };

const preview = spawn("pnpm", ["exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, stdio: "ignore" });
const url = `http://127.0.0.1:${port}/`;
for (let i = 0; i < 60; i += 1) { try { if ((await fetch(url)).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 250)); }

const STUB = () => {
  // A stand-in for the Electron preload bridge: scripted update states, as the main process would send them.
  const listeners = [];
  window.__calls = 0;
  window.gendragoon = {
    platform: "win32",
    onUpdateState: (cb) => listeners.push(cb),
    getUpdateState: async () => ({ status: "idle" }),
    checkForUpdates: async () => {
      window.__calls += 1;
      const send = (s) => listeners.forEach((cb) => cb(s));
      send({ status: "checking", manual: true });
      await new Promise((r) => setTimeout(r, 150));
      send({ status: "available", version: "0.2.0", notes: "" });
      for (const percent of [10, 55, 100]) { send({ status: "downloading", version: "0.2.0", percent, receivedBytes: percent, totalBytes: 100 }); await new Promise((r) => setTimeout(r, 150)); }
      send({ status: "verifying", version: "0.2.0" });
      await new Promise((r) => setTimeout(r, 150));
      send({ status: "relaunching", version: "0.2.0" });
      return { status: "relaunching", version: "0.2.0" };
    },
  };
};

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  await mkdir(outDir, { recursive: true });
  const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme);
  const shot = (page, name) => page.screenshot({ path: path.join(outDir, name) });

  const nav = async (pg, view) => { await pg.click(`[data-testid='nav-${view}']`); await new Promise((r) => setTimeout(r, 450)); };
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await page.evaluateOnNewDocument(STUB);
  await page.goto(`${url}#/files`, { waitUntil: "networkidle0" });
  check("default theme is dark", (await theme(page)) === "dark" && (await bg(page)) === "rgb(13, 11, 20)", await bg(page));
  await shot(page, "files-dark.png");
  await nav(page, "workspaces");
  await shot(page, "workspaces-dark.png");

  await nav(page, "settings");
  await page.waitForSelector("[data-testid='update-control']");
  check("settings has Appearance toggle with Dark/Light/System", (await page.$$("[data-testid^='theme-']")).length === 4); // wrapper + 3 buttons
  await shot(page, "settings-dark.png");

  // Manual update button: states in order.
  const seen = new Set();
  const poll = setInterval(async () => { try { seen.add(await page.$eval("[data-testid='update-control']", (n) => n.dataset.state)); } catch { /* navigating */ } }, 40);
  await page.click("[data-testid='update-check']");
  await page.waitForFunction(() => document.querySelector("[data-testid='update-control']")?.dataset.state === "relaunching", { timeout: 5000 });
  clearInterval(poll);
  const calls = await page.evaluate(() => window.__calls);
  check("manual button calls the main-process check once", calls === 1, `calls=${calls}`);
  for (const s of ["checking", "downloading", "verifying", "relaunching"]) check(`update state shown: ${s}`, seen.has(s) || s === "relaunching");
  const progress = await page.$eval("[data-testid='update-status']", (n) => n.textContent);
  check("relaunching text says the app restarts by itself", /restart by itself/.test(progress ?? ""), progress ?? "");
  await shot(page, "settings-updating-dark.png");

  // Light.
  await nav(page, "settings");
  await page.click("[data-testid='theme-light']");
  await new Promise((r) => setTimeout(r, 600));
  check("Light applies", (await theme(page)) === "light" && (await bg(page)) === "rgb(246, 244, 251)", await bg(page));
  await shot(page, "settings-light.png");
  await page.reload({ waitUntil: "networkidle0" });
  check("Light persists after reload", (await theme(page)) === "light");
  await nav(page, "files");
  await shot(page, "files-light.png");
  await nav(page, "workspaces");
  await shot(page, "workspaces-light.png");

  // System follows the OS, live.
  await nav(page, "settings");
  await page.click("[data-testid='theme-system']");
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await new Promise((r) => setTimeout(r, 500));
  const sysDark = await bg(page);
  await shot(page, "settings-system-os-dark.png");
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await new Promise((r) => setTimeout(r, 500));
  const sysLight = await bg(page);
  await shot(page, "settings-system-os-light.png");
  check("System follows OS dark", (await theme(page)) === "system" && sysDark === "rgb(13, 11, 20)", sysDark);
  check("System follows OS light, live", sysLight === "rgb(246, 244, 251)", sysLight);

  // Reduced motion.
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  const dur = await page.evaluate(() => getComputedStyle(document.querySelector(".btn")).transitionDuration);
  check("prefers-reduced-motion removes transitions", parseFloat(dur) < 0.01, dur);

  // Default really is dark on a fresh profile.
  const fresh = await browser.createBrowserContext();
  const p2 = await fresh.newPage();
  await p2.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await p2.goto(`${url}#/files`, { waitUntil: "networkidle0" });
  check("fresh profile is dark even when the OS is light (dark is the default)", (await theme(p2)) === "dark" && (await bg(p2)) === "rgb(13, 11, 20)");
} finally {
  await browser.close();
  preview.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
