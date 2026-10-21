/**
 * Contract types for the deployed GenDragoon API
 * (gendragoon-cloud-ssd native/Backend @ 4cb71b5, tag v0.18.0-rc.2).
 *
 * Additions Riley still has to build are marked proposed. The client may
 * call them, and today's server will 404 until they exist.
 */

export interface HealthResponse {
  ok?: boolean;
  state?: string;
  stage?: string;
}

export interface CapabilitiesResponse {
  protocol: number;
  chunkBytes: number;
  authenticatedStorage: boolean;
  resumableUploads: boolean;
  parallelChunks: boolean;
  rangeDownloads: boolean;
  checkoutProvider: string;
  checkoutEnabled: boolean;
}

export interface BillingStatusResponse {
  checkoutEnabled: boolean;
  stripeMode: "test" | "live" | "unconfigured" | string;
  projectCreationEnabled: boolean;
  availableKinds: string[];
  message?: string;
}

export interface PricingResponse {
  currency: "usd" | string;
  catalogVersion: number;
  /** Always 0: the workspace fee is included in the storage plans. */
  workspaceFeeMonthlyCents: number;
  workspaceFeeIncluded?: boolean;
  projects: {
    firstFree: boolean;
    /** 2 GB storage + the free performance plan (1 worker). */
    firstFreeIncludes?: { storageGB: number; performanceTier: string; workers: number };
    /** Every additional workspace: `["storage", "performance"]`. */
    additionalRequires?: ("storage" | "performance")[];
    /** Custom storage: `["performance"]`. */
    customStorageRequires?: ("storage" | "performance")[];
    defaultLimit: number;
    qualifiedLimit: number;
    qualifyingStorageTier: string;
    qualifyingPerformanceTier: string;
    qualifyingWorkers: number;
  };
  customStorage?: { storagePlanRequired: boolean; performancePlanRequired: boolean; extraFeeCents: number; providerFeesExtra?: boolean; setupWizard?: boolean };
  storage?: Record<string, { gb: number; monthlyCents: number; yearlyCents: number }>;
  performance?: Record<string, { workers: number; monthlyCents: number; yearlyCents: number }>;
  purchasesEnabled: boolean;
}

export type WorkspaceKind = "free" | "paid" | "byo";

export interface Workspace {
  id: string;
  name: string;
  kind: WorkspaceKind;
  /** Server flag. The client does not decide this by counting workspaces. */
  isFree: boolean;
  /** Server cents. 0 exactly when `isFree`, `grandfathered`, or `feeWaived` is true. */
  monthlyPriceCents: number;
  /**
   * Server flag. Required on list items and create `project` objects.
   * The price label is Included when this is true and `isFree` is false.
   */
  grandfathered: boolean;
  /**
   * Server flag. Required on list items and create `project` objects.
   * A waived fee is Included, and its cents are 0.
   */
  feeWaived: boolean;
  /** Present on paid/BYO server documents. Omitted from today's public payload. */
  accountHash?: string;
  /** Legacy free project only (`tenants/{accountKey}/workspaces/free`). */
  accountKey?: string;
  projectStatus?: string;
  projectBillingVersion?: number;
  projectFeeStatus?: "free" | "paid" | "owner" | "pending" | "legacy" | string;
  projectFeeCents?: number;
  /** "plans" when storage + performance plans are billed together (no separate fee). */
  billingModel?: "plans" | "free" | "legacy";
  customStorage?: boolean;
  requiredPlans?: { storage: "managed" | "custom"; storageTier?: string; performanceTier: string; interval: "month" | "year" } | null;
  plansStatus?: string | null;
  workspaceFeeIncluded?: boolean;
  workspaceSubscriptionId?: string | null;
  /** Stripe current_period_end. Proposed on the public payload. */
  currentPeriodEnd?: string | null;
  storageTier?: string | null;
  storageMode?: "standard" | "bundle" | null;
  storageActive?: boolean;
  performanceTier?: string | null;
  performanceActive?: boolean;
  provisioned?: boolean;
  quotaGB?: number;
  usedBytes?: number;
  workers?: number;
  storage?: {
    kind: "gendragoon" | "byo";
    provider?: string;
    endpoint?: string;
    bucketFingerprint?: string;
    storageTier?: string | null;
  };
}

