import { AccountDeletedError, ApiError, ReauthRequiredError, WorkspaceLockedError } from "./api/errors.js";
import type { AccountDeletionStatus } from "./api/types.js";
import type { LockAssessment } from "./policy.js";
import { wipeWorkspaceKeys, type SecretStore, type SecureStore } from "./seal.js";
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
const DELETION_JOB_KEY = "account-deletion:job-id";
const DELETION_TOKEN_KEY = "account-deletion:status-token";

function deletionFinished(status: AccountDeletionStatus["status"]): boolean {
  return status === "done" || status === "failed";
}

interface DeletionClient {
  deleteAccount(body: { reauthenticatedAt: string; idToken?: string }): Promise<{ jobId: string; statusToken?: string }>;
  deletionStatus(jobId: string, statusToken?: string): Promise<AccountDeletionStatus>;
}

interface DeletionJob {
  jobId: string;
  statusToken?: string;
}

/**
 * Accepts DELETE /v2/account, then polls GET /v2/account/deletions/:jobId
 * until the job is `done` or `failed`, or the timeout is reached.
 * Local keys are removed only after `done`. A 401 (`reauth_required` or
 * `invalid_token`) leaves them in place. A repeat delete that returns 410
 * `account_deleted` is polled by the job id in that body and does not wipe
 * on the 410 itself.
 * When SecureStore already has a job id and status token, that job is polled
 * and DELETE is not sent again. A repeat DELETE returns 410, never 401.
 */
export async function deleteAccountAndWipe(input: {
  client: DeletionClient;
  reauthenticatedAt: string;
  idToken?: string;
  workspaceIds: readonly string[];
  secrets: SecretStore;
  secureStore?: SecureStore;
  now?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  backoffMs?: readonly number[];
}): Promise<AccountDeletionStatus> {
  const saved = await loadDeletionJob(input.secureStore);
  const job = saved ?? await startDeletion(input);
  if (input.secureStore && job.statusToken) {
    await saveDeletionJob(input.secureStore, job.jobId, job.statusToken);
  }
  return pollDeletion({
    client: input.client,
    job,
    workspaceIds: input.workspaceIds,
    secrets: input.secrets,
    secureStore: input.secureStore,
    sleep: input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    timeoutMs: input.timeoutMs ?? DELETION_TIMEOUT_MS,
    backoffMs: input.backoffMs ?? DELETION_BACKOFF_MS,
  });
}

/**
 * Continue a deletion after restart. Uses the job id and status token in
 * SecureStore. Does not send DELETE. Returns null when nothing is saved.
 */
export async function resumeAccountDeletion(input: {
  client: {
    deletionStatus(jobId: string, statusToken?: string): Promise<AccountDeletionStatus>;
  };
  workspaceIds: readonly string[];
  secrets: SecretStore;
  secureStore: SecureStore;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  backoffMs?: readonly number[];
}): Promise<AccountDeletionStatus | null> {
  const saved = await loadDeletionJob(input.secureStore);
  if (!saved?.statusToken) return null;
  return pollDeletion({
    client: input.client,
    job: saved,
    workspaceIds: input.workspaceIds,
    secrets: input.secrets,
    secureStore: input.secureStore,
    sleep: input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    timeoutMs: input.timeoutMs ?? DELETION_TIMEOUT_MS,
    backoffMs: input.backoffMs ?? DELETION_BACKOFF_MS,
  });
}

/** DELETE only when SecureStore has no saved job. 410 account_deleted is the repeat response. */
async function startDeletion(input: {
  client: DeletionClient;
  reauthenticatedAt: string;
  idToken?: string;
  now?: number;
}): Promise<DeletionJob> {
  const at = reauthenticatedAtForDelete({ reauthenticatedAt: input.reauthenticatedAt, idToken: input.idToken });
  if (!reauthIsRecent(at, input.now ?? Date.now())) {
    throw new ReauthRequiredError();
  }
  return acceptDeletion(input.client, { reauthenticatedAt: at, idToken: input.idToken });
}

async function pollDeletion(input: {
  client: {
    deletionStatus(jobId: string, statusToken?: string): Promise<AccountDeletionStatus>;
  };
  job: DeletionJob;
  workspaceIds: readonly string[];
  secrets: SecretStore;
  secureStore?: SecureStore;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  backoffMs: readonly number[];
}): Promise<AccountDeletionStatus> {
  let waited = 0;
  let attempt = 0;
  let latest: AccountDeletionStatus;
  for (;;) {
    latest = input.job.statusToken
      ? await input.client.deletionStatus(input.job.jobId, input.job.statusToken)
      : await input.client.deletionStatus(input.job.jobId);
    if (deletionFinished(latest.status)) break;
    const wait = input.backoffMs[Math.min(attempt, input.backoffMs.length - 1)] ?? input.backoffMs[input.backoffMs.length - 1] ?? 8000;
    attempt += 1;
    if (waited + wait > input.timeoutMs) {
      throw new ApiError(504, "DELETION_TIMEOUT", "Account deletion did not finish before the timeout");
    }
    await input.sleep(wait);
    waited += wait;
  }
  if (latest.status === "done") {
    await wipeWorkspaceKeys(input.secrets, input.workspaceIds);
  }
  if (latest.status === "done" || latest.status === "failed") {
    await clearDeletionJob(input.secureStore);
  }
  return latest;
}

/** 202 `{jobId, statusToken}` or 410 `account_deleted` with the same fields. Anything else throws. */
async function acceptDeletion(
  client: DeletionClient,
  body: { reauthenticatedAt: string; idToken?: string },
): Promise<DeletionJob> {
  try {
    const accepted = await client.deleteAccount(body);
    return { jobId: accepted.jobId, statusToken: accepted.statusToken };
  } catch (error) {
    if (error instanceof AccountDeletedError && error.jobId) {
      return { jobId: error.jobId, statusToken: error.statusToken };
    }
    throw error;
  }
}

async function loadDeletionJob(store?: SecureStore): Promise<DeletionJob | null> {
  if (!store) return null;
  const jobId = decodeSecret(await store.get(DELETION_JOB_KEY));
  const statusToken = decodeSecret(await store.get(DELETION_TOKEN_KEY));
  if (!jobId || !statusToken) return null;
  return { jobId, statusToken };
}

async function saveDeletionJob(store: SecureStore, jobId: string, statusToken: string): Promise<void> {
  const encoder = new TextEncoder();
  await store.set(DELETION_JOB_KEY, encoder.encode(jobId));
  await store.set(DELETION_TOKEN_KEY, encoder.encode(statusToken));
}

async function clearDeletionJob(store?: SecureStore): Promise<void> {
  if (!store) return;
  await store.delete(DELETION_JOB_KEY);
  await store.delete(DELETION_TOKEN_KEY);
}

function decodeSecret(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (value instanceof Uint8Array && value.byteLength > 0) {
    const text = new TextDecoder().decode(value);
    return text.length > 0 ? text : null;
  }
  return null;
}
