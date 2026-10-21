/**
 * Avery's path. Core `requestDeletionSupport` posts here with the saved status
 * token and no body. `DELETION_SUPPORT_ENDPOINT_ENABLED` stays false until
 * production has the webhook.
 */
export const DELETION_SUPPORT_REQUEST_PATH = "/v2/account/deletions/:jobId/support-request";

export const SUPPORT_REQUEST_SENT = "Request sent. We'll finish deleting your account.";
export const SUPPORT_REQUEST_ALREADY = "Request already sent. We'll be in touch.";
/** A 409 `support_not_needed` whose refreshed status is still queued or running. */
export const SUPPORT_DELETION_STILL_RUNNING = "Your deletion is still in progress.";

export function deletionSupportRequestPath(jobId: string): string {
  return DELETION_SUPPORT_REQUEST_PATH.replace(":jobId", encodeURIComponent(jobId));
}
