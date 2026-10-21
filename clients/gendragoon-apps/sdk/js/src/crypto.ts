// Encryption formats: sdk/spec/FORMATS.md. WebCrypto only (Node 20+, browsers, Deno, Bun); scrypt is
// implemented here because WebCrypto has no scrypt.
import { buf, concat, dec, enc, equal, fromB64u, fromHex, random, toB64u, toHex, wipe } from "./bytes.js";

const subtle = () => globalThis.crypto.subtle;
const INFO = "gendragoon-sdk/v1/";
export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", buf(data)));
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", k, buf(data)));
}

/** HKDF-SHA256(ikm, no salt, info = "gendragoon-sdk/v1/" + purpose), 32 bytes. */
export async function subKey(ikm: Uint8Array, purpose: string): Promise<Uint8Array> {
  const k = await subtle().importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(INFO + purpose) }, k, 256));
}

export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<Uint8Array> {
  const k = await subtle().importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: buf(salt), info: enc.encode(info) }, k, 256));
}

export async function gcmSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey("raw", buf(key), "AES-GCM", false, ["encrypt"]);
  const p: AesGcmParams = { name: "AES-GCM", iv: buf(nonce) };
  if (aad) p.additionalData = buf(aad);
  return new Uint8Array(await subtle().encrypt(p, k, buf(plaintext)));
}

export async function gcmOpen(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array | null> {
  try {
    const k = await subtle().importKey("raw", buf(key), "AES-GCM", false, ["decrypt"]);
    const p: AesGcmParams = { name: "AES-GCM", iv: buf(nonce) };
    if (aad) p.additionalData = buf(aad);
    return new Uint8Array(await subtle().decrypt(p, k, buf(ciphertext)));
  } catch {
    return null;
  }
}

// ---- scrypt (RFC 7914) -------------------------------------------------------------------------------

async function pbkdf2(pass: Uint8Array, salt: Uint8Array, bytes: number): Promise<Uint8Array> {
  const k = await subtle().importKey("raw", buf(pass), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: buf(salt), iterations: 1 }, k, bytes * 8));
}

function salsa8(b: Uint32Array, x: Uint32Array): void {
  x.set(b);
  for (let i = 0; i < 8; i += 2) {
    const R = (a: number, n: number) => (a << n) | (a >>> (32 - n));
    x[4]! ^= R(x[0]! + x[12]!, 7); x[8]! ^= R(x[4]! + x[0]!, 9); x[12]! ^= R(x[8]! + x[4]!, 13); x[0]! ^= R(x[12]! + x[8]!, 18);
    x[9]! ^= R(x[5]! + x[1]!, 7); x[13]! ^= R(x[9]! + x[5]!, 9); x[1]! ^= R(x[13]! + x[9]!, 13); x[5]! ^= R(x[1]! + x[13]!, 18);
    x[14]! ^= R(x[10]! + x[6]!, 7); x[2]! ^= R(x[14]! + x[10]!, 9); x[6]! ^= R(x[2]! + x[14]!, 13); x[10]! ^= R(x[6]! + x[2]!, 18);
    x[3]! ^= R(x[15]! + x[11]!, 7); x[7]! ^= R(x[3]! + x[15]!, 9); x[11]! ^= R(x[7]! + x[3]!, 13); x[15]! ^= R(x[11]! + x[7]!, 18);
    x[1]! ^= R(x[0]! + x[3]!, 7); x[2]! ^= R(x[1]! + x[0]!, 9); x[3]! ^= R(x[2]! + x[1]!, 13); x[0]! ^= R(x[3]! + x[2]!, 18);
    x[6]! ^= R(x[5]! + x[4]!, 7); x[7]! ^= R(x[6]! + x[5]!, 9); x[4]! ^= R(x[7]! + x[6]!, 13); x[5]! ^= R(x[4]! + x[7]!, 18);
    x[11]! ^= R(x[10]! + x[9]!, 7); x[8]! ^= R(x[11]! + x[10]!, 9); x[9]! ^= R(x[8]! + x[11]!, 13); x[10]! ^= R(x[9]! + x[8]!, 18);
    x[12]! ^= R(x[15]! + x[14]!, 7); x[13]! ^= R(x[12]! + x[15]!, 9); x[14]! ^= R(x[13]! + x[12]!, 13); x[15]! ^= R(x[14]! + x[13]!, 18);
  }
  for (let i = 0; i < 16; i++) b[i] = (b[i]! + x[i]!) >>> 0;
}

