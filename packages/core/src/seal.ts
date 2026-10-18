import { CHUNK_BYTES } from "./transfer.js";

/**
 * Client-side encryption for managed-bucket objects.
 * WebCrypto AES-256-GCM only. No hand-rolled cipher, mode, or KDF.
 * Workspace keys and BYO secrets stay in a SecretStore the host backs
 * with the OS keychain. They are never sent to GenDragoon.
 */

const AES = "AES-GCM";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;

export interface SecretStore {
  get(name: string): Promise<Uint8Array | null>;
  set(name: string, bytes: Uint8Array): Promise<void>;
  delete(name: string): Promise<void>;
}

/** Same keychain contract. Deletion job id and status token use this name. */
export type SecureStore = SecretStore;

export interface SealedName {
  /** Stable file id. It stays when the object id changes. */
  fileId: string;
  oid: string;
  path: string;
  plaintextBytes: number;
  chunkBytes: number;
  /** Number of ciphertext frames. Opening fails when a frame is missing. */
  chunkCount: number;
  /** Plaintext size in bytes. Opening fails when the decrypted size differs. */
  totalSize: number;
  wrappedKey: string;
  wrapIv: string;
}

export interface ChunkBinding {
  fileId: string;
  objectId: string;
}

export interface LibraryManifest {
  version: number;
  files: SealedName[];
}

/** Reserved object id for the sealed library manifest. */
export const LIBRARY_OBJECT_ID = "manifest";

export function workspaceKeyId(workspaceId: string): string {
  return `workspace-key:${workspaceId}`;
}

export function byoSecretId(workspaceId: string): string {
  return `byo-secret:${workspaceId}`;
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, Uint8Array>();

  async get(name: string): Promise<Uint8Array | null> {
    const found = this.values.get(name);
    return found ? copyBytes(found) : null;
  }

  async set(name: string, bytes: Uint8Array): Promise<void> {
    this.values.set(name, copyBytes(bytes));
  }

  async delete(name: string): Promise<void> {
    this.values.delete(name);
  }
}

export async function createWorkspaceKey(): Promise<Uint8Array> {
  const key = await crypto.subtle.generateKey({ name: AES, length: 256 }, true, ["encrypt", "decrypt"]);
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

export async function importWorkspaceKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== KEY_BYTES) throw new Error("Workspace key must be 256 bits");
  return crypto.subtle.importKey("raw", copyBytes(raw), { name: AES }, false, ["encrypt", "decrypt"]);
}

export async function loadOrCreateWorkspaceKey(store: SecretStore, workspaceId: string): Promise<Uint8Array> {
  const name = workspaceKeyId(workspaceId);
  const existing = await store.get(name);
  if (existing && existing.byteLength === KEY_BYTES) return existing;
  const created = await createWorkspaceKey();
  await store.set(name, created);
  return created;
}

/** Removes workspace keys and BYO secrets from the device. Remote BYO buckets are not touched. */
export async function wipeWorkspaceKeys(store: SecretStore, workspaceIds: readonly string[]): Promise<void> {
  for (const id of workspaceIds) {
    await store.delete(workspaceKeyId(id));
    await store.delete(byoSecretId(id));
  }
}

export async function sealNamedFile(input: {
  path: string;
  plaintext: Uint8Array;
  workspaceKey: CryptoKey;
  chunkBytes?: number;
  fileId?: string;
  oid?: string;
}): Promise<{ oid: string; ciphertext: Uint8Array; entry: SealedName }> {
  const path = assertPlainPath(input.path);
  const chunkBytes = input.chunkBytes ?? CHUNK_BYTES;
  const fileId = input.fileId ?? randomOid();
  const oid = input.oid ?? randomOid();
  const raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const fileKey = await crypto.subtle.importKey("raw", raw, { name: AES }, false, ["encrypt", "decrypt"]);
  const wrapped = await wrapFileKey(raw, input.workspaceKey);
  raw.fill(0);
  const chunkCount = input.plaintext.byteLength === 0 ? 0 : Math.ceil(input.plaintext.byteLength / chunkBytes);
  const ciphertext = await sealBytes(input.plaintext, fileKey, chunkBytes, { fileId, objectId: oid });
  return {
    oid,
    ciphertext,
    entry: {
      fileId,
      oid,
      path,
      plaintextBytes: input.plaintext.byteLength,
      chunkBytes,
      chunkCount,
      totalSize: input.plaintext.byteLength,
      wrappedKey: bytesToBase64(wrapped.wrapped),
      wrapIv: bytesToBase64(wrapped.iv),
    },
  };
}

