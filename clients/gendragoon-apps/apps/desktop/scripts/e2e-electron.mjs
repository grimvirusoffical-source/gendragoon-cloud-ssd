/* global process, console, document, window */
/**
 * Real Electron main process under Xvfb against a local simulated update feed.
 * Scenario 1: feed is current -> manual button shows "up to date".
 * Scenario 2: feed gains a newer version -> manual button downloads, verifies, starts the installer detached
 *             with "/S --updated --force-run", and the app quits by itself.
 * Scenario 3: a newer version already on the feed at launch -> the startup check does the same, no click.
 * The "installer" is a shell script standing in for the NSIS setup (the real NSIS flow needs Windows).
 * Usage: node scripts/e2e-electron.mjs <path to linux-unpacked/gendragoon-cloud-ssd>
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagedBin = path.resolve(process.argv[2] ?? "release/linux-unpacked/gendragoon-cloud-ssd");
// A packaged app (resources/app.asar, or any binary not named "electron") reports app.isPackaged=true, which disables the
// GENDRAGOON_E2E harness switches. So run a copy of the same Electron runtime, renamed "electron", with the built app dir as a plain resources/app.
const bareDir = await mkdtemp(path.join(tmpdir(), "gd-e2e-electron-"));
await cp(path.dirname(packagedBin), bareDir, { recursive: true });
await rm(path.join(bareDir, "resources", "app.asar"), { force: true });
await rm(path.join(bareDir, "resources", "app.asar.unpacked"), { recursive: true, force: true });
await rename(path.join(bareDir, path.basename(packagedBin)), path.join(bareDir, "electron"));
await mkdir(path.join(bareDir, "resources", "app"), { recursive: true });
await writeFile(path.join(bareDir, "resources", "app", "package.json"), JSON.stringify({ name: "gendragoon-desktop", version: "0.1.0", main: "boot.js" }));
await writeFile(path.join(bareDir, "resources", "app", "boot.js"), `require(${JSON.stringify(path.join(appDir, "dist", "main.js"))});\n`);
const bin = path.join(bareDir, "electron");
const shotDir = process.env.SCREENSHOT_DIR || path.join(appDir, "screenshots");
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mark = await mkdtemp(path.join(tmpdir(), "gd-e2e-mark-"));
const installer = Buffer.from(`#!/bin/sh\necho "$@" > "${mark}/installer.args"\nsleep 1\necho relaunched > "${mark}/relaunched"\n`);
const sha = createHash("sha256").update(installer).digest("hex");
let feedVersion = "0.1.0"; // current
let seenNow = "";
let base = "";
const server = createServer((req, res) => {
  const url = req.url ?? "";
  if (url.startsWith("/repos/o/r/releases")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([{ tag_name: `v${feedVersion}`, prerelease: false, body: "e2e", assets: [
      { name: "Setup.exe", browser_download_url: `${base}/dl/Setup.exe` }, { name: "SHA256SUMS", browser_download_url: `${base}/dl/SHA256SUMS` } ] }]));
  } else if (url === "/dl/SHA256SUMS") res.end(`${sha}  Setup.exe\n`);
  else if (url === "/dl/Setup.exe") { res.setHeader("content-length", installer.length); res.end(installer); }
  else { res.statusCode = 404; res.end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
base = `http://127.0.0.1:${server.address().port}`;

async function launch(debugPort, extraEnv = {}) {
  const userData = await mkdtemp(path.join(tmpdir(), "gd-e2e-user-"));
  const child = spawn("xvfb-run", ["-a", bin, "--no-sandbox", "--disable-gpu", `--user-data-dir=${userData}`, `--remote-debugging-port=${debugPort}`], {
    env: { ...process.env, GENDRAGOON_E2E: "1", GENDRAGOON_UPDATE_REPO: "o/r", GENDRAGOON_UPDATE_API_BASE: base, ...extraEnv }, stdio: "ignore",
  });
  const exited = new Promise((r) => child.once("exit", r));
  return { child, exited, userData };
}
async function connect(port) {
  for (let i = 0; i < 80; i += 1) {
    try { return await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null }); } catch { await sleep(250); }
  }
  throw new Error("could not connect to Electron");
}
async function shellPage(browser) {
  for (let i = 0; i < 80; i += 1) {
    const page = (await browser.pages()).find((p) => p.url().startsWith("file://"));
    if (page) return page;
    await sleep(250);
  }
  throw new Error("no window");
}
const state = (page) => page.$eval("[data-testid='update-control']", (n) => n.dataset.state);
const exists = async (file) => { try { await readFile(file); return true; } catch { return false; } };

try {
  // 1 + 2
  let app = await launch(9341);
  let browser = await connect(9341);
  let page = await shellPage(browser);
  check("Electron main process starts and shows the window", (await page.title()) === "GenDragoon Cloud SSD");
  await page.waitForSelector("[data-testid='nav-settings']");
  await page.click("[data-testid='nav-settings']");
  await page.waitForSelector("[data-testid='update-check']");
  await page.click("[data-testid='update-check']");
  await page.waitForFunction(() => document.querySelector("[data-testid='update-control']")?.dataset.state === "up_to_date", { timeout: 15000 });
  check("manual check against a current feed says up to date", true, await page.$eval("[data-testid='update-status']", (n) => n.textContent));
  await page.screenshot({ path: path.join(shotDir, "electron-up-to-date.png") });

  feedVersion = "9.9.9";
  const seenList = [];
  await page.exposeFunction("__report", (st) => { if (seenList.at(-1) !== st) seenList.push(st); });
  await page.evaluate(() => {
    const node = document.querySelector("[data-testid='update-control']");
    new MutationObserver(() => window.__report(node.dataset.state)).observe(node, { attributes: true, attributeFilter: ["data-state"] });
  });
  const poll = setInterval(() => { seenNow = seenList.join(">"); }, 20);
  await page.click("[data-testid='update-check']").catch(() => undefined);
  await Promise.race([app.exited, sleep(30000)]);
  clearInterval(poll);
  check("manual check with a newer feed: app quits by itself", app.child.exitCode !== null || app.child.signalCode !== null);
  check("button shows progress states (checking -> ... -> installing/relaunching)", seenNow.startsWith("checking") && /installing|relaunching/.test(seenNow), seenNow);
  for (let i = 0; i < 60 && !(await exists(`${mark}/relaunched`)); i += 1) await sleep(100);
  check("installer ran detached with /S --updated --force-run", (await readFile(`${mark}/installer.args`, "utf8").catch(() => "")).trim() === "/S --updated --force-run");
  check("installer outlived the app and finished (relaunch marker)", await exists(`${mark}/relaunched`));
  check("pending-update marker written before install", await exists(path.join(app.userData, "pending-update.json")));
  await browser.disconnect().catch(() => undefined);

  // 3: startup auto-update with no click
  await import("node:fs/promises").then((fs) => fs.rm(`${mark}/relaunched`, { force: true }));
  app = await launch(9342);
  await Promise.race([app.exited, sleep(40000)]);
  check("startup check: app updates and quits with no click", app.child.exitCode !== null || app.child.signalCode !== null);
  for (let i = 0; i < 60 && !(await exists(`${mark}/relaunched`)); i += 1) await sleep(100);
  check("startup check: installer ran", await exists(`${mark}/relaunched`));

  // 4 + 5: store distributions leave updating alone even though the feed has a newer version.
  for (const [name, extraEnv, port] of [["rotten-apple (launcher marker)", { ROTTEN_APPLE_LAUNCHER: "1" }, 9343], ["mas (Mac App Store)", { GENDRAGOON_DISTRIBUTION: "mas" }, 9344]]) {
    await import("node:fs/promises").then((fs) => Promise.all([fs.rm(`${mark}/relaunched`, { force: true }), fs.rm(`${mark}/installer.args`, { force: true })]));
    const store = await launch(port, extraEnv);
    const b = await connect(port);
    const pg = await shellPage(b);
    await pg.waitForSelector("[data-testid='nav-settings']");
    await pg.click("[data-testid='nav-settings']");
    await sleep(2500);
    const hasButton = (await pg.$("[data-testid='update-check']")) !== null;
    const managed = await pg.$eval("body", () => document.querySelector("[data-testid='update-managed']")?.textContent ?? "");
    check(`${name}: no Check for updates button`, !hasButton);
    check(`${name}: ${name.startsWith("rotten") ? "shows launcher note" : "update UI fully hidden"}`, name.startsWith("rotten") ? /launcher/i.test(managed) : managed === "");
    await pg.screenshot({ path: path.join(shotDir, `electron-${name.split(" ")[0]}.png`) });
    await sleep(3000);
    check(`${name}: app stays running, installer never started`, store.child.exitCode === null && !(await exists(`${mark}/installer.args`)));
    await b.disconnect().catch(() => undefined);
    store.child.kill("SIGTERM");
    spawn("pkill", ["-f", `remote-debugging-port=${port}`]);
    await sleep(1000);
  }
} finally {
  server.close();
  await rm(bareDir, { recursive: true, force: true }).catch(() => undefined);
  spawn("pkill", ["-f", "gd-e2e-electron-"]);
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
