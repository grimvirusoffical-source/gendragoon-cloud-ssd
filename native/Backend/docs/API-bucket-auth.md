# Managed bucket access

Clients upload and download ciphertext in the managed customer bucket with short-lived V4 signed URLs. They never receive a service-account JSON key, a refresh token, or a downscoped OAuth access token.

Threat model, device encryption, and what the server is allowed to see are in [SECURITY.md](SECURITY.md) (`docs/SECURITY.md`, Avery). This page is only the bucket API and the IAM setup that backs it.

No key material, customer object, or production bucket name belongs in this repository.

## What the client does

Before upload, the device encrypts the file with AES-256-GCM. The filename is inside that ciphertext. The server is given an opaque object id (32 or 64 lowercase hex characters, or a UUID) and the ciphertext bytes. It does not accept or log a filename, a plaintext title, or an encryption key.

The reserved id `manifest` is the encrypted file-name list for the workspace. It is allowed for `get`, `put`, and `delete`, and it maps to `<prefix>manifest` (the prefix already ends in `/`, so the object is `<prefix>/manifest`). Every other id keeps the opaque-id check. Resumable uploads are out of scope for launch; `op:"resumable"` is `400 {"error":"invalid_op"}`.

Requests that include any of these fields are rejected with `400 {"error":"plaintext_rejected"}` and are not written to logs: `name`, `filename`, `fileName`, `originalName`, `plaintext`, `key`, `encryptionKey`, `dek`, `kek`, `password`, `secret`, `secretAccessKey`, `accessKey`, `accessKeyId`, `privateKey`, `content`, `data`.

## `POST /v2/workspaces/:id/storage-urls`

Firebase ID token required (Google provider, current Terms). API keys cannot call this route. The workspace is loaded only under the caller's `accountHash`. A workspace that belongs to another account is `404 {"error":"not_found"}`. The handler does not look up other accounts.

The request is `{op, objects:[ids]}`. `op` is `get`, `put`, or `delete`. `objects` is 1 to 32 ids. A `put` that includes `manifest` also sends `ifGeneration`. `0` or `"0"` creates the object only. Any other value is the current GCS generation. GCS generations are int64 and can be larger than `2^53`, so `ifGeneration` may be a safe integer or a decimal string of up to 20 digits. The client must send back exactly the `generation` string from the previous `get`.

`put`:

```json
{"op":"put","objects":["0123456789abcdef0123456789abcdef"]}
```

```json
{
  "bucket": "<CUSTOMER_BUCKET>",
  "prefix": "customer/<accountHash>/managed/<workspaceId>/objects/",
  "mode": "write",
  "op": "put",
  "expiresAt": "<ISO-8601>",
  "urls": [
    {"object":"0123456789abcdef0123456789abcdef","method":"PUT","url":"https://storage.googleapis.com/...","expiresAt":"<ISO-8601>"}
  ]
}
```

`get`:

```json
{"op":"get","objects":["0123456789abcdef0123456789abcdef"]}
```

```json
{
  "bucket": "<CUSTOMER_BUCKET>",
  "prefix": "customer/<accountHash>/managed/<workspaceId>/objects/",
  "mode": "read",
  "op": "get",
  "expiresAt": "<ISO-8601>",
  "urls": [
    {"object":"0123456789abcdef0123456789abcdef","method":"GET","url":"https://storage.googleapis.com/...","expiresAt":"<ISO-8601>"}
  ]
}
```

`delete`:

```json
{"op":"delete","objects":["0123456789abcdef0123456789abcdef"]}
```

```json
{
  "bucket": "<CUSTOMER_BUCKET>",
  "prefix": "customer/<accountHash>/managed/<workspaceId>/objects/",
  "mode": "delete",
  "op": "delete",
  "expiresAt": "<ISO-8601>",
  "urls": [
    {"object":"0123456789abcdef0123456789abcdef","method":"DELETE","url":"https://storage.googleapis.com/...","expiresAt":"<ISO-8601>"}
  ]
}
```

