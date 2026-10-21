import type { BrowserActions, BrowserMode, TreeNode } from "@gendragoon/core";
import { categorize } from "@gendragoon/core";

export function FileBrowser(props: {
  mode: BrowserMode;
  nodes: TreeNode[];
  selectedId: string | null;
  actions: BrowserActions;
  workspaceName: string;
  onSelect: (id: string) => void;
  onPrimary: () => void;
  onRefresh: () => void;
}) {
  const title = props.mode === "backup" ? "Backup manager" : "Uploader";
  const detail = props.mode === "backup"
    ? "Same library as the uploader. Refresh, select an item, then make a secure backup. There is no upload button."
    : "Upload files, folders, and app bundles into a workspace you own.";
  return (
    <section>
      <header className="topbar">
        <div>
          <div className="kicker"><span className="dot" /> WORKSPACE {props.workspaceName.toUpperCase()}</div>
          <h2>{title}</h2>
          <p className="sub">{detail}</p>
        </div>
        <div className="actions">
          <button type="button" className="btn-ghost" onClick={props.onRefresh} data-testid="refresh">Refresh</button>
          {props.actions.primaryLabel ? (
            <button type="button" className="btn" onClick={props.onPrimary} data-testid="primary-action">
              {props.actions.primaryLabel}
            </button>
          ) : null}
        </div>
      </header>
      <div className="grid">
        <div className="panel">
          <strong>Library</strong>
          <ul className="tree" data-testid="file-tree">
            {props.nodes.map((node) => (
              <li key={node.id}>
                <button
                  type="button"
                  className={props.selectedId === node.id ? "selected" : ""}
                  onClick={() => props.onSelect(node.id)}
                >
                  <span>{node.name}</span>
                  <span className="kind">{node.kind}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="panel stack">
          <strong>Selected item</strong>
          <Selection node={props.nodes.find((node) => node.id === props.selectedId) ?? null} />
          <p className="help">
            Downloads stay available. {props.actions.canUpload ? "Upload is open for this selection." : "Upload is hidden for this view."}
            {props.mode === "backup" ? " Backup copies the selection with the same resumable transfer." : ""}
          </p>
        </div>
      </div>
    </section>
  );
}

function Selection(props: { node: TreeNode | null }) {
  if (!props.node) return <p className="help">Choose a file, folder, or app bundle.</p>;
  const category = categorize({ name: props.node.name, mime: props.node.mime, kind: props.node.kind });
  return (
    <div className="stack">
      <div>
        <div className="sub">{props.node.path}</div>
        <h3 style={{ margin: "6px 0" }}>{props.node.name}</h3>
      </div>
      <div className="chips">
        <span className="chip">{category}</span>
        <span className="chip">{props.node.kind}</span>
        {props.node.sizeBytes !== undefined ? <span className="chip">{props.node.sizeBytes} bytes</span> : null}
      </div>
    </div>
  );
}
