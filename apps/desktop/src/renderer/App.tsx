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
  TeamOwnerMustTransferError,
  deletionAuthFailure,
  establishWorkspaceKey,
  dismissDeletion,
  GenDragoonClient,
  MemorySecretStore,
  performOwnershipChallenge,
  presignChallengeGet,
  providerErrorMessage,
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
  type ProviderBinding,
  type ProviderGrant,
  type Settings,
  type SortCategory,
  type TreeNode,
  type WorkspaceRecord,
  type CreateWorkspaceRequest,
  type PlansPricing,
  workspacePlansLabel,
} from "@gendragoon/core";
import { AccountSurface, AppShell, CustomStorageWizard, FileBrowser, NewWorkspace, RedxConnections, SettingsView, UpdateControl, deletionFailureNotice, type CustomStorageCredentials, type ShellView, type UpdateView } from "@gendragoon/ui";
import { TeamsView } from "./TeamsView";

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

/** Shown when no API base or token is configured (preview builds, screenshots). */
const SAMPLE_BINDINGS: ProviderBinding[] = [
  {
    id: "5b0e8f7a-2c41-4d6e-9a13-7f2c4b8d1e90",
    workspaceId: "paid-1",
    client: { name: "RedX", host: "studio-mac" },
    scopes: ["blobs:rw"],
    usedBytes: 3_400_000_000,
    quotaBytes: 10_000_000_000,
    objectCount: 1820,
    createdAt: "2026-10-12T09:30:00Z",
    lastUsedAt: "2026-10-19T06:10:00Z",
    lastError: null,
    active: true,
  },
];

const EXTENSIONS = [".jpg", ".mp4", ".mp3", ".pdf", ".zip", ".app", ".bin"];

