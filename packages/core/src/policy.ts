/**
 * Workspace records the client renders.
 *
 * Caps, the monthly fee, grandfathering, and lapse are decided on the server.
 * This module does not recompute them. Treat HTTP 423 `workspace_lock`
 * as the delete-or-merge lock. There is no /v2/access route.
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
  /**
   * Copied from the server list or create item. A local placeholder omits them.
   * The client does not count workspaces to fill these in.
   */
  isFree?: boolean;
  monthlyPriceCents?: number;
  /** Server flag on list and create items. */
  grandfathered?: boolean;
  /** Server flag on list and create items. */
  feeWaived?: boolean;
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
  /** "plans" when the workspace's storage + performance plans are billed together. */
  billingModel?: "plans" | "free" | "legacy";
  customStorage?: boolean;
  requiredPlans?: { storage: "managed" | "custom"; storageTier?: string; performanceTier: string; interval: "month" | "year" } | null;
  plansStatus?: string | null;
  byoRegistered?: boolean;
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

/**
 * Price fields copied off a workspace list item, a create `project`, or a
 * BYO register body. `monthlyPriceCents` is 0 exactly when `isFree`,
 * `grandfathered`, or `feeWaived` is true. This type does not recompute them.
 */
export interface WorkspacePrice {
  isFree: boolean;
  monthlyPriceCents: number;
  grandfathered: boolean;
  feeWaived: boolean;
}

/**
 * Reads the server price. `isFree`, `monthlyPriceCents`, `grandfathered`,
 * and `feeWaived` are required. The input object is not changed.
 */
export function parseWorkspacePrice(value: unknown): WorkspacePrice {
  if (!value || typeof value !== "object") throw new TypeError("Workspace price is missing");
  const record = value as Record<string, unknown>;
  if (typeof record.isFree !== "boolean") throw new TypeError("Workspace isFree is missing");
  if (typeof record.monthlyPriceCents !== "number" || !Number.isInteger(record.monthlyPriceCents)) {
    throw new TypeError("Workspace monthlyPriceCents is missing");
  }
  if (typeof record.grandfathered !== "boolean") throw new TypeError("Workspace grandfathered is missing");
  if (typeof record.feeWaived !== "boolean") throw new TypeError("Workspace feeWaived is missing");
  return {
    isFree: record.isFree,
    monthlyPriceCents: record.monthlyPriceCents,
    grandfathered: record.grandfathered,
    feeWaived: record.feeWaived,
  };
}

/** `Free` when `isFree`, `Included` when `grandfathered` or `feeWaived`, otherwise USD cents. */
export function workspacePriceLabel(price: WorkspacePrice): string {
  if (price.isFree) return "Free";
  if (price.grandfathered || price.feeWaived) return "Included";
  return formatMonthlyPriceCents(price.monthlyPriceCents);
}

function formatMonthlyPriceCents(cents: number): string {
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  return `${negative ? "-" : ""}$${dollars}.${String(remainder).padStart(2, "0")}`;
}
