// Client for one binding of the GenDragoon storage provider API (/provider/v1), authenticated with the
// binding's gdpk_ API key. Every call is checked by the gate first (levels: docs/LEVELS.md).
import { toHex } from "./bytes.js";
import { sha256, validateEnvelope, type KeyEnvelope } from "./crypto.js";
import { levelGate, type Gate, type Operation } from "./gate.js";
import { OPERATIONS, type OperationId } from "./operations.js";

export const VERSION = "0.1.0";

/** A non-2xx answer from the server. `code` is the server's machine code, such as "quota_exceeded". */
export class APIError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfterSeconds = 0) {
    super(`gendragoon: ${status} ${code}`);
    this.name = "APIError";
  }
  get notFound(): boolean { return this.status === 404; }
  get preconditionFailed(): boolean { return this.status === 412 || this.code === "precondition_failed" || this.code === "version_mismatch"; }
  get quotaExceeded(): boolean { return this.status === 507 || this.code === "quota_exceeded"; }
  get unauthorized(): boolean { return this.status === 401; }
  get rateLimited(): boolean { return this.status === 429; }
}

export class ChecksumError extends Error {
  constructor() { super("gendragoon: checksum mismatch"); this.name = "ChecksumError"; }
}

export const isNotFound = (e: unknown): boolean => e instanceof APIError && e.notFound;
export const isPreconditionFailed = (e: unknown): boolean => e instanceof APIError && e.preconditionFailed;
export const isQuotaExceeded = (e: unknown): boolean => e instanceof APIError && e.quotaExceeded;
export const isUnauthorized = (e: unknown): boolean => e instanceof APIError && e.unauthorized;

export interface Options {
  /** Checks every operation before it runs. Default: levelGate(DEFAULT_MAX_LEVEL). */
  gate?: Gate;
  /** fetch implementation (default globalThis.fetch). */
  fetch?: typeof fetch;
  /** Appended to the SDK's user agent (ignored by browsers). */
  userAgent?: string;
}

const OPS = new Map(OPERATIONS.map((o) => [o.id, o]));
export function operation(id: OperationId): Operation {
  const o = OPS.get(id);
  if (!o) throw new Error(`gendragoon: unknown operation ${id}`);
  return o;
}

/** Shared by every client type: the gate and the HTTP transport. */
export class Gated {
  protected readonly gate: Gate;
  protected readonly fetchFn: typeof fetch;
  protected readonly ua: string;
  constructor(opts: Options = {}) {
    this.gate = opts.gate ?? levelGate();
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.ua = `gendragoon-sdk-js/${VERSION}` + (opts.userAgent ? ` ${opts.userAgent}` : "");
  }
  /** Throws LevelError if the gate refuses the operation. */
  check(id: OperationId): void {
    this.gate(operation(id));
  }
  protected async send(method: string, url: string, body: Uint8Array | string | null, headers: Record<string, string>, authorization: string | null): Promise<Response> {
    const h: Record<string, string> = { ...headers };
    if (typeof process !== "undefined") h["User-Agent"] = this.ua;
    if (authorization) h["Authorization"] = authorization;
    let res: Response;
    try {
      res = await this.fetchFn(url, { method, headers: h, body: body as BodyInit | null, redirect: "error" });
    } catch (e) {
      throw new Error(`gendragoon: ${method} ${url.split("?")[0]}: ${(e as Error).message}`);
    }
    if (res.status >= 300) {
      let code = "";
      try { code = String(((await res.json()) as { error?: unknown }).error ?? ""); } catch { /* not JSON */ }
      throw new APIError(res.status, code, Number.parseInt(res.headers.get("Retry-After") ?? "0", 10) || 0);
    }
    return res;
  }
}

export interface Capabilities {
  version: number; maxBlobBytes: number; maxManifestBytes: number; idModes: string[]; manifestCas: boolean;
  batchHasMax: number; listMax: number; events?: { poll: boolean; changeSeq: boolean; webhook: boolean; stream: boolean };
}
export interface Usage { usedBytes: number; quotaBytes: number; objectCount: number; workspaceId: string; changeSeq: number; lastChangeAt: string | null }
export const remaining = (u: Usage): number => Math.max(0, u.quotaBytes - u.usedBytes);
export interface PutResult { created: boolean; generation: string }
export interface BlobInfo { size: number; generation: string; sha256: string }
export interface ListItem { id: string; size: number; generation: string | null }
export interface ListPage { items: ListItem[]; next: string | null }
export interface Manifest { data: Uint8Array; generation: string }
/** ifAbsent: create only. ifGeneration: compare-and-swap. */
export interface Precondition { ifAbsent?: boolean; ifGeneration?: string }

