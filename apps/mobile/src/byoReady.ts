import {
  GenDragoonClient,
  createSigV4ChallengeWriter,
  performOwnershipChallenge,
  type ByoObjectWriter,
} from "@gendragoon/core";

/**
 * Register, challenge, SigV4 PUT, and verify `{ presignedUrl }` are all present.
 * SFTP, Azure Blob, and WebDAV stay on the coming-soon list.
 */
export function byoServerFlowReady(): boolean {
  const client = GenDragoonClient.prototype as unknown as {
    registerByo?: unknown;
    createByoChallenge?: unknown;
    verifyByo?: unknown;
  };
  return typeof client.registerByo === "function"
    && typeof client.createByoChallenge === "function"
    && typeof client.verifyByo === "function"
    && typeof createSigV4ChallengeWriter === "function"
    && typeof performOwnershipChallenge === "function";
}

/**
 * Register the bucket, write `.gendragoon-challenge/<nonce>` with the device
 * SigV4 writer, then verify `{ presignedUrl }`. No live AWS call is required
 * when the caller supplies the writer.
 */
export async function connectBucket(input: {
  client: Pick<GenDragoonClient, "registerByo" | "createByoChallenge" | "verifyByo">;
  workspaceId: string;
  registration: { provider: string; endpoint: string; bucketFingerprint: string };
  writer: ByoObjectWriter;
  now?: number;
}): Promise<{ presignedUrl: string }> {
  if (!byoServerFlowReady()) {
    throw new Error("Bring-your-own storage is unavailable until the challenge object can be written.");
  }
  await input.client.registerByo(input.workspaceId, input.registration);
  const challenge = await input.client.createByoChallenge(input.workspaceId);
  const proof = await performOwnershipChallenge({
    challengeId: challenge.nonce,
    nonce: challenge.nonce,
    writer: input.writer,
    now: input.now,
  });
  const presignedUrl = proof.presignedGetUrl;
  await input.client.verifyByo(input.workspaceId, { presignedUrl });
  return { presignedUrl };
}
