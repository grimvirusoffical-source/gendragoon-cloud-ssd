# Managed bucket access

Clients upload and download ciphertext in the managed customer bucket with short-lived V4 signed URLs. They never receive a service-account JSON key, a refresh token, or a downscoped OAuth access token.

Threat model, device encryption, and what the server is allowed to see are in [SECURITY.md](SECURITY.md) (`docs/SECURITY.md`, Avery). This page is only the bucket API and the IAM setup that backs it.

No key material, customer object, or production bucket name belongs in this repository.

## What the client does

Before upload, the device encrypts the file with AES-256-GCM. The filename is inside that ciphertext. The server is given an opaque object id (32 or 64 lowercase hex characters, or a UUID) and the ciphertext bytes. It does not accept or log a filename, a plaintext title, or an encryption key.

Requests that include any of these fields are rejected with `400 {"error":"plaintext_rejected"}` and are not written to logs: `name`, `filename`, `fileName`, `originalName`, `plaintext`, `key`, `encryptionKey`, `dek`, `kek`, `password`, `secret`, `secretAccessKey`, `accessKey`, `accessKeyId`, `privateKey`, `content`, `data`.

## `POST /v2/workspaces/:id/storage-urls`

Firebase ID token required (Google provider, current Terms). API keys cannot call this route. The workspace is loaded only under the caller's `accountHash`. A workspace that belongs to another account is `404 {"error":"not_found"}`. The handler does not look up other accounts.

```json
{"op":"upload","objects":["0123456789abcdef0123456789abcdef"]}
```

`op` is `upload` or `download`. `objects` is 1 to 32 opaque ids.

```json
{
  "bucket": "<CUSTOMER_BUCKET>",
  "prefix": "customer/<accountHash>/managed/<workspaceId>/objects/",
  "mode": "write",
  "op": "upload",
  "expiresAt": "<ISO-8601>",
  "urls": [
    {"object":"0123456789abcdef0123456789abcdef","method":"PUT","url":"https://storage.googleapis.com/...","expiresAt":"<ISO-8601>"}
  ]
}
```

`download` returns `mode:"read"` and `method:"GET"`. The legacy free workspace uses the prefix `customer/<accountHash>/free/objects/`.

Each URL is a [V4 signed URL](https://cloud.google.com/storage/docs/access-control/signed-urls) from `@google-cloud/storage` `file.getSignedUrl({version:"v4"})`. That call uses Application Default Credentials and `google-auth-library` only on the server, to sign the URL (`iamcredentials.signBlob`). The response is the URL string. `DownscopedClient` and Credential Access Boundaries are not used.

Expiry is 15 minutes (`expiresAt - now <= 900000` ms). Upload URLs are signed with `Content-Type: application/octet-stream`. The client must send that header. The object path is `prefix + objectId` and is rejected unless it stays under that prefix.

| Condition | Response |
| --- | --- |
| Workspace not under the caller's account | `404 not_found` |
| Workspace locked and `op` is `upload` | `423 {"error":"workspace_lock"}` |
| Workspace locked and `op` is `download` | `200`, read-only URL |
| BYO / customer-owned workspace | `409 byo_external` (this route never signs a customer bucket) |
| Id contains a path, `.`, or a filename | `400 invalid_object_id` |

The lock check is an interface, `isWriteLocked({db, accountHash, workspace, workspaceId})`. When `workspace_policy.js` from `fix/backend-workspace-policy` is deployed, the route uses `listAccountProjects` and `summarizeProjects` (`locked` or `uploadsBlocked`). That module is not on this branch. Until then the stub treats `workspace.locked === true` or `workspace.uploadsBlocked === true` as locked, and tests inject `isWriteLocked`.

## At-rest bucket settings

The managed bucket is not created by this route. Provision it with:

| Control | Required setting |
| --- | --- |
| CMEK | Default Cloud KMS key in `GDSSD_KMS_KEY` |
| Uniform bucket-level access | Enabled |
| Public access prevention | `enforced` |
| Transport | HTTPS only. Signed URLs use `https://` |

`GDSSD_KMS_KEY` is the resource name, not a secret:

```text
projects/<STORAGE_PROJECT_ID>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>
```

`STORAGE_PROJECT_ID` stays `gendragood-ssd`. `CUSTOMER_BUCKET` is the private multi-tenant bucket. The personal bucket `gen-dragoon-ssd` is rejected.

## IAM

Only the backend runtime service account signs URLs and holds storage roles. Clients have no Google credentials.

| Principal | Role | Resource |
| --- | --- | --- |
| Backend runtime service account | `roles/iam.serviceAccountTokenCreator` | That same service account (required for V4 `signBlob`) |
| Backend runtime service account | `roles/storage.objectAdmin` | `CUSTOMER_BUCKET` only |
| Cloud Storage service agent | `roles/cloudkms.cryptoKeyEncrypterDecrypter` | `GDSSD_KMS_KEY` |

Do not grant `roles/iam.serviceAccountTokenCreator`, storage admin, or KMS roles to Firebase users, API-key holders, or the mobile/Mac apps. Do not put a service-account key file in the client or in this repo.
