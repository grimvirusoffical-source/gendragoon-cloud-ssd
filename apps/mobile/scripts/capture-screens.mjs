import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const outDir = path.resolve(root, process.env.SCREENSHOT_DIR || "docs/screenshots");

const source = await readFile(path.join(root, "src/shots.tsx"), "utf8");
const block = source.match(/export const SHOTS = \[([\s\S]*?)\] as const;/);
if (!block) throw new Error("Could not read SHOTS from src/shots.tsx");
const shots = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
if (shots.length === 0) throw new Error("No screenshot ids");

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = path.resolve(dist, `.${pathname}`);
  if (!file.startsWith(dist)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const written = [];
try {
  for (const shot of shots) {
    await page.goto(`http://127.0.0.1:${port}/index.html?shot=${encodeURIComponent(shot)}`, { waitUntil: "networkidle" });
    const frame = page.getByTestId("shot-ready");
    await frame.waitFor({ timeout: 15000 });
    const file = path.join(outDir, `${shot}.png`);
    await frame.screenshot({ path: file });
    written.push(file);
  }
} finally {
  await browser.close();
  server.close();
}

if (written.length !== shots.length) {
  throw new Error(`Captured ${written.length} of ${shots.length} screens`);
}
console.log(written.join("\n"));