export async function openNamedFile(
  ciphertext: Uint8Array,
  entry: SealedName,
  workspaceKey: CryptoKey,
): Promise<Uint8Array> {
  const fileKey = await unwrapFileKey(base64ToBytes(entry.wrappedKey), base64ToBytes(entry.wrapIv), workspaceKey);
  return openBytes(ciphertext, fileKey, {
    chunkCount: entry.chunkCount,
    totalSize: entry.totalSize,
    fileId: entry.fileId,
    objectId: entry.oid,
  });
}

export async function sealLibrary(manifest: LibraryManifest, workspaceKey: CryptoKey): Promise<Uint8Array> {
  if (!Number.isSafeInteger(manifest.version) || manifest.version < 1) throw new Error("Library manifest version is not supported");
  const encoded = new TextEncoder().encode(JSON.stringify(manifest));
  return sealBytes(encoded, workspaceKey, Math.max(encoded.byteLength, 1), {
    fileId: LIBRARY_OBJECT_ID,
    objectId: LIBRARY_OBJECT_ID,
  });
}

export async function openLibrary(ciphertext: Uint8Array, workspaceKey: CryptoKey): Promise<LibraryManifest> {
  const encoded = await openBytes(ciphertext, workspaceKey, {
    fileId: LIBRARY_OBJECT_ID,
    objectId: LIBRARY_OBJECT_ID,
  });
  const parsed = JSON.parse(new TextDecoder().decode(encoded)) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("Library manifest is unreadable");
  const record = parsed as { version?: unknown; files?: unknown };
  if (typeof record.version !== "number" || !Number.isSafeInteger(record.version) || record.version < 1 || !Array.isArray(record.files)) {
    throw new Error("Library manifest is unreadable");
  }
  return { version: record.version, files: record.files as SealedName[] };
}

export async function* sealStream(
  source: AsyncIterable<Uint8Array>,
  key: CryptoKey,
  chunkBytes = CHUNK_BYTES,
  binding: ChunkBinding = { fileId: "", objectId: "" },
): AsyncGenerator<Uint8Array> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new Error("Invalid chunk size");
  const parts: Uint8Array[] = [];
  for await (const piece of source) parts.push(piece);
  const plaintext = concatBytes(parts);
  const chunkCount = plaintext.byteLength === 0 ? 0 : Math.ceil(plaintext.byteLength / chunkBytes);
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * chunkBytes;
    const slice = plaintext.subarray(start, Math.min(start + chunkBytes, plaintext.byteLength));
    yield frame(await sealChunk(slice, key, binding, index, chunkCount, index === chunkCount - 1));
  }
}

export async function sealBytes(
  plaintext: Uint8Array,
  key: CryptoKey,
  chunkBytes = CHUNK_BYTES,
  binding: ChunkBinding = { fileId: "", objectId: "" },
): Promise<Uint8Array> {
  async function* once(): AsyncGenerator<Uint8Array> {
    yield plaintext;
  }
  const parts: Uint8Array[] = [];
  for await (const part of sealStream(once(), key, chunkBytes, binding)) parts.push(part);
  return concatBytes(parts);
}

