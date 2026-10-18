// Ambient module types for libsodium-wrappers-sumo. A path reference is required
// so packages that compile this file also see the declaration.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./libsodium-sumo.d.ts" />
import { ApiError } from "./api/errors.js";
import type { Argon2idKdf, KeyEnvelope, ScryptKdf } from "./api/types.js";
import { assertNoCredentialFields } from "./byo.js";
import {
  bytesToBase64Url,
  base64UrlToBytes,
  createWorkspaceKey,
  importWorkspaceKey,
  workspaceKeyId,
  type SecretStore,
} from "./seal.js";
import sodium from "libsodium-wrappers-sumo";

const AES = "AES-GCM";
const IV_BYTES = 12;
const KEY_BYTES = 32;
/** libsodium opsLimit ceiling. Mapped to `kdf.iterations` on the wire. */
export const KDF_MAX_ITERATIONS = 10;
/** 1 GiB expressed in KiB. Mapped from libsodium's byte memLimit. */
export const KDF_MAX_MEMORY_KIB = 1024 * 1024;
const ARGON_MEMORY_BYTES = 19 * 1024 * 1024;
const SCRYPT_N = 2 ** 14;

export const PASSPHRASE_LOSS_WARNING =
  "If you lose this passphrase, you lose the files. GenDragoon cannot recover them.";

type Argon2 = (
  passphrase: string,
  salt: Uint8Array,
  opsLimit: number,
  memLimit: number,
) => Uint8Array;

let ready: Promise<typeof sodium> | null = null;

function loadSodium(): Promise<typeof sodium> {
  ready ??= sodium.ready.then(() => sodium);
  return ready;
}

/**
 * Wrap one workspace key. Argon2id is the default.
 * Scrypt is used only when `kdf` is `"scrypt"`. An Argon2id failure stays an Argon2id failure.
 * `memoryKiB` above 1048576 or `iterations` above 10 is rejected before derivation.
 */
export async function createKeyEnvelope(
  workspaceKey: Uint8Array,
  passphrase: string,
  options: {
    kdf?: "argon2id" | "scrypt";
    version?: number;
    opsLimit?: number;
    memLimit?: number;
    parallelism?: number;
    scrypt?: Pick<ScryptKdf, "N" | "r" | "p">;
    argon2id?: Argon2;
  } = {},
): Promise<KeyEnvelope> {
  assertPassphrase(passphrase);
  if (workspaceKey.byteLength !== KEY_BYTES) throw new Error("Workspace key must be 256 bits");
  const version = options.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) throw new ApiError(422, "envelope_invalid", "Key envelope is unreadable");
  const lib = await loadSodium();
  const alg = options.kdf ?? "argon2id";
  const salt = lib.randombytes_buf(alg === "argon2id" ? lib.crypto_pwhash_SALTBYTES : 16);
  let kek: Uint8Array | null = null;
  let kdf: Argon2idKdf | ScryptKdf;
  if (alg === "argon2id") {
    const iterations = options.opsLimit ?? lib.crypto_pwhash_OPSLIMIT_INTERACTIVE;
    const memLimit = options.memLimit ?? ARGON_MEMORY_BYTES;
    const memoryKiB = memLimit / 1024;
    const parallelism = options.parallelism ?? 1;
    assertArgonCaps(memoryKiB, iterations);
    if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 4) {
      throw new ApiError(422, "envelope_invalid", "Key envelope is unreadable");
    }
    kdf = { alg: "argon2id", memoryKiB, iterations, parallelism };
    const derive = options.argon2id ?? ((pass, nextSalt, ops, mem) => lib.crypto_pwhash(
      KEY_BYTES,
      pass,
      nextSalt,
      ops,
      mem,
      lib.crypto_pwhash_ALG_ARGON2ID13,
    ));
    try {
      kek = derive(passphrase, salt, iterations, memLimit);
    } catch (error) {
      throw new Error(error instanceof Error && error.message === "envelope_invalid"
        ? "envelope_invalid"
        : "Argon2id key derivation failed");
    }
  } else {
    const N = options.scrypt?.N ?? SCRYPT_N;
    const r = options.scrypt?.r ?? 8;
    const p = options.scrypt?.p ?? 1;
    assertScryptN(N);
    if (N < 2 ** 14 || N > 2 ** 20 || r !== 8 || !Number.isInteger(p) || p < 1 || p > 4) {
      throw new ApiError(422, "envelope_invalid", "Key envelope is unreadable");
    }
    kdf = { alg: "scrypt", N, r, p };
    kek = lib.crypto_pwhash_scryptsalsa208sha256_ll(new TextEncoder().encode(passphrase), salt, N, r, p, KEY_BYTES);
  }
  if (!kek) throw new Error("Key derivation failed");
  const derived = kek;
  try {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const key = await crypto.subtle.importKey("raw", derived, { name: AES }, false, ["encrypt"]);
    const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: AES, iv }, key, copy(workspaceKey)));
    const envelope: KeyEnvelope = {
      version,
      kdf,
      salt: bytesToBase64Url(salt),
      iv: bytesToBase64Url(iv),
      wrappedKey: bytesToBase64Url(wrapped),
    };
    assertKeyEnvelope(envelope);
    return envelope;
  } finally {
    if (kek) lib.memzero(kek);
  }
}

