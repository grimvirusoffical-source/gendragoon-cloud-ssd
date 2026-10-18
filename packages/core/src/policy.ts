/**
 * Workspace records the client renders.
 *
 * Caps, the monthly fee, grandfathering, and lapse are decided on the server.
 * This module does not recompute them. Paint `GET /v2/access` and treat HTTP
 * 423 `workspace_lock` as the delete-or-merge lock.
 */

export type ProjectStatus =
  | "active"
  | "pending_activation"
  | "pending_payment"
  | "archived"
  | "payment_revoked"
  | "payment_confirmed_pending_capacity";

export type ProjectFeeStatus = "free" | "paid" | "owner" | "pending" | "legacy";

export type WorkspaceKind = "free" | "paid" | "byo";

export interface WorkspaceStorageManaged {
  kind: "gendragoon";
  storageTier: string | null;
}

export interface WorkspaceStorageByo {
  kind: "byo";
  storageTier: null;
  provider: string;
  endpoint: string;
  bucketFingerprint: string;
}

export type WorkspaceStorage = WorkspaceStorageManaged | WorkspaceStorageByo;

/**
 * Fields the client renders. accountHash (accountKey on the legacy free
 * project) is the ownership key the server already stores. There is no
 * ownerUid field and no member role. Billing flags such as a one-time fee
 * are not part of the client model.
 */
export interface WorkspaceRecord {
  id: string;
  name: string;
  kind: WorkspaceKind;
  accountHash?: string;
  accountKey?: string;
  projectStatus?: ProjectStatus;
  projectFeeStatus?: ProjectFeeStatus;
  workspaceSubscriptionId?: string | null;
  storageActive?: boolean;
  storageTier?: string | null;
  storageMode?: "standard" | "bundle" | null;
  performanceActive?: boolean;
  performanceTier?: string | null;
  provisioned?: boolean;
  projectBillingVersion?: number;
  storage?: WorkspaceStorage;
  createdAt?: string | null;
}

/** Server lock payload. Clients do not derive `locked` from workspace rows. */
export interface LockAssessment {
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
  paidThroughMs?: number;
  renewsAtMs?: number;
  lifetime?: boolean;
}

/** Display fields copied from the server access payload. No dates are computed. */
export interface PlanSummary {
  used: number;
  limit: number;
  locked: boolean;
  paidThroughMs?: number;
  renewsAtMs?: number;
  lifetime?: boolean;
}

/**
 * Formats the plan the server already decided. Missing fields stay missing.
 * This does not apply a cap, a grace period, or a lifetime rule of its own.
 */
export function planSummary(access: {
  cap: number;
  activeCount: number;
  locked: boolean;
  paidThroughMs?: number;
  renewsAtMs?: number;
  lifetime?: boolean;
}): PlanSummary {
  const summary: PlanSummary = {
    used: access.activeCount,
    limit: access.cap,
    locked: access.locked,
  };
  if (typeof access.paidThroughMs === "number") summary.paidThroughMs = access.paidThroughMs;
  if (typeof access.renewsAtMs === "number") summary.renewsAtMs = access.renewsAtMs;
  if (typeof access.lifetime === "boolean") summary.lifetime = access.lifetime;
  return summary;
}