function blockMix(B: Uint32Array, Y: Uint32Array, r: number, X: Uint32Array, tmp: Uint32Array): void {
  X.set(B.subarray((2 * r - 1) * 16, 2 * r * 16));
  for (let i = 0; i < 2 * r; i++) {
    for (let j = 0; j < 16; j++) X[j]! ^= B[i * 16 + j]!;
    salsa8(X, tmp);
    Y.set(X, ((i >> 1) + (i & 1) * r) * 16);
  }
}

/** scrypt(passphrase, salt, N, r, p) -> dkLen bytes. */
export async function scrypt(pass: Uint8Array, salt: Uint8Array, N: number, r: number, p: number, dkLen: number): Promise<Uint8Array> {
  const words = 32 * r;
  const raw = await pbkdf2(pass, salt, p * 128 * r);
  const B = new Uint32Array(p * words);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let i = 0; i < B.length; i++) B[i] = dv.getUint32(i * 4, true);
  const V = new Uint32Array(N * words);
  const X = new Uint32Array(words), Y = new Uint32Array(words), T = new Uint32Array(16), S = new Uint32Array(16);
  for (let k = 0; k < p; k++) {
    X.set(B.subarray(k * words, (k + 1) * words));
    for (let i = 0; i < N; i++) {
      V.set(X, i * words);
      blockMix(X, Y, r, T, S);
      X.set(Y);
    }
    for (let i = 0; i < N; i++) {
      const j = X[(2 * r - 1) * 16]! & (N - 1);
      for (let w = 0; w < words; w++) X[w]! ^= V[j * words + w]!;
      blockMix(X, Y, r, T, S);
      X.set(Y);
    }
    B.set(X, k * words);
  }
  const out = new Uint8Array(B.length * 4);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < B.length; i++) ov.setUint32(i * 4, B[i]!, true);
  V.fill(0);
  return pbkdf2(pass, out, dkLen);
}

// ---- key envelope -------------------------------------------------------------------------------------

export interface ScryptKdf { alg: "scrypt"; N: number; r: number; p: number }
export interface Argon2idKdf { alg: "argon2id"; memoryKiB: number; iterations: number; parallelism: number }
export interface KeyEnvelope { version: number; kdf: ScryptKdf | Argon2idKdf; salt: string; iv: string; wrappedKey: string }

export const DEFAULT_SCRYPT: ScryptKdf = { alg: "scrypt", N: 2 ** 15, r: 8, p: 1 };

/** Argon2id is not part of WebCrypto. Install an implementation to open argon2id envelopes. */
export type Argon2idFn = (pass: Uint8Array, salt: Uint8Array, kdf: Argon2idKdf, len: number) => Promise<Uint8Array>;
let argon2id: Argon2idFn | null = null;
export function setArgon2id(fn: Argon2idFn | null): void {
  argon2id = fn;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super("gendragoon: the recovery passphrase did not unlock this key");
    this.name = "WrongPassphraseError";
  }
}

export function validateEnvelope(e: unknown): asserts e is KeyEnvelope {
  const bad = () => new Error("gendragoon: key envelope is not valid");
  if (!e || typeof e !== "object") throw bad();
  const env = e as KeyEnvelope;
  if (!Number.isSafeInteger(env.version) || env.version < 1) throw bad();
  const k = env.kdf as unknown as Record<string, number | string>;
  if (k?.alg === "scrypt") {
    const N = k.N as number;
    if (!Number.isInteger(N) || N < 2 ** 14 || N > 2 ** 20 || (N & (N - 1)) !== 0 || k.r !== 8 || !(Number(k.p) >= 1 && Number(k.p) <= 4)) throw bad();
  } else if (k?.alg === "argon2id") {
    const m = k.memoryKiB as number, t = k.iterations as number, p = k.parallelism as number;
    if (!(m >= 19456 && m <= 1048576 && t >= 1 && t <= 10 && p >= 1 && p <= 4)) throw bad();
  } else throw bad();
  try {
    const salt = fromB64u(env.salt), iv = fromB64u(env.iv), wk = fromB64u(env.wrappedKey);
    if (salt.length < 16 || salt.length > 64 || iv.length < 12 || iv.length > 32 || wk.length < 32) throw bad();
  } catch {
    throw bad();
  }
}

async function deriveKek(passphrase: string, kdf: KeyEnvelope["kdf"], salt: Uint8Array): Promise<Uint8Array> {
  if (enc.encode(passphrase).length < 8) throw new Error("gendragoon: recovery passphrase must be at least 8 characters");
  const pass = enc.encode(passphrase);
  if (kdf.alg === "scrypt") return scrypt(pass, salt, kdf.N, kdf.r, kdf.p, KEY_BYTES);
  if (!argon2id) throw new Error("gendragoon: this envelope uses argon2id; call setArgon2id() with an implementation");
  return argon2id(pass, salt, kdf, KEY_BYTES);
}