export const API_KEY_RE = /^gdpk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const etag = (r: Response) => (r.headers.get("ETag") ?? "").replace(/"/g, "");
const preHeaders = (p: Precondition | undefined, h: Record<string, string>) => {
  if (p?.ifAbsent) h["If-None-Match"] = "*";
  else if (p?.ifGeneration) h["If-Match"] = `"${p.ifGeneration}"`;
  return h;
};
function needHex(id: string, what: string) {
  if (!HEX64.test(id)) throw new Error(`gendragoon: ${what} must be 64 lower-case hex characters`);
}

export class Client extends Gated {
  readonly base: string;
  #key: string;
  constructor(base: string, apiKey: string, opts: Options = {}) {
    super(opts);
    if (!API_KEY_RE.test(apiKey)) throw new Error("gendragoon: malformed API key");
    this.base = base.replace(/\/+$/, "");
    this.#key = apiKey;
  }
  /** The key in use (after rotateApiKey, the new one). */
  get apiKey(): string { return this.#key; }

  /** @internal */
  async request(op: OperationId, method: string, path: string, body: Uint8Array | string | null = null, headers: Record<string, string> = {}, auth = true): Promise<Response> {
    this.check(op);
    return this.send(method, this.base + path, body, headers, auth ? `Bearer ${this.#key}` : null);
  }
  private async json<T>(op: OperationId, path: string): Promise<T> {
    return (await (await this.request(op, "GET", path)).json()) as T;
  }

  async capabilities(): Promise<Capabilities> {
    return (await (await this.request("capabilities", "GET", "/capabilities", null, {}, false)).json()) as Capabilities;
  }
  async health(): Promise<void> {
    await this.request("health", "GET", "/health");
  }
  async usage(): Promise<Usage> {
    return this.json<Usage>("usage", "/usage");
  }

  // ---- blobs ----
  /** Stores data content-addressed (id = SHA-256) and returns the id. */
  async putBlob(data: Uint8Array): Promise<{ id: string } & PutResult> {
    const id = toHex(await sha256(data));
    return { id, ...(await this.putBlobAs(id, data, "content")) };
  }
  /** Stores data under an id the caller chose (for example an HMAC of the plaintext). */
  async putSealedBlob(id: string, data: Uint8Array): Promise<PutResult> {
    return this.putBlobAs(id, data, "sealed");
  }
  private async putBlobAs(id: string, data: Uint8Array, mode: string): Promise<PutResult> {
    needHex(id, "blob id");
    const r = await this.request("blobs.put", "PUT", `/blobs/${id}`, data, {
      "Content-Type": "application/octet-stream", "X-Id-Mode": mode, "X-Content-SHA256": toHex(await sha256(data)),
    });
    return { created: r.status === 201, generation: etag(r) };
  }
  /** Reads a blob and verifies its checksum. */
  async getBlob(id: string): Promise<Uint8Array> {
    needHex(id, "blob id");
    const r = await this.request("blobs.get", "GET", `/blobs/${id}`);
    const data = new Uint8Array(await r.arrayBuffer());
    const want = r.headers.get("X-Content-SHA256");
    if (want && want !== toHex(await sha256(data))) throw new ChecksumError();
    return data;
  }
  async headBlob(id: string): Promise<BlobInfo> {
    needHex(id, "blob id");
    const r = await this.request("blobs.head", "HEAD", `/blobs/${id}`);
    return { size: Number(r.headers.get("Content-Length") ?? 0), generation: etag(r), sha256: r.headers.get("X-Content-SHA256") ?? "" };
  }
  /** Level L2, risk destructive. Deleting a missing blob succeeds. */
  async deleteBlob(id: string): Promise<void> {
    needHex(id, "blob id");
    await this.request("blobs.delete", "DELETE", `/blobs/${id}`);
  }
  private async list(op: OperationId, path: string, cursor?: string | null, limit?: number): Promise<ListPage> {
    const q = new URLSearchParams();
    if (cursor) q.set("cursor", cursor);
    if (limit) q.set("limit", String(limit));
    const qs = q.toString();
    const out = await this.json<{ ids?: string[]; items?: ListItem[]; next?: string | null }>(op, path + (qs ? `?${qs}` : ""));
    return { items: out.items ?? (out.ids ?? []).map((id) => ({ id, size: 0, generation: null })), next: out.next ?? null };
  }
  listBlobs(cursor?: string | null, limit?: number): Promise<ListPage> { return this.list("blobs.list", "/blobs", cursor, limit); }
  listManifests(cursor?: string | null, limit?: number): Promise<ListPage> { return this.list("manifests.list", "/manifests", cursor, limit); }
  async allBlobs(): Promise<ListItem[]> { return this.all((c) => this.listBlobs(c)); }
  async allManifests(): Promise<ListItem[]> { return this.all((c) => this.listManifests(c)); }
  private async all(page: (cursor: string | null) => Promise<ListPage>): Promise<ListItem[]> {
    const out: ListItem[] = [];
    let cursor: string | null = null;
    do {
      const p: ListPage = await page(cursor);
      out.push(...p.items);
      cursor = p.next;
    } while (cursor);
    return out;
  }
  /** The subset of ids that exist, in input order. */
  async hasBlobs(ids: string[]): Promise<string[]> {
    const present: string[] = [];
    for (let i = 0; i < ids.length; i += 1000) {
      const r = await this.request("blobs.batchHas", "POST", "/blobs/batch-has", JSON.stringify({ ids: ids.slice(i, i + 1000) }), { "Content-Type": "application/json" });
      present.push(...((await r.json()) as { present: string[] }).present);
    }
    return present;
  }

  // ---- manifests ----
  async getManifest(key: string): Promise<Manifest> {
    needHex(key, "manifest key");
    const r = await this.request("manifests.get", "GET", `/manifests/${key}`);
    return { data: new Uint8Array(await r.arrayBuffer()), generation: etag(r) };
  }
  /** Losing a compare-and-swap race throws an APIError with preconditionFailed set. */
  async putManifest(key: string, data: Uint8Array, pre?: Precondition): Promise<PutResult> {
    needHex(key, "manifest key");
    const h = preHeaders(pre, { "Content-Type": "application/octet-stream", "X-Content-SHA256": toHex(await sha256(data)) });
    const r = await this.request("manifests.put", "PUT", `/manifests/${key}`, data, h);
    return { created: r.status === 201, generation: etag(r) };
  }
  /** Level L2, risk destructive. */
  async deleteManifest(key: string, pre?: Precondition): Promise<void> {
    needHex(key, "manifest key");
    await this.request("manifests.delete", "DELETE", `/manifests/${key}`, null, preHeaders(pre, {}));
  }

  // ---- key envelope ----
  async getKeyEnvelope(): Promise<KeyEnvelope> {
    const env = await this.json<unknown>("keyEnvelope.get", "/key-envelope");
    validateEnvelope(env);
    return env;
  }
  /** @internal */
  async putKeyEnvelope(op: "keyEnvelope.create" | "keyEnvelope.replace", env: KeyEnvelope, pre: Record<string, string>): Promise<void> {
    validateEnvelope(env);
    await this.request(op, "PUT", "/key-envelope", JSON.stringify(env), { ...pre, "Content-Type": "application/json" });
  }

  /** Replaces the API key; the old one keeps working for ten minutes. Returns the new key to store. */
  async rotateApiKey(): Promise<string> {
    const r = await this.request("apiKey.rotate", "POST", "/connect/rotate");
    const k = ((await r.json()) as { apiKey?: string }).apiKey;
    if (!k || !API_KEY_RE.test(k)) throw new Error("gendragoon: unexpected rotate response");
    this.#key = k;
    return k;
  }

  /** Level L4, risk bulk-destructive: deletes every manifest and blob of this binding. The default gate refuses it. */
  async wipe(): Promise<number> {
    this.check("storage.wipe");
    let n = 0;
    for (const kind of ["manifests", "blobs"] as const) {
      const items = kind === "manifests" ? await this.allManifests() : await this.allBlobs();
      for (const it of items) {
        await this.request("storage.wipe", "DELETE", `/${kind}/${it.id}`);
        n++;
      }
    }
    return n;
  }
}
