// Encrypted (or plain) files and folders stored in one manifest per drive, committed with compare-and-swap.
import { fromB64u, random, toB64u, toHex } from "./bytes.js";
import { CorruptError, KEY_BYTES, driveManifestKey, openChunk, openManifest, sealChunk, sealManifest, sha256, text } from "./crypto.js";
import { APIError, isNotFound, isPreconditionFailed, type Client } from "./client.js";
import type { Keyring } from "./keyring.js";

export const DEFAULT_CHUNK_SIZE = 4 << 20;

export interface FileEntry { size: number; mtime: number; sha256: string; chunks: string[]; key?: string }
export interface DriveDocument { v: 1; encrypted: boolean; files: Record<string, FileEntry>; folders: string[] | null; updatedAt: number }
export interface Entry { name: string; path: string; folder: boolean; size: number; mtime: Date | null }
export interface DriveOptions { plain?: boolean; chunkSize?: number }

const notFound = () => new APIError(404, "not_found");

/** Validates a drive path: slash-separated, no leading/trailing slash, no empty, "." or ".." segments, no backslash or control characters, at most 1024 bytes. */
export function cleanPath(p: string): string {
  const bad = () => new Error(`gendragoon: invalid path ${JSON.stringify(p)}`);
  if (!p || text.encode(p).length > 1024 || p.startsWith("/") || p.endsWith("/") || p.includes("\\")) throw bad();
  for (const seg of p.split("/")) {
    if (!seg || seg === "." || seg === ".." || /[\x00-\x1f\x7f]/.test(seg)) throw bad();
  }
  return p;
}
/** folder/slot for a save slot; slot must be one path segment and folder "" or a valid drive path. */
export function slotPath(folder: string, slot: string): string {
  if (!slot || slot.includes("/")) throw new Error(`gendragoon: invalid slot name ${JSON.stringify(slot)}`);
  return cleanPath(folder ? `${folder}/${slot}` : slot);
}
const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function folderSet(doc: DriveDocument): Set<string> {
  const set = new Set(doc.folders ?? []);
  for (const p of Object.keys(doc.files)) for (let d = dirname(p); d; d = dirname(d)) set.add(d);
  return set;
}

