/* global process, console, document, getComputedStyle, localStorage */
/**
 * Loads each Chromium-family zip (chrome, edge, opera) as a real unpacked extension in headless Chrome,
 * opens the popup, and drives it. Firefox is linted separately with web-ext (see package.json).
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const zipDir = process.env.EXT_ZIP_DIR || path.join(root, "dist-zips");
const shotDir = process.env.SCREENSHOT_DIR || path.join(root, "screenshots");
const chrome = process.env.CHROME_PATH || "/opt/ungoogled-chromium/chrome"; // branded Chrome 137+ ignores --load-extension
const version = JSON.parse((await import("node:fs")).readFileSync(path.join(root, "package.json"), "utf8")).version;
await mkdir(shotDir, { recursive: true });
let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed += 1; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`); };

for (const browser of ["chrome", "edge", "opera"]) {
  const dir = await mkdtemp(path.join(tmpdir(), `gd-ext-${browser}-`));
  const unzip = spawnSync("unzip", ["-q", path.join(zipDir, `GenDragoon-Extension-${browser}-${version}.zip`), "-d", dir]);
  check(`${browser}: zip unpacks`, unzip.status === 0);
  const profile = await mkdtemp(path.join(tmpdir(), "gd-prof-"));
  const b = await puppeteer.launch({
    executablePath: chrome, headless: true, userDataDir: profile,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-features=DisableLoadExtensionCommandLineSwitch", "--enable-unsafe-extension-debugging", `--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  try {
    const sw = await b.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 15000 });
    const id = new URL(sw.url()).host;
    check(`${browser}: service worker started`, /^[a-p]{32}$/.test(id), id);
    const page = await b.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.setViewport({ width: 380, height: 640, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await page.goto(`chrome-extension://${id}/popup.html`, { waitUntil: "networkidle0" });
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check(`${browser}: popup defaults to dark even with a light OS`, theme === "dark" && bg === "rgb(13, 11, 20)", `${theme} ${bg}`);
    await page.waitForFunction(() => /Online|Offline/.test(document.getElementById("status")?.textContent ?? ""), { timeout: 12000 });
    const status = await page.$eval("#status", (n) => n.textContent);
    check(`${browser}: service status rendered`, /Online|Offline/.test(status ?? ""), status ?? "");
    await page.type("#filename", "holiday.MP4");
    const sorted = await page.$eval("#sort-result", (n) => n.textContent);
    check(`${browser}: sorter says Videos`, /Videos/.test(sorted ?? ""), sorted ?? "");
    await page.screenshot({ path: path.join(shotDir, `popup-${browser}-dark.png`) });
    await page.click("#theme button[data-theme='light']");
    await new Promise((r) => setTimeout(r, 600));
    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check(`${browser}: Light theme applies`, lightBg === "rgb(246, 244, 251)", lightBg);
    await page.screenshot({ path: path.join(shotDir, `popup-${browser}-light.png`) });
    await page.reload({ waitUntil: "networkidle0" });
    check(`${browser}: theme persists`, (await page.evaluate(() => document.documentElement.dataset.theme)) === "light");
    await page.click("#theme button[data-theme='system']");
    await new Promise((r) => setTimeout(r, 500));
    check(`${browser}: System follows the (light) OS`, (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(246, 244, 251)");
    check(`${browser}: no script errors`, errors.length === 0, errors.join("; "));
  } finally {
    await b.close();
    await rm(dir, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  }
}
console.log(failed ? `${failed} check(s) failed` : "all extension load checks passed");
process.exit(failed ? 1 : 0);
