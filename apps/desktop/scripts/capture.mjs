import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.SCREENSHOT_DIR || "/opt/cursor/artifacts/screenshots";
const chrome = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const port = 4173;

const preview = spawn(
  "pnpm",
  ["exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
);

let logs = "";
preview.stdout.on("data", (chunk) => { logs += chunk.toString(); });
preview.stderr.on("data", (chunk) => { logs += chunk.toString(); });

try {
  await waitForServer(`http://127.0.0.1:${port}/`);
  await mkdir(outDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${port}/#/lock`, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-testid='lock-screen']");
  const previewText = await page.$eval("[data-testid='merge-preview']", (node) => node.textContent ?? "");
  if (!previewText.includes("(from ")) throw new Error(`Merge preview missing rename: ${previewText}`);
  await shot(page, "lock-screen.png");

  await page.click("[data-testid='delete-unpaid-1']");
  await page.waitForFunction(() => !document.body.textContent?.includes("Field recordings"));
  await page.click("[data-testid='nav-files']");
  await page.waitForSelector("[data-testid='primary-action']");
  const uploadLabel = await page.$eval("[data-testid='primary-action']", (node) => node.textContent ?? "");
  if (uploadLabel.trim() !== "Upload") throw new Error(`Expected Upload, saw ${uploadLabel}`);
  await shot(page, "uploader.png");

  await page.click("[data-testid='nav-backup']");
  await page.waitForFunction(() => document.querySelector("[data-testid='primary-action']")?.textContent?.includes("Make secure backup"));
  const uploadButtons = await page.$$eval("button", (nodes) => nodes.map((node) => node.textContent?.trim()).filter((text) => text === "Upload"));
  if (uploadButtons.length !== 0) throw new Error("Backup view still shows an Upload button");
  await page.click("[data-testid='primary-action']");
  await page.waitForFunction(() => document.querySelector("[data-testid='status']")?.textContent?.includes("Make secure backup queued"));
  await shot(page, "backup-manager.png");

  await page.click("[data-testid='nav-settings']");
  await page.waitForSelector("[data-testid='sort-.jpg']");
  await page.select("[data-testid='sort-.jpg']", "Audio");
  const saved = await page.$eval("[data-testid='settings-view']", (node) => node.textContent ?? "");
  if (!saved.includes("Saved override")) throw new Error("Settings override did not persist in the view");
  await shot(page, "settings-mapping.png");

  await page.click("[data-testid='nav-connect']");
  await page.waitForSelector("[data-testid='provider-gcs-s3']");
  const providers = await page.$$eval("[data-testid^='provider-']", (nodes) => nodes.map((node) => node.getAttribute("data-testid")));
  for (const id of ["provider-aws", "provider-r2", "provider-b2", "provider-wasabi", "provider-minio", "provider-gcs-s3", "provider-sftp"]) {
    if (!providers.includes(id)) throw new Error(`Missing ${id}`);
  }
  if (providers.some((id) => id?.includes("azure") || id?.includes("webdav"))) {
    throw new Error(`Later providers were selectable: ${providers.join(",")}`);
  }
  await page.click("[data-testid='byo-challenge']");
  await page.waitForFunction(() => document.querySelector("[data-testid='byo-message']")?.textContent?.includes("Credentials were not included"));
  await shot(page, "connect-storage.png");

  await browser.close();
  console.log(`screenshots written to ${outDir}`);
} finally {
  preview.kill("SIGTERM");
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(outDir, name) });
}

async function waitForServer(url) {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // preview is still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite preview did not start\n${logs}`);
}
