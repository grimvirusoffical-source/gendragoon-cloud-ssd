// Sharing one file with a recipient (ECDH P-256 + HKDF-SHA256 + AES-256-GCM, sdk/spec/FORMATS.md), and the
// read-only keys a recipient uses to fetch the chunks.
import { concat, enc, fromB64u, random, toB64u } from "./bytes.js";
import { CorruptError, NONCE_BYTES, gcmOpen, gcmSeal, hkdf, sha256, text } from "./crypto.js";
import { API_KEY_RE, APIError, type Client } from "./client.js";
import { readEntry, type Drive, type FileEntry } from "./drive.js";

const PREFIX = "gdid1_";
const ALG = "ECDH-P256+HKDF-SHA256+A256GCM";
const AAD = enc.encode("gd-share-v1");
const subtle = () => globalThis.crypto.subtle;
const P256 = { name: "ECDH", namedCurve: "P-256" } as const;

export interface Share { v: 1; alg: string; recipient: string; epk: string; nonce: string; ct: string }
export interface SharedFile { v: 1; path: string; entry: FileEntry }

/** A recipient key pair. */
export class Identity {
  private constructor(private readonly priv: CryptoKey, private readonly pub: Uint8Array, private readonly d: Uint8Array) {}
  /** Creates a recipient key pair. Level L2, risk key (local). */
  static async create(c: Client): Promise<Identity> {
    c.check("share.createIdentity");
    const kp = (await subtle().generateKey(P256, true, ["deriveBits"])) as CryptoKeyPair;
    const jwk = await subtle().exportKey("jwk", kp.privateKey);
    const pub = new Uint8Array(await subtle().exportKey("raw", kp.publicKey));
    return new Identity(kp.privateKey, pub, fromB64u(jwk.d!));
  }
  /** Restores an identity from privateBytes(): 32-byte scalar followed by the 65-byte uncompressed public point. */
  static async fromPrivate(b: Uint8Array): Promise<Identity> {
    if (b.length !== 97 || b[32] !== 4) throw new Error("gendragoon: identity must be 97 bytes");
    const d = b.slice(0, 32), pub = b.slice(32);
    const priv = await subtle().importKey("jwk", { kty: "EC", crv: "P-256", d: toB64u(d), x: toB64u(pub.subarray(1, 33)), y: toB64u(pub.subarray(33)), ext: true },
      P256, true, ["deriveBits"]).catch(() => { throw new Error("gendragoon: identity public key does not match"); });
    return new Identity(priv, pub, d);
  }
  /** Keep it secret. */
  privateBytes(): Uint8Array { return concat(this.d, this.pub); }
  /** The shareable recipient id: "gdid1_" + base64url(uncompressed point). */
  get public(): string { return PREFIX + toB64u(this.pub); }
  /** @internal */
  async shared(epk: Uint8Array): Promise<Uint8Array> {
    const k = await subtle().importKey("raw", epk as Uint8Array<ArrayBuffer>, P256, false, []);
    return new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: k }, this.priv, 256));
  }
  /** @internal */
  get publicRaw(): Uint8Array { return this.pub; }
}

async function recipientTag(rpk: Uint8Array): Promise<string> { return toB64u((await sha256(rpk)).subarray(0, 8)); }
const shareKey = (shared: Uint8Array, epk: Uint8Array, rpk: Uint8Array) => hkdf(shared, concat(epk, rpk), "gendragoon-sdk/v1/share");

function parseRecipient(id: string): Uint8Array {
  if (!id.startsWith(PREFIX)) throw new Error("gendragoon: not a recipient id");
  const raw = fromB64u(id.slice(PREFIX.length));
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("gendragoon: not a recipient id");
  return raw;
}

