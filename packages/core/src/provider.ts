/**
 * Client side of the GenDragoon provider API (`/provider/v1`, backend branch feature/provider-v1).
 * A signed-in user connects another app (RedX) to one workspace, sees the connections and revokes them.
 * API keys (`gdpk_…`) are only ever returned to the connecting app; nothing here accepts, stores or shows one.
 *
 * PRICING (open, Josh decides): a connection's quota is a snapshot of the workspace quota taken at connect
 * time and is counted separately from the workspace's own files. Whether RedX bytes count against the
 * workspace usage is not decided (joint design 13.2, P1-P6). The UI shows the server's numbers only.
 */

export const PROVIDER_BASE_PATH = "/provider/v1";
export const PROVIDER_SCOPES = ["blobs:rw", "blobs:r"] as const;
export type ProviderScope = (typeof PROVIDER_SCOPES)[number];

export interface ProviderClientInfo {
  name: string;
  host: string;
}

export interface ProviderBinding {
  id: string;
  workspaceId: string;
  client: ProviderClientInfo;
  scopes: ProviderScope[];
  usedBytes: number;
  quotaBytes: number;
  objectCount: number;
  createdAt: string;
  lastUsedAt: string | null;
  lastError: string | null;
  active: boolean;
}

export interface ProviderGrant {
  grant: string;
  expiresAt: string;
  ttlSeconds: number;
}

export interface ProviderAuthorization {
  code: string;
  expiresAt: string;
}

export interface ProviderRevokeResult {
  revoked: boolean;
  purgedObjects: number | null;
}

/** A connect request another app hands to GenDragoon, e.g. gendragoon://connect?… (PKCE S256). */
export interface ProviderConnectRequest {
  requester: ProviderClientInfo;
  scopes: ProviderScope[];
  codeChallenge: string;
  codeChallengeMethod: "S256";
  /** Loopback only: the code is handed back to an app on this device, never to a remote site. */
  redirectUri: string;
  state: string;
}

const BINDING_ID = /^[0-9a-f-]{36}$/;
const B64URL43 = /^[A-Za-z0-9_-]{43}$/;
const SECRET_PREFIX = /gdpk_|gdpg_|gdpc_/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function iso(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

export function isProviderScope(value: unknown): value is ProviderScope {
  return typeof value === "string" && (PROVIDER_SCOPES as readonly string[]).includes(value);
}

/**
 * Keeps only the documented fields. A record that carries anything that looks like a secret is dropped:
 * the list must never become a way to display a key.
 */
export function parseProviderBindings(body: unknown): ProviderBinding[] {
  if (!isRecord(body) || !Array.isArray(body.bindings)) throw new Error("Unexpected bindings response");
  const out: ProviderBinding[] = [];
  for (const raw of body.bindings) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !BINDING_ID.test(raw.id)) continue;
    if (SECRET_PREFIX.test(JSON.stringify(raw))) continue;
    const client = isRecord(raw.client) ? raw.client : {};
    out.push({
      id: raw.id,
      workspaceId: text(raw.workspaceId, 64),
      client: { name: text(client.name, 80) || "Unknown app", host: text(client.host, 253) },
      scopes: Array.isArray(raw.scopes) ? raw.scopes.filter(isProviderScope) : [],
      usedBytes: count(raw.usedBytes),
      quotaBytes: count(raw.quotaBytes),
      objectCount: count(raw.objectCount),
      createdAt: iso(raw.createdAt) ?? new Date(0).toISOString(),
      lastUsedAt: iso(raw.lastUsedAt),
      lastError: raw.lastError == null ? null : text(raw.lastError, 200),
      active: raw.active === true,
    });
  }
  return out.sort((a, b) => Number(b.active) - Number(a.active) || b.createdAt.localeCompare(a.createdAt));
}

export function parseProviderGrant(body: unknown): ProviderGrant {
  if (!isRecord(body) || typeof body.grant !== "string" || !/^gdpg_[A-Za-z0-9_-]{43}$/.test(body.grant)) {
    throw new Error("Unexpected grant response");
  }
  return { grant: body.grant, expiresAt: iso(body.expiresAt) ?? "", ttlSeconds: count(body.ttlSeconds) };
}

