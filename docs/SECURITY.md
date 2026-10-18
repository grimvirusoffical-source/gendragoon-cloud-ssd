# Security

Clients do not hold GCP credentials for the managed bucket. They also do not invent ciphers.

## Managed bucket

1. The user signs in with Firebase.
2. The backend verifies the ID token and that `accountHash` (or `accountKey` for the legacy free project) owns the workspace.
3. `POST /v2/workspaces/:id/storage-urls` returns V4 signed URLs or resumable-upload session URLs.
4. Each URL is `https`, has no userinfo, contains the workspace prefix, and expires in at most 15 minutes.
5. The client uploads or downloads ciphertext at that URL. It does not send an `Authorization` header or any key material.
6. A locked workspace (over the cap, or unpaid) receives `access: "read-only"` and download links only. Upload and resumable requests are writes and return HTTP 423 `{ "code": "workspace_lock" }`. Reads and deletes keep working.

## Encryption

`packages/core` uses WebCrypto `AES-GCM` with 256-bit keys. There is no custom block cipher, mode, MAC, or key derivation.

- Each workspace has a random 256-bit key in the OS keychain (`SecretStore` on the host, Electron `safeStorage` on Windows).
- Each file has a random 256-bit key, wrapped with the workspace key (AES-GCM) and stored inside the library manifest.
- File bytes are encrypted in 8 MiB chunks so a large file is not held as a single buffer. Each chunk has its own random 12-byte IV. WebCrypto appends the GCM tag.
- The plaintext path is stored only in that manifest. The manifest is itself AES-GCM sealed with the workspace key and uploaded as the opaque object `library`. Object ids in the bucket are random.
- A checksum failure on an app update is unrelated. It still refuses to install.

The workspace key and BYO secrets are never sent to GenDragoon, never logged, and never written into the repository.

## Delete account

`DELETE /v2/account` requires a Firebase re-auth newer than one hour and returns HTTP 202 with a job id. `GET /v2/account/deletion/:jobId` is the status. The server cancels Stripe subscriptions, deletes managed-bucket objects, and deletes the Firebase user. BYO buckets are left alone. The client deletes the local workspace key and the local BYO secret, then signs out. Settings asks twice before starting this.