/** JSON with sorted object keys and the Go SDK's field order, so documents diff cleanly across SDKs. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)}:${stableJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
function encodeDoc(doc: DriveDocument): string {
  const files: Record<string, unknown> = {};
  for (const k of Object.keys(doc.files).sort()) {
    const e = doc.files[k]!;
    files[k] = e.key ? { size: e.size, mtime: e.mtime, sha256: e.sha256, chunks: e.chunks, key: e.key } : { size: e.size, mtime: e.mtime, sha256: e.sha256, chunks: e.chunks };
  }
  const head = `{"v":1,"encrypted":${doc.encrypted},"files":`;
  return head + `{${Object.entries(files).map(([k, x]) => `${JSON.stringify(k)}:${stableJson(x)}`).join(",")}}` +
    `,"folders":${doc.folders && doc.folders.length ? JSON.stringify(doc.folders) : "null"},"updatedAt":${doc.updatedAt}}`;
}

export class Drive {
  readonly manifestKey: string;
  private readonly chunkSize: number;
  private constructor(private readonly c: Client, private readonly keys: Keyring | null, readonly name: string, key: string, chunkSize: number) {
    this.manifestKey = key;
    this.chunkSize = chunkSize;
  }
  /** Opens the drive called name; nothing is read until the first call. Encrypted drives need an unlocked keyring. */
  static async open(c: Client, name: string, keys: Keyring | null, opts: DriveOptions = {}): Promise<Drive> {
    if (!name || text.encode(name).length > 128) throw new Error("gendragoon: drive name must be 1 to 128 bytes");
    const cs = opts.chunkSize && opts.chunkSize > 0 ? opts.chunkSize : DEFAULT_CHUNK_SIZE;
    if (cs > (16 << 20) - 64) throw new Error("gendragoon: chunk size must be below 16 MiB");
    if (opts.plain) return new Drive(c, null, name, await driveManifestKey(null, name), cs);
    if (!keys) throw new Error("gendragoon: an encrypted drive needs a keyring (or pass plain: true)");
    return new Drive(c, keys, name, await driveManifestKey(keys.master(), name), cs);
  }
  private mk(): Uint8Array | null { return this.keys ? this.keys.master() : null; }
  get encrypted(): boolean { return this.keys !== null; }

  /** @internal */
  async load(): Promise<{ doc: DriveDocument; gen: string }> {
    let m;
    try {
      m = await this.c.getManifest(this.manifestKey);
    } catch (e) {
      if (isNotFound(e)) return { doc: { v: 1, encrypted: this.encrypted, files: {}, folders: null, updatedAt: 0 }, gen: "" };
      throw e;
    }
    let doc: DriveDocument;
    try {
      doc = JSON.parse(text.decode(await openManifest(this.mk(), this.manifestKey, m.data))) as DriveDocument;
    } catch (e) {
      if (e instanceof CorruptError || e instanceof SyntaxError || e instanceof TypeError) throw new CorruptError();
      throw e;
    }
    if (doc.v !== 1) throw new CorruptError();
    doc.files ??= {};
    return { doc, gen: m.generation };
  }

  /** @internal Applies fn to the latest document and commits it, retrying on conflict. */
  async update(fn: (doc: DriveDocument) => void): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const { doc, gen } = await this.load();
      fn(doc);
      doc.updatedAt = Date.now();
      if (doc.folders) doc.folders.sort();
      const body = text.encode(encodeDoc(doc));
      try {
        await this.c.putManifest(this.manifestKey, await sealManifest(this.mk(), this.manifestKey, body), gen ? { ifGeneration: gen } : { ifAbsent: true });
        return;
      } catch (e) {
        if (!isPreconditionFailed(e) || attempt >= 12) throw e;
      }
      await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * (40 << Math.min(attempt, 4)))));
    }
  }

  async snapshot(): Promise<DriveDocument> {
    this.c.check("files.list");
    return (await this.load()).doc;
  }
  /** Direct children of folder ("" is the root): folders first, then by name. */
  async list(folder = ""): Promise<Entry[]> {
    this.c.check("files.list");
    if (folder) cleanPath(folder);
    const { doc } = await this.load();
    const out: Entry[] = [];
    for (const f of folderSet(doc)) if (dirname(f) === folder) out.push({ name: basename(f), path: f, folder: true, size: 0, mtime: null });
    for (const [p, e] of Object.entries(doc.files)) if (dirname(p) === folder) out.push({ name: basename(p), path: p, folder: false, size: e.size, mtime: new Date(e.mtime) });
    return out.sort((a, b) => (a.folder !== b.folder ? (a.folder ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  async stat(p: string): Promise<FileEntry> {
    this.c.check("files.stat");
    const e = (await this.load()).doc.files[p];
    if (!e) throw notFound();
    return e;
  }

  /** Creates or replaces a file. Unchanged chunks of an existing file are not uploaded again. */
  async writeFile(p: string, data: Uint8Array, opts: { mtime?: Date } = {}): Promise<FileEntry> {
    this.c.check("files.write");
    cleanPath(p);
    let fileKey: Uint8Array | null = null;
    if (this.keys) {
      try {
        const old = (await this.load()).doc.files[p];
        if (old?.key) fileKey = fromB64u(old.key);
      } catch { /* a fresh key below */ }
      if (!fileKey || fileKey.length !== KEY_BYTES) fileKey = random(KEY_BYTES);
    }
    const entry = await this.upload(fileKey, data);
    entry.mtime = opts.mtime ? opts.mtime.getTime() : Date.now();
    await this.update((doc) => {
      if (folderSet(doc).has(p)) throw new Error(`gendragoon: ${JSON.stringify(p)} is a folder`);
      for (let d = dirname(p); d; d = dirname(d)) if (doc.files[d]) throw new Error(`gendragoon: ${JSON.stringify(d)} is a file`);
      doc.files[p] = entry;
    });
    return entry;
  }

  /** @internal */
  async upload(fileKey: Uint8Array | null, data: Uint8Array): Promise<FileEntry> {
    const entry: FileEntry = { size: data.length, mtime: 0, sha256: toHex(await sha256(data)), chunks: [] };
    if (fileKey) entry.key = toB64u(fileKey);
    const parts: { id: string; blob: Uint8Array }[] = [];
    for (let off = 0; off < data.length; off += this.chunkSize) {
      const chunk = data.subarray(off, Math.min(off + this.chunkSize, data.length));
      parts.push(fileKey ? await sealChunk(fileKey, chunk) : { id: toHex(await sha256(chunk)), blob: chunk });
    }
    const have = new Set(await this.c.hasBlobs(parts.map((x) => x.id)));
    for (const part of parts) {
      entry.chunks.push(part.id);
      if (have.has(part.id)) continue;
      if (fileKey) await this.c.putSealedBlob(part.id, part.blob);
      else await this.c.putBlob(part.blob);
      have.add(part.id);
    }
    return entry;
  }

  /** A file's content, verified against its SHA-256. */
  async readFile(p: string): Promise<Uint8Array> {
    this.c.check("files.read");
    const e = (await this.load()).doc.files[p];
    if (!e) throw notFound();
    return readEntry(this.c, e);
  }

  /** Creates a folder and its parents. An existing folder is not an error. */
  async mkdir(p: string): Promise<void> {
    this.c.check("files.mkdir");
    cleanPath(p);
    await this.update((doc) => {
      const set = folderSet(doc);
      doc.folders ??= [];
      for (let d = p; d; d = dirname(d)) {
        if (doc.files[d]) throw new Error(`gendragoon: ${JSON.stringify(d)} is a file`);
        if (!set.has(d)) { doc.folders.push(d); set.add(d); }
      }
    });
  }

  /** Renames a file or a folder with everything in it. The destination must not exist. */
  async move(from: string, to: string): Promise<void> {
    this.c.check("files.move");
    cleanPath(from); cleanPath(to);
    if (to === from || to.startsWith(from + "/")) throw new Error("gendragoon: cannot move a folder into itself");
    await this.update((doc) => {
      const set = folderSet(doc);
      if (doc.files[to] || set.has(to)) throw new Error(`gendragoon: ${JSON.stringify(to)} already exists`);
      const e = doc.files[from];
      if (e) { delete doc.files[from]; doc.files[to] = e; return; }
      if (!set.has(from)) throw notFound();
      for (const [p, f] of Object.entries(doc.files)) {
        if (p.startsWith(from + "/")) { delete doc.files[p]; doc.files[to + p.slice(from.length)] = f; }
      }
      const folders = (doc.folders ?? []).map((f) => (f === from || f.startsWith(from + "/") ? to + f.slice(from.length) : f));
      folders.push(to);
      doc.folders = [...new Set(folders)];
    });
  }

  /** Removes one file or one empty folder. Level L3, risk destructive. Blobs stay until collectGarbage. Cloud saves at L2 use deleteSlot. */
  async delete(p: string): Promise<void> {
    this.c.check("files.delete");
    await this.update((doc) => {
      if (doc.files[p]) { delete doc.files[p]; return; }
      const set = folderSet(doc);
      if (!set.has(p)) throw notFound();
      for (const q of [...set, ...Object.keys(doc.files)]) if (q.startsWith(p + "/")) throw new Error(`gendragoon: folder ${JSON.stringify(p)} is not empty`);
      doc.folders = (doc.folders ?? []).filter((f) => f !== p);
    });
  }

  /**
   * Removes one save slot, the file folder/slot, where slot is a single path segment. It never removes a folder,
   * a nested file or anything outside folder, and only changes this drive's manifest (blobs stay until
   * collectGarbage). Its reach equals overwriting the slot, which L2 allows. Level L2, risk destructive.
   */
  async deleteSlot(folder: string, slot: string): Promise<void> {
    this.c.check("files.deleteSlot");
    const p = slotPath(folder, slot);
    await this.update((doc) => {
      if (!doc.files[p]) throw notFound();
      delete doc.files[p];
    });
  }

  /** Removes a folder and everything in it; returns how many files were removed. Level L3, risk bulk-destructive. */
  async deleteFolder(p: string): Promise<number> {
    this.c.check("files.deleteFolder");
    let n = 0;
    await this.update((doc) => {
      n = 0;
      for (const q of Object.keys(doc.files)) if (q.startsWith(p + "/")) { delete doc.files[q]; n++; }
      doc.folders = (doc.folders ?? []).filter((f) => f !== p && !f.startsWith(p + "/"));
    });
    return n;
  }
}

/** @internal Downloads and verifies one file entry. */
export async function readEntry(c: Client, e: FileEntry): Promise<Uint8Array> {
  let fileKey: Uint8Array | null = null;
  if (e.key) {
    try { fileKey = fromB64u(e.key); } catch { throw new CorruptError(); }
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const id of e.chunks) {
    let blob = await c.getBlob(id);
    if (fileKey) blob = await openChunk(fileKey, id, blob);
    parts.push(blob);
    total += blob.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  if (total !== e.size || toHex(await sha256(out)) !== e.sha256) throw new CorruptError();
  return out;
}

/**
 * Deletes blobs no drive references. Refuses if any manifest cannot be read as a drive (it could reference
 * blobs this SDK does not know about), unless force is set. Level L3, risk bulk-destructive.
 */
export async function collectGarbage(c: Client, keys: Keyring | null, force = false): Promise<number> {
  c.check("files.collectGarbage");
  const mk = keys?.unlocked ? keys.master() : null;
  const used = new Set<string>();
  for (const m of await c.allManifests()) {
    let got;
    try { got = await c.getManifest(m.id); } catch (e) { if (isNotFound(e)) continue; throw e; }
    let doc: DriveDocument | null = null;
    try {
      doc = JSON.parse(text.decode(await openManifest(mk, m.id, got.data))) as DriveDocument;
      if (doc.v !== 1) doc = null;
    } catch { doc = null; }
    if (!doc) {
      if (force) continue;
      throw new Error(`gendragoon: manifest ${m.id.slice(0, 12)} is not a readable drive; refusing to collect garbage`);
    }
    for (const e of Object.values(doc.files ?? {})) for (const id of e.chunks) used.add(id);
  }
  let deleted = 0;
  for (const b of await c.allBlobs()) {
    if (!used.has(b.id)) {
      await c.request("files.collectGarbage", "DELETE", `/blobs/${b.id}`);
      deleted++;
    }
  }
  return deleted;
}
