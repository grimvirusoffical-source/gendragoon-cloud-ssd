import {
  accountUidFromIdToken,
  deleteAccountAndWipe,
  deletionAuthFailure,
  dismissAccountDeletion,
  type GenDragoonClient,
  type SecretStore,
} from "@gendragoon/core";

/** Same SecureStore as core's deletion job. The uid is the account that started it. */
const DELETION_UID_KEY = "account-deletion:uid";
const DELETION_JOB_KEY = "account-deletion:job-id";

/**
 * Account deletion is core's deleteAccountAndWipe. The Expo SecretStore is
 * both the workspace-key store and the deletion job store.
 */
export async function deleteSignedInAccount(input: {
  client: Pick<GenDragoonClient, "deleteAccount" | "deletionStatus">;
  idToken: string;
  workspaceIds: readonly string[];
  secrets: SecretStore;
}) {
  const uid = accountUidFromIdToken(input.idToken);
  if (uid) await input.secrets.set(DELETION_UID_KEY, new TextEncoder().encode(uid));
  try {
    const status = await deleteAccountAndWipe({
      client: input.client,
      reauthenticatedAt: "",
      idToken: input.idToken,
      workspaceIds: input.workspaceIds,
      secrets: input.secrets,
      secureStore: input.secrets,
    });
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
