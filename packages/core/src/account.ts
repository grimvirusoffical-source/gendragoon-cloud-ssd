import { ApiError, WorkspaceLockedError } from "./api/errors.js";
import type { AccountDeletionStatus } from "./api/types.js";
import type { LockAssessment } from "./policy.js";
import { wipeWorkspaceKeys, type SecretStore } from "./seal.js";
import { reauthIsRecent } from "./storage.js";

/**
 * Account session states the shell is allowed to render.
 * delete_or_merge is the login lock: reads and deletes stay available,
 * writes are refused until the user deletes or merges.
 */
export type AccountPhase = "ready" | "delete_or_merge";

export type AccountLockReason = "clear" | "over_cap" | "unpaid" | "server_lock";

export interface AccountState {
  phase: AccountPhase;
  reason: AccountLockReason;
}

export type AccountEvent =
  | { type: "write_locked" }
  | { type: "read_ok" }
  | { type: "delete_ok" }
  | { type: "assessment"; assessment: Pick<LockAssessment, "locked" | "overCap" | "unpaidIds"> };

export function accountFromAssessment(
  assessment: Pick<LockAssessment, "locked" | "overCap" | "unpaidIds">,
): AccountState {
  if (!assessment.locked) return { phase: "ready", reason: "clear" };
  if (assessment.overCap) return { phase: "delete_or_merge", reason: "over_cap" };
  if (assessment.unpaidIds.length > 0) return { phase: "delete_or_merge", reason: "unpaid" };
  return { phase: "delete_or_merge", reason: "server_lock" };
}

/**
 * Reads and deletes do not enter or leave the lock. A write rejected with
 * workspace_lock always enters delete-or-merge. A fresh server assessment
 * is what clears it, after the user has deleted or merged.
 */
export function reduceAccount(state: AccountState, event: AccountEvent): AccountState {
  switch (event.type) {
    case "read_ok":
    case "delete_ok":
      return state;
    case "write_locked":
      if (state.reason === "over_cap" || state.reason === "unpaid") {
        return { phase: "delete_or_merge", reason: state.reason };
      }
      return { phase: "delete_or_merge", reason: "server_lock" };
    case "assessment":
      return accountFromAssessment(event.assessment);
    default:
      return state;
  }
}

export function isWorkspaceLockError(error: unknown): error is WorkspaceLockedError {
  if (error instanceof WorkspaceLockedError) return true;
  return error instanceof ApiError && (error.status === 423 || error.code === "workspace_lock");
}

/** Apply an API failure. Only a workspace lock changes the phase. */
export function applyApiFailure(state: AccountState, error: unknown): AccountState {
  if (!isWorkspaceLockError(error)) return state;
  return reduceAccount(state, { type: "write_locked" });
}

/** Where the shell should go after a failed call. Lock replaces the current view. */
export function viewAfterFailure(view: string, error: unknown): string {
  if (isWorkspaceLockError(error)) return "workspaces";
  return view;
}

/**
 * Accepts DELETE /v2/account, wipes local workspace and BYO keys, then reads
 * the deletion job. A stale re-auth fails before anything is deleted.
 */
export async function deleteAccountAndWipe(input: {
  client: {
    deleteAccount(body: { reauthenticatedAt: string }): Promise<{ jobId: string }>;
    deletionStatus(jobId: string): Promise<AccountDeletionStatus>;
  };
  reauthenticatedAt: string;
  workspaceIds: readonly string[];
  secrets: SecretStore;
  now?: number;
}): Promise<AccountDeletionStatus> {
  if (!reauthIsRecent(input.reauthenticatedAt, input.now ?? Date.now())) {
    throw new ApiError(401, "REAUTH_REQUIRED", "Sign in again before deleting the account");
  }
  const accepted = await input.client.deleteAccount({ reauthenticatedAt: input.reauthenticatedAt });
  await wipeWorkspaceKeys(input.secrets, input.workspaceIds);
  return input.client.deletionStatus(accepted.jobId);
}
