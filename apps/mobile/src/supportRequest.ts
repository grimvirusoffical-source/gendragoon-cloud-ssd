/**
 * Avery's path. The status token is the only credential, and the body is empty.
 * Core will add `requestDeletionSupport()` against Riley's fixtures.
 * Swap the fetch inside `requestDeletionSupport` for that export when it lands.
 */
export const DELETION_SUPPORT_REQUEST_PATH = "/v2/account/deletions/:jobId/support-request";

export const SUPPORT_REQUEST_SENT = "Request sent. We'll finish deleting your account.";
export const SUPPORT_REQUEST_ALREADY = "Request already sent. We'll be in touch.";

export type DeletionSupportRequestResult =
  | { kind: "sent"; requestId: string }
  | { kind: "refresh" }
  | { kind: "already" }
  | { kind: "fallback" };

export function deletionSupportRequestPath(jobId: string): string {
  return DELETION_SUPPORT_REQUEST_PATH.replace(":jobId", encodeURIComponent(jobId));
}

/**
 * Provisional call. A 202 `{status:"received", requestId}` is success, including
 * a repeat of the same requestId. 409 `support_not_needed` means the job is not
 * failed, so the caller refreshes deletion status. 429 is already sent.
 * A network error, HTTP 404, or HTTP 5xx falls back to the support contact.
 * 404 must not ask the user to sign in: the account may already be deleted.
 * Only 202, a repeat send, 409, and 429 have their own UI.
 */
export async function requestDeletionSupport(input: {
  baseUrl: string;
  jobId: string;
  statusToken: string;
  fetchImpl?: typeof fetch;
}): Promise<DeletionSupportRequestResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = new URL(deletionSupportRequestPath(input.jobId), input.baseUrl).toString();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${input.statusToken}` },
    });
  } catch {
    return { kind: "fallback" };
  }
  if (response.status >= 500) return { kind: "fallback" };
  if (response.status === 429) return { kind: "already" };
  if (response.status === 409) {
    const body = await readJson(response);
    return body.error === "support_not_needed" ? { kind: "refresh" } : { kind: "fallback" };
  }
  if (response.status === 202) {
    const body = await readJson(response);
    if (body.status === "received" && typeof body.requestId === "string" && body.requestId.length > 0) {
      return { kind: "sent", requestId: body.requestId };
    }
  }
  return { kind: "fallback" };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