`manifest` put. The signed URL includes `x-goog-if-generation-match` set to the exact `ifGeneration` string. The client must send that header with that exact value. GCS returns `412` when the generation does not match, so two devices cannot silently overwrite the name list.

A generation past `2^53` is sent as a decimal string:

```json
{"op":"put","objects":["manifest"],"ifGeneration":"9223372036854775807"}
```

```json
{"op":"put","objects":["manifest"],"ifGeneration":0}
```

```json
{
  "bucket": "<CUSTOMER_BUCKET>",
  "prefix": "customer/<accountHash>/managed/<workspaceId>/objects/",
  "mode": "write",
  "op": "put",
  "expiresAt": "<ISO-8601>",
  "urls": [
    {"object":"manifest","method":"PUT","url":"https://storage.googleapis.com/<bucket>/customer/<accountHash>/managed/<workspaceId>/objects/manifest?...","expiresAt":"<ISO-8601>"}
  ]
}
```

`manifest` get also returns the object's current `generation` from its metadata, always as a decimal string. A missing object is generation `"0"`. Send that string back unchanged as `ifGeneration` on the next put.

```json
{"op":"get","objects":["manifest"]}
```

```json
{
  "bucket": "<CUSTOMER_BUCKET>",
  "prefix": "customer/<accountHash>/managed/<workspaceId>/objects/",
  "mode": "read",
  "op": "get",
  "expiresAt": "<ISO-8601>",
  "urls": [
    {"object":"manifest","method":"GET","url":"https://storage.googleapis.com/<bucket>/customer/<accountHash>/managed/<workspaceId>/objects/manifest?...","generation":"42","expiresAt":"<ISO-8601>"}
  ]
}
```

`manifest` delete:

```json
{"op":"delete","objects":["manifest"]}
```

```json
{
  "bucket": "<CUSTOMER_BUCKET>",
  "prefix": "customer/<accountHash>/managed/<workspaceId>/objects/",
  "mode": "delete",
  "op": "delete",
  "expiresAt": "<ISO-8601>",
  "urls": [
    {"object":"manifest","method":"DELETE","url":"https://storage.googleapis.com/<bucket>/customer/<accountHash>/managed/<workspaceId>/objects/manifest?...","expiresAt":"<ISO-8601>"}
  ]
}
```

A missing or invalid `ifGeneration` on a manifest put is `400 {"error":"manifest_generation_required"}`. The signed put URL carries `x-goog-if-generation-match` set to that generation. The client must send the header. GCS returns `412` when it does not match.

The legacy free workspace uses the prefix `customer/<accountHash>/free/objects/`.

Each URL is a [V4 signed URL](https://cloud.google.com/storage/docs/access-control/signed-urls) from `@google-cloud/storage` `file.getSignedUrl({version:"v4"})`. That call uses Application Default Credentials and `google-auth-library` only on the server, to sign the URL (`iamcredentials.signBlob`). The response is the URL string. `DownscopedClient` and Credential Access Boundaries are not used.

Expiry is 15 minutes (`expiresAt - now <= 900000` ms). Upload URLs are signed with `Content-Type: application/octet-stream`. The client must send that header. The object path is `prefix + objectId` and is rejected unless it stays under that prefix.

| Condition | Response |
| --- | --- |
| Workspace not under the caller's account | `404 not_found` |
| Workspace locked and `op` is `put` or `delete` | `423 {"error":"workspace_lock","reason","overBy","unpaidWorkspaceIds"}` |
| Workspace locked and `op` is `get` | `200`, read-only URL |
| BYO / customer-owned workspace | `409 byo_external` (this route never signs a customer bucket) |
| Id contains a path, `.`, or a filename | `400 invalid_object_id` |

The lock check uses `workspace_policy.listAccountProjects` and `summarizeProjects`. A locked or upload-blocked summary returns `lockBody`: `error`, `reason`, `overBy`, and `unpaidWorkspaceIds`. A workspace list that cannot be read returns `reason: "scope_unavailable"`.

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
