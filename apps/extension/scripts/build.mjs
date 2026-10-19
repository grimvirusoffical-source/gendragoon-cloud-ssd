/* global process, console */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSERS, DEFAULT_API_BASE, manifestFor } from "./manifests.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const apiBase = process.env.GENDRAGOON_API_BASE || DEFAULT_API_BASE;
const zip = process.argv.includes("--zip");
const outRoot = process.env.EXT_OUT || path.join(root, "dist");
const zipDir = process.env.EXT_ZIP_DIR || path.join(root, "dist-zips");

await rm(outRoot, { recursive: true, force: true });
if (zip) await mkdir(zipDir, { recursive: true });
for (const browser of BROWSERS) {
  const dir = path.join(outRoot, browser);
  await mkdir(dir, { recursive: true });
  await build({
    entryPoints: { popup: path.join(root, "src/popup.ts"), background: path.join(root, "src/background.ts"), "popup-style": path.join(root, "src/popup.css") },
    outdir: dir, bundle: true, format: "iife", target: ["chrome114", "firefox128"], minify: true, sourcemap: false, legalComments: "none",
    define: { __API_BASE__: JSON.stringify(apiBase) }, loader: { ".png": "dataurl" }, logLevel: "warning",
  });
  // esbuild names the css after its entry; popup.html links popup.css.
  await cp(path.join(dir, "popup-style.css"), path.join(dir, "popup.css"));
  await rm(path.join(dir, "popup-style.css"));
  await cp(path.join(root, "src/popup.html"), path.join(dir, "popup.html"));
  await cp(path.join(root, "icons"), path.join(dir, "icons"), { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifestFor(browser, pkg.version, apiBase), null, 2)}\n`);
  if (zip) {
    const file = path.join(zipDir, `GenDragoon-Extension-${browser}-${pkg.version}.zip`);
    await rm(file, { force: true });
    // Deterministic zip (sorted names, fixed timestamps) so the same input gives the same bytes.
    const py = "import sys,os,zipfile\nd,f=sys.argv[1:3]\nz=zipfile.ZipFile(f,'w',zipfile.ZIP_DEFLATED)\nfor r,_,fs in os.walk(d):\n  for n in fs: pass\nnames=sorted(os.path.relpath(os.path.join(r,n),d) for r,_,fs in os.walk(d) for n in fs)\nfor n in names:\n  i=zipfile.ZipInfo(n,(2026,1,1,0,0,0)); i.compress_type=zipfile.ZIP_DEFLATED; i.external_attr=0o644<<16\n  z.writestr(i,open(os.path.join(d,n),'rb').read())\nz.close()\n";
    const r = spawnSync("python3", ["-c", py, dir, file], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`zip failed for ${browser}`);
    console.log(`zip ${file}`);
  }
}
console.log(`built ${BROWSERS.join(", ")} v${pkg.version} (api ${apiBase})`);
