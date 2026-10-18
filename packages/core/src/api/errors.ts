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
