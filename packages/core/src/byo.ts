/**
 * Bring-your-own storage.
 *
 * Launch providers are S3-compatible (AWS, R2, B2, Wasabi, MinIO), Google
 * Cloud Storage through its S3-interop HMAC keys (no native GCS adapter),
 * and SFTP. Azure Blob, WebDAV, and native GCS are later.
 *
 * Billing matches managed workspaces ($5/month, same cap, lapse, and lock).
 * Credentials stay on the device (OS keychain / secure storage). The server
 * stores only provider type, endpoint, and a bucket fingerprint.
 * Ownership of the GenDragoon workspace is still accountHash. The challenge
 * file proves the user controls the bucket; it is not the ownership rule.
 */

export const LAUNCH_BYO_PROVIDERS = Object.freeze([
  { id: "aws", label: "Amazon S3", protocol: "s3" },
  { id: "r2", label: "Cloudflare R2", protocol: "s3" },
  { id: "b2", label: "Backblaze B2", protocol: "s3" },
  { id: "wasabi", label: "Wasabi", protocol: "s3" },
  { id: "minio", label: "MinIO", protocol: "s3" },
  { id: "gcs-s3", label: "Google Cloud Storage (S3-compatible HMAC)", protocol: "s3" },
  { id: "sftp", label: "SFTP (VPS)", protocol: "sftp" },
] as const);

/** Documented only. Not selectable at launch. */
export const LATER_BYO_PROVIDERS = Object.freeze(["azure-blob", "webdav", "gcs-native"] as const);

export type ByoProviderId = (typeof LAUNCH_BYO_PROVIDERS)[number]["id"];
export type LaterByoProviderId = (typeof LATER_BYO_PROVIDERS)[number];

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

export interface ByoChallenge {
  challengeId: string;
  objectKey: string;
  nonce: string;
  expiresAt: string;
}

export interface ByoProof {
  challengeId: string;
  readBack: string;
}

const CREDENTIAL_KEYS = new Set([
  "accesskeyid",
  "secretaccesskey",
  "sessiontoken",
  "password",
  "passphrase",
  "privatekey",
  "privatekeypem",
  "token",
  "apikey",
  "credentials",
  "hmacsecret",
  "secret",
]);

export function isLaunchProvider(value: string): value is ByoProviderId {
  return LAUNCH_BYO_PROVIDERS.some((provider) => provider.id === value);
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
  const protocol = LAUNCH_BYO_PROVIDERS.find((item) => item.id === provider)?.protocol;
  if (protocol === "s3") {
    if (url.protocol !== "https:") throw new Error("S3-compatible endpoints must use https");
  } else if (url.protocol !== "sftp:") {
    throw new Error("SFTP endpoints must use sftp");
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

export interface ByoProbe {
  write(key: string, body: string): Promise<void>;
  read(key: string): Promise<string>;
  remove(key: string): Promise<void>;
}

/**
 * Write the server nonce, read it back, then delete the probe object.
 * The server compares readBack to the nonce it generated. The workspace
 * stays inactive until that verification succeeds.
 */
export async function performOwnershipProof(
  probe: ByoProbe,
  challenge: Pick<ByoChallenge, "objectKey" | "nonce">,
): Promise<{ readBack: string; cleaned: boolean }> {
  await probe.write(challenge.objectKey, challenge.nonce);
  let readBack = "";
  try {
    readBack = await probe.read(challenge.objectKey);
  } finally {
    await probe.remove(challenge.objectKey);
  }
  return { readBack, cleaned: true };
}

export function proofMatches(challenge: Pick<ByoChallenge, "nonce">, readBack: string): boolean {
  return readBack === challenge.nonce;
}

export function byoMayActivate(serverVerified: boolean): boolean {
  return serverVerified === true;
}
