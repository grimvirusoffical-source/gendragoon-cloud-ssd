import type { ReactNode } from "react";
import {
  isWorkspaceLockError,
  type AccountPhase,
  type LockAssessment,
  type WorkspaceRecord,
} from "@gendragoon/core";
import { LockScreen } from "./LockScreen.js";

/**
 * A workspace_lock failure renders the delete-or-merge screen.
 * Other failures stay a banner. The lock is not a generic error string.
 */
export function AccountSurface(props: {
  phase: AccountPhase;
  error?: unknown;
  assessment: LockAssessment;
  workspaces: WorkspaceRecord[];
  onDelete: (id: string) => void;
  children: ReactNode;
}) {
  if (props.phase === "delete_or_merge" || isWorkspaceLockError(props.error)) {
    const assessment: LockAssessment = props.assessment.locked
      ? props.assessment
      : { ...props.assessment, locked: true, uploadsBlocked: true, normalUseBlocked: true };
    const lock = isWorkspaceLockError(props.error) ? props.error : undefined;
    return (
      <>
        {lock ? (
          <div className="banner" data-testid="lock-from-server">
            Uploads are paused. Delete or merge workspaces to continue. Downloads still work.
          </div>
        ) : null}
        <LockScreen assessment={assessment} workspaces={props.workspaces} onDelete={props.onDelete} lock={lock} />
      </>
    );
  }
  const message = props.error instanceof Error ? props.error.message : null;
  return (
    <>
      {message ? (
        <div className="banner" role="alert" data-testid="generic-error">{message}</div>
      ) : null}
      {props.children}
    </>
  );
}
