import {
  establishWorkspaceKey,
  replaceEncryptedObject,
  type GenDragoonClient,
  type SecretStore,
} from "@gendragoon/core";

/**
 * Create or adopt the workspace key.
 * `establishWorkspaceKey` stores a new key only after the server accepts the PUT.
 * A 409 `envelope_exists` adopts the fetched envelope instead.
 */
export async function createEncryptedWorkspace(input: {
  client: Pick<GenDragoonClient, "putKeyEnvelope" | "getKeyEnvelope">;
  secrets: SecretStore;
  workspaceId: string;
  passphrase: string;
}): Promise<Uint8Array> {
  const established = await establishWorkspaceKey({
    store: input.secrets,
    workspaceId: input.workspaceId,
    passphrase: input.passphrase,
    put: (envelope) => input.client.putKeyEnvelope(input.workspaceId, envelope),
    get: () => input.client.getKeyEnvelope(input.workspaceId),
  });
  return established.key;
}

/**
 * Four steps: storage URL for the new object, signed PUT of the ciphertext,
 * manifest commit with `ifGeneration` as a decimal string, then delete the old object.
 */
export function replaceEncryptedFile(
  input: Parameters<typeof replaceEncryptedObject>[0],
): ReturnType<typeof replaceEncryptedObject> {
  return replaceEncryptedObject(input);
}
