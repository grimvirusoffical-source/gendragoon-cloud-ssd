import {
  accountUidFromIdToken,
  deleteAccountAndWipe,
  deletionAuthFailure,
  dismissAccountDeletion,
  type GenDragoonClient,
  type SecretStore,
} from "@gendragoon/core";
import * as coreExports from "@gendragoon/core";

/** Same SecureStore as core's deletion job. The uid is the account that started it. */
const DELETION_UID_KEY = "account-deletion:uid";
const DELETION_JOB_KEY = "account-deletion:job-id";

type DeletionNotRetryableCtor = new (...args: never[]) => Error & { jobId: string };

/**
 * PR #1 exports `DeletionNotRetryableError` (409, carries `jobId`).
 * Until that class exists, a 409 stays a plain `ApiError` and this is null.
 */
export function isDeletionNotRetryableError(error: unknown): error is Error & { jobId: string } {
  const ctor = (coreExports as { DeletionNotRetryableError?: DeletionNotRetryableCtor }).DeletionNotRetryableError;
  if (typeof ctor !== "function" || !(error instanceof ctor)) return false;
  return typeof error.jobId === "string" && error.jobId.length > 0;
}

/**
 * PR #1 calls `onAuthFailure(signal, error)` and does not throw for these.
 * `signed_out` carries `InvalidTokenError` from a Firebase-token `invalid_token`:
 * clear only the session and leave the progress screen polling.
 * `reauth_required` is the status-token safety net: show re-sign-in and keep the job.
 * Unknown signals are ignored until that hook lands.
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

export function clientRetriesDeletion(client: object): client is { retryDeletion: () => Promise<unknown> } {
  return typeof (client as { retryDeletion?: unknown }).retryDeletion === "function";
}

export async function deleteSignedInAccount(input: {
  client: Pick<GenDragoonClient, "deleteAccount" | "deletionStatus">;
  idToken: string;
  workspaceIds: readonly string[];
  secrets: SecretStore;
  /** Forwarded to core once PR #1 reads `onAuthFailure` during polling. */
  onAuthFailure?: (signal: string, error: unknown) => void;
}) {
  const uid = accountUidFromIdToken(input.idToken);
  if (uid) await input.secrets.set(DELETION_UID_KEY, new TextEncoder().encode(uid));
  try {
    const request: Parameters<typeof deleteAccountAndWipe>[0] = {
      client: input.client,
      reauthenticatedAt: "",
      idToken: input.idToken,
      workspaceIds: input.workspaceIds,
      secrets: input.secrets,
      secureStore: input.secrets,
    };
    if (input.onAuthFailure) Object.assign(request, { onAuthFailure: input.onAuthFailure });
    const status = await deleteAccountAndWipe(request);
    if (status.status === "done") {
      await input.secrets.delete(DELETION_UID_KEY);
    }
    return status;
  } catch (error) {
    const job = await input.secrets.get(DELETION_JOB_KEY);
    // invalid_token clears the session only. The uid stays with any saved job.
    if (deletionSessionAction(error) !== "sign-out" && (!job || job.byteLength === 0)) {
      await input.secrets.delete(DELETION_UID_KEY);
    }
    throw error;
  }
}

export async function dismissSignedInDeletion(secrets: SecretStore): Promise<void> {
  await dismissAccountDeletion(secrets);
  await secrets.delete(DELETION_UID_KEY);
}

export async function savedDeletionUid(secrets: SecretStore): Promise<string | null> {
  const bytes = await secrets.get(DELETION_UID_KEY);
  if (!bytes || bytes.byteLength === 0) return null;
  const text = new TextDecoder().decode(bytes);
  return text.length > 0 ? text : null;
}

export function deletionSessionAction(error: unknown): "reauth" | "sign-out" | null {
  return deletionAuthFailure(error);
}
