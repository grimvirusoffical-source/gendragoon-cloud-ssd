import {
  deleteAccountAndWipe,
  deletionAuthFailure,
  type GenDragoonClient,
  type SecretStore,
} from "@gendragoon/core";

/**
 * Account deletion is core's deleteAccountAndWipe: confirm body, plural
 * polling, 410 handling, and the auth_time check. This function only
 * forwards the Expo SecretStore.
 */
export function deleteSignedInAccount(input: {
  client: Pick<GenDragoonClient, "deleteAccount" | "deletionStatus">;
  idToken: string;
  workspaceIds: readonly string[];
  secrets: SecretStore;
}) {
  return deleteAccountAndWipe({
    client: input.client,
    reauthenticatedAt: "",
    idToken: input.idToken,
    workspaceIds: input.workspaceIds,
    secrets: input.secrets,
  });
}

export function deletionSessionAction(error: unknown): "reauth" | "sign-out" | null {
  return deletionAuthFailure(error);
}
