# Device assignment for GenDragoon Receiver workspaces

This is a staged rollout and **must not be enabled in production until every platform client is upgraded**. It is not a substitute for identity verification or fraud controls.

## API

Authenticate each request with an account session token (not an integration key).

| Route | Action |
|---|---|
| `GET /v1/receivers/me/workspaces/:workspaceId/devices` | List the account's assigned devices; no credentials returned |
| `POST /v1/receivers/me/workspaces/:workspaceId/devices` | Assign device with JSON `{"name":"My laptop","platform":"macos"}` |
| `DELETE /v1/receivers/me/workspaces/:workspaceId/devices/:deviceId` | Revoke that device |

Platforms are `macos`, `windows`, `linux`, `ios`, `android`, and `other`. Each workspace permits up to 20 assignments and an account may assign a device to several workspaces. The POST response exposes a random 32-byte device credential **once**; only its SHA-256 hash is stored in the Receiver's authenticated account ledger. Device registration follows account ownership and the existing workspace subscription entitlements.

When enforcement is deliberately activated via `GENDRAGOON_REQUIRE_DEVICE_ASSIGNMENT=1`, workspace data requests also require `x-gendragoon-device-id` and `x-gendragoon-device-token`. The pair is validated against the selected workspace, so a credential for one workspace cannot read another. Invalid or revoked credentials cause `423 device_assignment_required`. Account management and device enrollment remain accessible without these headers.

**Rollout prerequisites:** Distribute updated signed native clients and extension adapters that attach these headers to every authorized workspace operation, store the credentials in each operating system's secure storage, migrate existing devices, and confirm offload/download/restore with a live server. The Mac Home screen supports enrollment and Keychain storage, but other client transfer adapters are not fully migrated yet. Consequently, keep enforcement **off** until that work and tests are complete.

**Free-plan abuse:** Per-account workspace limits and verified subscriptions remain authoritative. A device ID can be reset or spoofed, so registration is **not** an effective control against creating multiple new email accounts. Cross-account free-plan abuse needs server-side anti-abuse controls at signup, such as verified account eligibility, device attestation when available, and rate limits respecting privacy.
