import { useEffect, useState } from "react";
import {
  accountFromAssessment,
  actionsForMode,
  applyApiFailure,
  byoErrorMessage,
  byoSecretId,
  categorize,
  challengeObjectKey,
  DeletionNotFoundError,
  DeletionNotRetryableError,
  SUPPORT_CONTACT,
  deleteAccountAndWipe,
  deletionAuthFailure,
  establishWorkspaceKey,
  dismissDeletion,
  GenDragoonClient,
  MemorySecretStore,
  performOwnershipChallenge,
  presignChallengeGet,
  reduceAccount,
  retryDeletion,
  registrationRequiresChallenge,
  toServerByoRegistration,
  treeNode,
  updateSortMapping,
  viewAfterFailure,
  type AccessResponse,
  type AccountState,
  type BrowserMode,
  type ByoProviderId,
  type Settings,
  type SortCategory,
  type TreeNode,
  type WorkspaceRecord,
} from "@gendragoon/core";
import { AccountSurface, AppShell, ByoSetup, FileBrowser, SettingsView, deletionFailureNotice, type ShellView } from "@gendragoon/ui";

const secrets = new MemorySecretStore();

/** Local plan view. Lock state comes from workspace records and HTTP 423, not from /v2/access. */
const LOCKED_ACCESS: AccessResponse = {
  locked: true,
  cap: 10,
  activeCount: 11,
  overCap: true,
  unpaidIds: ["unpaid-1"],
  lapsedIds: [],
  readable: true,
  downloadsAllowed: true,
  uploadsBlocked: true,
  normalUseBlocked: true,
  highTier: false,
  freeWorkspaces: 1,
  paidThroughMs: Date.parse("2026-10-18T00:00:00.000Z"),
  renewsAtMs: Date.parse("2026-11-18T00:00:00.000Z"),
  lifetime: false,
};

