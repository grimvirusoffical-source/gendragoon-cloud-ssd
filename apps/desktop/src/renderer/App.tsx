import { useEffect, useMemo, useState } from "react";
import {
  accountFromAssessment,
  actionsForMode,
  applyApiFailure,
  assessLock,
  byoSecretId,
  categorize,
  deleteAccountAndWipe,
  GenDragoonClient,
  MemorySecretStore,
  reauthIsRecent,
  reduceAccount,
  toServerByoRegistration,
  treeNode,
  updateSortMapping,
  viewAfterFailure,
  wipeWorkspaceKeys,
  WORKSPACE_MONTHLY_CENTS,
  type AccountState,
  type BrowserMode,
  type ByoProviderId,
  type Settings,
  type SortCategory,
  type TreeNode,
  type WorkspaceRecord,
} from "@gendragoon/core";
import { AccountSurface, AppShell, ByoSetup, FileBrowser, SettingsView, type ShellView } from "@gendragoon/ui";

const NOW = Date.parse("2026-10-18T00:00:00.000Z");
const secrets = new MemorySecretStore();

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
  const name = hash.replace("#/", "");
  if (name === "backup" || name === "settings" || name === "files") return name;
  if (name === "workspaces" || name === "lock" || name === "connect") return "workspaces";
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
  const [notice, setNotice] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<unknown>(null);
  const [byoMessage, setByoMessage] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const assessment = useMemo(() => assessLock(workspaces, NOW), [workspaces]);
  const [account, setAccount] = useState<AccountState>(() => accountFromAssessment(assessment));
  const mode: BrowserMode = view === "backup" ? "backup" : "upload";
  const selected = NODES.find((node) => node.id === selectedId) ?? null;
  const actions = actionsForMode(mode, selected, assessment);

  useEffect(() => {
    setAccount((current) => reduceAccount(current, { type: "assessment", assessment }));
  }, [assessment]);

  useEffect(() => {
    window.gendragoon?.setTransferActive?.(status.includes("queued"));
  }, [status]);

  useEffect(() => {
    window.gendragoon?.onUpdaterNotice?.((text) => setNotice(text));
  }, []);

  function open(next: ShellView) {
    window.location.hash = `#/${next}`;
    setView(next);
  }

  function onWriteFailure(error: unknown) {
    setWriteError(error);
    setAccount((current) => applyApiFailure(current, error));
    const next = viewAfterFailure(view, error);
    if (next === "workspaces") open("workspaces");
    else setStatus(error instanceof Error ? error.message : "Request failed");
  }

  function onPrimary() {
    if (!actions.primaryLabel || !selected) return;
    setWriteError(null);
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

  async function onStoreSecret(secret: string) {
    const workspaceId = workspaces.find((workspace) => workspace.kind === "byo")?.id ?? "byo";
    await secrets.set(byoSecretId(workspaceId), new TextEncoder().encode(secret));
  }

  async function onDeleteAccount() {
    setDeleting(true);
    const reauthenticatedAt = new Date().toISOString();
    try {
      const token = await window.gendragoon?.getIdToken?.();
      const apiBase = import.meta.env.VITE_API_BASE;
      if (apiBase && token) {
        const client = new GenDragoonClient({ baseUrl: apiBase, getToken: async () => token });
        await deleteAccountAndWipe({
          client,
          reauthenticatedAt,
          workspaceIds: workspaces.map((workspace) => workspace.id),
          secrets,
        });
      } else if (!reauthIsRecent(reauthenticatedAt)) {
        throw new Error("Sign in again before deleting the account");
      } else {
        await wipeWorkspaceKeys(secrets, workspaces.map((workspace) => workspace.id));
      }
      setSignedOut(true);
    } catch (error) {
      onWriteFailure(error);
    } finally {
      setDeleting(false);
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

  if (signedOut) {
    return (
      <main className="main" data-testid="signed-out">
        <h2>Signed out</h2>
        <p className="sub">Account deletion was accepted. Workspace keys were removed from this device.</p>
      </main>
    );
  }

  const browser = (
    <FileBrowser
      mode={mode}
      nodes={NODES}
      selectedId={selectedId}
      actions={actions}
      workspaceName="Personal"
      onSelect={setSelectedId}
      onPrimary={onPrimary}
      onRefresh={() => {
        setAccount((current) => reduceAccount(current, { type: "read_ok" }));
        setStatus("Library refreshed");
      }}
    />
  );

  let body = (
    <AccountSurface
      phase={account.phase}
      error={writeError}
      assessment={assessment}
      workspaces={workspaces}
      onDelete={(id) => setWorkspaces((current) => current.filter((workspace) => workspace.id !== id))}
    >
      {browser}
    </AccountSurface>
  );
  if (view === "workspaces") {
    body = account.phase === "delete_or_merge" ? (
      <AccountSurface
        phase={account.phase}
        error={writeError}
        assessment={assessment}
        workspaces={workspaces}
        onDelete={(id) => setWorkspaces((current) => current.filter((workspace) => workspace.id !== id))}
      >
        {null}
      </AccountSurface>
    ) : (
      <section data-testid="workspaces-view">
        <header className="topbar">
          <div>
            <div className="kicker"><span className="dot" /> WORKSPACES</div>
            <h2>Your workspaces</h2>
            <p className="sub">Managed storage uses short-lived signed links. Your own cloud stays on this device.</p>
          </div>
        </header>
        <ByoSetup onChallenge={(input) => void onChallenge(input)} onStoreSecret={(secret) => void onStoreSecret(secret)} message={byoMessage} />
      </section>
    );
  } else if (view === "settings") {
    body = (
      <SettingsView
        settings={settings}
        rows={rows}
        onChange={onSort}
        onDeleteAccount={() => void onDeleteAccount()}
        deleting={deleting}
      />
    );
  }

  return (
    <AppShell view={view} onView={open} locked={account.phase === "delete_or_merge"} onSignOut={() => setSignedOut(true)}>
      {notice ? <div className="banner" data-testid="updater-notice">{notice}</div> : null}
      {body}
      <p className="footer-note" data-testid="status">{status}</p>
    </AppShell>
  );
}
