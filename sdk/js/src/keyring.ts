// The unlocked master key, held in memory only.
import { random, wipe } from "./bytes.js";
import { DEFAULT_SCRYPT, KEY_BYTES, LockedError, unwrapMasterKey, wrapMasterKey } from "./crypto.js";
import { APIError, type Client } from "./client.js";

export class Keyring {
  #mk: Uint8Array | null = null;
  constructor(private readonly client: Client) {}
  get unlocked(): boolean { return this.#mk !== null; }
  /** Wipes the master key from memory. */
  lock(): void { wipe(this.#mk); this.#mk = null; }
  /** @internal */
  master(): Uint8Array {
    if (!this.#mk) throw new LockedError();
    return this.#mk;
  }
  private set(mk: Uint8Array) { wipe(this.#mk); this.#mk = mk; }

  /** Reads the binding's key envelope and opens it. Level L2, risk key. */
  async unlock(passphrase: string): Promise<void> {
    this.client.check("crypto.unlock");
    this.set(await unwrapMasterKey(await this.client.getKeyEnvelope(), passphrase));
  }
  /** Generates a master key and stores its envelope. Create-only: it never replaces an existing envelope (412). Level L2, risk key. */
  async create(passphrase: string): Promise<void> {
    this.client.check("keyEnvelope.create");
    const mk = random(KEY_BYTES);
    const env = await wrapMasterKey(mk, passphrase, DEFAULT_SCRYPT, 1);
    try {
      await this.client.putKeyEnvelope("keyEnvelope.create", env, { "If-None-Match": "*" });
    } catch (e) {
      wipe(mk);
      if (e instanceof APIError && e.code === "envelope_exists") throw new APIError(412, "envelope_exists");
      throw e;
    }
    this.set(mk);
  }
  /** Re-wraps the master key under a new passphrase (compare-and-swap on the envelope version). Level L3, risk key. */
  async changePassphrase(newPassphrase: string): Promise<void> {
    this.client.check("keyEnvelope.replace");
    const mk = this.master();
    const cur = await this.client.getKeyEnvelope();
    const env = await wrapMasterKey(mk, newPassphrase, DEFAULT_SCRYPT, cur.version + 1);
    await this.client.putKeyEnvelope("keyEnvelope.replace", env, { "If-Match": `"${cur.version}"` });
  }
  /** Loads a master key handed over by the host (for example the Rotten Apple launcher). Level L2, risk key. */
  importMasterKey(mk: Uint8Array): void {
    this.client.check("crypto.importMasterKey");
    if (mk.length !== KEY_BYTES) throw new Error("gendragoon: master key must be 32 bytes");
    this.set(mk.slice());
  }
  /** A copy of the raw master key. Level L4, risk key-export: the default gate refuses it. */
  exportMasterKey(): Uint8Array {
    this.client.check("crypto.exportMasterKey");
    return this.master().slice();
  }
}
