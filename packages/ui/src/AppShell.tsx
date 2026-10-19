import type { ReactNode } from "react";

export type ShellView = "files" | "backup" | "workspaces" | "connections" | "settings";

const NAV: { id: ShellView; label: string }[] = [
  { id: "files", label: "Files" },
  { id: "backup", label: "Backup" },
  { id: "workspaces", label: "Workspaces" },
  { id: "connections", label: "Connected apps" },
  { id: "settings", label: "Settings" },
];

export function AppShell(props: {
  view: ShellView;
  onView: (view: ShellView) => void;
  locked: boolean;
  onSignOut: () => void;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M11.2 1.8 4.4 11h4.3l-.9 7.2L15.6 8.7h-4.4l0-6.9Z" fill="currentColor" />
            </svg>
          </div>
          <div>
            <h1>GENDRAGOON</h1>
            <p>CLOUD SSD</p>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={props.view === item.id ? "active" : ""}
              onClick={() => props.onView(item.id)}
              data-testid={`nav-${item.id}`}
            >
              <span>{item.label}</span>
              {item.id === "workspaces" && props.locked ? <span className="tag">LOCK</span> : null}
            </button>
          ))}
        </nav>
        <button type="button" className="nav-signout" data-testid="sign-out" onClick={props.onSignOut}>
          Sign out
        </button>
      </aside>
      <main className="main">{props.children}</main>
    </div>
  );
}
