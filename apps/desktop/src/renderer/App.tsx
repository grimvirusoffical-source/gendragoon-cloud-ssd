import { useMemo, useState } from "react";
import {
  actionsForMode,
  assessLock,
  categorize,
  toServerByoRegistration,
  treeNode,
  updateSortMapping,
  WORKSPACE_MONTHLY_CENTS,
  type BrowserMode,
  type ByoProviderId,
  type Settings,
  type SortCategory,
  type TreeNode,
  type WorkspaceRecord,
} from "@gendragoon/core";
import { AppShell, ByoSetup, FileBrowser, LockScreen, SettingsView, type ShellView } from "@gendragoon/ui";

const NOW = Date.parse("2026-10-18T00:00:00.000Z");

const NODES: TreeNode[] = [
  treeNode({ path: "Pictures/vacation.jpg", directory: false, sizeBytes: 240112, mime: "image/jpeg" }),
  treeNode({ path: "Videos/launch.mp4", directory: false, sizeBytes: 980000, mime: "video/mp4" }),
  treeNode({ path: "Documents/notes.pdf", directory: false, sizeBytes: 12000, mime: "application/pdf" }),
  treeNode({ path: "Apps/Grok Bot.app", directory: true }),
];

function sampleWorkspaces(): WorkspaceRecord[] {
  const paid = Array.from({ length: 10 }, (_, index) => ({
    id: `paid-${index + 1}`,
    name: index === 0 ? "Personal" : `Library ${index + 1}`,
    kind: "paid" as const,
    projectStatus: "active" as const,
    projectFeeStatus: "paid" as const,
    feeIsOneTime: true,
    provisioned: true,
    storageActive: true,
    storageTier: "100GB",
    storage: { kind: "gendragoon" as const, storageTier: "100GB" },
  }));
  return [
    {
      id: "unpaid-1",
      name: "Field recordings",
      kind: "byo",
      projectStatus: "active",
      feeIsOneTime: false,
      projectFeeStatus: "pending",
      provisioned: false,
      storage: {
        kind: "byo",
        storageTier: null,
        provider: "sftp",
        endpoint: "sftp://vps.example",
        bucketFingerprint: "demo",
      },
    },
    ...paid,
  ];
}

const EXTENSIONS = [".jpg", ".mp4", ".mp3", ".pdf", ".zip", ".app", ".bin"];

function viewFromHash(hash: string): ShellView {
  const name = hash.replace("#/", "") as ShellView;
  if (name === "backup" || name === "lock" || name === "settings" || name === "connect" || name === "files") return name;
  return "files";
}

export function App() {
  const [view, setView] = useState<ShellView>(() => viewFromHash(window.location.hash));
  const [selectedId, setSelectedId] = useState<string | null>(NODES[0]?.id ?? null);
  const [workspaces, setWorkspaces] = useState(sampleWorkspaces);
  const [settings, setSettings] = useState<Settings>({
    schema: 1,
    sortOverrides: { extensions: { ".mp4": "Other" }, mimeTypes: {} },
  });
  const [status, setStatus] = useState("Ready");
  const [byoMessage, setByoMessage] = useState<string | null>(null);
  const assessment = useMemo(() => assessLock(workspaces, NOW), [workspaces]);
  const mode: BrowserMode = view === "backup" ? "backup" : "upload";
  const selected = NODES.find((node) => node.id === selectedId) ?? null;
  const actions = actionsForMode(mode, selected, assessment);

  function open(next: ShellView) {
    window.location.hash = `#/${next}`;
    setView(next);
  }

  function onPrimary() {
    if (!actions.primaryLabel || !selected) return;
    setStatus(`${actions.primaryLabel} queued for ${selected.name}`);
  }

  function onSort(extension: string, category: SortCategory) {
    setSettings((current) => updateSortMapping(current, extension, category));
  }

  async function onChallenge(input: { provider: ByoProviderId; endpoint: string; bucket: string }) {
    try {
      const record = await toServerByoRegistration(input);
      setByoMessage(`Server record would store ${record.provider}, ${record.endpoint}, fingerprint ${record.bucketFingerprint.slice(0, 16)}. Credentials were not included. Workspace fee $${WORKSPACE_MONTHLY_CENTS / 100}/month.`);
    } catch (error) {
      setByoMessage(error instanceof Error ? error.message : "Setup failed");
    }
  }

  const rows = EXTENSIONS.map((extension) => {
    const category = categorize({ name: `file${extension}` }, settings.sortOverrides);
    return {
      extension,
      category,
      source: settings.sortOverrides.extensions[extension] ? "override" as const : "default" as const,
    };
  });

  let body = (
    <FileBrowser
      mode="upload"
      nodes={NODES}
      selectedId={selectedId}
      actions={actions}
      workspaceName="Personal"
      onSelect={setSelectedId}
      onPrimary={onPrimary}
      onRefresh={() => setStatus("Library refreshed")}
    />
  );
  if (view === "backup") {
    body = (
      <FileBrowser
        mode="backup"
        nodes={NODES}
        selectedId={selectedId}
        actions={actions}
        workspaceName="Personal"
        onSelect={setSelectedId}
        onPrimary={onPrimary}
        onRefresh={() => setStatus("Library refreshed")}
      />
    );
  } else if (view === "lock") {
    body = (
      <LockScreen
        assessment={assessment}
        workspaces={workspaces}
        onDelete={(id) => setWorkspaces((current) => current.filter((workspace) => workspace.id !== id))}
      />
    );
  } else if (view === "settings") {
    body = <SettingsView settings={settings} rows={rows} onChange={onSort} />;
  } else if (view === "connect") {
    body = <ByoSetup onChallenge={(input) => void onChallenge(input)} message={byoMessage} />;
  }

  return (
    <>
      <AppShell view={view} onView={open} locked={assessment.locked}>
        {assessment.locked && view !== "lock" ? (
          <div className="banner">Uploads are paused until workspaces are deleted or merged. Downloads still work.</div>
        ) : null}
        {body}
        <p className="footer-note" data-testid="status">{status}</p>
      </AppShell>
    </>
  );
}
