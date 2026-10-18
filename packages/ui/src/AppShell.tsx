import type { ReactNode } from "react";

export type ShellView = "files" | "backup" | "lock" | "settings" | "connect";

const NAV: { id: ShellView; label: string }[] = [
  { id: "files", label: "Files" },
  { id: "backup", label: "Backup" },
  { id: "connect", label: "Connect storage" },
  { id: "settings", label: "Settings" },
  { id: "lock", label: "Workspaces" },
];

export function AppShell(props: {
  view: ShellView;
  onView: (view: ShellView) => void;
  locked: boolean;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M4 13.5h12.2a2.8 2.8 0 0 0 .3-5.6 4.2 4.2 0 0 0-8.1-1.2A3.3 3.3 0 0 0 4 13.5Z" stroke="white" strokeWidth="1.6" />
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
              {item.id === "lock" && props.locked ? <span className="tag">LOCK</span> : null}
            </button>
          ))}
        </nav>
      </aside>
      <main className="main">{props.children}</main>
    </div>
  );
}
