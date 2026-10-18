import { AccountDeletedError, ApiError, ReauthRequiredError, WorkspaceLockedError } from "./api/errors.js";
import type { AccountDeletionStatus } from "./api/types.js";
import type { LockAssessment } from "./policy.js";
import { wipeWorkspaceKeys, type SecretStore } from "./seal.js";
import { reauthIsRecent, reauthenticatedAtForDelete } from "./storage.js";

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

const DELETION_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000];
const DELETION_TIMEOUT_MS = 120_000;

function deletionFinished(status: AccountDeletionStatus["status"]): boolean {
  return status === "done" || status === "failed";
}

/**
 * Accepts DELETE /v2/account, then polls GET /v2/account/deletions/:jobId
 * until the job is `done` or `failed`, or the timeout is reached.
 * Local keys are removed only after `done`. A 401 (`reauth_required` or
 * `invalid_token`) leaves them in place. A repeat delete that returns 410
 * `account_deleted` is polled by the job id in that body and does not wipe
 * on the 410 itself.
 */
export async function deleteAccountAndWipe(input: {
  client: {
    deleteAccount(body: { reauthenticatedAt: string; idToken?: string }): Promise<{ jobId: string }>;
    deletionStatus(jobId: string): Promise<AccountDeletionStatus>;
  };
  reauthenticatedAt: string;
  idToken?: string;
  workspaceIds: readonly string[];
  secrets: SecretStore;
  now?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  backoffMs?: readonly number[];
}): Promise<AccountDeletionStatus> {
  const at = reauthenticatedAtForDelete({ reauthenticatedAt: input.reauthenticatedAt, idToken: input.idToken });
  if (!reauthIsRecent(at, input.now ?? Date.now())) {
    throw new ReauthRequiredError();
  }
  const accepted = await acceptDeletion(input.client, { reauthenticatedAt: at, idToken: input.idToken });
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = input.timeoutMs ?? DELETION_TIMEOUT_MS;
  const backoff = input.backoffMs ?? DELETION_BACKOFF_MS;
  let waited = 0;
  let attempt = 0;
  let latest: AccountDeletionStatus;
  for (;;) {
    latest = await input.client.deletionStatus(accepted.jobId);
    if (deletionFinished(latest.status)) break;
    const wait = backoff[Math.min(attempt, backoff.length - 1)] ?? backoff[backoff.length - 1] ?? 8000;
    attempt += 1;
    if (waited + wait > timeoutMs) {
      throw new ApiError(504, "DELETION_TIMEOUT", "Account deletion did not finish before the timeout");
    }
    await sleep(wait);
    waited += wait;
  }
  if (latest.status === "done") {
    await wipeWorkspaceKeys(input.secrets, input.workspaceIds);
  }
  return latest;
}

/** 202 `{jobId}` or 410 `account_deleted` with the same job id. Anything else throws. */
async function acceptDeletion(
  client: {
    deleteAccount(body: { reauthenticatedAt: string; idToken?: string }): Promise<{ jobId: string }>;
  },
  body: { reauthenticatedAt: string; idToken?: string },
): Promise<{ jobId: string }> {
  try {
    return await client.deleteAccount(body);
  } catch (error) {
    if (error instanceof AccountDeletedError && error.jobId) return { jobId: error.jobId };
    throw error;
  }
}