export async function wrapMasterKey(mk: Uint8Array, passphrase: string, kdf: KeyEnvelope["kdf"] = DEFAULT_SCRYPT, version = 1,
  rnd: (n: number) => Uint8Array = random): Promise<KeyEnvelope> {
  if (mk.length !== KEY_BYTES) throw new Error("gendragoon: master key must be 32 bytes");
  const salt = rnd(16), iv = rnd(NONCE_BYTES);
  const kek = await deriveKek(passphrase, kdf, salt);
  try {
    const env: KeyEnvelope = { version, kdf, salt: toB64u(salt), iv: toB64u(iv), wrappedKey: toB64u(await gcmSeal(kek, iv, mk)) };
    validateEnvelope(env);
    return env;
  } finally {
    wipe(kek);
  }
}

export async function unwrapMasterKey(env: KeyEnvelope, passphrase: string): Promise<Uint8Array> {
  validateEnvelope(env);
  const kek = await deriveKek(passphrase, env.kdf, fromB64u(env.salt));
  try {
    const mk = await gcmOpen(kek, fromB64u(env.iv), fromB64u(env.wrappedKey));
    if (!mk || mk.length !== KEY_BYTES) throw new WrongPassphraseError();
    return mk;
  } finally {
    wipe(kek);
  }
}

// ---- sealed objects ----------------------------------------------------------------------------------

const CHUNK_MAGIC = enc.encode("GDC1");
const MANIFEST_MAGIC = enc.encode("GDM1");
const PLAIN_MANIFEST = enc.encode("GDM0");

export class LockedError extends Error {
  constructor() {
    super("gendragoon: master key not unlocked");
    this.name = "LockedError";
  }
}

export class CorruptError extends Error {
  constructor() {
    super("gendragoon: data is corrupt or was encrypted with another key");
    this.name = "CorruptError";
  }
}

export async function sealChunk(fileKey: Uint8Array, plaintext: Uint8Array, nonce: Uint8Array = random(NONCE_BYTES)): Promise<{ id: string; blob: Uint8Array }> {
  const rawId = await hmacSha256(await subKey(fileKey, "chunk-id"), plaintext);
  const ct = await gcmSeal(await subKey(fileKey, "chunk-enc"), nonce, plaintext, concat(CHUNK_MAGIC, rawId));
  return { id: toHex(rawId), blob: concat(CHUNK_MAGIC, nonce, ct) };
}

export async function openChunk(fileKey: Uint8Array, id: string, blob: Uint8Array): Promise<Uint8Array> {
  if (!/^[0-9a-f]{64}$/.test(id) || blob.length < 32 || !equal(blob.subarray(0, 4), CHUNK_MAGIC)) throw new CorruptError();
  const rawId = fromHex(id);
  const pt = await gcmOpen(await subKey(fileKey, "chunk-enc"), blob.subarray(4, 16), blob.subarray(16), concat(CHUNK_MAGIC, rawId));
  if (!pt || !equal(await hmacSha256(await subKey(fileKey, "chunk-id"), pt), rawId)) throw new CorruptError();
  return pt;
}

/** Manifest key of a named drive. mk null: the plain-drive key. */
export async function driveManifestKey(mk: Uint8Array | null, name: string): Promise<string> {
  if (!mk) return toHex(await sha256(enc.encode(INFO + "drive:" + name)));
  return toHex(await hmacSha256(await subKey(mk, "manifest-name"), enc.encode("drive:" + name)));
}

export async function sealManifest(mk: Uint8Array | null, key: string, plaintext: Uint8Array, nonce: Uint8Array = random(NONCE_BYTES)): Promise<Uint8Array> {
  if (!mk) return concat(PLAIN_MANIFEST, plaintext);
  const ct = await gcmSeal(await subKey(mk, "manifest-enc"), nonce, plaintext, concat(MANIFEST_MAGIC, fromHex(key)));
  return concat(MANIFEST_MAGIC, nonce, ct);
}

export async function openManifest(mk: Uint8Array | null, key: string, data: Uint8Array): Promise<Uint8Array> {
  if (data.length >= 4 && equal(data.subarray(0, 4), PLAIN_MANIFEST)) return data.subarray(4);
  if (data.length < 32 || !equal(data.subarray(0, 4), MANIFEST_MAGIC)) throw new CorruptError();
  if (!mk) throw new LockedError();
  const pt = await gcmOpen(await subKey(mk, "manifest-enc"), data.subarray(4, 16), data.subarray(16), concat(MANIFEST_MAGIC, fromHex(key)));
  if (!pt) throw new CorruptError();
  return pt;
}

export const text = { encode: (s: string) => enc.encode(s), decode: (b: Uint8Array) => dec.decode(b) };
