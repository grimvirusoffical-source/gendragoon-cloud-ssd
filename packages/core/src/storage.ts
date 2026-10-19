import { ApiError, WorkspaceLockedError } from "./api/errors.js";
import type { StorageObjectUrl, StorageUrlRequest, StorageUrlResponse } from "./api/types.js";

/** Backend owner cap for V4 signed URLs. */
export const SIGNED_URL_MAX_MS = 15 * 60 * 1000;

/** DELETE /v2/account accepts a Firebase re-auth newer than this. */
export const REAUTH_WINDOW_MS = 5 * 60 * 1000;

export function reauthIsRecent(iso: string, now = Date.now()): boolean {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return false;
  const age = now - at;
  return age >= 0 && age < REAUTH_WINDOW_MS;
}

/** Firebase ID token `auth_time` in milliseconds. `iat` from a refresh is ignored. */
export function authTimeMsFromIdToken(token: string): number | null {
  const payload = decodeJwtPayload(token);
  const authTime = payload?.auth_time;
  if (typeof authTime !== "number" || !Number.isFinite(authTime)) return null;
  return authTime * 1000;
}

/**
 * Timestamp used for the 5-minute delete check.
 * An ID token wins over `reauthenticatedAt`, and only `auth_time` counts.
 */
export function reauthenticatedAtForDelete(input: { reauthenticatedAt?: string; idToken?: string }): string {
  if (input.idToken) {
    const authTime = authTimeMsFromIdToken(input.idToken);
    return authTime === null ? "" : new Date(authTime).toISOString();
  }
  return input.reauthenticatedAt ?? "";
}

function decodeJwtPayload(token: string): { auth_time?: unknown; iat?: unknown } | null {
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as { auth_time?: unknown; iat?: unknown };
  } catch {
    return null;
  }
}

/**
 * Locked accounts may ask for download links only.
 * Put and delete are writes. There is no resumable op.
 * A manifest put always sends `ifGeneration` as a decimal string. The first save sends `"0"`.
 */
export function canonicalGeneration(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(value);
}

export function storageOperations(input: {
  intent: "upload" | "download" | "delete" | "get" | "put";
  oid: string;
  locked: boolean;
  /** Ignored on the wire. Callers still pass the plaintext size. */
  sizeBytes?: number;
  ifGeneration?: string;
}): StorageUrlRequest {
  if (!input.oid || input.oid.includes("/") || input.oid.includes("..")) {
    throw new Error("Object id must stay inside the workspace prefix");
  }
  const op = input.intent === "upload" ? "put" : input.intent === "download" ? "get" : input.intent;
  if (input.locked && (op === "put" || op === "delete")) throw new WorkspaceLockedError();
  const request: StorageUrlRequest = { op, objects: [input.oid] };
  if (input.oid === "manifest") {
    const generation = input.ifGeneration ?? "0";
    if (!canonicalGeneration(generation)) {
      throw new Error("Manifest generation must be a non-negative decimal string");
    }
    request.ifGeneration = generation;
  } else if (input.ifGeneration !== undefined) {
    if (!canonicalGeneration(input.ifGeneration)) {
      throw new Error("Manifest generation must be a non-negative decimal string");
    }
    request.ifGeneration = input.ifGeneration;
  }
  return request;
}

export function assertStorageUrlResponse(response: StorageUrlResponse, now = Date.now()): void {
  if (!response || typeof response.prefix !== "string" || !response.prefix || response.prefix.includes("..")) {
    throw new Error("Storage links are missing a workspace prefix");
  }
  if (response.mode !== "read" && response.mode !== "write" && response.mode !== "delete") {
    throw new Error("Storage link access is not recognized");
  }
  if (response.op !== "get" && response.op !== "put" && response.op !== "delete") {
    throw new Error("Storage link access is not recognized");
  }
  assertFresh(response.expiresAt, now);
  if (!Array.isArray(response.urls) || response.urls.length === 0) throw new Error("Storage links are missing");
  for (const link of response.urls) {
    assertFresh(link.expiresAt, now);
    assertScopedUrl(link.url, response.prefix);
    if (!link.object) throw new Error("Storage links are missing");
    if (response.mode === "read" && link.method !== "GET") {
      throw new Error("Locked workspace storage links are download-only");
    }
    if (link.method !== "GET" && link.method !== "PUT" && link.method !== "DELETE") {
      throw new Error("Storage link access is not recognized");
    }
  }
}

/** PUT ciphertext to a signed URL. No Authorization header and no key material. */
export async function putSignedObject(
  link: StorageObjectUrl,
  bytes: Uint8Array,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (link.method !== "PUT") {
    throw new Error("Download links cannot accept uploads");
  }
  let response: Response;
  try {
    response = await fetchImpl(link.url, { method: link.method, body: bytes });
  } catch {
    throw new Error("Signed upload failed");
  }
  if (response.status === 412) {
    throw new ApiError(412, "stale_generation", "The manifest generation changed. Fetch it and merge before writing again.");
  }
  if (!response.ok) throw new Error("Signed upload failed");
}

function assertFresh(expiresAt: string, now: number): void {
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) throw new Error("Signed URL expiry is unreadable");
  const ttl = expires - now;
  if (ttl <= 0 || ttl > SIGNED_URL_MAX_MS) {
    throw new Error("Signed URL lifetime must be at most 15 minutes");
  }
}

function assertScopedUrl(value: string, prefix: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Signed URL must be https");
  }
  if (url.protocol !== "https:") throw new Error("Signed URL must be https");
  if (url.username || url.password) throw new Error("Signed URL must not include credentials");
  const haystack = decodeURIComponent(`${url.pathname}${url.search}`);
  if (!haystack.includes(prefix)) throw new Error("Signed URL is not scoped to the workspace prefix");
}