/** @internal Seals a payload to a recipient public key (the ephemeral key and nonce may be fixed for test vectors). */
export async function sealShare(rpk: Uint8Array, payload: Uint8Array, eph?: Identity, nonce: Uint8Array = random(NONCE_BYTES)): Promise<Share> {
  let shared: Uint8Array, epk: Uint8Array;
  if (eph) {
    shared = await eph.shared(rpk);
    epk = eph.publicRaw;
  } else {
    const kp = (await subtle().generateKey(P256, false, ["deriveBits"])) as CryptoKeyPair;
    const r = await subtle().importKey("raw", rpk as Uint8Array<ArrayBuffer>, P256, false, []);
    shared = new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: r }, kp.privateKey, 256));
    epk = new Uint8Array(await subtle().exportKey("raw", kp.publicKey));
  }
  const key = await shareKey(shared, epk, rpk);
  return { v: 1, alg: ALG, recipient: await recipientTag(rpk), epk: toB64u(epk), nonce: toB64u(nonce), ct: toB64u(await gcmSeal(key, nonce, payload, AAD)) };
}

/** Encrypts one file of an encrypted drive to a recipient. Level L3, risk sharing. */
export async function exportShare(drive: Drive, c: Client, path: string, recipient: string): Promise<Share> {
  c.check("share.export");
  if (!drive.encrypted) throw new Error("gendragoon: plain drives have nothing to share; give the reader access to the binding instead");
  const rpk = parseRecipient(recipient);
  const e = (await drive.load()).doc.files[path];
  if (!e) throw new APIError(404, "not_found");
  const entry: FileEntry = { size: e.size, mtime: e.mtime, sha256: e.sha256, chunks: e.chunks, ...(e.key ? { key: e.key } : {}) };
  return sealShare(rpk, enc.encode(JSON.stringify({ v: 1, path, entry })));
}

/** Decrypts a share with the recipient's identity (no network). */
export async function openShareEnvelope(id: Identity, s: Share): Promise<SharedFile> {
  if (s?.v !== 1 || s.alg !== ALG) throw new Error("gendragoon: unsupported share");
  if (s.recipient !== (await recipientTag(id.publicRaw))) throw new Error("gendragoon: this share is addressed to someone else");
  let epk: Uint8Array, nonce: Uint8Array, ct: Uint8Array, shared: Uint8Array;
  try {
    epk = fromB64u(s.epk); nonce = fromB64u(s.nonce); ct = fromB64u(s.ct);
    shared = await id.shared(epk);
  } catch { throw new CorruptError(); }
  const pt = await gcmOpen(await shareKey(shared, epk, id.publicRaw), nonce, ct, AAD);
  if (!pt) throw new CorruptError();
  let f: SharedFile;
  try { f = JSON.parse(text.decode(pt)) as SharedFile; } catch { throw new CorruptError(); }
  if (f.v !== 1 || !f.entry || !Array.isArray(f.entry.chunks)) throw new CorruptError();
  return f;
}

/** Decrypts a share and downloads the file through this client (read access to the sender's binding). Level L2, risk read. */
export async function openShare(c: Client, id: Identity, s: Share): Promise<{ file: SharedFile; data: Uint8Array }> {
  c.check("share.open");
  const file = await openShareEnvelope(id, s);
  return { file, data: await readEntry(c, file.entry) };
}

export interface ReadKey { keyId: string; apiKey?: string; scopes: string[]; label: string; createdAt?: string; expiresAt: string; revoked?: boolean }

/** Mints a read-only key for this binding, valid ttlDays (1 to 90). It cannot write, mint keys or read the key envelope. Level L3, risk sharing. */
export async function createReadKey(c: Client, label: string, ttlDays = 30): Promise<ReadKey> {
  const r = await c.request("share.createReadKey", "POST", "/keys", JSON.stringify({ label, ttlDays }), { "Content-Type": "application/json" });
  const k = (await r.json()) as ReadKey;
  if (!k.apiKey || !API_KEY_RE.test(k.apiKey)) throw new Error("gendragoon: unexpected key response");
  return k;
}
/** This binding's read-only keys (never their secrets). Level L2, risk read. */
export async function listReadKeys(c: Client): Promise<ReadKey[]> {
  return ((await (await c.request("share.listReadKeys", "GET", "/keys")).json()) as { keys: ReadKey[] }).keys;
}
/** Revokes a read-only key at once. Level L3, risk sharing. */
export async function revokeReadKey(c: Client, keyId: string): Promise<void> {
  if (!/^[0-9a-f]{16}$/.test(keyId)) throw new Error("gendragoon: malformed key id");
  await c.request("share.revokeReadKey", "DELETE", `/keys/${keyId}`);
}
