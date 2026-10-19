# PROPOSAL for RedX Dev: a remote pack backend over Gendragoon `/provider/v1`

Not part of RedX. This is Gendragoon Dev's suggestion; RedX Dev owns the real adapter in `/workspace/redx`.

`native/Backend/contract/redxpack/remote.go` already has RedX's exact method set and passes RedX's real `pack.New` round trip (`-tags redx`). A RedX version would be the same code inside RedX's tree (`host/storage/gendragoon`), with these changes:

1. Return `pack.ErrChunkNotFound` / `pack.ErrManifestNotFound` directly (the reference uses substitutable sentinels).
2. `SaveManifest`: keep the last `ETag` per key from `LoadManifest` and send `If-Match`; on `412` reload and return an error, so two RedX processes on one binding cannot silently overwrite each other (pack's doc says two processes must not share one backend; CAS turns a violation into an error instead of corruption).
3. Local LRU cache for `GetChunk` (chunks are immutable), `batch-has` for `ensureChunk` dedupe checks, retries with backoff on `429`/`503` honouring `Retry-After`, a request timeout.
4. Map `507 quota_exceeded` to RedX's `storage_full` and surface `/usage` through the proposed `storage.Backend.Usage()`; `/health` through `Health()`.
5. Key from `<data>/storage-secrets` (0600), never logged; call `/connect/rotate` before `keyExpiresAt`.
6. Encrypted packs: chunk ids are SHA-256 of ciphertext, so `X-Id-Mode: content` works unchanged; media/sealed names use `sealed` mode.
