interface SodiumPwhash {
  ready: Promise<void>;
  crypto_pwhash_SALTBYTES: number;
  crypto_pwhash_ALG_ARGON2ID13: number;
  crypto_pwhash_OPSLIMIT_INTERACTIVE: number;
  crypto_pwhash_MEMLIMIT_INTERACTIVE: number;
  crypto_pwhash_scryptsalsa208sha256_SALTBYTES: number;
  crypto_pwhash_scryptsalsa208sha256_OPSLIMIT_INTERACTIVE: number;
  crypto_pwhash_scryptsalsa208sha256_MEMLIMIT_INTERACTIVE: number;
  randombytes_buf(length: number): Uint8Array;
  crypto_pwhash(
    length: number,
    passphrase: string,
    salt: Uint8Array,
    opsLimit: number,
    memLimit: number,
    algorithm: number,
  ): Uint8Array;
  crypto_pwhash_scryptsalsa208sha256(
    length: number,
    passphrase: string,
    salt: Uint8Array,
    opsLimit: number,
    memLimit: number,
  ): Uint8Array;
  crypto_pwhash_scryptsalsa208sha256_ll(
    password: Uint8Array,
    salt: Uint8Array,
    N: number,
    r: number,
    p: number,
    length: number,
  ): Uint8Array;
  memzero(bytes: Uint8Array): void;
}

declare module "libsodium-wrappers-sumo" {
  const sodium: SodiumPwhash;
  export default sodium;
}
