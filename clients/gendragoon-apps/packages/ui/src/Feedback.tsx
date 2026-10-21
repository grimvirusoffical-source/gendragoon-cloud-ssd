import type { ReactNode } from "react";

/** Shimmering placeholder while content loads. Decorative: hidden from assistive tech. */
export function Skeleton(props: { lines?: number; height?: number }) {
  const lines = props.lines ?? 3;
  return (
    <div className="skeleton-group" aria-hidden="true" data-testid="skeleton">
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className="skeleton" style={{ height: props.height ?? 14, width: index === lines - 1 ? "60%" : "100%" }} />
      ))}
    </div>
  );
}

export function EmptyState(props: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="empty-state" data-testid="empty-state">
      <div className="empty-mark" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>
      </div>
      <h3>{props.title}</h3>
      {props.detail ? <p className="help">{props.detail}</p> : null}
      {props.action}
    </div>
  );
}

export function ErrorState(props: { title: string; detail?: string; onRetry?: () => void }) {
  return (
    <div className="empty-state error-state" role="alert" data-testid="error-state">
      <div className="empty-mark" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M12 8v5m0 3.5v.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </div>
      <h3>{props.title}</h3>
      {props.detail ? <p className="help">{props.detail}</p> : null}
      {props.onRetry ? <button type="button" className="btn-ghost" onClick={props.onRetry}>Try again</button> : null}
    </div>
  );
}

export type TransferPhase = "queued" | "uploading" | "verifying" | "preloading" | "cached" | "backing_up" | "restoring" | "done" | "error";

const PHASE_LABEL: Record<TransferPhase, string> = {
  queued: "Queued", uploading: "Uploading", verifying: "Verifying", preloading: "Pre-caching", cached: "Cached on this device",
  backing_up: "Backing up", restoring: "Restoring", done: "Done", error: "Needs attention",
};

/** Status pill + progress bar for upload / pre-cache / backup / restore states. */
export function TransferStatus(props: { phase: TransferPhase; percent?: number | null; label?: string }) {
  const active = props.phase === "uploading" || props.phase === "preloading" || props.phase === "backing_up" || props.phase === "restoring" || props.phase === "verifying";
  const tone = props.phase === "error" ? "err" : props.phase === "done" || props.phase === "cached" ? "ok" : active ? "live" : "idle";
  return (
    <div className="transfer" data-testid="transfer-status" data-phase={props.phase}>
      <span className={`pill pill-${tone}`}>{props.label ?? PHASE_LABEL[props.phase]}</span>
      {active ? (
        <div className={`progress ${props.percent == null ? "indeterminate" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={props.percent ?? undefined}>
          <span style={props.percent == null ? undefined : { transform: `scaleX(${Math.max(0, Math.min(100, props.percent)) / 100})` }} />
        </div>
      ) : null}
    </div>
  );
}
