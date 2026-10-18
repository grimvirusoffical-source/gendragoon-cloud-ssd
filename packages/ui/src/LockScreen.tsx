import type { LockAssessment, WorkspaceRecord } from "@gendragoon/core";
import { planMerge } from "@gendragoon/core";
import { useMemo, useState } from "react";

export function LockScreen(props: {
  assessment: LockAssessment;
  workspaces: WorkspaceRecord[];
  onDelete: (id: string) => void;
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

  return (
    <section data-testid="lock-screen">
      <header className="topbar">
        <div>
          <div className="kicker"><span className="dot warn" /> SIGNED IN</div>
          <h2>Resolve workspaces to continue</h2>
          <p className="sub">
            {props.assessment.overCap
              ? `This account is over the ${props.assessment.cap} workspace cap (${props.assessment.activeCount} active).`
              : `Cap is ${props.assessment.cap}.`}
            {props.assessment.unpaidIds.length > 0
              ? ` ${props.assessment.unpaidIds.length} workspace${props.assessment.unpaidIds.length === 1 ? "" : "s"} unpaid.`
              : ""}
            {" "}Downloads stay available. Uploads and normal use stay blocked until you delete or merge down to the cap.
          </p>
        </div>
      </header>
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
                  <div className="sub">{unpaid ? "Unpaid" : workspace.feeIsOneTime ? "One-time, stays paid" : workspace.kind}</div>
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
