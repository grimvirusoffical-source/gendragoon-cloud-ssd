import { GenDragoonClient } from "@gendragoon/core";

/**
 * The server flow is register, a null-body challenge, a device SigV4 write
 * of `.gendragoon-challenge/<nonce>`, then verify `{presignedUrl}`.
 * Core still posts `{challengeId, presignedGetUrl}` to `/byo/proof` and has
 * no register or verify method. Until those exist, BYO stays hidden.
 * Credentials are not stored on the device in place of that flow.
 */
export function byoServerFlowReady(): boolean {
  const client = GenDragoonClient.prototype as unknown as {
    registerByo?: unknown;
    verifyByo?: unknown;
  };
  return typeof client.registerByo === "function" && typeof client.verifyByo === "function";
}
