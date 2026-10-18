# Security

Clients do not hold GCP credentials for the managed bucket. They also do not invent ciphers.

## Managed bucket

1. The user signs in with Firebase.
2. The backend verifies the ID token and that `accountHash` (or `accountKey` for the legacy free project) owns the workspace.
3. `POST /v2/workspaces/:id/storage-urls` returns V4 signed URLs or resumable-upload session URLs.
4. Each URL is `https`, has no userinfo, contains the workspace prefix, and expires in at most 15 minutes.
5. The client uploads or downloads ciphertext at that URL. It does not send an `Authorization` header or any key material.
6. A locked workspace (over the cap, or unpaid) receives `access: "read-only"` and download links only. Upload and resumable requests are writes and return HTTP 423 `{ "error": "workspace_lock", "reason", "overBy", "unpaidWorkspaceIds" }`. Reads and deletes keep working.

## Encryption

`packages/core` uses WebCrypto `AES-GCM` with 256-bit keys. The only password hash is libsodium Argon2id, with scrypt if Argon2id throws. There is no custom block cipher or MAC.

- The device that creates a workspace generates one random 256-bit workspace key.
- That key is wrapped with a KEK from a user-set recovery passphrase. Argon2id (or scrypt) salt and parameters are stored in the envelope. The wrap is AES-256-GCM.
- The server stores only that envelope at `GET`/`PUT /v2/workspaces/:id/key-envelope`. It never receives the passphrase or the raw key.
- A new device prompts for the passphrase once, unwraps the key, and caches it in the OS keychain (`SecretStore` on the host, Electron `safeStorage` on Windows). Later opens use the cache.
- The passphrase setup tells the user that losing the passphrase means losing the files. GenDragoon cannot recover them.
- Each file has a random 256-bit key, wrapped with the workspace key (AES-GCM). The filename, wrapped key, and size live in the sealed library manifest.
- File bytes are encrypted in 8 MiB chunks so a large file is not held as a single buffer. Each chunk has its own random 12-byte nonce. The chunk index is bound as additional authenticated data (uint32 big-endian). WebCrypto appends the GCM tag. A chunk moved to another index does not decrypt.
- The plaintext path is stored only in that manifest. The manifest is itself AES-GCM sealed with the workspace key and uploaded as the opaque object `library`. Object ids in the bucket are random.
- A checksum failure on an app update is unrelated. It still refuses to install.

The workspace key and BYO secrets are never sent to GenDragoon, never logged, and never written into the repository.

## Delete account

`DELETE /v2/account` sends exactly `{ "confirm": "DELETE" }`. It does not send the ID token or `reauthenticatedAt` in the body. The 5-minute window uses the ID token `auth_time` claim, not `iat` from a refresh. A stale sign-in is HTTP 401 `reauth_required`. The client sends the user to sign in again and retries. It does not wipe local keys. A 401 with no error code follows that same sign-in path and keeps the saved job id and status token. HTTP 401 `invalid_token` signs the user out and also leaves local keys in place.

The call returns HTTP 202 `{ "status": "deleting", "jobId", "statusToken" }`. A repeat delete returns HTTP 410 `{ "error": "account_deleted", "jobId", "statusToken" }`, not 401. The client polls that job id with `Authorization: Bearer <statusToken>` and does not wipe because of the 410 itself. The job id and status token live in SecureStore. After a restart, `resumeAccountDeletion` polls the saved job and does not send DELETE again. DELETE is sent only when no job is saved. Status is `GET /v2/account/deletions/:jobId`. The client polls with backoff until the job is `done` or `failed`, or two minutes pass. `queued` and `running` are not finished. The server cancels Stripe subscriptions, deletes managed-bucket objects, and deletes the Firebase user. BYO buckets are left alone. The client deletes the local workspace key and the local BYO secret only after `done`, clears the saved status token, then signs out. A 404 while polling is a retryable error. The saved job stays until `done` or the user dismisses it with `dismissAccountDeletion`. Settings asks twice before starting this.

## Bring your own bucket

The device holds the S3 credentials. It writes `.gendragoon-challenge/<nonce>` and signs a GET for that one object. The URL is https, has no userinfo, and expires within 15 minutes. The proof body is `{ presignedUrl }`. The client never sends `readBack`. A missing URL is HTTP 400 `presigned_url_required`. Stored secrets are not in that body and are not logged. SFTP, Azure, and WebDAV are not registered. The server answers those with 422 `byo_provider_unsupported`. A 409 `byo_unverifiable` message exists only as a fallback. The server does not send it.
