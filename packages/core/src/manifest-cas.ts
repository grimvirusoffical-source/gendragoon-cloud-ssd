import { ApiError } from "./api/errors.js";
import type { StorageUrlRequest } from "./api/types.js";
import { planIncomingPath } from "./merge.js";
import { LIBRARY_OBJECT_ID, type LibraryManifest, type ManifestTombstone, type SealedName, type SecureStore } from "./seal.js";
import { canonicalGeneration } from "./storage.js";

const VERSION_PREFIX = "manifest-version:";
const SYNCED_PREFIX = "manifest-synced:";
/** Tombstones older than this may be dropped. Time is not an order. */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function manifestVersionKey(workspaceId: string): string {
  return `${VERSION_PREFIX}${workspaceId}`;
}

export function manifestSyncedKey(workspaceId: string): string {
  return `${SYNCED_PREFIX}${workspaceId}`;
}

export async function readManifestVersion(store: SecureStore, workspaceId: string): Promise<number> {
  const raw = await store.get(manifestVersionKey(workspaceId));
  if (!raw || raw.byteLength === 0) return 0;
  const parsed = Number(new TextDecoder().decode(raw));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function readLastSyncedVersion(store: SecureStore, workspaceId: string): Promise<number> {
  const raw = await store.get(manifestSyncedKey(workspaceId));
  if (!raw || raw.byteLength === 0) return 0;
  const parsed = Number(new TextDecoder().decode(raw));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function rememberLastSyncedVersion(store: SecureStore, workspaceId: string, version: number): Promise<void> {
  await store.set(manifestSyncedKey(workspaceId), new TextEncoder().encode(String(version)));
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

export interface ManifestMergeFile {
  fileId: string;
  path: string;
  writtenAtVersion: number;
}

export interface ManifestMergeDocument<F extends ManifestMergeFile = ManifestMergeFile> {
  version: number;
  prunedThroughVersion: number;
  files: F[];
  tombstones: ManifestTombstone[];
}

/**
 * Merge two sealed manifests. Order is the manifest version, never the clock.
 * `nowMs` only decides whether a tombstone is old enough to prune.
 * A device whose `lastSyncedVersion` is behind `remote.prunedThroughVersion` adopts
 * the remote document and re-applies only local changes newer than `lastSyncedVersion`.
 */
export function mergeSealedManifest<F extends ManifestMergeFile>(input: {
  local: ManifestMergeDocument<F>;
  remote: ManifestMergeDocument<F>;
  lastSyncedVersion: number;
  nowMs: number;
}): ManifestMergeDocument<F> {
  const remotePruned = input.remote.prunedThroughVersion ?? 0;
  const stale = input.lastSyncedVersion < remotePruned;
  const remoteNewerEmpty = !stale && input.remote.version > input.local.version && input.remote.files.length === 0;
  const localFileFloor = stale ? input.lastSyncedVersion : remoteNewerEmpty ? input.remote.version : -1;
  const localTombFloor = localFileFloor;
  const files = new Map<string, F>();
  const reapplied = new Set<string>();
  for (const file of input.remote.files) files.set(file.fileId, file);
  for (const file of input.local.files) {
    if (file.writtenAtVersion <= localFileFloor) continue;
    const previous = files.get(file.fileId);
    if (!previous || file.writtenAtVersion > previous.writtenAtVersion) {
      files.set(file.fileId, file);
      if (stale) reapplied.add(file.fileId);
    }
  }
  const tombstones = new Map<string, ManifestTombstone>();
  for (const tombstone of input.remote.tombstones) tombstones.set(tombstone.fileId, tombstone);
  for (const tombstone of input.local.tombstones) {
    if (tombstone.deletedAtVersion <= localTombFloor) continue;
    const previous = tombstones.get(tombstone.fileId);
    if (!previous || tombstone.deletedAtVersion > previous.deletedAtVersion) tombstones.set(tombstone.fileId, tombstone);
  }
  const version = Math.max(input.local.version, input.remote.version) + 1;
  const live: F[] = [];
  for (const file of files.values()) {
    const tombstone = tombstones.get(file.fileId);
    if (tombstone && tombstone.deletedAtVersion > file.writtenAtVersion) continue;
    live.push(reapplied.has(file.fileId) ? { ...file, writtenAtVersion: version } : file);
  }
  live.sort((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0));
  let prunedThrough = Math.max(input.local.prunedThroughVersion ?? 0, remotePruned);
  const kept: ManifestTombstone[] = [];
  for (const tombstone of tombstones.values()) {
    if (input.nowMs - tombstone.deletedAtMs >= TOMBSTONE_TTL_MS) {
      if (tombstone.deletedAtVersion > prunedThrough) prunedThrough = tombstone.deletedAtVersion;
      continue;
    }
    kept.push(tombstone);
  }
  kept.sort((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0));
  return { version, prunedThroughVersion: prunedThrough, files: live, tombstones: kept };
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
  nowMs?: number;
}): Promise<LibraryManifest> {
  const seen = await readManifestVersion(input.store, input.workspaceId);
  if (input.local.version < seen) {
    throw new Error("Manifest version is older than the last one opened on this device");
  }
  const maxAttempts = input.maxAttempts ?? 3;
  let pending = input.local;
  const nowMs = input.nowMs ?? Date.now();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const remote = await input.download();
    if (remote.manifest.version < seen) {
      throw new Error("Manifest version is older than the last one opened on this device");
    }
    const lastSyncedVersion = await readLastSyncedVersion(input.store, input.workspaceId);
    const merged = mergeSealedManifest({
      local: toMergeDocument(pending),
      remote: toMergeDocument(remote.manifest),
      lastSyncedVersion,
      nowMs,
    });
    const next = fromMergeDocument(merged);
    if (next.version < seen) next.version = seen + 1;
    try {
      if (!canonicalGeneration(remote.generation)) {
        throw new ApiError(400, "manifest_generation_required", "Manifest upload requires the current generation.");
      }
      await input.upload(next, remote.generation);
      await rememberManifestVersion(input.store, input.workspaceId, next.version);
      await rememberLastSyncedVersion(input.store, input.workspaceId, next.version);
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

function toMergeDocument(manifest: LibraryManifest): ManifestMergeDocument<SealedName & ManifestMergeFile> {
  return {
    version: manifest.version,
    prunedThroughVersion: manifest.prunedThroughVersion ?? 0,
    tombstones: manifest.tombstones ?? [],
    files: manifest.files.map((file) => ({
      ...file,
      fileId: file.fileId || file.oid,
      writtenAtVersion: file.writtenAtVersion ?? manifest.version,
    })),
  };
}

function fromMergeDocument(document: ManifestMergeDocument<SealedName & ManifestMergeFile>): LibraryManifest {
  return {
    version: document.version,
    prunedThroughVersion: document.prunedThroughVersion,
    tombstones: document.tombstones,
    files: document.files,
  };
}
