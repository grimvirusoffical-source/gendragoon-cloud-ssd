// Node-only helpers: folder sync with the local disk and the PKCE loopback listener.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import * as path from "node:path";
import { fromB64u, random } from "./bytes.js";
import { KEY_BYTES } from "./crypto.js";
import { cleanPath, readEntry, type Drive, type FileEntry } from "./drive.js";
import { CODE_RE, type PKCE } from "./connect.js";
import type { Client } from "./client.js";

export * from "./index.js";

export interface SyncOptions {
  /** Drive folder that corresponds to the local folder ("" is the drive root). */
  prefix?: string;
  /** Report what would change without changing anything. */
  dryRun?: boolean;
  /** True for local relative paths (slash-separated) that must not be synced. */
  skip?: (rel: string) => boolean;
}
export interface SyncReport { uploaded: string[]; downloaded: string[]; deleted: string[]; unchanged: number }
interface LocalFile { abs: string; size: number; mtimeMs: number }

async function scanLocal(root: string, skip?: (rel: string) => boolean): Promise<Map<string, LocalFile>> {
  const out = new Map<string, LocalFile>();
  async function walk(dir: string, rel: string) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" && rel === "") return;
      throw e;
    }
    for (const de of entries) {
      const r = rel ? `${rel}/${de.name}` : de.name;
      if (skip?.(r)) continue;
      const abs = path.join(dir, de.name);
      if (de.isDirectory()) await walk(abs, r);
      else if (de.isFile()) { // symlinks and special files are never followed or uploaded
        const st = await stat(abs);
        out.set(r, { abs, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
      }
    }
  }
  await walk(root, "");
  return out;
}
const drivePath = (prefix: string, rel: string) => (prefix ? `${prefix}/${rel}` : rel);
const under = (p: string, prefix: string) => !prefix || p.startsWith(prefix + "/");
const relOf = (p: string, prefix: string) => (prefix ? p.slice(prefix.length + 1) : p);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function push(d: Drive, localDir: string, opts: SyncOptions, mirror: boolean): Promise<SyncReport> {
  const prefix = opts.prefix ?? "";
  if (prefix) cleanPath(prefix);
  const local = await scanLocal(localDir, opts.skip);
  const { doc } = await d.load();
  const rep: SyncReport = { uploaded: [], downloaded: [], deleted: [], unchanged: 0 };
  const changed = new Map<string, FileEntry>();
  for (const rel of [...local.keys()].sort()) {
    const dp = cleanPath(drivePath(prefix, rel));
    const lf = local.get(rel)!;
    const data = new Uint8Array(await readFile(lf.abs));
    const old = doc.files[dp];
    if (old && old.sha256 === sha(data) && old.size === lf.size) { rep.unchanged++; continue; }
    rep.uploaded.push(dp);
    if (opts.dryRun) continue;
    let fileKey: Uint8Array | null = null;
    if (d.encrypted) {
      if (old?.key) fileKey = fromB64u(old.key);
      if (!fileKey || fileKey.length !== KEY_BYTES) fileKey = random(KEY_BYTES);
    }
    const entry = await d.upload(fileKey, data);
    entry.mtime = lf.mtimeMs;
    changed.set(dp, entry);
  }
  const gone: string[] = [];
  if (mirror) {
    for (const p of Object.keys(doc.files)) if (under(p, prefix) && !local.has(relOf(p, prefix))) gone.push(p);
    gone.sort();
    rep.deleted = gone;
  }
  if (opts.dryRun || (changed.size === 0 && gone.length === 0)) return rep;
  await d.update((latest) => {
    for (const [p, e] of changed) latest.files[p] = e;
    for (const p of gone) delete latest.files[p];
  });
  return rep;
}

