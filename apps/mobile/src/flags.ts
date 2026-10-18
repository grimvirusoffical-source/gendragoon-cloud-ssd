/**
 * Encrypted workspace setup, passphrase and key-envelope screens, and
 * encrypted upload or replace.
 *
 * Off until core accepts the server key envelope. That envelope is
 * `{kdf:{alg, memoryKiB, iterations, parallelism}}` with base64url `salt`,
 * `iv`, and `wrappedKey`. `ifGeneration` comes back as a decimal string.
 * Mobile does not reshape either. Sign-in, the workspace list, the lock
 * screen, account deletion, and downloads stay available.
 */
export const ENCRYPTED_WORKSPACE_ENABLED = false;
