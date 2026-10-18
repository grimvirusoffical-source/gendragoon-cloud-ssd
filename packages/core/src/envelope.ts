// Ambient module types for libsodium-wrappers-sumo. A path reference is required
// so packages that compile this file also see the declaration.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./libsodium-sumo.d.ts" />
import type { KeyEnvelope } from "./api/types.js";
import { assertNoCredentialFields } from "./byo.js";
import {
  bytesToBase64,
  base64ToBytes,
  createWorkspaceKey,
  importWorkspaceKey,
  workspaceKeyId,
  type SecretStore,
} from "./seal.js";
import sodium from "libsodium-wrappers-sumo";

const AES = "AES-GCM";
const IV_BYTES = 12;
const KEY_BYTES = 32;

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
 * One random 256-bit workspace key, wrapped for the server.
 * Argon2id is the KDF. If it throws, the envelope uses scrypt instead.
 * Salt and KDF params are stored in the envelope. The raw key is not.
 */
export async function createKeyEnvelope(
  workspaceKey: Uint8Array,
  passphrase: string,
  options: {
    kdf?: KeyEnvelope["kdf"];
    opsLimit?: number;
    memLimit?: number;
    argon2id?: Argon2;
  } = {},
): Promise<KeyEnvelope> {
  assertPassphrase(passphrase);
  if (workspaceKey.byteLength !== KEY_BYTES) throw new Error("Workspace key must be 256 bits");
  const lib = await loadSodium();
  let kdf: KeyEnvelope["kdf"] = options.kdf ?? "argon2id";
  let salt: Uint8Array;
  let opsLimit: number;
  let memLimit: number;
  let kek: Uint8Array | null = null;
  if (kdf === "argon2id") {
    salt = lib.randombytes_buf(lib.crypto_pwhash_SALTBYTES);
    opsLimit = options.opsLimit ?? lib.crypto_pwhash_OPSLIMIT_INTERACTIVE;
    memLimit = options.memLimit ?? lib.crypto_pwhash_MEMLIMIT_INTERACTIVE;
    try {
      const derive = options.argon2id ?? ((pass, nextSalt, ops, mem) => lib.crypto_pwhash(
        KEY_BYTES,
        pass,
        nextSalt,
        ops,
        mem,
        lib.crypto_pwhash_ALG_ARGON2ID13,
      ));
      kek = derive(passphrase, salt, opsLimit, memLimit);
    } catch {
      kdf = "scrypt";
      salt = lib.randombytes_buf(lib.crypto_pwhash_scryptsalsa208sha256_SALTBYTES);
      opsLimit = lib.crypto_pwhash_scryptsalsa208sha256_OPSLIMIT_INTERACTIVE;
      memLimit = lib.crypto_pwhash_scryptsalsa208sha256_MEMLIMIT_INTERACTIVE;
      kek = lib.crypto_pwhash_scryptsalsa208sha256(KEY_BYTES, passphrase, salt, opsLimit, memLimit);
    }
  } else {
    salt = lib.randombytes_buf(lib.crypto_pwhash_scryptsalsa208sha256_SALTBYTES);
    opsLimit = options.opsLimit ?? lib.crypto_pwhash_scryptsalsa208sha256_OPSLIMIT_INTERACTIVE;
    memLimit = options.memLimit ?? lib.crypto_pwhash_scryptsalsa208sha256_MEMLIMIT_INTERACTIVE;
    kek = lib.crypto_pwhash_scryptsalsa208sha256(KEY_BYTES, passphrase, salt, opsLimit, memLimit);
  }
  if (!kek) throw new Error("Key derivation failed");
  const derived = kek;
  try {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const key = await crypto.subtle.importKey("raw", derived, { name: AES }, false, ["encrypt"]);
    const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: AES, iv }, key, copy(workspaceKey)));
    const envelope: KeyEnvelope = {
      version: 1,
      kdf,
      salt: bytesToBase64(salt),
      opsLimit,
      memLimit,
      iv: bytesToBase64(iv),
      wrappedKey: bytesToBase64(wrapped),
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
  const salt = base64ToBytes(envelope.salt);
  const kek = envelope.kdf === "argon2id"
    ? lib.crypto_pwhash(KEY_BYTES, passphrase, salt, envelope.opsLimit, envelope.memLimit, lib.crypto_pwhash_ALG_ARGON2ID13)
    : lib.crypto_pwhash_scryptsalsa208sha256(KEY_BYTES, passphrase, salt, envelope.opsLimit, envelope.memLimit);
  try {
    const key = await crypto.subtle.importKey("raw", kek, { name: AES }, false, ["decrypt"]);
    const raw = new Uint8Array(await crypto.subtle.decrypt(
      { name: AES, iv: base64ToBytes(envelope.iv) },
      key,
      base64ToBytes(envelope.wrappedKey),
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
  if (!value || typeof value !== "object") throw new Error("Key envelope is unreadable");
  const record = value as Partial<KeyEnvelope>;
  if (record.version !== 1) throw new Error("Key envelope is unreadable");
  if (record.kdf !== "argon2id" && record.kdf !== "scrypt") throw new Error("Key envelope is unreadable");
  if (typeof record.salt !== "string" || typeof record.iv !== "string" || typeof record.wrappedKey !== "string") {
    throw new Error("Key envelope is unreadable");
  }
  if (!Number.isFinite(record.opsLimit) || !Number.isFinite(record.memLimit) || (record.opsLimit ?? 0) <= 0 || (record.memLimit ?? 0) <= 0) {
    throw new Error("Key envelope is unreadable");
  }
  const keys = Object.keys(record);
  const allowed = new Set(["version", "kdf", "salt", "opsLimit", "memLimit", "iv", "wrappedKey"]);
  if (keys.some((key) => !allowed.has(key))) throw new Error("Key envelope is unreadable");
}

/**
 * Creating device: generate the workspace key, wrap it, cache it.
 * New device: ask for the passphrase once, then cache the unwrapped key.
 * A later call on the same device uses the keychain and does not ask again.
 */
export async function openWorkspaceKey(input: {
  store: SecretStore;
  workspaceId: string;
  envelope?: KeyEnvelope | null;
  passphrase?: string;
  create?: boolean;
  kdf?: KeyEnvelope["kdf"];
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

export async function importWrappedWorkspaceKey(raw: Uint8Array): Promise<CryptoKey> {
  return importWorkspaceKey(raw);
}

function assertPassphrase(passphrase: string): void {
  if (passphrase.trim().length < 8) throw new Error("Recovery passphrase must be at least 8 characters");
}

function copy(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}
