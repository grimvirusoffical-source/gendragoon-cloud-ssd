/**
 * Workspace billing and lock rules.
 *
 * The live backend (gendragoon-cloud-ssd @ 4cb71b5, tag v0.18.0-rc.2,
 * native/Backend/projects.js) is the source of the 10/20 cap and the
 * 2 TB + Turbo qualification. Clients render the assessment below; the
 * server enforces it on every request. A local "allowed" result is not
 * authorization.
 *
 * Grandfathered one-time activations keep feeIsOneTime=true and never lapse.
 * Recurring workspace fees lapse at Stripe current_period_end plus
 * LAPSE_GRACE_DAYS. Whether the first workspace is free is still pending:
 * FREE_WORKSPACES defaults to 1 and 0 is the only other legal value.
 */

export const FREE_WORKSPACES = 1;
export const MAX_WORKSPACES_BASE = 10;
export const MAX_WORKSPACES_HIGH = 20;
export const WORKSPACE_MONTHLY_CENTS = 500;
export const LAPSE_GRACE_DAYS = 3;
export const LAPSE_GRACE_MS = LAPSE_GRACE_DAYS * 24 * 60 * 60 * 1000;
export const QUALIFYING_STORAGE_GB = 2000;
export const QUALIFYING_WORKERS = 8;

export type FreeWorkspaceAllowance = 0 | 1;

export const STORAGE_GB: Readonly<Record<string, number>> = Object.freeze({
  "100GB": 100,
  "200GB": 200,
  "300GB": 300,
  "500GB": 500,
  "1TB": 1000,
  "2TB": 2000,
  "3TB": 3000,
  "4TB": 4000,
  "5TB": 5000,
  "6TB": 6000,
});

export const PERFORMANCE_WORKERS: Readonly<Record<string, number>> = Object.freeze({
  lite: 2,
  boost: 4,
  turbo: 8,
  ultra: 12,
  max: 20,
});

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
 * ownerUid field and no member role.
 */
