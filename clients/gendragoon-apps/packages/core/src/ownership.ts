import type { WorkspaceRecord } from "./policy.js";

/**
 * Ownership is the existing accountHash field. The legacy free project uses
 * accountKey. Both are sha256("gd-v1:" + Firebase uid), computed on the
 * server from the verified token. Clients do not send a hash to claim a
 * workspace. There are no shared workspaces or member roles at launch.
 *
 * A different account that requests someone else's id receives 404. The
 * deployed server still answers 403 PROJECT_FORBIDDEN when the document
 * exists and the hash does not match; Riley should collapse that to 404.
 * The client already hides that 403 so the UI cannot reveal existence.
 */
export interface SessionIdentity {
  accountHash?: string;
  accountKey?: string;
}

export function foreignAccount(workspace: WorkspaceRecord, session: SessionIdentity): boolean {
  if (workspace.kind === "free" || workspace.id === "free") {
    return Boolean(workspace.accountKey && session.accountKey && workspace.accountKey !== session.accountKey);
  }
  return Boolean(workspace.accountHash && session.accountHash && workspace.accountHash !== session.accountHash);
}

/** Render filter only. The server list is authoritative. */
export function renderableWorkspaces(
  workspaces: readonly WorkspaceRecord[],
  session: SessionIdentity,
): WorkspaceRecord[] {
  return workspaces.filter((workspace) => !foreignAccount(workspace, session));
}

export interface HttpErrorLike {
  status: number;
  code?: string;
  message?: string;
}

/** Normative status for a workspace this account does not own. */
export function foreignWorkspaceStatus(): 404 {
  return 404;
}

export function hidesWorkspaceExistence(error: HttpErrorLike): boolean {
  return error.status === 404 || error.code === "PROJECT_FORBIDDEN";
}