export function parseProviderAuthorization(body: unknown): ProviderAuthorization {
  if (!isRecord(body) || typeof body.code !== "string" || !/^gdpc_[A-Za-z0-9_-]{43}$/.test(body.code)) {
    throw new Error("Unexpected authorization response");
  }
  return { code: body.code, expiresAt: iso(body.expiresAt) ?? "" };
}

export interface QuotaView {
  usedBytes: number;
  quotaBytes: number;
  /** 0..1, clamped. */
  fraction: number;
  /** "ok" < 80 %, "warn" < 100 %, "full" at or above the limit. */
  level: "ok" | "warn" | "full";
  label: string;
}

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** Decimal units, matching the rest of the app. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace(/\.0+$|(\.\d*[1-9])0+$/, "$1")} ${UNITS[unit]}`;
}

export function providerQuota(binding: Pick<ProviderBinding, "usedBytes" | "quotaBytes">): QuotaView {
  const quota = Math.max(0, binding.quotaBytes);
  const used = Math.max(0, binding.usedBytes);
  const fraction = quota > 0 ? Math.min(1, used / quota) : used > 0 ? 1 : 0;
  const level = quota > 0 && used >= quota ? "full" : fraction >= 0.8 ? "warn" : "ok";
  return { usedBytes: used, quotaBytes: quota, fraction, level, label: `${formatBytes(used)} of ${formatBytes(quota)}` };
}

function loopback(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]") && url.port !== "" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Parses gendragoon://connect?client=…&host=…&scope=…&code_challenge=…&code_challenge_method=S256&redirect_uri=…&state=… */
export function parseConnectRequest(link: string): ProviderConnectRequest {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error("Not a connect link");
  }
  if (url.protocol !== "gendragoon:" || (url.hostname !== "connect" && url.pathname.replace(/^\/+/, "") !== "connect")) {
    throw new Error("Not a connect link");
  }
  const q = url.searchParams;
  const name = text(q.get("client"), 80).trim();
  const host = text(q.get("host"), 253).trim();
  const challenge = q.get("code_challenge") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";
  const state = text(q.get("state"), 128);
  if (!name) throw new Error("The app did not say who it is");
  if (q.get("code_challenge_method") !== "S256" || !B64URL43.test(challenge)) throw new Error("The connect link is missing a valid PKCE challenge");
  if (!loopback(redirectUri)) throw new Error("The code can only be returned to an app on this device");
  if (!state) throw new Error("The connect link has no state value");
  const requested = (q.get("scope") ?? "blobs:rw").split(/[ ,]+/).filter(Boolean);
  if (!requested.every(isProviderScope)) throw new Error("The app asked for an unknown permission");
  return { requester: { name, host }, scopes: requested as ProviderScope[], codeChallenge: challenge, codeChallengeMethod: "S256", redirectUri, state };
}

/** Where the approved code goes: the app's loopback listener, with its own state echoed back. */
export function connectRedirect(request: ProviderConnectRequest, auth: ProviderAuthorization): string {
  const url = new URL(request.redirectUri);
  url.searchParams.set("code", auth.code);
  url.searchParams.set("state", request.state);
  return url.toString();
}

export function scopeLabel(scopes: readonly ProviderScope[]): string {
  return scopes.includes("blobs:rw") ? "Read and write" : scopes.includes("blobs:r") ? "Read only" : "No access";
}

/** User-facing text for provider API failures. */
export function providerErrorMessage(error: unknown): string {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  const status = isRecord(error) && typeof error.status === "number" ? error.status : 0;
  if (code === "workspace_not_found" || status === 404) return "That workspace is not available for connections.";
  if (code === "rate_limited" || status === 429) return "Too many connect attempts. Wait a minute and try again.";
  if (code === "invalid_scope" || code === "invalid_pkce") return "The app's connect request was not valid.";
  if (status === 0) return "Could not reach GenDragoon. Check your connection.";
  return "Connections are unavailable right now. Try again later.";
}
