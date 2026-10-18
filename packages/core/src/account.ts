import { AccountDeletedError, ApiError, DeletionNotFoundError, ReauthRequiredError, WorkspaceLockedError, isInvalidToken } from "./api/errors.js";
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
const DELETION_RECOVERY_KEY = "account-deletion:needs-token-recovery";

/** Shell hook while a deletion poll is still running. */
export type DeletionAuthSignal = "signed_out" | "reauth_required";

function deletionContinues(status: string | undefined): boolean {
  return status === "queued" || status === "running";
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
 * Local keys are removed only after `done`. The saved job is cleared only
 * after `done` or `dismissDeletion`. `failed` keeps the job and does not wipe.
 * A statusToken poll that returns `invalid_token` stops, keeps the job, and
 * signals `reauth_required`. A Firebase-token poll that returns `invalid_token`
 * signals `signed_out`, keeps the job, and continues with the saved statusToken.
 * DELETE is sent again only by `retryDeletion` (failed + retryable) and by
 * this function after sign-in when the saved status token was rejected or the
 * status poll returned 404.
 */
export async function deleteAccountAndWipe(input: DeletionRunInput): Promise<AccountDeletionStatus> {
  const saved = await loadDeletionJob(input.secureStore);
  const recover = await loadRecovery(input.secureStore);
  let job: DeletionJob;
  let credential: PollCredential = "status";
  if (!saved) {
    job = await startDeletion(input).catch(async (error: unknown) => {
      if (isInvalidToken(error)) {
        await input.onAuthFailure?.("signed_out", error);
        await input.clearSession?.();
      }
      throw error;
    });
  } else if (recover || !input.onAuthFailure) {
    // Sign-in recovery: the status token was rejected or the status was 404,
    // or the caller is repeating DELETE after signing in.
    const fresh = await startDeletion(input).catch(async (error: unknown) => {
      if (isInvalidToken(error)) {
        await input.onAuthFailure?.("signed_out", error);
        await input.clearSession?.();
      }
      throw error;
    });
    if (fresh.jobId !== saved.jobId) {
      throw new ApiError(409, "DELETION_JOB_MISMATCH", "The server did not resume the saved deletion job");
    }
    if (!fresh.statusToken) {
      throw new ApiError(502, "DELETION_UNCONFIRMED", "Account deletion did not return a status token");
    }
    job = { jobId: saved.jobId, statusToken: fresh.statusToken };
    await clearRecovery(input.secureStore);
  } else {
    job = saved;
    credential = "firebase";
  }
  if (input.secureStore && job.statusToken) {
    await saveDeletionJob(input.secureStore, job.jobId, job.statusToken);
  }
  return pollDeletion({
    ...pollInput(input),
    client: input.client,
    job,
    credential,
  });
}

/**
 * Repeat DELETE for a saved job that failed with `retryable: true`.
 * HTTP 202 keeps the same job id, stores the new statusToken, and resumes polling.
 * HTTP 409 `deletion_not_retryable` keeps the saved job and does not wipe.
 */
export async function retryDeletion(input: DeletionRunInput): Promise<AccountDeletionStatus> {
  const saved = await loadDeletionJob(input.secureStore);
  if (!saved?.statusToken || !input.secureStore) {
    throw new ApiError(409, "DELETION_JOB_MISSING", "There is no saved account deletion to retry");
  }
  const fresh = await startDeletion(input);
  if (fresh.jobId !== saved.jobId) {
    throw new ApiError(409, "DELETION_JOB_MISMATCH", "The server did not resume the saved deletion job");
  }
  if (!fresh.statusToken) {
    throw new ApiError(502, "DELETION_UNCONFIRMED", "Account deletion did not return a status token");
  }
  const job = { jobId: saved.jobId, statusToken: fresh.statusToken };
  await saveDeletionJob(input.secureStore, job.jobId, job.statusToken);
  return pollDeletion({
    ...pollInput(input),
    client: input.client,
    job,
    credential: "status",
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
  clearSession?: () => Promise<void> | void;
  onAuthFailure?: (signal: DeletionAuthSignal, error: unknown) => void;
}): Promise<AccountDeletionStatus | null> {
  const saved = await loadDeletionJob(input.secureStore);
  if (!saved?.statusToken) return null;
  return pollDeletion({
    ...pollInput(input),
    client: input.client,
    job: saved,
    credential: "status",
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

type PollCredential = "firebase" | "status";

interface DeletionRunInput {
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
  /** Clears the Firebase session only. The saved deletion job stays. */
  clearSession?: () => Promise<void> | void;
  /** Called without aborting the poll. `signed_out` continues with the statusToken. */
  onAuthFailure?: (signal: DeletionAuthSignal, error: unknown) => void;
}

function pollInput(input: DeletionRunInput | {
  workspaceIds: readonly string[];
  secrets: SecretStore;
  secureStore?: SecureStore;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  backoffMs?: readonly number[];
  clearSession?: () => Promise<void> | void;
  onAuthFailure?: (signal: DeletionAuthSignal, error: unknown) => void;
}): Omit<Parameters<typeof pollDeletion>[0], "client" | "job" | "credential"> {
  return {
    workspaceIds: input.workspaceIds,
    secrets: input.secrets,
    secureStore: input.secureStore,
    sleep: input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    timeoutMs: input.timeoutMs ?? DELETION_TIMEOUT_MS,
    backoffMs: input.backoffMs ?? DELETION_BACKOFF_MS,
    clearSession: input.clearSession,
    onAuthFailure: input.onAuthFailure,
  };
}

async function pollDeletion(input: {
  client: {
    deletionStatus(jobId: string, statusToken?: string): Promise<AccountDeletionStatus>;
  };
  job: DeletionJob;
  credential: PollCredential;
  workspaceIds: readonly string[];
  secrets: SecretStore;
  secureStore?: SecureStore;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  backoffMs: readonly number[];
  clearSession?: () => Promise<void> | void;
  onAuthFailure?: (signal: DeletionAuthSignal, error: unknown) => void;
}): Promise<AccountDeletionStatus> {
  let waited = 0;
  let attempt = 0;
  let credential = input.credential;
  let switchedToStatus = false;
  let latest: AccountDeletionStatus | undefined;
  for (;;) {
    try {
      const useStatus = credential === "status" && !!input.job.statusToken;
      latest = useStatus
        ? await input.client.deletionStatus(input.job.jobId, input.job.statusToken)
        : await input.client.deletionStatus(input.job.jobId);
    } catch (error) {
      latest = undefined;
      if (error instanceof ApiError && error.status === 404) {
        await markRecovery(input.secureStore);
        throw new DeletionNotFoundError();
      }
      const statusRejected = credential === "status" && (isInvalidToken(error) || error instanceof ReauthRequiredError);
      if (statusRejected) {
        await markRecovery(input.secureStore);
        const reauth = error instanceof ReauthRequiredError ? error : new ReauthRequiredError();
        await input.onAuthFailure?.("reauth_required", reauth);
        throw reauth;
      }
      if (isInvalidToken(error)) {
        await input.onAuthFailure?.("signed_out", error);
        await input.clearSession?.();
        if (input.job.statusToken && !switchedToStatus) {
          credential = "status";
          switchedToStatus = true;
          continue;
        }
        throw error;
      }
      throw error;
    }
    if (latest && (latest.status === "done" || latest.status === "failed")) break;
    if (latest && !deletionContinues(latest.status)) {
      throw new ApiError(409, "DELETION_STATUS_UNKNOWN", "Account deletion status is not recognized");
    }
    const wait = input.backoffMs[Math.min(attempt, input.backoffMs.length - 1)] ?? input.backoffMs[input.backoffMs.length - 1] ?? 8000;
    attempt += 1;
    if (waited + wait > input.timeoutMs) {
      throw new ApiError(504, "DELETION_TIMEOUT", "Account deletion did not finish before the timeout");
    }
    await input.sleep(wait);
    waited += wait;
  }
  if (!latest) throw new ApiError(504, "DELETION_TIMEOUT", "Account deletion did not finish before the timeout");
  if (latest.status === "done") {
    await wipeWorkspaceKeys(input.secrets, input.workspaceIds);
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
  await store.delete(DELETION_RECOVERY_KEY);
}

async function markRecovery(store?: SecureStore): Promise<void> {
  if (!store) return;
  await store.set(DELETION_RECOVERY_KEY, new TextEncoder().encode("1"));
}

async function clearRecovery(store?: SecureStore): Promise<void> {
  if (!store) return;
  await store.delete(DELETION_RECOVERY_KEY);
}

async function loadRecovery(store?: SecureStore): Promise<boolean> {
  if (!store) return false;
  return decodeSecret(await store.get(DELETION_RECOVERY_KEY)) !== null;
}

/**
 * Forget a saved deletion job without wiping workspace keys or BYO secrets.
 * Used when the user dismisses a failed or retryable deletion.
 */
export async function dismissDeletion(store: SecureStore): Promise<void> {
  await clearDeletionJob(store);
}

/** Same as `dismissDeletion`. */
export async function dismissAccountDeletion(store: SecureStore): Promise<void> {
  await dismissDeletion(store);
}

function decodeSecret(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (value instanceof Uint8Array && value.byteLength > 0) {
    const text = new TextDecoder().decode(value);
    return text.length > 0 ? text : null;
  }
  return null;
}
