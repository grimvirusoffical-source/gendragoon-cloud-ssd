# Security

Clients do not hold GCP credentials for the managed bucket. They also do not invent ciphers.

## Managed bucket

1. The user signs in with Firebase.
2. The backend verifies the ID token and that `accountHash` (or `accountKey` for the legacy free project) owns the workspace.
3. `POST /v2/workspaces/:id/storage-urls` takes `{ "op": "get" | "put" | "delete", "objects": ["…"] }` and returns `{ "mode": "read" | "write" | "delete", "urls": [{ "object", "url", "method" }] }`. A manifest put also sends `ifGeneration` as a decimal string.
4. Each URL is `https`, has no userinfo, contains the workspace prefix, and expires in at most 15 minutes.
5. The client uploads or downloads ciphertext at that URL. It does not send an `Authorization` header or any key material.
6. A locked workspace (over the cap, or unpaid) receives `mode: "read"` and GET links only. A put or delete returns HTTP 423 `{ "error": "workspace_lock", "reason", "overBy", "unpaidWorkspaceIds" }`. Get stays allowed.

## Encryption

`packages/core` uses WebCrypto `AES-GCM` with 256-bit keys. The password hash is libsodium Argon2id. Scrypt is used only when `kdf.alg` is `scrypt`. An Argon2id failure is not replaced with scrypt. The client rejects `memoryKiB` below 19456 or above 1048576, or `iterations` above 10, before deriving. Scrypt `N` must be a power of two from `2^14` through `2^20`. Any other `N` is rejected before derivation as `kdf_params_invalid`. The envelope never sends top-level `opsLimit` or `memLimit`. `salt`, `iv`, and `wrappedKey` are written as unpadded base64url and read as either base64url or standard base64. There is no custom block cipher or MAC.

- The device that creates a workspace generates one random 256-bit workspace key.
- That key is wrapped with a KEK from a user-set recovery passphrase. Argon2id (or scrypt) salt and parameters are stored in the envelope. The wrap is AES-256-GCM.
- The server stores only that envelope at `GET`/`PUT /v2/workspaces/:id/key-envelope`. It never receives the passphrase or the raw key.
- A new device prompts for the passphrase once, unwraps the key, and caches it in the OS keychain (`SecretStore` on the host, Electron `safeStorage` on Windows). Later opens use the cache.
- The passphrase setup tells the user that losing the passphrase means losing the files. GenDragoon cannot recover them.
- Each file has a random 256-bit key, wrapped with the workspace key (AES-GCM). The filename, wrapped key, and size live in the sealed library manifest.
- File bytes are encrypted in 8 MiB chunks so a large file is not held as a single buffer. Each chunk has its own random 12-byte nonce. Additional data binds the file id, the object id, the chunk index, the total chunk count, and a final-chunk flag. WebCrypto appends the GCM tag. A chunk moved to another file or index does not decrypt. The sealed name records `chunkCount` and `totalSize`. A truncated object, or one whose decrypted length does not match, is rejected.
- The plaintext path is stored only in that manifest. The manifest is itself AES-GCM sealed with the workspace key and uploaded as the reserved object id `manifest`. Other object ids are random. A manifest upload sends `ifGeneration` as the exact decimal string from `urls[].generation` (`"0"` on create) and the same string as `x-goog-if-generation-match`. The client does not parse that string into a number. HTTP 412 retries a compare-and-swap. HTTP 400 `manifest_generation_required` means the generation was omitted. The sealed version is a monotonic integer stored in SecureStore and is the only order for entries and tombstones. A delete records `{fileId, deletedAtVersion, deletedAtMs}`. `deletedAtMs` only decides whether a tombstone is old enough to prune (30 days). Devices persist `lastSyncedVersion`. A device behind `prunedThroughVersion` adopts the remote manifest and re-applies only local changes newer than `lastSyncedVersion`. The client never replaces a remote manifest, including an empty one, with the local one. A replacement writes the new chunks, commits the manifest, and only then deletes the old objects.
- A checksum failure on an app update is unrelated. It still refuses to install.

The workspace key and BYO secrets are never sent to GenDragoon, never logged, and never written into the repository.

## Delete account

`DELETE /v2/account` sends exactly `{ "confirm": "DELETE" }`. It does not send the ID token or `reauthenticatedAt` in the body. The 5-minute window uses the ID token `auth_time` claim, not `iat` from a refresh. A stale sign-in is HTTP 401 `reauth_required`. The client sends the user to sign in again and retries. It does not wipe local keys. A 401 with no error code follows that same sign-in path and keeps the saved job id and status token. HTTP 401 `invalid_token` signs the user out and also leaves local keys in place.

The call returns HTTP 202 `{ "status": "deleting", "jobId", "statusToken" }`. A repeat delete returns HTTP 410 `{ "error": "account_deleted", "jobId", "statusToken" }`, not 401. The client does not wipe because of the 410 itself. The job id and status token are opaque strings in SecureStore. `resumeAccountDeletion` polls the saved status token and does not send DELETE. A status GET that returns `unauthorized`, `reauth_required`, no error code, or a status-token `invalid_token` stops, keeps the job, wipes nothing, and signals `reauth_required`. After that sign-in the client sends DELETE again and stores the fresh status token from the 410. A Firebase-token poll that returns `invalid_token` clears the session only, keeps the job, and continues with the saved status token. `failed` keeps the job and does not wipe. Retry on `retryable: true` sends DELETE again. A status GET of `failed` with `retryable: false` keeps the job, wipes nothing, and shows `SUPPORT_CONTACT` plus Dismiss, with no Retry. HTTP 409 `deletion_not_retryable` keeps the job and shows that same support contact plus Dismiss. A 404 while polling is retryable and keeps the job. The saved job is cleared only after `done` (which also wipes) or `dismissDeletion`. Settings asks twice before starting this.

## Bring your own bucket

The device holds the S3 credentials. It writes `.gendragoon-challenge/<nonce>` and signs a GET for that one object. The URL is https, has no userinfo, and expires within 15 minutes. The proof body is `{ presignedUrl }` with a non-empty URL. A missing URL is HTTP 400 `presigned_url_required`. Stored secrets are not in that body and are not logged. Registration stores `bucketFingerprint`. `hostFingerprint` is an alias and is sent as `bucketFingerprint`. SFTP, Azure, and WebDAV are not registered. The server answers those with 422 `byo_provider_unsupported`. A 409 `byo_unverifiable` message exists only as a fallback. The server does not send it.