export async function unwrapWorkspaceKey(envelope: KeyEnvelope, passphrase: string): Promise<Uint8Array> {
  assertPassphrase(passphrase);
  assertKeyEnvelope(envelope);
  const lib = await loadSodium();
  const salt = base64UrlToBytes(envelope.salt);
  const kek = envelope.kdf.alg === "argon2id"
    ? lib.crypto_pwhash(
      KEY_BYTES,
      passphrase,
      salt,
      envelope.kdf.iterations,
      envelope.kdf.memoryKiB * 1024,
      lib.crypto_pwhash_ALG_ARGON2ID13,
    )
    : lib.crypto_pwhash_scryptsalsa208sha256_ll(
      new TextEncoder().encode(passphrase),
      salt,
      envelope.kdf.N,
      envelope.kdf.r,
      envelope.kdf.p,
      KEY_BYTES,
    );
  try {
    const key = await crypto.subtle.importKey("raw", kek, { name: AES }, false, ["decrypt"]);
    const raw = new Uint8Array(await crypto.subtle.decrypt(
      { name: AES, iv: base64UrlToBytes(envelope.iv) },
      key,
      base64UrlToBytes(envelope.wrappedKey),
    ));
    if (raw.byteLength !== KEY_BYTES) throw new Error("Recovery passphrase did not unlock this workspace");
    return raw;
  } catch (error) {
    if (error instanceof Error && error.message === "Recovery passphrase did not unlock this workspace") throw error;
    throw new Error("Recovery passphrase did not unlock this workspace");
  } finally {
    lib.memzero(kek);
  }
}

export function assertKeyEnvelope(value: unknown): asserts value is KeyEnvelope {
  assertNoCredentialFields(value);
  if (!value || typeof value !== "object") throw invalidEnvelope();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowed = new Set(["version", "kdf", "salt", "iv", "wrappedKey"]);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) throw invalidEnvelope();
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 1) throw invalidEnvelope();
  if (typeof record.salt !== "string" || typeof record.iv !== "string" || typeof record.wrappedKey !== "string") {
    throw invalidEnvelope();
  }
  const salt = decodeField(record.salt);
  const iv = decodeField(record.iv);
  const wrapped = decodeField(record.wrappedKey);
  if (salt.byteLength < 16 || salt.byteLength > 64) throw invalidEnvelope();
  if (iv.byteLength < 12 || iv.byteLength > 32) throw invalidEnvelope();
  if (wrapped.byteLength < 32) throw invalidEnvelope();
  assertKdf(record.kdf);
}

