/**
 * Workspace plans (server billing version 3).
 *
 * - The workspace fee is included in the storage plans; there is no separate fee.
 * - The first hosted workspace is free: 2 GB storage and the free performance plan.
 * - Every additional workspace buys a storage plan AND a performance plan, billed together.
 * - Custom storage (own S3 / VPS / cloud) skips the storage plan but still buys a paid
 *   performance plan, then runs the setup wizard.
 *
 * The server enforces all of this (PLANS_REQUIRED, PERFORMANCE_PLAN_REQUIRED, INVALID_SELECTION).
 * These helpers mirror the rules so the UI never offers a request the server will refuse.
 */

export const STORAGE_PLAN_TIERS = ["100GB", "200GB", "300GB", "500GB", "1TB", "2TB", "3TB", "4TB", "5TB", "6TB"] as const;
export type StoragePlanTier = (typeof STORAGE_PLAN_TIERS)[number];
export const PERFORMANCE_PLAN_TIERS = ["lite", "boost", "turbo", "ultra", "max"] as const;
export type PerformancePlanTier = (typeof PERFORMANCE_PLAN_TIERS)[number];
export type PlanInterval = "month" | "year";
export type WorkspaceStorageChoice = "managed" | "custom";

export const FIRST_WORKSPACE_INCLUDES = { storageGB: 2, performanceTier: "free", workers: 1 } as const;

export interface WorkspacePlansSelection {
  storageTier?: StoragePlanTier;
  performanceTier?: PerformancePlanTier;
  interval: PlanInterval;
}

/** Body of POST /v2/projects. `plans` is omitted for the free first workspace. */
export interface CreateWorkspaceRequest {
  name: string;
  intentId: string;
  storage?: WorkspaceStorageChoice;
  plans?: { storageTier?: StoragePlanTier; performanceTier: PerformancePlanTier; interval: PlanInterval };
}

export type PlansErrorCode = "PLANS_REQUIRED" | "PERFORMANCE_PLAN_REQUIRED" | "INVALID_SELECTION";

export const PLANS_MESSAGES: Record<PlansErrorCode | "PLANS_CHECKOUT_UNAVAILABLE" | "PLANS_PRICE_UNCONFIGURED" | "CUSTOM_STORAGE_NEW_WORKSPACE" | "PLANS_MANAGED_TOGETHER" | "CUSTOM_STORAGE_FEE_RETIRED", string> = {
  PLANS_REQUIRED: "Each additional workspace needs a storage plan and a performance plan. Choose both to continue.",
  PERFORMANCE_PLAN_REQUIRED: "Custom storage needs a paid performance plan. Choose Lite, Boost, Turbo, Ultra or Max.",
  INVALID_SELECTION: "That plan combination is not available. Choose a storage plan and a performance plan with the same billing period.",
  PLANS_CHECKOUT_UNAVAILABLE: "Plan checkout is not available yet. Your existing workspaces remain available.",
  PLANS_PRICE_UNCONFIGURED: "These plans can't be bought yet. Your existing workspaces remain available.",
  CUSTOM_STORAGE_NEW_WORKSPACE: "Create a new workspace and choose Custom storage to connect your own provider.",
  PLANS_MANAGED_TOGETHER: "This workspace's storage and performance plans are changed together from the workspace.",
  CUSTOM_STORAGE_FEE_RETIRED: "Custom storage no longer has a separate fee. It uses the workspace's performance plan.",
};

export class PlansSelectionError extends Error {
  constructor(readonly code: PlansErrorCode) {
    super(PLANS_MESSAGES[code]);
    this.name = "PlansSelectionError";
  }
}

const isStorageTier = (value: unknown): value is StoragePlanTier => (STORAGE_PLAN_TIERS as readonly unknown[]).includes(value);
const isPerformanceTier = (value: unknown): value is PerformancePlanTier => (PERFORMANCE_PLAN_TIERS as readonly unknown[]).includes(value);

/** What a new workspace needs, from the server policy (`freeProjectAvailable`). */
export function newWorkspaceRequirement(input: { freeProjectAvailable?: boolean; storage: WorkspaceStorageChoice }):
  { kind: "free" } | { kind: "plans"; needs: readonly ("storage" | "performance")[] } {
  if (input.storage === "custom") return { kind: "plans", needs: ["performance"] };
  if (input.freeProjectAvailable === true) return { kind: "free" };
  return { kind: "plans", needs: ["storage", "performance"] };
}

/** Builds the exact POST /v2/projects body, or throws the same code the server would. */
export function buildCreateWorkspaceRequest(input: {
  name: string;
  intentId: string;
  storage: WorkspaceStorageChoice;
  freeProjectAvailable?: boolean;
  selection: WorkspacePlansSelection;
}): CreateWorkspaceRequest {
  const requirement = newWorkspaceRequirement(input);
  if (requirement.kind === "free") return { name: input.name, intentId: input.intentId };
  const { performanceTier, storageTier, interval } = input.selection;
  if (interval !== "month" && interval !== "year") throw new PlansSelectionError("INVALID_SELECTION");
  if (!isPerformanceTier(performanceTier)) {
    throw new PlansSelectionError(input.storage === "custom" ? "PERFORMANCE_PLAN_REQUIRED" : "PLANS_REQUIRED");
  }
  if (input.storage === "custom") {
    return { name: input.name, intentId: input.intentId, storage: "custom", plans: { performanceTier, interval } };
  }
  if (!isStorageTier(storageTier)) throw new PlansSelectionError("PLANS_REQUIRED");
  return { name: input.name, intentId: input.intentId, plans: { storageTier, performanceTier, interval } };
}

