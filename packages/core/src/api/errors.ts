export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * HTTP 423 { code: "workspace_lock" } on a write while the account is over
 * the cap or unpaid. Reads and deletes do not use this error.
 */
export class WorkspaceLockedError extends ApiError {
  constructor() {
    super(423, "workspace_lock", "Workspace is locked");
    this.name = "WorkspaceLockedError";
  }
}

/** HTTP 401 `reauth_required`. The last sign-in is older than five minutes. */
export class ReauthRequiredError extends ApiError {
  constructor() {
    super(401, "reauth_required", "Sign in again. Your last sign-in is older than 5 minutes.");
    this.name = "ReauthRequiredError";
  }
}

export function isReauthRequired(error: unknown): error is ReauthRequiredError {
  if (error instanceof ReauthRequiredError) return true;
  return error instanceof ApiError && error.status === 401 && error.code === "reauth_required";
}

/** HTTP 401 `invalid_token`. The session cannot be used. Local keys stay. */
export class InvalidTokenError extends ApiError {
  constructor() {
    super(401, "invalid_token", "This session is no longer valid. Sign in again.");
    this.name = "InvalidTokenError";
  }
}

export function isInvalidToken(error: unknown): error is InvalidTokenError {
  if (error instanceof InvalidTokenError) return true;
  return error instanceof ApiError && error.status === 401 && error.code === "invalid_token";
}

/** What the shell does with a 401 from account deletion. Keys are not wiped. */
export function deletionAuthFailure(error: unknown): "reauth" | "sign-out" | null {
  if (isReauthRequired(error)) return "reauth";
  if (isInvalidToken(error)) return "sign-out";
  return null;
}

/**
 * HTTP 410 `account_deleted` on a repeat DELETE /v2/account.
 * The body carries the in-flight job id. Receiving this status does not wipe local keys.
 */
export class AccountDeletedError extends ApiError {
  readonly jobId: string;

  constructor(jobId: string) {
    super(410, "account_deleted", "This account is already deleted.");
    this.name = "AccountDeletedError";
    this.jobId = jobId;
  }
}

export function isAccountDeleted(error: unknown): error is AccountDeletedError {
  return error instanceof AccountDeletedError && error.jobId.length > 0;
}
