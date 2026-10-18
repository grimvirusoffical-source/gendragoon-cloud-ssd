import { WorkspaceLockedError } from "./api/errors.js";
import type { StorageLink, StorageUrlRequest, StorageUrlResponse } from "./api/types.js";

/** Backend owner cap for V4 and resumable session URLs. */
export const SIGNED_URL_MAX_MS = 15 * 60 * 1000;

/** DELETE /v2/account accepts a Firebase re-auth newer than this. */
export const REAUTH_WINDOW_MS = 60 * 60 * 1000;

export function reauthIsRecent(iso: string, now = Date.now()): boolean {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return false;
  const age = now - at;
  return age >= 0 && age < REAUTH_WINDOW_MS;
}

/**
 * Locked accounts may ask for download links only. Upload and resumable
 * session URLs are writes; the server answers those with HTTP 423.
 */
export function storageOperations(input: {
  intent: "upload" | "download" | "delete";
  oid: string;
  sizeBytes?: number;
  locked: boolean;
}): StorageUrlRequest {
  if (!input.oid || input.oid.includes("/") || input.oid.includes("..")) {
    throw new Error("Object id must stay inside the workspace prefix");
  }
  if (input.locked && input.intent === "upload") throw new WorkspaceLockedError();
  if (input.intent === "download" || input.locked) {
    return { operations: [{ op: "download", oid: input.oid }] };
  }
  if (input.intent === "delete") return { operations: [{ op: "delete", oid: input.oid }] };
  return {
    operations: [
      { op: "upload", oid: input.oid, sizeBytes: input.sizeBytes },
      { op: "resumable", oid: input.oid, sizeBytes: input.sizeBytes },
    ],
  };
}

export function assertStorageUrlResponse(response: StorageUrlResponse, now = Date.now()): void {
  if (!response || typeof response.prefix !== "string" || !response.prefix || response.prefix.includes("..")) {
    throw new Error("Storage links are missing a workspace prefix");
  }
  assertFresh(response.expiresAt, now);
  if (response.access !== "read-write" && response.access !== "read-only") {
    throw new Error("Storage link access is not recognized");
  }
  if (!Array.isArray(response.links)) throw new Error("Storage links are missing");
  for (const link of response.links) {
    assertFresh(link.expiresAt, now);
    assertScopedUrl(link.url, response.prefix);
    if (response.access === "read-only" && link.op !== "download") {
      throw new Error("Locked workspace storage links are download-only");
    }
  }
}

/** PUT or POST ciphertext to a signed URL. No Authorization header and no key material. */
export async function putSignedObject(
  link: StorageLink,
  bytes: Uint8Array,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (link.op !== "upload" && link.op !== "resumable") {
    throw new Error("Download links cannot accept uploads");
  }
  let response: Response;
  try {
    response = await fetchImpl(link.url, { method: link.method, body: bytes });
  } catch {
    throw new Error("Signed upload failed");
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
