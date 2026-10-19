/**
 * "Check for updates" control. Pure view: the host (Electron main via preload, or a test)
 * supplies the state and the click handler. Structural types, so this package does not import the updater.
 */
export type UpdateView =
  | { status: "idle" }
  | { status: "checking"; manual?: boolean }
  | { status: "up_to_date"; currentVersion: string; checkedAt?: number }
  | { status: "available"; version: string; notes?: string; url?: string }
  | { status: "downloading"; version: string; percent: number | null; receivedBytes?: number; totalBytes?: number | null }
  | { status: "verifying"; version: string }
  | { status: "ready"; version: string }
  | { status: "deferred"; version: string }
  | { status: "installing"; version: string }
  | { status: "relaunching"; version: string }
  | { status: "error"; message: string; stage?: string };

const BUSY = new Set(["checking", "downloading", "verifying", "ready", "installing", "relaunching"]);

export function isUpdateBusy(state: UpdateView): boolean {
  return BUSY.has(state.status);
}

export function updateLabel(state: UpdateView, currentVersion?: string): string {
  switch (state.status) {
    case "idle": return currentVersion ? `Version ${currentVersion}` : "Not checked yet";
    case "checking": return "Checking for updates…";
    case "up_to_date": return `You're up to date (version ${state.currentVersion})`;
    case "available": return `Version ${state.version} is available`;
    case "downloading": return state.percent === null ? `Downloading ${state.version}…` : `Downloading ${state.version}: ${state.percent}%`;
    case "verifying": return `Verifying ${state.version}…`;
    case "ready": return `Version ${state.version} is ready to install`;
    case "deferred": return `Version ${state.version} is ready. It installs when your upload or backup finishes.`;
    case "installing": return `Installing ${state.version}…`;
    case "relaunching": return "Updating… the app will restart by itself.";
    case "error": return state.message;
  }
}

export function UpdateControl(props: {
  state: UpdateView;
  currentVersion?: string;
  onCheck: () => void;
  /** full (default): button + progress. managed: read-only note (the store launcher updates). hidden: renders nothing (Mac App Store). */
  ui?: "full" | "managed" | "hidden";
  note?: string;
}) {
  const { state } = props;
  if (props.ui === "hidden") return null;
  if (props.ui === "managed") {
    return (
      <section className="panel update-control" data-testid="update-managed" aria-labelledby="update-title">
        <h3 id="update-title">Updates</h3>
        <p className="help">{props.note ?? "Updates are managed by the app store you installed this from."}</p>
      </section>
    );
  }
  const busy = isUpdateBusy(state);
  const percent = state.status === "downloading" ? state.percent : null;
  return (
    <section className="panel update-control" data-testid="update-control" data-state={state.status} aria-labelledby="update-title">
      <div className="update-head">
        <div>
          <h3 id="update-title">Updates</h3>
          <p className={`update-status ${state.status === "error" ? "is-error" : ""}`} role={state.status === "error" ? "alert" : "status"} aria-live="polite" data-testid="update-status">
            {updateLabel(state, props.currentVersion)}
          </p>
        </div>
        <button type="button" className="btn" data-testid="update-check" disabled={busy} onClick={props.onCheck} aria-busy={busy}>
          {state.status === "checking" ? "Checking…" : state.status === "error" ? "Try again" : "Check for updates"}
        </button>
      </div>
      {state.status === "downloading" || state.status === "verifying" || state.status === "installing" || state.status === "relaunching" ? (
        <div
          className={`progress ${percent === null ? "indeterminate" : ""}`}
          role="progressbar"
          aria-label="Update progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          data-testid="update-progress"
        >
          <span style={percent === null ? undefined : { transform: `scaleX(${percent / 100})` }} />
        </div>
      ) : null}
      {state.status === "available" && state.url ? (
        <p className="help" data-testid="update-manual">Automatic install is available in the Windows installer build. <a href={state.url} rel="noreferrer noopener">Download version {state.version}</a>.</p>
      ) : null}
    </section>
  );
}
