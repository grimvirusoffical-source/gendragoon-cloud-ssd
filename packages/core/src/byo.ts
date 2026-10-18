/**
 * Bring-your-own storage.
 *
 * Launch providers are S3-compatible only: AWS, R2, B2, Wasabi, MinIO, and
 * Google Cloud Storage through its S3 HMAC keys. SFTP, Azure Blob, and WebDAV
 * are shown as coming soon and are not selectable. There is no native GCS adapter.
 *
 * Billing matches whatever the server reports for the workspace. Credentials
 * stay on the device. The server stores only provider type, endpoint, and a
 * bucket fingerprint. Ownership of the GenDragoon workspace is still accountHash.
 */

import { ApiError } from "./api/errors.js";

export const LAUNCH_BYO_PROVIDERS = Object.freeze([
  { id: "aws", label: "Amazon S3", protocol: "s3" },
  { id: "r2", label: "Cloudflare R2", protocol: "s3" },
  { id: "b2", label: "Backblaze B2", protocol: "s3" },
  { id: "wasabi", label: "Wasabi", protocol: "s3" },
  { id: "minio", label: "MinIO", protocol: "s3" },
  { id: "gcs-s3", label: "Google Cloud Storage (S3-compatible HMAC)", protocol: "s3" },
] as const);

/** Disabled in Connect Storage. Not sent as a launch provider. */
export const COMING_SOON_BYO_PROVIDERS = Object.freeze([
  { id: "sftp", label: "SFTP" },
  { id: "azure-blob", label: "Azure Blob" },
  { id: "webdav", label: "WebDAV" },
] as const);

/** Not selectable at launch. Includes the coming-soon row plus native GCS. */
export const LATER_BYO_PROVIDERS = Object.freeze(["sftp", "azure-blob", "webdav", "gcs-native"] as const);

export type ByoProviderId = (typeof LAUNCH_BYO_PROVIDERS)[number]["id"];
export type LaterByoProviderId = (typeof LATER_BYO_PROVIDERS)[number];

export const BYO_UNSUPPORTED_MESSAGE =
  "This storage provider is not supported yet. SFTP, Azure, and WebDAV are coming soon.";

/**
 * Fallback copy only. The server does not return 409 `byo_unverifiable`.
 * A provider it will not register, including SFTP, returns 422
 * `byo_provider_unsupported`.
 */
export const BYO_UNVERIFIABLE_MESSAGE =
  "GenDragoon could not verify that you control this bucket.";

/** HTTP 400 `{ "error": "presigned_url_required" }` when verify has no presignedUrl. */
export const BYO_PRESIGNED_URL_MESSAGE =
  "A presigned URL is required to verify this bucket.";

export interface StorageProviderManaged {
  kind: "gendragoon";
  storageTier: string | null;
}

export interface StorageProviderByo {
  kind: "byo";
  provider: ByoProviderId;
  endpoint: string;
  bucketFingerprint: string;
}

export type StorageProvider = StorageProviderManaged | StorageProviderByo;

/** Device-only. Never assign this onto a workspace or an API body. */
export interface DeviceByoCredentials {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  username?: string;
  privateKeyPem?: string;
  passphrase?: string;
}

export interface ServerByoRegistration {
  provider: ByoProviderId;
  endpoint: string;
  bucketFingerprint: string;
}

export const CHALLENGE_PREFIX = ".gendragoon-challenge/";

/** Presigned GET links for the ownership object expire within this window. */
export const CHALLENGE_URL_MAX_MS = 15 * 60 * 1000;

export interface ByoChallenge {
  challengeId: string;
  objectKey: string;
  nonce: string;
  expiresAt: string;
}

/** Sent to the server. A presigned GET only. No stored credentials. */
export interface ByoProof {
  challengeId: string;
  presignedGetUrl: string;
}

const CREDENTIAL_KEYS = new Set([
  "accesskeyid",
  "secretaccesskey",
  "sessiontoken",
  "password",
  "passphrase",
  "privatekey",
  "private_key",
  "privatekeypem",
  "client_email",
  "token",
  "apikey",
  "credentials",
  "hmacsecret",
  "secret",
]);

const CREDENTIAL_QUERY = new Set([
  "secret",
  "password",
  "passphrase",
  "secretaccesskey",
  "sessiontoken",
  "privatekey",
  "private_key",
  "privatekeypem",
  "token",
  "apikey",
  "credentials",
  "hmacsecret",
  "x-amz-security-token",
]);

export function isLaunchProvider(value: string): value is ByoProviderId {
  return LAUNCH_BYO_PROVIDERS.some((provider) => provider.id === value);
}

export function byoErrorMessage(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "";
  if (code === "byo_provider_unsupported") return BYO_UNSUPPORTED_MESSAGE;
  if (code === "byo_unverifiable") return BYO_UNVERIFIABLE_MESSAGE;
  if (code === "presigned_url_required") return BYO_PRESIGNED_URL_MESSAGE;
  if (error instanceof Error && error.message) return error.message;
  return "Storage setup failed";
}