export interface ProjectPolicy {
  firstProjectFree: boolean;
  freeProjectClaimed: boolean;
  freeProjectAvailable: boolean;
  /** 0: there is no project or workspace fee. */
  newProjectOneTimeCents: number;
  workspaceFeeIncluded?: boolean;
  firstWorkspaceIncludes?: { storageGB: number; performanceTier: string; workers: number };
  additionalWorkspaceRequires?: ("storage" | "performance")[];
  customStorageRequires?: ("storage" | "performance")[];
  defaultLimit: number;
  qualifiedLimit: number;
  projectLimit: number;
  usedProjectSlots: number;
  qualifiesForHigherLimit: boolean;
}

export interface WorkspaceListResponse {
  ownerBenefits: boolean;
  workspaces: Workspace[];
  policy: ProjectPolicy;
}

export interface ProjectListResponse {
  ownerBenefits: boolean;
  policy: ProjectPolicy;
  projects: Workspace[];
}

export interface CheckoutResponse {
  url?: string;
  workspaceId?: string;
  resumed?: boolean;
  alreadyActivated?: boolean;
  oneTimeCents?: number;
  /** Sum of the chosen plan prices. Never includes a workspace fee. */
  totalCents?: number;
  quote?: { totalCents?: number; tier?: string; interval?: string };
}

export interface UploadStatus {
  status: string;
  uploadId: string;
  chunkBytes: number;
  totalChunks: number;
  sizeBytes: number;
  nextIndex: number;
  uploadedBytes: number;
}

export interface CloudFile {
  id: string;
  name: string;
  sizeBytes: number;
  kind?: "file" | "folder" | "app" | string;
  originalName?: string;
  logicalBytes?: number;
  archiveFormat?: string;
  manifestSHA256?: string;
}

export interface FileListResponse {
  files: CloudFile[];
  nextCursor: string | null;
  quotaBytes: number;
  usedBytes: number;
  workers: number;
}

export interface CreateUploadRequest {
  name: string;
  sizeBytes: number;
  requestId?: string;
  kind?: "file" | "folder" | "app";
  originalName?: string;
  archiveFormat?: "gendragoon-package-v1";
  manifestSHA256?: string;
  logicalBytes?: number;
}


/** POST /v2/workspaces/:sourceId/merge. confirmName is the source workspace name. */
export interface MergeRequest {
  sourceId: string;
  targetId: string;
  confirmName: string;
}

export interface MergeResponse {
  copied: number;
  idempotent: boolean;
  merged: boolean;
  sourceDeleted: boolean;
  sourceId: string;
  workspaceId: string;
}

export interface MergePreviewFile {
  name: string;
  renamedTo: string;
  sizeBytes: number;
}

export interface MergePreviewResponse {
  confirmName: string;
  files: MergePreviewFile[];
  sourceId: string;
  targetId: string;
}

/**
 * POST /v2/workspaces/:id/byo/register. No secrets.
 * `hostFingerprint` is an alias of `bucketFingerprint`. The request sends `bucketFingerprint`.
 */
export interface ByoRegisterRequest {
  provider: string;
  endpoint: string;
  bucketFingerprint?: string;
  hostFingerprint?: string;
}

/** Registration body. The challenge request itself has no body. */
export type ByoChallengeRequest = ByoRegisterRequest;

/** POST /v2/workspaces/:id/byo/challenge returns this. There is no request body. */
export interface ByoChallengeResponse {
  nonce: string;
  expiresAtMs: number;
  ttlMs: number;
}

/** Device-generated presigned GET for `.gendragoon-challenge/<nonce>`. No credentials. */
export interface ByoProofRequest {
  presignedUrl: string;
}

export interface ByoProofResponse {
  verified: boolean;
  workspaceId: string;
  bucketFingerprint?: string;
}

/**
 * POST /v2/workspaces/:id/byo/register success body.
 * `grandfatheringEnded` is copied through when the server sends it.
 */