async function writeAtomic(target: string, data: Uint8Array, mtimeMs: number) {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.gd-${randomBytes(6).toString("hex")}`);
  try {
    await writeFile(tmp, data);
    await rename(tmp, target);
  } finally {
    await rm(tmp, { force: true });
  }
  const t = new Date(mtimeMs);
  await utimes(target, t, t);
}

async function pull(d: Drive, c: Client, localDir: string, opts: SyncOptions, mirror: boolean): Promise<SyncReport> {
  const prefix = opts.prefix ?? "";
  const { doc } = await d.load();
  const local = await scanLocal(localDir, opts.skip);
  const rep: SyncReport = { uploaded: [], downloaded: [], deleted: [], unchanged: 0 };
  const remote = new Set<string>();
  const root = path.resolve(localDir);
  for (const p of Object.keys(doc.files).sort()) {
    if (!under(p, prefix)) continue;
    const rel = relOf(p, prefix);
    if (opts.skip?.(rel)) continue;
    remote.add(rel);
    const e = doc.files[p]!;
    const lf = local.get(rel);
    if (lf && lf.size === e.size && sha(new Uint8Array(await readFile(lf.abs))) === e.sha256) { rep.unchanged++; continue; }
    rep.downloaded.push(p);
    if (opts.dryRun) continue;
    const target = path.resolve(root, ...rel.split("/"));
    if (!target.startsWith(root + path.sep)) throw new Error("gendragoon: drive path escapes the local folder");
    await writeAtomic(target, await readEntry(c, e), e.mtime);
  }
  if (mirror) {
    for (const rel of [...local.keys()].sort()) {
      if (remote.has(rel)) continue;
      rep.deleted.push(drivePath(prefix, rel));
      if (!opts.dryRun) await rm(local.get(rel)!.abs);
    }
  }
  return rep;
}

/** Uploads local files that are new or differ from the drive (by SHA-256). Remote-only files are kept. Level L2, risk write. */
export function pushFolder(c: Client, d: Drive, localDir: string, opts: SyncOptions = {}): Promise<SyncReport> {
  c.check("sync.push");
  return push(d, localDir, opts, false);
}
/** Downloads drive files that are new or differ locally, written atomically. Local-only files are kept. Level L2, risk write. */
export function pullFolder(c: Client, d: Drive, localDir: string, opts: SyncOptions = {}): Promise<SyncReport> {
  c.check("sync.pull");
  return pull(d, c, localDir, opts, false);
}
/** Makes one side identical to the other, deleting files only on the target side. Level L3, risk bulk-destructive. Try dryRun first. */
export function mirrorFolder(c: Client, d: Drive, localDir: string, direction: "toDrive" | "toLocal", opts: SyncOptions = {}): Promise<SyncReport> {
  c.check("sync.mirror");
  return direction === "toDrive" ? push(d, localDir, opts, true) : pull(d, c, localDir, opts, true);
}

/** Listens on 127.0.0.1 for the redirect that carries the authorization code. */
export class Loopback {
  private constructor(private readonly server: Server, readonly redirectUri: string, private readonly code: Promise<string>) {}
  static async listen(p: PKCE): Promise<Loopback> {
    let deliver!: (c: string) => void;
    const code = new Promise<string>((r) => (deliver = r));
    const want = Buffer.from(p.state);
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const got = Buffer.from(u.searchParams.get("state") ?? "");
      const c = u.searchParams.get("code") ?? "";
      if (u.pathname !== "/gendragoon/callback" || got.length !== want.length || !timingSafeEqual(got, want) || !CODE_RE.test(c)) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("This link is not for this app.\n");
        return;
      }
      deliver(c);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Connected. You can close this window and return to the app.\n");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    return new Loopback(server, `http://127.0.0.1:${port}/gendragoon/callback`, code);
  }
  /** The authorization code; rejects after timeoutMs (default 5 minutes). Closes the listener either way. */
  async wait(timeoutMs = 300_000): Promise<string> {
    let t: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([this.code, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("gendragoon: timed out waiting for the connect redirect")), timeoutMs); })]);
    } finally {
      clearTimeout(t);
      this.close();
    }
  }
  close(): void { this.server.close(); }
}
