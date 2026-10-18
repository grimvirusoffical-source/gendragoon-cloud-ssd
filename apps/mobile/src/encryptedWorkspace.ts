import {
  openWorkspaceKey,
  storageOperations,
  type GenDragoonClient,
  type SecretStore,
} from "@gendragoon/core";

/**
 * Create a workspace key and store its envelope.
 * Core saves the new key before the server accepts the PUT. A 409
 * `envelope_exists` must instead drop that key and use the fetched one.
 * That recovery belongs in core; this wrapper does not add it.
 */
export async function createEncryptedWorkspace(input: {
  client: Pick<GenDragoonClient, "putKeyEnvelope">;
  secrets: SecretStore;
  workspaceId: string;
  passphrase: string;
}): Promise<Uint8Array> {
  const opened = await openWorkspaceKey({
    store: input.secrets,
    workspaceId: input.workspaceId,
    passphrase: input.passphrase,
    create: true,
  });
  if (!opened.key || !opened.envelope) {
    throw new Error("Encrypted workspace setup needs a passphrase");
  }
  await input.client.putKeyEnvelope(input.workspaceId, opened.envelope);
  return opened.key;
}

/**
 * Core's upload request, which does not yet send ifGeneration or delete the
 * previous object only after the manifest commit.
 */
export function encryptedReplaceRequests(input: { oid: string; sizeBytes: number }): unknown[] {
  return [
    storageOperations({ intent: "upload", oid: input.oid, sizeBytes: input.sizeBytes, locked: false }),
  ];
}