export interface ByoRegisterResponse {
  grandfatheringEnded?: boolean;
  isFree?: boolean;
  monthlyPriceCents?: number;
  feeWaived?: boolean;
}

/** Proposed login/plan-change payload. Server is source of truth. */
export interface AccessResponse {
  locked: boolean;
  cap: number;
  activeCount: number;
  overCap: boolean;
  unpaidIds: string[];
  lapsedIds: string[];
  readable: true;
  downloadsAllowed: true;
  uploadsBlocked: boolean;
  normalUseBlocked: boolean;
  highTier: boolean;
  /** Server count. The client does not cap or recompute it. */
  freeWorkspaces: number;
  /** Server clock. The client does not derive this from a period end. */
  paidThroughMs?: number;
  renewsAtMs?: number;
  lifetime?: boolean;
}

export type StorageOp = "get" | "put" | "delete";
export type StorageMode = "read" | "write" | "delete";

/**
 * POST /v2/workspaces/:id/storage-urls.
 * `{ op, objects }` only. Object ids are opaque. No names, keys, or GCP credentials.
 * A manifest put sends `ifGeneration` as the exact decimal string from
 * `urls[].generation`. `"0"` creates the object. It is never a JavaScript number.
 */
export interface StorageUrlRequest {
  op: StorageOp;
  objects: string[];
  ifGeneration?: string;
}

/** Signed object URL. Older probes call this a storage link. */
export type StorageLink = StorageObjectUrl;

export interface StorageObjectUrl {
  object: string;
  url: string;
  method: "GET" | "PUT" | "DELETE";
  expiresAt: string;
  generation?: string;
}

export interface StorageUrlResponse {
  bucket?: string;
  prefix: string;
  mode: StorageMode;
  op: StorageOp;
  expiresAt: string;
  urls: StorageObjectUrl[];
}

/**
 * Local freshness inputs for DELETE /v2/account. Neither field is sent.
 * The HTTP body is exactly `{ "confirm": "DELETE" }`.
 * When `idToken` is set, the 5-minute window uses its `auth_time` claim, not `iat`.
 */
export interface DeleteAccountRequest {
  reauthenticatedAt: string;
  idToken?: string;
}

/** HTTP 202 `{ status: "deleting", jobId, statusToken }`. */
export interface DeleteAccountAccepted {
  jobId: string;
  status?: string;
  /** Bearer token for GET /v2/account/deletions/:jobId. Not a Firebase ID token. */
  statusToken?: string;
}

export interface AccountDeletionStatus {
  jobId: string;
  status: "queued" | "running" | "done" | "failed" | (string & {});
  stripeSubscriptionsCancelled?: number;
  managedObjectsDeleted?: number;
  byoWorkspacesLeftIntact?: number;
  firebaseUserDeleted?: boolean;
  confirmation?: string;
  /** Present on `failed`. Retry is offered only when this is true. */
  retryable?: boolean;
}

/**
 * POST /v2/account/deletions/:jobId/support-request.
 * The status token saved for that job is the only credential. A missing
 * session is not sign-in. `fallback` carries the exported SUPPORT_CONTACT.
 */
export type DeletionSupportResult =
  | { kind: "received"; requestId: string }
  | { kind: "already_sent"; retryAfterSec?: number }
  | { kind: "not_needed"; status: AccountDeletionStatus }
  | { kind: "fallback"; contact: { value: string; isPlaceholder: boolean } };

/** Argon2id parameters on the wire. `memoryKiB` is libsodium's byte memLimit / 1024. `iterations` is opsLimit. */
export interface Argon2idKdf {
  alg: "argon2id";
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

/** Scrypt parameters. Used only when `alg` is `scrypt`. */
export interface ScryptKdf {
  alg: "scrypt";
  N: number;
  r: number;
  p: number;
}

/**
 * PUT/GET /v2/workspaces/:id/key-envelope.
 * salt, iv, and wrappedKey are base64url. No passphrase and no raw key.
 */
export interface KeyEnvelope {
  version: number;
  kdf: Argon2idKdf | ScryptKdf;
  salt: string;
  iv: string;
  wrappedKey: string;
}
