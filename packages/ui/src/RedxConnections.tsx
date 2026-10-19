import { providerQuota, scopeLabel, type ProviderBinding, type ProviderConnectRequest, type ProviderGrant } from "@gendragoon/core";
import { useState } from "react";
import { EmptyState, ErrorState, Skeleton } from "./Feedback.js";

export interface ConnectionWorkspace {
  id: string;
  name: string;
}

function when(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function QuotaMeter(props: { binding: ProviderBinding }) {
  const quota = providerQuota(props.binding);
  const percent = Math.round(quota.fraction * 100);
  return (
    <div className="quota" data-testid={`quota-${props.binding.id}`} data-level={quota.level}>
      <div className="quota-row">
        <span>{quota.label}</span>
        <span className="help">{props.binding.objectCount} objects</span>
      </div>
      <div
        className={`progress quota-${quota.level}`}
        role="progressbar"
        aria-label={`Storage used by ${props.binding.client.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={quota.label}
      >
        <span style={{ transform: `scaleX(${quota.fraction})` }} />
      </div>
      {quota.level === "full" ? <p className="help quota-note">Limit reached. The app cannot store more until data is removed.</p> : null}
    </div>
  );
}

function ConnectionRow(props: { binding: ProviderBinding; workspaceName: string; busy: boolean; onRevoke: (id: string, deleteData: boolean) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const b = props.binding;
  return (
    <li className="connection" data-testid={`connection-${b.id}`}>
      <div className="connection-head">
        <div>
          <h3>{b.client.name}</h3>
          <p className="help">{b.client.host ? `${b.client.host} · ` : ""}{props.workspaceName} · {scopeLabel(b.scopes)}</p>
        </div>
        <span className={b.active ? "pill pill-ok" : "pill"}>{b.active ? "Connected" : "Revoked"}</span>
      </div>
      <QuotaMeter binding={b} />
      <p className="help">Connected {when(b.createdAt)} · Last used {when(b.lastUsedAt)}</p>
      {b.lastError ? <p className="help connection-error" role="status">Last error: {b.lastError}</p> : null}
      {b.active && !confirming ? (
        <div className="actions">
          <button type="button" className="btn-danger" data-testid={`revoke-${b.id}`} onClick={() => setConfirming(true)}>Revoke</button>
        </div>
      ) : null}
      {b.active && confirming ? (
        <div className="confirm" role="group" aria-label={`Revoke ${b.client.name}`}>
          <p>{b.client.name} loses access immediately. Its keys stop working.</p>
          <label className="check">
            <input type="checkbox" data-testid={`delete-data-${b.id}`} checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} />
            Also delete what {b.client.name} stored here. This cannot be undone.
          </label>
          <div className="actions">
            <button type="button" className="btn-ghost" onClick={() => { setConfirming(false); setDeleteData(false); }}>Cancel</button>
            <button type="button" className="btn-danger" data-testid={`confirm-revoke-${b.id}`} disabled={props.busy} aria-busy={props.busy} onClick={() => props.onRevoke(b.id, deleteData)}>
              {deleteData ? "Revoke and delete data" : "Revoke access"}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Settings surface for apps (RedX) that use a GenDragoon workspace as storage.
 * Connect: a one-time code to paste into the app, or approving a connect link the app opened.
 * Shows only what /provider/v1/bindings returns; keys never reach this component.
 */
export function RedxConnections(props: {
  bindings: ProviderBinding[] | null;
  error: string | null;
  workspaces: ConnectionWorkspace[];
  grant: ProviderGrant | null;
  pendingRequest: ProviderConnectRequest | null;
  busyId?: string | null;
  connecting?: boolean;
  onCreateGrant: (workspaceId: string) => void;
  onApproveRequest: (workspaceId: string) => void;
  onDenyRequest: () => void;
  onRevoke: (id: string, deleteData: boolean) => void;
  onRetry: () => void;
  onCopy?: (value: string) => void;
}) {
  const [workspaceId, setWorkspaceId] = useState(props.workspaces[0]?.id ?? "");
  const names = new Map(props.workspaces.map((w) => [w.id, w.name]));
  const canConnect = Boolean(workspaceId) && !props.connecting;
  let list;
  if (props.error) list = <ErrorState title="Could not load connections" detail={props.error} onRetry={props.onRetry} />;
  else if (!props.bindings) list = <Skeleton lines={3} />;
  else if (props.bindings.length === 0) list = <EmptyState title="No connected apps" detail="Connect RedX to keep its packs in one of your workspaces." />;
  else list = (
    <ul className="connections" data-testid="connections-list">
      {props.bindings.map((b) => (
        <ConnectionRow key={b.id} binding={b} workspaceName={names.get(b.workspaceId) ?? b.workspaceId} busy={props.busyId === b.id} onRevoke={props.onRevoke} />
      ))}
    </ul>
  );
  return (
    <section data-testid="redx-connections">
      <header className="topbar">
        <div>
          <div className="kicker"><span className="dot" /> CONNECTED APPS</div>
          <h2>RedX and other apps</h2>
          <p className="sub">A connected app stores encrypted data in a workspace you choose. It only sees its own data, and you can revoke it at any time.</p>
        </div>
      </header>
      {props.pendingRequest ? (
        <div className="panel stack" role="dialog" aria-label="Connect request" data-testid="connect-request">
          <h3>{props.pendingRequest.requester.name} wants to connect</h3>
          <p className="help">
            {props.pendingRequest.requester.host ? `${props.pendingRequest.requester.host} · ` : ""}{scopeLabel(props.pendingRequest.scopes)}.
            {" "}Approve only if you started this from the app on this device.
          </p>
          <WorkspacePicker workspaces={props.workspaces} value={workspaceId} onChange={setWorkspaceId} />
          <div className="actions">
            <button type="button" className="btn-ghost" data-testid="deny-request" onClick={props.onDenyRequest}>Deny</button>
            <button type="button" className="btn" data-testid="approve-request" disabled={!canConnect} aria-busy={props.connecting} onClick={() => props.onApproveRequest(workspaceId)}>Approve</button>
          </div>
        </div>
      ) : null}
      <div className="panel stack">
        <h3>Connect an app</h3>
        {props.workspaces.length === 0 ? (
          <p className="help">Create a workspace first. Connected apps store data inside a workspace.</p>
        ) : (
          <>
            <WorkspacePicker workspaces={props.workspaces} value={workspaceId} onChange={setWorkspaceId} />
            <div className="actions">
              <button type="button" className="btn" data-testid="create-grant" disabled={!canConnect} aria-busy={props.connecting} onClick={() => props.onCreateGrant(workspaceId)}>Get a connect code</button>
            </div>
          </>
        )}
        {props.grant ? (
          <div className="preview grant" data-testid="grant">
            <p className="help">Paste this into RedX within {Math.max(1, Math.round(props.grant.ttlSeconds / 60))} minutes. It works once.</p>
            <code className="grant-code" data-testid="grant-code">{props.grant.grant}</code>
            {props.onCopy ? <button type="button" className="btn-ghost" data-testid="copy-grant" onClick={() => props.onCopy?.(props.grant!.grant)}>Copy</button> : null}
          </div>
        ) : null}
      </div>
      <div className="panel">
        <h3>Connections</h3>
        {list}
      </div>
    </section>
  );
}

function WorkspacePicker(props: { workspaces: ConnectionWorkspace[]; value: string; onChange: (id: string) => void }) {
  return (
    <label className="field">Workspace
      <select data-testid="connect-workspace" value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
      </select>
    </label>
  );
}
