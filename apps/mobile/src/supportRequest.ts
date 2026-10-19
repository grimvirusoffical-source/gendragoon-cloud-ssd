/**
 * Avery's path. Core `requestDeletionSupport` posts here with the saved status
 * token and no body. `DELETION_SUPPORT_ENDPOINT_ENABLED` stays false until
 * production has the webhook.
 */
export const DELETION_SUPPORT_REQUEST_PATH = "/v2/account/deletions/:jobId/support-request";

export const SUPPORT_REQUEST_SENT = "Request sent. We'll finish deleting your account.";
export const SUPPORT_REQUEST_ALREADY = "Request already sent. We'll be in touch.";

export function deletionSupportRequestPath(jobId: string): string {
  return DELETION_SUPPORT_REQUEST_PATH.replace(":jobId", encodeURIComponent(jobId));
}