export async function openBytes(
  ciphertext: Uint8Array,
  key: CryptoKey,
  expected?: { chunkCount?: number; totalSize?: number; fileId?: string; objectId?: string },
): Promise<Uint8Array> {
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (offset < ciphertext.byteLength) {
    if (offset + 4 > ciphertext.byteLength) throw new Error("Ciphertext is truncated");
    const view = new DataView(ciphertext.buffer, ciphertext.byteOffset + offset, 4);
    const length = view.getUint32(0);
    offset += 4;
    if (length < IV_BYTES + TAG_BYTES || offset + length > ciphertext.byteLength) {
      throw new Error("Ciphertext is truncated");
    }
    frames.push(ciphertext.subarray(offset, offset + length));
    offset += length;
  }
  if (expected?.chunkCount !== undefined && frames.length !== expected.chunkCount) {
    throw new Error("Ciphertext is truncated");
  }
  const binding = { fileId: expected?.fileId ?? "", objectId: expected?.objectId ?? "" };
  const parts: Uint8Array[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    const chunk = frames[index];
    if (!chunk) throw new Error("Ciphertext is truncated");
    parts.push(await openChunk(chunk, key, binding, index, frames.length, index === frames.length - 1));
  }
  const plain = concatBytes(parts);
  if (expected?.totalSize !== undefined && plain.byteLength !== expected.totalSize) {
    throw new Error("Ciphertext is truncated");
  }
  return plain;
}

async function wrapFileKey(raw: Uint8Array, workspaceKey: CryptoKey): Promise<{ wrapped: Uint8Array; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: AES, iv }, workspaceKey, copyBytes(raw)));
  return { wrapped, iv };
}

async function unwrapFileKey(wrapped: Uint8Array, iv: Uint8Array, workspaceKey: CryptoKey): Promise<CryptoKey> {
  const raw = new Uint8Array(await crypto.subtle.decrypt({ name: AES, iv: copyBytes(iv) }, workspaceKey, copyBytes(wrapped)));
  if (raw.byteLength !== KEY_BYTES) throw new Error("Wrapped file key is invalid");
  return crypto.subtle.importKey("raw", raw, { name: AES }, false, ["encrypt", "decrypt"]);
}

function chunkAad(binding: ChunkBinding, index: number, chunkCount: number, final: boolean): Uint8Array {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) throw new Error("Invalid chunk index");
  if (!Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > 0xffffffff) throw new Error("Invalid chunk count");
  const fileId = new TextEncoder().encode(binding.fileId);
  const objectId = new TextEncoder().encode(binding.objectId);
  const aad = new Uint8Array(4 + 4 + 1 + 2 + fileId.byteLength + 2 + objectId.byteLength);
  const view = new DataView(aad.buffer);
  view.setUint32(0, index);
  view.setUint32(4, chunkCount);
  aad[8] = final ? 1 : 0;
  view.setUint16(9, fileId.byteLength);
  aad.set(fileId, 11);
  view.setUint16(11 + fileId.byteLength, objectId.byteLength);
  aad.set(objectId, 13 + fileId.byteLength);
  return aad;
}

async function sealChunk(
  plaintext: Uint8Array,
  key: CryptoKey,
  binding: ChunkBinding,
  index: number,
  chunkCount: number,
  final: boolean,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: AES, iv, additionalData: chunkAad(binding, index, chunkCount, final) },
    key,
    copyBytes(plaintext),
  ));
  const out = new Uint8Array(iv.byteLength + cipher.byteLength);
  out.set(iv, 0);
  out.set(cipher, iv.byteLength);
  return out;
}

async function openChunk(
  bytes: Uint8Array,
  key: CryptoKey,
  binding: ChunkBinding,
  index: number,
  chunkCount: number,
  final: boolean,
): Promise<Uint8Array> {
  const iv = bytes.subarray(0, IV_BYTES);
  const cipher = bytes.subarray(IV_BYTES);
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: AES, iv: copyBytes(iv), additionalData: chunkAad(binding, index, chunkCount, final) },
    key,
    copyBytes(cipher),
  ));
}

function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, payload.byteLength);
  out.set(payload, 4);
  return out;
}

function assertPlainPath(value: string): string {
  const parts = value.split("/");
  if (!value || value.startsWith("/") || value.includes("\\") || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid file path");
  }
  return value;
}

function randomOid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

/**
 * Lenient envelope decoder. Accepts base64url and standard base64, with or
 * without `=` padding. Encoding stays `bytesToBase64Url` (no padding).
 */
export function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) throw new Error("envelope_invalid");
  const stripped = value.replace(/=+$/g, "");
  const padded = stripped + (stripped.length % 4 === 0 ? "" : "=".repeat(4 - (stripped.length % 4)));
  return base64ToBytes(padded.replaceAll("-", "+").replaceAll("_", "/"));
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}
