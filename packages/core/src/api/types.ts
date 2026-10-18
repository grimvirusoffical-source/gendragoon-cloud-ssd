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
  workspaceFeeMonthlyCents: number;
  legacyWorkspaceFeeMonthlyCents: number;
  projects: {
    firstFree: boolean;
    additionalOneTimeCents: number;
    defaultLimit: number;
    qualifiedLimit: number;
    qualifyingStorageTier: string;
    qualifyingPerformanceTier: string;
    qualifyingWorkers: number;
  };
  purchasesEnabled: boolean;
}

export type WorkspaceKind = "free" | "paid" | "byo";

export interface Workspace {
  id: string;
  name: string;
  kind: WorkspaceKind;
  /** Present on paid/BYO server documents. Omitted from today's public payload. */
  accountHash?: string;
  /** Legacy free project only (`tenants/{accountKey}/workspaces/free`). */
  accountKey?: string;
  projectStatus?: string;
  projectBillingVersion?: number;
  projectFeeStatus?: "free" | "paid" | "owner" | "pending" | "legacy" | string;
  projectFeeCents?: number;
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
  newProjectOneTimeCents: number;
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

/** Proposed. Recurring $5 workspace fee. Not the one-time project activation. */
export interface WorkspaceFeeCheckout {
  url?: string;
  workspaceId: string;
  monthlyCents: 500;
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

/** POST /v2/workspaces/:id/byo/register. No secrets. */
export interface ByoRegisterRequest {
  provider: string;
  endpoint: string;
  bucketFingerprint: string;
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
  freeWorkspaces: 0 | 1;
  /** Server clock. The client does not derive this from a period end. */
  paidThroughMs?: number;
  renewsAtMs?: number;
  lifetime?: boolean;
}

export type StorageOp = "upload" | "download" | "resumable" | "delete";
export type StorageAccess = "read-write" | "read-only";

/** POST /v2/workspaces/:id/storage-urls. Object ids only. No names, keys, or GCP credentials. */
export interface StorageOperation {
  op: StorageOp;
  oid: string;
  sizeBytes?: number;
}

export interface StorageUrlRequest {
  operations: StorageOperation[];
}

export interface StorageLink {
  op: StorageOp;
  oid: string;
  method: "GET" | "PUT" | "POST" | "DELETE";
  url: string;
  expiresAt: string;
}

export interface StorageUrlResponse {
  prefix: string;
  expiresAt: string;
  access: StorageAccess;
  links: StorageLink[];
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
  status: "accepted" | "running" | "succeeded" | "done" | "failed";
  stripeSubscriptionsCancelled?: number;
  managedObjectsDeleted?: number;
  byoWorkspacesLeftIntact?: number;
  firebaseUserDeleted?: boolean;
  confirmation?: string;
}

/** PUT/GET /v2/workspaces/:id/key-envelope. No passphrase and no raw key. */
export interface KeyEnvelope {
  version: 1;
  kdf: "argon2id" | "scrypt";
  salt: string;
  opsLimit: number;
  memLimit: number;
  iv: string;
  wrappedKey: string;
}