export function assertNoCredentialFields(value: unknown, path = "body"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialFields(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (CREDENTIAL_KEYS.has(key.toLowerCase())) {
      throw new Error(`Refusing credential field ${path}.${key}`);
    }
    assertNoCredentialFields(nested, `${path}.${key}`);
  }
}

export async function bucketFingerprint(provider: ByoProviderId, endpoint: string, bucket: string): Promise<string> {
  const material = `${provider}\n${endpoint}\n${bucket}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeEndpoint(provider: ByoProviderId, endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) throw new Error("Endpoint is required");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Endpoint must be an absolute URL");
  }
  if (url.username || url.password) {
    throw new Error("Endpoint must not include credentials");
  }
  if (!isLaunchProvider(provider) || url.protocol !== "https:") {
    throw new Error("S3-compatible endpoints must use https");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export async function toServerByoRegistration(input: {
  provider: string;
  endpoint: string;
  bucket: string;
  credentials?: DeviceByoCredentials;
}): Promise<ServerByoRegistration> {
  assertNoCredentialFields(input);
  if (!isLaunchProvider(input.provider)) {
    throw new Error("Provider is not available at launch");
  }
  const endpoint = normalizeEndpoint(input.provider, input.endpoint);
  const bucket = input.bucket.trim();
  if (!bucket || bucket.includes("/") || bucket.includes("\\") || bucket === "." || bucket === "..") {
    throw new Error("Bucket name is invalid");
  }
  return {
    provider: input.provider,
    endpoint,
    bucketFingerprint: await bucketFingerprint(input.provider, endpoint, bucket),
  };
}

export function challengeObjectKey(nonce: string): string {
  if (!nonce || nonce.length > 200 || /[^A-Za-z0-9_-]/.test(nonce)) {
    throw new Error("Challenge nonce is invalid");
  }
  return `${CHALLENGE_PREFIX}${nonce}`;
}

export interface ByoObjectWriter {
  write(key: string, body: string): Promise<void>;
  /** Short-lived GET for exactly `key`, signed on the device. */
  presignGet(key: string, expiresInMs: number): Promise<string>;
}

/**
 * Every registration runs a new challenge. A previous proof is not reused,
 * including when the same bucket is connected again.
 */
export function registrationRequiresChallenge(): boolean {
  return true;
}

/**
 * Write `.gendragoon-challenge/<nonce>` with device credentials, then return
 * a presigned GET for that object. The returned body is what the server receives.
 */
export async function performOwnershipChallenge(input: {
  challengeId: string;
  nonce: string;
  writer: ByoObjectWriter;
  now?: number;
}): Promise<ByoProof> {
  const objectKey = challengeObjectKey(input.nonce);
  await input.writer.write(objectKey, input.nonce);
  const presignedGetUrl = await input.writer.presignGet(objectKey, CHALLENGE_URL_MAX_MS);
  assertChallengeGetUrl(presignedGetUrl, objectKey, input.now ?? Date.now());
  const proof: ByoProof = { challengeId: input.challengeId, presignedGetUrl };
  assertNoCredentialFields(proof);
  return proof;
}

export function assertChallengeGetUrl(value: string, objectKey: string, now = Date.now()): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Challenge URL must be https");
  }
  if (url.protocol !== "https:") throw new Error("Challenge URL must be https");
  if (url.username || url.password) throw new Error("Challenge URL must not include credentials");
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY.has(key.toLowerCase())) {
      throw new Error("Challenge URL must not include credentials");
    }
  }
  const path = decodeURIComponent(url.pathname).replace(/\/+$/, "");
  if (!path.endsWith(`/${objectKey}`)) {
    throw new Error("Challenge URL must point at exactly the challenge object");
  }
  const ttl = presignTtlMs(url, now);
  if (ttl === null || ttl <= 0 || ttl > CHALLENGE_URL_MAX_MS) {
    throw new Error("Challenge URL must be a short-lived presigned GET");
  }
}

export function byoMayActivate(serverVerified: boolean): boolean {
  return serverVerified === true;
}

function presignTtlMs(url: URL, now: number): number | null {
  const expires = url.searchParams.get("X-Amz-Expires") ?? url.searchParams.get("X-Goog-Expires");
  const date = url.searchParams.get("X-Amz-Date") ?? url.searchParams.get("X-Goog-Date");
  if (expires && date) {
    const seconds = Number(expires);
    const start = parseAmzDate(date);
    if (!Number.isFinite(seconds) || start === null) return null;
    return start + seconds * 1000 - now;
  }
  const absolute = url.searchParams.get("Expires");
  if (!absolute) return null;
  const stamp = Number(absolute);
  if (!Number.isFinite(stamp)) return null;
  const ms = stamp > 10_000_000_000 ? stamp : stamp * 1000;
  return ms - now;
}

function parseAmzDate(value: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  return Date.UTC(year, month - 1, day, hour, minute, second);
}
