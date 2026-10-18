import { GenDragoonClient } from "@gendragoon/core";

/**
 * Core can register, challenge, and verify `{presignedUrl}`.
 * It does not yet write the challenge object with SigV4. Until that write
 * exists, BYO stays hidden and this function refuses to run.
 */
export function byoServerFlowReady(): boolean {
  const client = GenDragoonClient.prototype as unknown as {
    registerByo?: unknown;
    createByoChallenge?: unknown;
    verifyByo?: unknown;
    writeByoChallengeObject?: unknown;
  };
  return typeof client.registerByo === "function"
    && typeof client.createByoChallenge === "function"
    && typeof client.verifyByo === "function"
    && typeof client.writeByoChallengeObject === "function";
}

/** Register, challenge, then verify. The presigned URL is produced on the device. */
export async function connectBucket(input: {
  client: Pick<GenDragoonClient, "registerByo" | "createByoChallenge" | "verifyByo">;
  workspaceId: string;
  registration: { provider: string; endpoint: string; bucketFingerprint: string };
  presignedUrl: string;
}): Promise<{ nonce: string }> {
  if (!byoServerFlowReady()) {
    throw new Error("Bring-your-own storage is unavailable until the challenge object can be written.");
  }
  await input.client.registerByo(input.workspaceId, input.registration);
  const challenge = await input.client.createByoChallenge(input.workspaceId);
  await input.client.verifyByo(input.workspaceId, { presignedUrl: input.presignedUrl });
  return { nonce: challenge.nonce };
}
