import { WorkspaceLockedError, accountFromAssessment, applyApiFailure, type LockAssessment } from "@gendragoon/core";

/** HTTP 409 `workspace_busy`. The workspace stays in the list. */
export const WORKSPACE_BUSY_MESSAGE =
  "This workspace is busy (upload, merge or checkout in progress). Try again when it finishes.";

export function isWorkspaceBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { status?: number; code?: string; error?: string };
  const code = typeof record.code === "string" ? record.code : record.error;
  return record.status === 409 && code === "workspace_busy";
}

/** Server `projectStatus: "deleting"`. Not on the core union until that state ships. */
export function isDeletingWorkspace(workspace: { projectStatus?: string | null }): boolean {
  return workspace.projectStatus === "deleting";
}

/**
 * Non-blocking grace copy. The date is the server `graceEndsAt`, formatted in
 * the device's own time zone so it is never a day later than the real deadline.
 */
export function graceBanner(payByMs: number, timeZone?: string): string {
  const date = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(payByMs));
  return `Payment due, pay by ${date} to keep using this workspace.`;
}

/**
 * Unpaid and lapsed workspaces lock only themselves.
 * An over-cap account still uses the account lock screen.
 */
export function locksThisWorkspaceOnly(
  access: { overCap: boolean; unpaidIds: readonly string[]; lapsedIds: readonly string[] },
  workspaceId: string,
): boolean {
  if (access.overCap) return false;
  return access.unpaidIds.includes(workspaceId) || access.lapsedIds.includes(workspaceId);
}

/** Whole-app lock. A lapsed workspace (`reason: "unpaid"`) does not qualify. */
export function accountLockCoversApp(
  assessment: Pick<LockAssessment, "locked" | "overCap" | "unpaidIds">,
): boolean {
  const state = accountFromAssessment(assessment);
  return state.phase === "delete_or_merge" && state.reason !== "unpaid";
}

/**
 * A lapsed 423 records that workspace and leaves the rest of the account usable.
 * Over-cap, scope, and merge locks still lock the account.
 */
export function noteWorkspaceLock(error: unknown, access: LockAssessment): LockAssessment {
  if (error instanceof WorkspaceLockedError) {
    const accountWide = error.reason === "over_cap"
      || error.reason === "over_cap_and_lapsed"
      || error.reason === "scope_unavailable"
      || error.reason === "merge_in_progress"
      || error.overBy > 0;
    if (!accountWide && (error.reason === "lapsed" || error.unpaidWorkspaceIds.length > 0)) {
      const ids = error.unpaidWorkspaceIds;
      return {
        ...access,
        unpaidIds: [...new Set([...access.unpaidIds, ...ids])],
        lapsedIds: [...new Set([...access.lapsedIds, ...ids])],
      };
    }
  }
  const next = applyApiFailure(accountFromAssessment(access), error);
  if (next.phase !== "delete_or_merge") return access;
  const overCap = error instanceof WorkspaceLockedError
    && (error.reason === "over_cap" || error.reason === "over_cap_and_lapsed" || error.overBy > 0);
  return {
    ...access,
    locked: true,
    overCap: overCap || access.overCap,
    uploadsBlocked: true,
    normalUseBlocked: true,
    unpaidIds: error instanceof WorkspaceLockedError
      ? [...new Set([...access.unpaidIds, ...error.unpaidWorkspaceIds])]
      : access.unpaidIds,
  };
}