function assertKdf(value: unknown): asserts value is Argon2idKdf | ScryptKdf {
  if (!value || typeof value !== "object") throw invalidEnvelope();
  const record = value as Record<string, unknown>;
  if (record.alg === "argon2id") {
    const keys = Object.keys(record);
    if (keys.length !== 4 || !["alg", "memoryKiB", "iterations", "parallelism"].every((key) => keys.includes(key))) {
      throw invalidEnvelope();
    }
    assertArgonCaps(record.memoryKiB, record.iterations);
    if (!Number.isInteger(record.parallelism) || (record.parallelism as number) < 1 || (record.parallelism as number) > 4) {
      throw invalidEnvelope();
    }
    return;
  }
  if (record.alg === "scrypt") {
    const keys = Object.keys(record);
    if (keys.length !== 4 || !["alg", "N", "r", "p"].every((key) => keys.includes(key))) throw invalidEnvelope();
    const N = record.N as number;
    const r = record.r as number;
    const p = record.p as number;
    assertScryptN(N);
    if (N < 2 ** 14 || N > 2 ** 20 || r !== 8 || !Number.isInteger(p) || p < 1 || p > 4) {
      throw invalidEnvelope();
    }
    return;
  }
  throw invalidEnvelope();
}

/** Reject scrypt `N` before any derivation. Same code the server uses for bad KDF parameters. */
function assertScryptN(N: unknown): void {
  if (typeof N !== "number" || !Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0) {
    throw new ApiError(422, "kdf_params_invalid", "Key derivation parameters are not allowed.");
  }
}

function assertArgonCaps(memoryKiB: unknown, iterations: unknown): void {
  if (!Number.isInteger(memoryKiB) || (memoryKiB as number) < 1 || (memoryKiB as number) > KDF_MAX_MEMORY_KIB) {
    throw invalidEnvelope();
  }
  if (!Number.isInteger(iterations) || (iterations as number) < 1 || (iterations as number) > KDF_MAX_ITERATIONS) {
    throw invalidEnvelope();
  }
}

function invalidEnvelope(): ApiError {
  return new ApiError(422, "envelope_invalid", "Key envelope is unreadable");
}

function decodeField(value: string): Uint8Array {
  try {
    return base64UrlToBytes(value);
  } catch {
    throw invalidEnvelope();
  }
}

/**
 * Creating device: generate the workspace key and wrap it.
 * The key is cached only after the caller has a 201. This function does not upload.
 * New device: ask for the passphrase once, then cache the unwrapped key.
 */
export async function openWorkspaceKey(input: {
  store: SecretStore;
  workspaceId: string;
  envelope?: KeyEnvelope | null;
  passphrase?: string;
  create?: boolean;
  kdf?: "argon2id" | "scrypt";
  opsLimit?: number;
  memLimit?: number;
  argon2id?: Argon2;
}): Promise<{ state: "cached" | "unlocked" | "needs-passphrase"; key?: Uint8Array; envelope?: KeyEnvelope }> {
  const name = workspaceKeyId(input.workspaceId);
  const cached = await input.store.get(name);
  if (cached && cached.byteLength === KEY_BYTES) return { state: "cached", key: cached };
  if (input.create) {
    if (!input.passphrase) return { state: "needs-passphrase" };
    const key = await createWorkspaceKey();
    const envelope = await createKeyEnvelope(key, input.passphrase, input);
    await input.store.set(name, key);
    return { state: "unlocked", key, envelope };
  }
  if (!input.envelope || !input.passphrase) return { state: "needs-passphrase" };
  const key = await unwrapWorkspaceKey(input.envelope, input.passphrase);
  await input.store.set(name, key);
  return { state: "unlocked", key };
}

/**
 * Upload a wrapped key. The local key is written only after `put` resolves.
 * A 409 or 412 leaves whatever was already stored untouched.
 */