const OPEN_ACCESS: AccessResponse = {
  ...LOCKED_ACCESS,
  locked: false,
  activeCount: 10,
  overCap: false,
  unpaidIds: [],
  uploadsBlocked: false,
  normalUseBlocked: false,
};

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
      projectFeeStatus: "pending",
      provisioned: false,
      storage: {
        kind: "byo",
        storageTier: null,
        provider: "r2",
        endpoint: "https://example.r2.cloudflarestorage.com",
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
  const [signedOut, setSignedOut] = useState<null | "deleted" | "invalid-token" | "signed-out">(null);
  const [deleting, setDeleting] = useState(false);
  const [reauthRequired, setReauthRequired] = useState(false);
  const [deletionNotice, setDeletionNotice] = useState<{ message: string; retryable: boolean; support?: string } | null>(null);
  const [access, setAccess] = useState<AccessResponse>(LOCKED_ACCESS);
  const [account, setAccount] = useState<AccountState>(() => accountFromAssessment(LOCKED_ACCESS));
  const mode: BrowserMode = view === "backup" ? "backup" : "upload";
  const selected = NODES.find((node) => node.id === selectedId) ?? null;
  const actions = actionsForMode(mode, selected, access);

  useEffect(() => {
    setAccount((current) => reduceAccount(current, { type: "assessment", assessment: access }));
  }, [access]);

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

  async function onChallenge(input: { provider: ByoProviderId; endpoint: string; bucket: string; accessKeyId?: string; secretAccessKey?: string }) {
    try {
      const record = await toServerByoRegistration(input);
      if (!registrationRequiresChallenge()) {
        throw new Error("Ownership challenge must run again when storage is registered");
      }
      const token = await window.gendragoon?.getIdToken?.();
      const apiBase = import.meta.env.VITE_API_BASE;
      const workspaceId = workspaces.find((workspace) => workspace.kind === "byo")?.id ?? "byo";
      let challengeId = crypto.randomUUID().replace(/-/g, "");
      let nonce = crypto.randomUUID().replace(/-/g, "");
      const client = apiBase
        ? new GenDragoonClient({ baseUrl: apiBase, getToken: async () => token })
        : null;
      if (client && token) {
        await client.registerByo(workspaceId, record);
        const challenge = await client.createByoChallenge(workspaceId);
        nonce = challenge.nonce;
        challengeId = nonce;
        if (challengeObjectKey(nonce) !== `.gendragoon-challenge/${nonce}`) {
          throw new Error("Challenge object must be .gendragoon-challenge/<nonce>");
        }
      }
      const started = Date.now();
      const proof = await performOwnershipChallenge({
        challengeId,
        nonce,
        now: started,
        writer: {
          async write() {
            // The device writes the object with the keychain secret. That secret is not returned.
          },
          async presignGet(key) {
            if (!input.accessKeyId || !input.secretAccessKey) {
              throw new Error("Access Key ID and Secret Access Key are required");
            }
            return presignChallengeGet({
              endpoint: record.endpoint,
              bucket: input.bucket,
              key,
              accessKeyId: input.accessKeyId,
              secretAccessKey: input.secretAccessKey,
              expiresInSeconds: 300,
            });
          },
        },
      });
      if (client && token) await client.submitByoProof(workspaceId, proof);
      setByoMessage(`Server record would store ${record.provider}, ${record.endpoint}, fingerprint ${record.bucketFingerprint.slice(0, 16)}. Credentials were not included. Proof is a presigned GET for ${challengeObjectKey(nonce)}.`);
    } catch (error) {
      setByoMessage(byoErrorMessage(error));
    }
  }

  async function onStoreSecret(secret: string) {
    const workspaceId = workspaces.find((workspace) => workspace.kind === "byo")?.id ?? "byo";
    await secrets.set(byoSecretId(workspaceId), new TextEncoder().encode(secret));
  }

  function onAuthFailure(signal: "signed_out" | "reauth_required") {
    if (signal === "reauth_required") {
      setReauthRequired(true);
      setStatus("Sign in again");
      return;
    }
    setSignedOut("invalid-token");
  }

  function noticeForResult(result: { status: string; retryable?: boolean }) {
    const notice = deletionFailureNotice(result);
    if (!notice) return null;
    return { message: notice.message, retryable: notice.retryable, support: notice.supportContact };
  }

  async function onDeleteAccount(reauthenticatedAt = new Date().toISOString()) {
    setDeleting(true);
    try {
      const token = await window.gendragoon?.getIdToken?.();
      const apiBase = import.meta.env.VITE_API_BASE;
      const workspaceIds = workspaces.map((workspace) => workspace.id);
      if (!apiBase || !token) {
        setReauthRequired(true);
        setStatus("Sign in again");
        return;
      }
      const client = new GenDragoonClient({ baseUrl: apiBase, getToken: async () => token });
      const result = await deleteAccountAndWipe({
        client,
        reauthenticatedAt,
        idToken: token,
        workspaceIds,
        secrets,
        secureStore: secrets,
        onAuthFailure,
      });
      const notice = noticeForResult(result);
      setDeletionNotice(notice);
      setReauthRequired(false);
      if (!notice) setSignedOut("deleted");
    } catch (error) {
      if (error instanceof DeletionNotRetryableError) {
        setDeletionNotice({ message: error.message, retryable: false, support: SUPPORT_CONTACT.value });
        return;
      }
      if (error instanceof DeletionNotFoundError) {
        setDeletionNotice({ message: error.message, retryable: true });
        return;
      }
      const auth = deletionAuthFailure(error);
      if (auth === "reauth") {
        setReauthRequired(true);
        setStatus(error instanceof Error ? error.message : "Sign in again");
        return;
      }
      if (auth === "sign-out") {
        setSignedOut("invalid-token");
        return;
      }
      onWriteFailure(error);
    } finally {
      setDeleting(false);
    }
  }

  async function onRetryDeletion() {
    setDeleting(true);
    try {
      const token = await window.gendragoon?.getIdToken?.();
      const apiBase = import.meta.env.VITE_API_BASE;
      if (!apiBase || !token) {
        setReauthRequired(true);
        setStatus("Sign in again");
        return;
      }
      const client = new GenDragoonClient({ baseUrl: apiBase, getToken: async () => token });
      const result = await retryDeletion({
        client,
        reauthenticatedAt: new Date().toISOString(),
        idToken: token,
        workspaceIds: workspaces.map((workspace) => workspace.id),
        secrets,
        secureStore: secrets,
        onAuthFailure,
      });
      const notice = noticeForResult(result);
      setDeletionNotice(notice);
      if (!notice) setSignedOut("deleted");
    } catch (error) {
      if (error instanceof DeletionNotRetryableError) {
        setDeletionNotice({ message: error.message, retryable: false, support: SUPPORT_CONTACT.value });
        return;
      }
      onWriteFailure(error);
    } finally {
      setDeleting(false);
    }
  }

  async function onDismissDeletion() {
    await dismissDeletion(secrets);
    setDeletionNotice(null);
  }

  async function onPassphrase(passphrase: string) {
    const workspaceId = workspaces.find((workspace) => workspace.kind !== "byo")?.id ?? "paid-1";
    const token = await window.gendragoon?.getIdToken?.();
    const apiBase = import.meta.env.VITE_API_BASE;
    if (!apiBase || !token) {
      setReauthRequired(true);
      setStatus("Sign in again");
      return;
    }
    try {
      const client = new GenDragoonClient({ baseUrl: apiBase, getToken: async () => token });
      const opened = await establishWorkspaceKey({
        store: secrets,
        workspaceId,
        passphrase,
        get: () => client.getKeyEnvelope(workspaceId),
        put: (envelope) => client.putKeyEnvelope(workspaceId, envelope),
      });
      setStatus(opened.adopted
        ? "Using the workspace key already stored for this workspace."
        : "Recovery passphrase saved on this device.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save the recovery passphrase");
    }
  }

  function onSignInAgain() {
    setReauthRequired(false);
    void onDeleteAccount(new Date().toISOString());
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
    const detail = signedOut === "invalid-token"
      ? "This session is no longer valid. Workspace keys were kept on this device."
      : signedOut === "signed-out"
        ? "Signed out. Workspace keys were kept on this device."
        : "Account deletion was accepted. Workspace keys were removed from this device.";
    return (
      <main className="main" data-testid="signed-out">
        <h2>Signed out</h2>
        <p className="sub">{detail}</p>
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
        assessment={access}
        workspaces={workspaces}
        onDelete={(id) => {
          setWorkspaces((current) => current.filter((workspace) => workspace.id !== id));
          if (id === "unpaid-1") setAccess(OPEN_ACCESS);
        }}
      >
        {browser}
      </AccountSurface>
    );
  if (view === "workspaces") {
    body = account.phase === "delete_or_merge" ? (
      <AccountSurface
        phase={account.phase}
        error={writeError}
        assessment={access}
        workspaces={workspaces}
        onDelete={(id) => {
          setWorkspaces((current) => current.filter((workspace) => workspace.id !== id));
          if (id === "unpaid-1") setAccess(OPEN_ACCESS);
        }}
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
        reauthRequired={reauthRequired}
        onSignInAgain={onSignInAgain}
        onPassphrase={(passphrase) => void onPassphrase(passphrase)}
        deletionMessage={deletionNotice?.message}
        deletionRetryable={deletionNotice?.retryable}
        supportContact={deletionNotice?.support}
        onRetryDeletion={() => void onRetryDeletion()}
        onDismissDeletion={() => void onDismissDeletion()}
      />
    );
  }

  return (
    <AppShell view={view} onView={open} locked={account.phase === "delete_or_merge"} onSignOut={() => setSignedOut("signed-out")}>
      {notice ? <div className="banner" data-testid="updater-notice">{notice}</div> : null}
      {body}
      <p className="footer-note" data-testid="status">{status}</p>
    </AppShell>
  );
}