/** Subset of GET /v2/pricing used for plan quotes. */
export interface PlansPricing {
  storage: Record<string, { gb: number; monthlyCents: number; yearlyCents: number }>;
  performance: Record<string, { workers: number; monthlyCents: number; yearlyCents: number }>;
}

/**
 * Quote for the plans the user picked: one line per plan, no workspace-fee line.
 * Returns null when a price is missing, so the UI never shows a guessed amount.
 */
export function quoteWorkspacePlans(pricing: PlansPricing | null | undefined, input: { storage: WorkspaceStorageChoice; selection: WorkspacePlansSelection }):
  { lines: { label: string; cents: number }[]; totalCents: number; interval: PlanInterval } | null {
  if (!pricing) return null;
  const { interval, storageTier, performanceTier } = input.selection;
  const pick = (row: { monthlyCents: number; yearlyCents: number } | undefined) => (row ? (interval === "year" ? row.yearlyCents : row.monthlyCents) : undefined);
  const lines: { label: string; cents: number }[] = [];
  if (input.storage === "managed") {
    const cents = storageTier ? pick(pricing.storage[storageTier]) : undefined;
    if (typeof cents !== "number") return null;
    lines.push({ label: `${storageTier} storage plan`, cents });
  }
  const perf = performanceTier ? pick(pricing.performance[performanceTier]) : undefined;
  if (typeof perf !== "number" || !performanceTier) return null;
  lines.push({ label: `${capitalize(performanceTier)} performance plan`, cents: perf });
  return { lines, totalCents: lines.reduce((sum, line) => sum + line.cents, 0), interval };
}

export function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

/** Plan label for a workspace row: "100GB + Boost", "Custom storage + Lite", or null. */
export function workspacePlansLabel(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { billingModel?: unknown; requiredPlans?: unknown };
  if (record.billingModel !== "plans" || !record.requiredPlans || typeof record.requiredPlans !== "object") return null;
  const plans = record.requiredPlans as { storage?: unknown; storageTier?: unknown; performanceTier?: unknown };
  if (typeof plans.performanceTier !== "string") return null;
  const storage = plans.storage === "custom" ? "Custom storage" : typeof plans.storageTier === "string" ? plans.storageTier : null;
  return storage ? `${storage} + ${capitalize(plans.performanceTier)}` : null;
}

/** Custom storage setup wizard: provider → credentials (stay on device) → connection test → finish. */
export const CUSTOM_STORAGE_STEPS = ["provider", "credentials", "test", "finish"] as const;
export type CustomStorageStep = (typeof CUSTOM_STORAGE_STEPS)[number];

export interface CustomStorageWizardState {
  step: CustomStorageStep;
  provider: string | null;
  endpoint: string;
  bucket: string;
  /** Kept in memory, then the OS keychain. Never part of a request body. */
  hasCredentials: boolean;
  testing: boolean;
  error: string | null;
}

export type CustomStorageWizardEvent =
  | { type: "provider"; provider: string }
  | { type: "credentials"; endpoint: string; bucket: string; hasCredentials: boolean }
  | { type: "test_started" }
  | { type: "test_failed"; message: string }
  | { type: "test_passed" }
  | { type: "back" };

export const INITIAL_CUSTOM_STORAGE: CustomStorageWizardState = {
  step: "provider",
  provider: null,
  endpoint: "",
  bucket: "",
  hasCredentials: false,
  testing: false,
  error: null,
};

export function customStorageWizard(state: CustomStorageWizardState, event: CustomStorageWizardEvent): CustomStorageWizardState {
  switch (event.type) {
    case "provider":
      return state.step === "provider" ? { ...state, provider: event.provider, step: "credentials", error: null } : state;
    case "credentials": {
      if (state.step !== "credentials") return state;
      if (!/^https:\/\/[^\s/]+/.test(event.endpoint) || !event.bucket.trim() || !event.hasCredentials) {
        return { ...state, error: "Enter an https endpoint, a bucket and your access keys." };
      }
      return { ...state, endpoint: event.endpoint, bucket: event.bucket.trim(), hasCredentials: true, step: "test", error: null };
    }
    case "test_started":
      return state.step === "test" ? { ...state, testing: true, error: null } : state;
    case "test_failed":
      return state.step === "test" ? { ...state, testing: false, error: event.message } : state;
    case "test_passed":
      return state.step === "test" ? { ...state, testing: false, step: "finish", error: null } : state;
    case "back": {
      if (state.testing || state.step === "finish") return state;
      const index = CUSTOM_STORAGE_STEPS.indexOf(state.step);
      return index > 0 ? { ...state, step: CUSTOM_STORAGE_STEPS[index - 1]!, error: null } : state;
    }
  }
}
