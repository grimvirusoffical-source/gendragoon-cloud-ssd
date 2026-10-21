import type { LockAssessment, WorkspaceLockedError, WorkspaceRecord } from "@gendragoon/core";
import { planMerge, planSummary } from "@gendragoon/core";
import { useMemo, useState } from "react";

const LOCK_REASON: Record<string, string> = {
  over_cap: "This account is over the workspace cap.",
  lapsed: "A workspace payment has lapsed.",
  over_cap_and_lapsed: "This account is over the cap and a workspace payment has lapsed.",
  scope_unavailable: "Workspace scope is unavailable.",
  merge_in_progress: "A merge is in progress.",
};

export function LockScreen(props: {
  assessment: LockAssessment;
  workspaces: WorkspaceRecord[];
  onDelete: (id: string) => void;
  /** HTTP 423 body from a workspace-lock fixture: reason, overBy, unpaidWorkspaceIds. */
  lock?: WorkspaceLockedError;
}) {
  const active = props.workspaces.filter((workspace) => workspace.projectStatus !== "archived");
  const [sourceId, setSourceId] = useState(active[1]?.id ?? active[0]?.id ?? "");
  const [targetId, setTargetId] = useState(active[0]?.id ?? "");
  const preview = useMemo(() => {
    if (!sourceId || !targetId || sourceId === targetId) return [];
    const source = active.find((workspace) => workspace.id === sourceId);
    return planMerge(
      [{ path: "Photos/cat.jpg" }, { path: "Notes/todo.txt" }],
      source?.name ?? "source",
      ["Photos/cat.jpg"],
    );
  }, [active, sourceId, targetId]);
  const plan = planSummary(props.assessment);
  const paidThrough = plan.lifetime
    ? "Lifetime"
    : plan.paidThroughMs !== undefined
      ? `Paid through ${new Date(plan.paidThroughMs).toISOString().slice(0, 10)}`
      : null;

  return (
    <section data-testid="lock-screen">
      <header className="topbar">
        <div>
          <div className="kicker"><span className="dot warn" /> SIGNED IN</div>
          <h2>Resolve workspaces to continue</h2>
          <p className="sub">
            {plan.locked && props.assessment.overCap
              ? `This account is over the ${plan.limit} workspace cap (${plan.used} active).`
              : `Cap is ${plan.limit}.`}
            {props.assessment.unpaidIds.length > 0
              ? ` ${props.assessment.unpaidIds.length} workspace${props.assessment.unpaidIds.length === 1 ? "" : "s"} unpaid.`
              : ""}
            {" "}Downloads stay available. Uploads and normal use stay blocked until you delete or merge down to the cap.
            {paidThrough ? ` ${paidThrough}.` : ""}
            {plan.renewsAtMs !== undefined ? ` Renews ${new Date(plan.renewsAtMs).toISOString().slice(0, 10)}.` : ""}
          </p>
        </div>
      </header>
      {props.lock?.reason ? (
        <div
          className="banner"
          data-testid="lock-detail"
          data-reason={props.lock.reason}
          data-over-by={String(props.lock.overBy)}
        >
          <p>{LOCK_REASON[props.lock.reason] ?? props.lock.reason} Over by {props.lock.overBy}.</p>
          {props.lock.unpaidWorkspaceIds.length > 0 ? (
            <ul data-testid="unpaid-workspaces">
              {props.lock.unpaidWorkspaceIds.map((id) => <li key={id}>{id}</li>)}
            </ul>
          ) : (
            <p data-testid="unpaid-workspaces">No unpaid workspaces.</p>
          )}
        </div>
      ) : null}
      {props.assessment.locked ? (
        <div className="banner" data-testid="lock-banner">
          The server enforces this lock. Deleting or merging here is a request, not local permission.
        </div>
      ) : null}
      <div className="lock-grid">
        <div className="panel">
          {active.map((workspace) => {
            const unpaid = props.assessment.unpaidIds.includes(workspace.id);
            return (
              <div className="workspace-row" key={workspace.id}>
                <div>
                  <strong>{workspace.name}</strong>
                  <div className="sub">{unpaid ? "Unpaid" : workspace.kind}</div>
                </div>
                <span className="kind">{workspace.kind}</span>
                <button type="button" className="btn-danger" data-testid={`delete-${workspace.id}`} onClick={() => props.onDelete(workspace.id)}>
                  Delete
                </button>
              </div>
            );
          })}
        </div>
        <div className="panel stack">
          <strong>Merge</strong>
          <p className="help">Files move into the target. A duplicate incoming path is renamed to “name (from source)”. Nothing is overwritten, and the source is removed only after every copy verifies.</p>
          <label className="field">Source
            <select data-testid="merge-source" value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
              {active.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
            </select>
          </label>
          <label className="field">Target
            <select data-testid="merge-target" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              {active.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
            </select>
          </label>
          <div className="preview" data-testid="merge-preview">
            {preview.length === 0 ? "Choose two different workspaces." : preview.map((entry) => (
              <div key={entry.sourcePath}>{entry.sourcePath} → {entry.targetPath}</div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
