/* global process, console, document, getComputedStyle, setTimeout, URL */
/**
 * Renders store listing images from the built Chromium extension: 1280x800 screenshots (options page, popup on a branded canvas)
 * in dark and light, and the 440x280 small promo tile. Output: $STORE_ASSET_DIR (default ./store-assets).
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.STORE_ASSET_DIR || path.join(root, "store-assets");
const chrome = process.env.CHROME_PATH || "/opt/ungoogled-chromium/chrome";
const version = JSON.parse((await import("node:fs")).readFileSync(path.join(root, "package.json"), "utf8")).version;
await mkdir(out, { recursive: true });
const dir = await mkdtemp(path.join(tmpdir(), "gd-store-"));
spawnSync("unzip", ["-q", path.join(root, "dist-zips", `GenDragoon-Extension-chrome-${version}.zip`), "-d", dir]);
const b = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: await mkdtemp(path.join(tmpdir(), "gd-p-")),
  args: ["--no-sandbox", "--disable-features=DisableLoadExtensionCommandLineSwitch", "--enable-unsafe-extension-debugging", `--disable-extensions-except=${dir}`, `--load-extension=${dir}`] });
try {
  const sw = await b.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 15000 });
  const id = new URL(sw.url()).host;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const theme of ["dark", "light"]) {
    const page = await b.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.goto(`chrome-extension://${id}/options.html`, { waitUntil: "networkidle0" });
    await page.click(`#theme button[data-theme='${theme}']`);
    await page.waitForFunction(() => /Online|Offline/.test(document.getElementById("status")?.textContent ?? ""), { timeout: 12000 });
    await wait(700);
    await page.screenshot({ path: path.join(out, `screenshot-1-settings-${theme}-1280x800.png`) });
    // Popup rendered on a 1280x800 canvas.
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.goto(`chrome-extension://${id}/popup.html`, { waitUntil: "networkidle0" });
    await page.click(`#theme button[data-theme='${theme}']`);
    await page.type("#filename", "holiday.mp4");
    await page.waitForFunction(() => /Online|Offline/.test(document.getElementById("status")?.textContent ?? ""), { timeout: 12000 });
    await wait(700);
    await page.evaluate(() => {
      const bg = getComputedStyle(document.body).backgroundColor;
      document.body.style.cssText += `;width:380px;margin:20px auto;border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.5);transform:scale(1.3);transform-origin:top center;background:${bg}`;
      document.documentElement.style.background = "radial-gradient(900px 500px at 50% -10%, rgba(139,92,246,.35), transparent 70%), #07050d";
    });
    await page.screenshot({ path: path.join(out, `screenshot-2-popup-${theme}-1280x800.png`) });
    await page.close();
  }
} finally {
  await b.close();
}
console.log("store assets in", out);