function viewFromHash(hash: string): ShellView {
  const name = hash.replace("#/", "");
  if (name === "backup" || name === "settings" || name === "files" || name === "connections" || name === "teams") return name;
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
  const [updateState, setUpdateState] = useState<UpdateView>({ status: "idle" });
  // Inside the desktop shell the main process says whether this distribution self-updates. Until it answers, show nothing (a store build must never flash an update button).
  const [updateUi, setUpdateUi] = useState<{ ui: "full" | "managed" | "hidden"; note?: string }>(() => (window.gendragoon?.getUpdatePolicy ? { ui: "hidden" } : { ui: "full" }));
  const [writeError, setWriteError] = useState<unknown>(null);
  const [pricing, setPricing] = useState<PlansPricing | null>(null);
  const [freeProjectAvailable, setFreeProjectAvailable] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [creating, setCreating] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [intentId, setIntentId] = useState(() => crypto.randomUUID());
  const [setupId, setSetupId] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState<null | "deleted" | "invalid-token" | "signed-out">(null);
  const [deleting, setDeleting] = useState(false);
  const [reauthRequired, setReauthRequired] = useState(false);
  const [deletionNotice, setDeletionNotice] = useState<{ message: string; retryable: boolean; support?: string } | null>(null);
  const [bindings, setBindings] = useState<ProviderBinding[] | null>(null);
  const [bindingsError, setBindingsError] = useState<string | null>(null);
  const [grant, setGrant] = useState<ProviderGrant | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
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
    window.gendragoon?.onUpdateState?.((next) => setUpdateState(next as UpdateView));
    void window.gendragoon?.getUpdatePolicy?.().then((policy) => {
      const p = policy as { ui?: string; note?: string } | undefined;
      setUpdateUi({ ui: p?.ui === "managed" || p?.ui === "hidden" ? p.ui : "full", note: p?.note });
    }).catch(() => setUpdateUi({ ui: "hidden" }));
    void window.gendragoon?.getUpdateState?.().then((current) => setUpdateState(current as UpdateView));
  }, []);

  /** Manual "Check for updates": a real check in the main process. Progress arrives through onUpdateState. */
  function checkForUpdates() {
    const check = window.gendragoon?.checkForUpdates;
    if (!check) {
      setUpdateState({ status: "error", message: "Updates are only available in the installed desktop app." });
      return;
    }
    setUpdateState({ status: "checking", manual: true });
    void check().then((final) => setUpdateState(final as UpdateView)).catch(() => setUpdateState({ status: "error", message: "Could not check for updates. Try again." }));
  }

  async function providerClient(): Promise<GenDragoonClient | null> {
    const token = await window.gendragoon?.getIdToken?.();
    const apiBase = import.meta.env.VITE_API_BASE;
    return apiBase && token ? new GenDragoonClient({ baseUrl: apiBase, getToken: async () => token }) : null;
  }

  async function loadBindings() {
    setBindingsError(null);
    setBindings(null);
    try {
      const client = await providerClient();
      setBindings(client ? await client.providerBindings() : SAMPLE_BINDINGS);
    } catch (error) {
      setBindingsError(providerErrorMessage(error));
    }
  }

  async function onCreateGrant(workspaceId: string) {
    setConnecting(true);
    try {
      const client = await providerClient();
      setGrant(client
        ? await client.createProviderGrant(workspaceId, { name: "RedX", host: "" })
        : { grant: `gdpg_${"x".repeat(43)}`, expiresAt: new Date(Date.now() + 300_000).toISOString(), ttlSeconds: 300 });
    } catch (error) {
      setBindingsError(providerErrorMessage(error));
    } finally {
      setConnecting(false);
    }
  }

  async function onRevokeBinding(id: string, deleteData: boolean) {
    setRevokingId(id);
    try {
      const client = await providerClient();
      if (client) await client.revokeProviderBinding(id, deleteData);
      else setBindings((current) => current?.map((b) => (b.id === id ? { ...b, active: false, usedBytes: deleteData ? 0 : b.usedBytes } : b)) ?? null);
      if (client) await loadBindings();
    } catch (error) {
      setBindingsError(providerErrorMessage(error));
    } finally {
      setRevokingId(null);
    }
  }

  useEffect(() => {
    if (view === "connections") void loadBindings();
    if (view === "workspaces" || view === "teams") void loadWorkspaces();
  }, [view]);

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

  async function loadWorkspaces() {
    const client = await providerClient();
    if (!client) return; // Preview build: keeps the local sample list.
    try {
      const [list, prices] = await Promise.all([client.listWorkspaces(), client.pricing()]);
      setWorkspaces(list.workspaces as WorkspaceRecord[]);
      setFreeProjectAvailable(list.policy.freeProjectAvailable === true);
      setPricing(prices.storage && prices.performance ? { storage: prices.storage, performance: prices.performance } : null);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not load workspaces");
    }
  }

  async function openBilling(url: unknown) {
    if (typeof url !== "string") return;
    const opened = await window.gendragoon?.openBilling?.(url);
    if (!opened) setStatus("Open the checkout link from the installed desktop app.");
  }

  async function onCreateWorkspace(request: CreateWorkspaceRequest) {
    setCreating(true);
    setWorkspaceError(null);
    try {
      const client = await providerClient();
      if (!client) {
        setWorkspaceError("Sign in to create a workspace.");
        return;
      }
      const created = await client.createProject(request);
      setShowNew(false);
      setIntentId(crypto.randomUUID());
      await openBilling(created.url);
      await loadWorkspaces();
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not create the workspace");
    } finally {
      setCreating(false);
    }
  }

  async function onResumeCheckout(id: string) {
    setWorkspaceError(null);
    try {
      const client = await providerClient();
      if (!client) return;
      const checkout = await client.checkoutProject(id);
      await openBilling(checkout.url);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not open checkout");
    }
  }

  /**
   * Custom storage connection test: register (no secrets) → challenge → write + presign on this
   * device → verify. Credentials go to the OS keychain and never into a request body.
   */
  async function runCustomStorageTest(workspaceId: string, input: CustomStorageCredentials) {
    const client = await providerClient();
    if (!client) throw new Error("Sign in to connect custom storage.");
    const record = await toServerByoRegistration(input);
    if (!registrationRequiresChallenge()) throw new Error("Ownership challenge must run again when storage is registered");
    await secrets.set(byoSecretId(workspaceId), new TextEncoder().encode(input.secretAccessKey));
    try {
      await client.registerByo(workspaceId, record);
      const challenge = await client.createByoChallenge(workspaceId);
      if (challengeObjectKey(challenge.nonce) !== `.gendragoon-challenge/${challenge.nonce}`) {
        throw new Error("Challenge object must be .gendragoon-challenge/<nonce>");
      }
      const proof = await performOwnershipChallenge({
        challengeId: challenge.nonce,
        nonce: challenge.nonce,
        now: Date.now(),
        writer: {
          async write() {
            // The device writes the object with the keychain secret. That secret is not returned.
          },
          async presignGet(key) {
            return presignChallengeGet({ endpoint: record.endpoint, bucket: input.bucket, key, accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey, expiresInSeconds: 300 });
          },
        },
      });
      await client.submitByoProof(workspaceId, proof);
      await loadWorkspaces();
    } catch (error) {
      throw new Error(byoErrorMessage(error));
    }
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
      if (error instanceof TeamOwnerMustTransferError) {
        // Nothing was deleted: the user owns teams with other members.
        setDeletionNotice({ message: error.message, retryable: false });
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

  const setupWorkspace = setupId ? workspaces.find((workspace) => workspace.id === setupId) ?? null : null;
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
            <p className="sub">Each workspace has its own storage and performance plan. The workspace fee is included.</p>
          </div>
          {!showNew ? <button type="button" className="btn" data-testid="new-workspace-open" onClick={() => setShowNew(true)}>New workspace</button> : null}
        </header>
        {workspaceError ? <div className="banner" role="alert" data-testid="workspace-error">{workspaceError}</div> : null}
        {showNew ? (
          <NewWorkspace
            freeProjectAvailable={freeProjectAvailable}
            pricing={pricing}
            intentId={intentId}
            busy={creating}
            onSubmit={(request) => void onCreateWorkspace(request)}
            onCancel={() => setShowNew(false)}
          />
        ) : null}
        {setupWorkspace ? (
          <CustomStorageWizard
            workspaceName={setupWorkspace.name}
            onTest={(credentials) => runCustomStorageTest(setupWorkspace.id, credentials)}
            onDone={() => setSetupId(null)}
          />
        ) : null}
        <div className="panel" data-testid="workspace-list">
          {workspaces.map((workspace) => {
            const pending = workspace.projectStatus === "pending_payment";
            const needsSetup = workspace.customStorage === true && workspace.projectStatus === "active" && workspace.byoRegistered !== true;
            const plan = workspace.isFree ? "Free · 2 GB" : workspacePlansLabel(workspace) ?? workspace.storageTier ?? (workspace.kind === "byo" ? "Custom storage" : "");
            return (
              <div className="workspace-row" key={workspace.id} data-testid={`workspace-${workspace.id}`}>
                <span>{workspace.name || workspace.id}</span>
                <span className="chip">{pending ? "Payment needed" : plan}</span>
                {pending ? (
                  <button type="button" className="btn" data-testid={`checkout-${workspace.id}`} onClick={() => void onResumeCheckout(workspace.id)}>Continue to checkout</button>
                ) : needsSetup ? (
                  <button type="button" className="btn" data-testid={`setup-${workspace.id}`} onClick={() => setSetupId(workspace.id)}>Finish setup</button>
                ) : <span />}
              </div>
            );
          })}
        </div>
      </section>
    );
  } else if (view === "teams") {
    body = (
      <TeamsView
        client={providerClient}
        openBilling={openBilling}
        pricing={pricing}
        personalWorkspaces={workspaces.map((w) => ({ id: w.id, name: w.name || w.id }))}
      />
    );
  } else if (view === "connections") {
    body = (
      <RedxConnections
        bindings={bindings}
        error={bindingsError}
        workspaces={workspaces.filter((w) => w.kind !== "byo").map((w) => ({ id: w.id, name: w.name || w.id }))}
        grant={grant}
        // TODO(connect links): gendragoon://connect?… from RedX (PKCE) needs a protocol handler in main.ts and a
        // preload bridge; parseConnectRequest/authorizeProvider/connectRedirect in core are ready for it.
        pendingRequest={null}
        busyId={revokingId}
        connecting={connecting}
        onCreateGrant={(id) => void onCreateGrant(id)}
        onApproveRequest={() => {}}
        onDenyRequest={() => {}}
        onRevoke={(id, deleteData) => void onRevokeBinding(id, deleteData)}
        onRetry={() => void loadBindings()}
        onCopy={(value) => void navigator.clipboard?.writeText(value)}
      />
    );
  } else if (view === "settings") {
    body = (
      <>
      <UpdateControl state={updateState} onCheck={checkForUpdates} ui={updateUi.ui} note={updateUi.note} />
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
      </>
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
