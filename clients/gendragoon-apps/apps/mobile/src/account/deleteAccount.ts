import {
  DELETION_UID_KEY,
  DeletionNotRetryableError,
  accountUidFromIdToken,
  deleteAccountAndWipe,
  deletionAuthFailure,
  dismissAccountDeletion,
  readDeletionUid,
  resumeAccountDeletion,
  retryDeletion,
  type DeletionAuthSignal,
  type GenDragoonClient,
  type SecretStore,
} from "@gendragoon/core";

/** The uid key (`DELETION_UID_KEY`) is owned by core and written by it with the job; mobile also writes it before DELETE so a crash mid-request still has it. */
const DELETION_JOB_KEY = "account-deletion:job-id";
const DELETION_TOKEN_KEY = "account-deletion:status-token";

type DeletionClient = Pick<GenDragoonClient, "deleteAccount" | "deletionStatus">;

export interface SignedInDeletionInput {
  client: DeletionClient;
  idToken: string;
  workspaceIds: readonly string[];
  secrets: SecretStore;
  onAuthFailure?: (signal: DeletionAuthSignal, error: unknown) => void;
  /** Clears the Firebase session only. Core keeps the saved job. */
  clearSession?: () => Promise<void> | void;
}

export function isDeletionNotRetryableError(error: unknown): error is DeletionNotRetryableError {
  return error instanceof DeletionNotRetryableError;
}

/**
 * `signed_out` clears only the session. Polling continues on the status token.
 * `reauth_required` shows re-sign-in and leaves the job in place.
 */
export function applyAuthFailureSignal(
  signal: string,
  _error: unknown,
  actions: { clearSession: () => void; showReauth: () => void },
): void {
  if (signal === "signed_out") {
    actions.clearSession();
    return;
  }
  if (signal === "reauth_required") actions.showReauth();
}

export function signedInDeletionRun(input: SignedInDeletionInput) {
  return {
    client: input.client,
    reauthenticatedAt: "",
    idToken: input.idToken,
    workspaceIds: input.workspaceIds,
    secrets: input.secrets,
    secureStore: input.secrets,
    onAuthFailure: input.onAuthFailure,
    clearSession: input.clearSession,
  };
}

export async function deleteSignedInAccount(input: SignedInDeletionInput) {
  const uid = accountUidFromIdToken(input.idToken);
  if (uid) await input.secrets.set(DELETION_UID_KEY, new TextEncoder().encode(uid));
  try {
    const status = await deleteAccountAndWipe(signedInDeletionRun(input));
    if (status.status === "done") {
      await input.secrets.delete(DELETION_UID_KEY);
    }
    return status;
  } catch (error) {
    if (isDeletionNotRetryableError(error) && error.jobId.length > 0) {
      await input.secrets.set(DELETION_JOB_KEY, new TextEncoder().encode(error.jobId));
    }
    const job = await input.secrets.get(DELETION_JOB_KEY);
    if (deletionSessionAction(error) !== "sign-out" && (!job || job.byteLength === 0)) {
      await input.secrets.delete(DELETION_UID_KEY);
    }
    throw error;
  }
}

/** Repeat DELETE for a saved job that failed with `retryable: true`. */
export function retrySignedInDeletion(input: SignedInDeletionInput) {
  return retryDeletion(signedInDeletionRun(input));
}

/** Poll the saved status token. Does not send DELETE. */
export function resumeSignedInDeletion(input: SignedInDeletionInput) {
  return resumeAccountDeletion({
    client: input.client,
    workspaceIds: input.workspaceIds,
    secrets: input.secrets,
    secureStore: input.secrets,
    onAuthFailure: input.onAuthFailure,
    clearSession: input.clearSession,
  });
}

export async function dismissSignedInDeletion(secrets: SecretStore): Promise<void> {
  await dismissAccountDeletion(secrets);
  await secrets.delete(DELETION_UID_KEY);
}

export async function savedDeletionUid(secrets: SecretStore): Promise<string | null> {
  return readDeletionUid(secrets);
}

export async function savedDeletionStatusToken(secrets: SecretStore): Promise<string | null> {
  return readSecret(secrets, DELETION_TOKEN_KEY);
}

export function deletionSessionAction(error: unknown): "reauth" | "sign-out" | null {
  return deletionAuthFailure(error);
}

async function readSecret(secrets: SecretStore, name: string): Promise<string | null> {
  const bytes = await secrets.get(name);
  if (!bytes || bytes.byteLength === 0) return null;
  const text = new TextDecoder().decode(bytes);
  return text.length > 0 ? text : null;
}