export interface WorkspaceRecord {
  id: string;
  name: string;
  kind: WorkspaceKind;
  accountHash?: string;
  accountKey?: string;
  projectStatus?: ProjectStatus;
  projectFeeStatus?: ProjectFeeStatus;
  feeIsOneTime?: boolean;
  workspaceSubscriptionId?: string | null;
  currentPeriodEnd?: string | null;
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

export interface LockAssessment {
  locked: boolean;
  cap: number;
  activeCount: number;
  overCap: boolean;
  unpaidIds: string[];
  lapsedIds: string[];
  /** Cloud bytes stay readable while the UI is locked. */
  readable: true;
  downloadsAllowed: true;
  uploadsBlocked: boolean;
  normalUseBlocked: boolean;
  highTier: boolean;
}

export interface WorkspaceQuote {
  free: boolean;
  monthlyCents: number;
  feeIsOneTime: false;
  performanceAddon: boolean;
}

export function freeWorkspaceAllowance(value: number = FREE_WORKSPACES): FreeWorkspaceAllowance {
  if (value !== 0 && value !== 1) {
    throw new Error("FREE_WORKSPACES must be 0 or 1");
  }
  return value;
}

export function isArchived(workspace: WorkspaceRecord): boolean {
  return workspace.projectStatus === "archived";
}

function storageGb(tier: string | null | undefined): number | undefined {
  if (!tier || !Object.prototype.hasOwnProperty.call(STORAGE_GB, tier)) return undefined;
  return STORAGE_GB[tier];
}

function workerCount(tier: string | null | undefined): number {
  if (!tier || !Object.prototype.hasOwnProperty.call(PERFORMANCE_WORKERS, tier)) return 0;
  return PERFORMANCE_WORKERS[tier] ?? 0;
}

/** Port of native/Backend/projects.js activatedBasicProject. */
function activatedBasicProject(workspace: WorkspaceRecord): boolean {
  return workspace.projectBillingVersion === 2
    && workspace.projectStatus === "active"
    && (workspace.projectFeeStatus === "free"
      || workspace.projectFeeStatus === "paid"
      || workspace.projectFeeStatus === "owner")
    && workspace.provisioned === true;
}

/**
 * Port of native/Backend/projects.js qualifiesForHigherLimit.
 * High cap (20) applies only when one active project has at least 2 TB and
 * Turbo (8 workers), or an equivalent bundle. Re-evaluate on every login
 * and plan change; do not cache the previous cap.
 */
export function qualifiesForHigherLimit(workspace: WorkspaceRecord): boolean {
  if (workspace.projectStatus !== "active" || workspace.storageActive !== true || workspace.provisioned !== true) {
    return false;
  }
  const gb = storageGb(workspace.storageTier);
  if (gb === undefined || gb < QUALIFYING_STORAGE_GB) return false;
  if (workspace.projectBillingVersion === 2 && !activatedBasicProject(workspace)) return false;
  const extra = workspace.performanceActive === true ? workerCount(workspace.performanceTier) : 0;
  const bundled = workspace.storageMode === "bundle"
    ? Math.min(24, Math.max(2, Math.floor(gb / 250)))
    : 0;
  return Math.max(extra, bundled) >= QUALIFYING_WORKERS;
}

export function workspaceCap(workspaces: readonly WorkspaceRecord[]): number {
  return workspaces.some(qualifiesForHigherLimit) ? MAX_WORKSPACES_HIGH : MAX_WORKSPACES_BASE;
}

export function freeSlotIds(
  workspaces: readonly WorkspaceRecord[],
  allowance: number = FREE_WORKSPACES,
): Set<string> {
  const allowed = freeWorkspaceAllowance(allowance);
  if (allowed === 0) return new Set();
  const candidates = workspaces
    .filter((workspace) => !isArchived(workspace) && isFreeMarked(workspace))
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  return new Set(candidates.slice(0, allowed).map((workspace) => workspace.id));
}

function isFreeMarked(workspace: WorkspaceRecord): boolean {
  return workspace.kind === "free" || workspace.id === "free" || workspace.projectFeeStatus === "free";
}

/**
 * One-time $5 buyers stay paid forever. An omitted flag plus projectFeeStatus
 * "paid" and no recurring subscription id is the live one-time activation.
 * feeIsOneTime false opts into the recurring lapse rule even if status is paid.
 */
export function isGrandfathered(workspace: WorkspaceRecord): boolean {
  if (workspace.feeIsOneTime === true) return true;
  if (workspace.feeIsOneTime === false) return false;
  return workspace.projectFeeStatus === "paid" && !workspace.workspaceSubscriptionId;
}

export function graceEndsAt(currentPeriodEnd: string): number {
  const end = new Date(currentPeriodEnd).getTime();
  if (!Number.isFinite(end)) {
    throw new Error("currentPeriodEnd must be an ISO timestamp");
  }
  return end + LAPSE_GRACE_MS;
}

export function isLapsed(workspace: WorkspaceRecord, now: number, freeIds: ReadonlySet<string>): boolean {
  if (freeIds.has(workspace.id) || isGrandfathered(workspace) || workspace.projectFeeStatus === "owner") {
    return false;
  }
  if (!workspace.currentPeriodEnd) return false;
  return now > graceEndsAt(workspace.currentPeriodEnd);
}

export function isUnpaid(workspace: WorkspaceRecord, now: number, freeIds: ReadonlySet<string>): boolean {
  if (isArchived(workspace)) return false;
  if (freeIds.has(workspace.id) || isGrandfathered(workspace) || workspace.projectFeeStatus === "owner") {
    return false;
  }
  if (workspace.currentPeriodEnd) return now > graceEndsAt(workspace.currentPeriodEnd);
  return true;
}

/** Call with the server's latest workspace list on login and after every plan change. */
export function assessLock(
  workspaces: readonly WorkspaceRecord[],
  now: number,
  allowance: number = FREE_WORKSPACES,
): LockAssessment {
  const active = workspaces.filter((workspace) => !isArchived(workspace));
  const freeIds = freeSlotIds(workspaces, allowance);
  const cap = workspaceCap(active);
  const unpaid = active.filter((workspace) => isUnpaid(workspace, now, freeIds));
  const lapsed = active.filter((workspace) => isLapsed(workspace, now, freeIds));
  const overCap = active.length > cap;
  const locked = overCap || unpaid.length > 0;
  return {
    locked,
    cap,
    activeCount: active.length,
    overCap,
    unpaidIds: unpaid.map((workspace) => workspace.id),
    lapsedIds: lapsed.map((workspace) => workspace.id),
    readable: true,
    downloadsAllowed: true,
    uploadsBlocked: locked,
    normalUseBlocked: locked,
    highTier: cap === MAX_WORKSPACES_HIGH,
  };
}

export function workspaceMonthlyCents(workspace: WorkspaceRecord, freeIds: ReadonlySet<string>): number {
  if (freeIds.has(workspace.id) || isGrandfathered(workspace) || workspace.projectFeeStatus === "owner") {
    return 0;
  }
  return WORKSPACE_MONTHLY_CENTS;
}

/** Performance tiers are add-ons. The free workspace cannot buy one. */
export function performanceAddonAllowed(workspace: WorkspaceRecord, freeIds: ReadonlySet<string>): boolean {
  if (freeIds.has(workspace.id)) return false;
  if (workspace.kind === "free" || workspace.projectFeeStatus === "free") return false;
  return true;
}

export function quoteAdditionalWorkspace(
  existing: readonly WorkspaceRecord[],
  allowance: number = FREE_WORKSPACES,
): WorkspaceQuote {
  const allowed = freeWorkspaceAllowance(allowance);
  const freeIds = freeSlotIds(existing, allowed);
  if (freeIds.size < allowed) {
    return { free: true, monthlyCents: 0, feeIsOneTime: false, performanceAddon: false };
  }
  return {
    free: false,
    monthlyCents: WORKSPACE_MONTHLY_CENTS,
    feeIsOneTime: false,
    performanceAddon: true,
  };
}