export async function publishKeyEnvelope(input: {
  store: SecretStore;
  workspaceId: string;
  key: Uint8Array;
  envelope: KeyEnvelope;
  put: (envelope: KeyEnvelope) => Promise<unknown>;
}): Promise<void> {
  assertKeyEnvelope(input.envelope);
  await input.put(input.envelope);
  await input.store.set(workspaceKeyId(input.workspaceId), copy(input.key));
}

/**
 * Create the workspace key on the server.
 * The generated key is stored only after HTTP 201.
 * HTTP 409 means another device won: fetch that envelope, unwrap it, adopt that key.
 * The create is not retried and the existing envelope is not overwritten.
 */
export async function establishWorkspaceKey(input: {
  store: SecretStore;
  workspaceId: string;
  passphrase: string;
  get: () => Promise<KeyEnvelope>;
  put: (envelope: KeyEnvelope) => Promise<unknown>;
  kdf?: "argon2id" | "scrypt";
  opsLimit?: number;
  memLimit?: number;
}): Promise<{ key: Uint8Array; envelope: KeyEnvelope; adopted: boolean }> {
  const generated = await createWorkspaceKey();
  const envelope = await createKeyEnvelope(generated, input.passphrase, {
    kdf: input.kdf,
    version: 1,
    opsLimit: input.opsLimit,
    memLimit: input.memLimit,
  });
  try {
    await input.put(envelope);
    await input.store.set(workspaceKeyId(input.workspaceId), generated);
    return { key: generated, envelope, adopted: false };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && error.code === "envelope_exists") {
      const remote = await input.get();
      const adopted = await unwrapWorkspaceKey(remote, input.passphrase);
      await input.store.set(workspaceKeyId(input.workspaceId), adopted);
      return { key: adopted, envelope: remote, adopted: true };
    }
    throw error;
  }
}

/**
 * Change the passphrase wrap. The workspace key bytes stay the same.
 * HTTP 412 refetches the current version and re-wraps that same key.
 */
export async function rewrapWorkspaceKey(input: {
  key: Uint8Array;
  passphrase: string;
  get: () => Promise<KeyEnvelope>;
  put: (envelope: KeyEnvelope) => Promise<KeyEnvelope>;
}): Promise<{ key: Uint8Array; envelope: KeyEnvelope }> {
  const current = await input.get();
  const next = await createKeyEnvelope(input.key, input.passphrase, { version: current.version + 1, ...kdfOptions(current) });
  try {
    const saved = await input.put(next);
    return { key: copy(input.key), envelope: saved };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 412) throw error;
    const again = await input.get();
    const retry = await createKeyEnvelope(input.key, input.passphrase, { version: again.version + 1, ...kdfOptions(again) });
    const saved = await input.put(retry);
    return { key: copy(input.key), envelope: saved };
  }
}

function kdfOptions(envelope: KeyEnvelope): { kdf: "argon2id" | "scrypt"; opsLimit?: number; memLimit?: number; parallelism?: number; scrypt?: Pick<ScryptKdf, "N" | "r" | "p"> } {
  if (envelope.kdf.alg === "scrypt") {
    return { kdf: "scrypt", scrypt: { N: envelope.kdf.N, r: envelope.kdf.r, p: envelope.kdf.p } };
  }
  return {
    kdf: "argon2id",
    opsLimit: envelope.kdf.iterations,
    memLimit: envelope.kdf.memoryKiB * 1024,
    parallelism: envelope.kdf.parallelism,
  };
}

export async function importWrappedWorkspaceKey(raw: Uint8Array): Promise<CryptoKey> {
  return importWorkspaceKey(raw);
}

function assertPassphrase(passphrase: string): void {
  if (passphrase.trim().length < 8) throw new Error("Recovery passphrase must be at least 8 characters");
}

function copy(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}
