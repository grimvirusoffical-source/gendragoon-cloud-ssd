import { ApiError } from "./api/errors.js";
import type { StorageUrlRequest } from "./api/types.js";
import { planIncomingPath } from "./merge.js";
import { LIBRARY_OBJECT_ID, type LibraryManifest, type SealedName, type SecureStore } from "./seal.js";
import { canonicalGeneration } from "./storage.js";

const VERSION_PREFIX = "manifest-version:";

export function manifestVersionKey(workspaceId: string): string {
  return `${VERSION_PREFIX}${workspaceId}`;
}

export async function readManifestVersion(store: SecureStore, workspaceId: string): Promise<number> {
  const raw = await store.get(manifestVersionKey(workspaceId));
  if (!raw || raw.byteLength === 0) return 0;
  const parsed = Number(new TextDecoder().decode(raw));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** Reject a decrypted manifest whose version is behind the last one this device opened. */
export async function rememberManifestVersion(store: SecureStore, workspaceId: string, version: number): Promise<void> {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Manifest version is not supported");
  const seen = await readManifestVersion(store, workspaceId);
  if (version < seen) throw new Error("Manifest version is older than the last one opened on this device");
  await store.set(manifestVersionKey(workspaceId), new TextEncoder().encode(String(version)));
}

/** Union by object id. A path clash on a new id uses the merge rename rule. */
export function mergeManifestFiles(current: LibraryManifest, incoming: LibraryManifest, sourceName: string): LibraryManifest {
  const files = new Map<string, SealedName>();
  const taken = new Set<string>();
  for (const file of current.files) {
    files.set(file.oid, file);
    taken.add(file.path);
  }
  for (const file of incoming.files) {
    if (files.has(file.oid)) continue;
    const path = taken.has(file.path) ? planIncomingPath(file.path, sourceName, taken) : file.path;
    taken.add(path);
    files.set(file.oid, path === file.path ? file : { ...file, path });
  }
  const version = Math.max(current.version, incoming.version) + 1;
  return { version, files: [...files.values()] };
}

export function manifestUploadRequest(ifGeneration = "0"): StorageUrlRequest {
  if (!canonicalGeneration(ifGeneration)) {
    throw new ApiError(400, "manifest_generation_required", "Manifest upload requires the current generation.");
  }
  return { op: "put", objects: [LIBRARY_OBJECT_ID], ifGeneration };
}

export async function putManifestBytes(input: {
  url: string;
  ifGeneration: string;
  bytes: Uint8Array;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  if (!canonicalGeneration(input.ifGeneration)) {
    throw new ApiError(400, "manifest_generation_required", "Manifest upload requires the current generation.");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(input.url, {
      method: "PUT",
      headers: { "x-goog-if-generation-match": input.ifGeneration },
      body: input.bytes,
    });
  } catch {
    throw new Error("Manifest upload failed");
  }
  if (response.status === 412) throw new ApiError(412, "stale_version", "The manifest generation changed. Fetch it again.");
  if (response.status === 400) throw new ApiError(400, "manifest_generation_required", "Manifest upload requires the current generation.");
  if (!response.ok) throw new Error("Manifest upload failed");
}

/**
 * Download, and on 412 merge by object id, re-seal, and retry.
 * The sealed version is monotonic and is stored in SecureStore.
 */
export async function commitManifest(input: {
  workspaceId: string;
  store: SecureStore;
  local: LibraryManifest;
  sourceName: string;
  download: () => Promise<{ generation: string; manifest: LibraryManifest }>;
  upload: (manifest: LibraryManifest, ifGeneration: string) => Promise<void>;
  maxAttempts?: number;
}): Promise<LibraryManifest> {
  const seen = await readManifestVersion(input.store, input.workspaceId);
  if (input.local.version < seen) {
    throw new Error("Manifest version is older than the last one opened on this device");
  }
  const maxAttempts = input.maxAttempts ?? 3;
  let pending = input.local;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const remote = await input.download();
    if (remote.manifest.version < seen) {
      throw new Error("Manifest version is older than the last one opened on this device");
    }
    const next = remote.manifest.files.length === 0 && pending.files.length > 0
      ? { ...pending, version: Math.max(pending.version, remote.manifest.version, seen) }
      : mergeManifestFiles(
        remote.manifest.version >= pending.version ? remote.manifest : pending,
        remote.manifest.version >= pending.version ? pending : remote.manifest,
        input.sourceName,
      );
    if (next.version < seen) next.version = seen + 1;
    try {
      if (!canonicalGeneration(remote.generation)) {
        throw new ApiError(400, "manifest_generation_required", "Manifest upload requires the current generation.");
      }
      await input.upload(next, remote.generation);
      await rememberManifestVersion(input.store, input.workspaceId, next.version);
      return next;
    } catch (error) {
      if (error instanceof ApiError && error.status === 412 && attempt + 1 < maxAttempts) {
        pending = next;
        continue;
      }
      throw error;
    }
  }
  throw new ApiError(412, "stale_version", "The manifest generation changed. Fetch it again.");
}
