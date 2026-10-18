import {
  ApiError,
  COMING_SOON_BYO_PROVIDERS,
  LAUNCH_BYO_PROVIDERS,
  PASSPHRASE_LOSS_WARNING,
  SUPPORT_CONTACT,
  SORT_CATEGORIES,
  accountUidFromIdToken,
  actionsForMode,
  applySortOverride,
  byoErrorMessage,
  categorize,
  challengeObjectKey,
  planMerge,
  planSummary,
  type LockAssessment,
  type SecretStore,
  type SortOverrides,
  type TreeNode,
  type WorkspaceRecord,
} from "@gendragoon/core";
import { colors, space, type as typeScale } from "@gendragoon/ui/theme";
import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  applyAuthFailureSignal,
  deletionSessionAction,
  deleteSignedInAccount,
  dismissSignedInDeletion,
  isDeletionNotRetryableError,
  resumeSignedInDeletion,
  retrySignedInDeletion,
  savedDeletionStatusToken,
  savedDeletionUid,
} from "./account/deleteAccount";
import { SAME_ACCOUNT_MESSAGE, sessionMaySwap } from "./account/session";
import { byoServerFlowReady } from "./byoReady";
import { DELETION_SUPPORT_ENDPOINT_ENABLED, ENCRYPTED_WORKSPACE_ENABLED, WORKSPACE_PRICING_ENABLED } from "./flags";
import {
  additionalWorkspaceFeeText,
  includedPricingEndsWarning,
  serverPriceLabel,
  unpaidWorkspaceSubtitle,
  workspaceQuoteExplanation,
} from "./pricing";
import { WORKSPACE_BUSY_MESSAGE, graceBanner, isDeletingWorkspace, isWorkspaceBusy } from "./workspaceState";
import { SUPPORT_REQUEST_ALREADY, SUPPORT_REQUEST_SENT, requestDeletionSupport } from "./supportRequest";
import { supportContactTarget } from "./supportContact";
import { Banner, Button, Screen, Title, cardStyle } from "./ui";

export function workspacesWithUnpaid<T extends { id: string }>(
  workspaces: readonly T[],
  unpaidIds: readonly string[],
): Array<T & { unpaid: boolean }> {
  const unpaid = new Set(unpaidIds);
  return workspaces.map((workspace) => ({ ...workspace, unpaid: unpaid.has(workspace.id) }));
}

export function SignInScreen(props: {
  onSignIn: () => void;
  googleEnabled: boolean;
  blockedMessage?: string | null;
}) {
  return (
    <Screen testID="sign-in-screen">
      <Title kicker="GenDragoon">Cloud SSD</Title>
      <Text style={styles.help}>Files stay encrypted on this device before they upload.</Text>
      {props.blockedMessage ? <Banner testID="session-error">{props.blockedMessage}</Banner> : null}
      <Button label="Sign in" testID="sign-in" onPress={props.onSignIn} />
      {props.googleEnabled ? <Text style={styles.help}>Google is configured for this build.</Text> : null}
    </Screen>
  );
}

/**
 * Compares the proposed account with the deletion job before the session
 * token changes. A mismatch leaves the current token in place.
 */
export function SignInSession(props: {
  secrets: SecretStore;
  sessionToken: string;
  nextToken: string;
  googleEnabled: boolean;
  onSwapped: (token: string) => void;
}) {
  const [token, setToken] = useState(props.sessionToken);
  const [error, setError] = useState<string | null>(null);
  async function signIn() {
    const currentUid = accountUidFromIdToken(props.sessionToken);
    const savedUid = await savedDeletionUid(props.secrets);
    const nextUid = accountUidFromIdToken(props.nextToken);
    if (!sessionMaySwap(currentUid, nextUid) || !sessionMaySwap(savedUid, nextUid)) {
      setError(SAME_ACCOUNT_MESSAGE);
      return;
    }
    setError(null);
    setToken(props.nextToken);
    props.onSwapped(props.nextToken);
  }
  return (
    <View>
      <Text testID="session-uid">{accountUidFromIdToken(token) ?? ""}</Text>
      <SignInScreen
        googleEnabled={props.googleEnabled}
        blockedMessage={error}
        onSignIn={() => void signIn()}
      />
    </View>
  );
}

export interface WorkspaceLockBody {
  reason: string;
  overBy: number;
  unpaidWorkspaceIds: readonly string[];
}

/**
 * Same copy as the shared lock surface in `@gendragoon/ui`.
 * The screen switches on the top-level `reason`.
 */
const LOCK_REASON: Record<string, string> = {
  over_cap: "This account is over the workspace cap.",
  lapsed: "A workspace payment has lapsed. Pay to restore this workspace.",
  over_cap_and_lapsed: "This account is over the cap and a workspace payment has lapsed. Pay to restore this workspace.",
  scope_unavailable: "Workspace scope is unavailable.",
  merge_in_progress: "A merge is in progress.",
};

function overPlanNotice(overBy: number): string {
  const noun = overBy === 1 ? "workspace" : "workspaces";
  return `You're ${overBy} ${noun} over your plan.`;
}

export function lockReasonMessage(reason: string, overBy = 0): string {
  const lead = LOCK_REASON[reason] ?? "This workspace is locked.";
  const overCap = reason === "over_cap" || reason === "over_cap_and_lapsed";
  if (overCap && overBy > 0) return `${lead} ${overPlanNotice(overBy)}`;
  return lead;
}

export function LockScreen(props: {
  access?: LockAssessment;
  workspaces: readonly WorkspaceRecord[];
  /** HTTP 423 `workspace_lock` body. Displayed as sent. */
  lock?: WorkspaceLockBody;
  /** Lapsed and unpaid workspaces lock only this screen, not the rest of the app. */
  workspaceOnly?: boolean;
  onReview: () => void;
  onPay?: () => void;
}) {
  const summary = props.access ? planSummary(props.access) : null;
  const unpaidIds = props.lock?.unpaidWorkspaceIds ?? props.access?.unpaidIds ?? [];
  const rows = workspacesWithUnpaid(props.workspaces, unpaidIds);
  const known = new Set(rows.map((workspace) => workspace.id));
  const unmatched = unpaidIds.filter((id) => !known.has(id));
  const payFirst = props.lock?.reason === "lapsed" || props.lock?.reason === "over_cap_and_lapsed";
  const workspaceOnly = props.workspaceOnly === true;
  return (
    <Screen testID="lock-screen">
      <Title kicker="Workspaces">{workspaceOnly ? (rows[0]?.name ?? "This workspace") : "Resolve workspaces to continue"}</Title>
      {workspaceOnly ? (
        <Banner testID="lock-banner">This workspace is locked. Your other workspaces stay usable. Downloads stay available.</Banner>
      ) : summary ? (
        <Banner testID="lock-banner">
          {`This account is ${summary.locked ? "locked" : "open"} (${summary.used} of ${summary.limit}). Downloads stay available.`}
        </Banner>
      ) : (
        <Banner testID="lock-banner">Downloads stay available.</Banner>
      )}
      {props.lock ? (
        <Text testID="lock-reason" style={styles.help}>{lockReasonMessage(props.lock.reason, props.lock.overBy)}</Text>
      ) : null}
      {rows.map((workspace) => (
        <Text key={workspace.id} testID={`lock-workspace-${workspace.id}`} style={styles.help}>
          {workspace.name}{workspace.unpaid ? " · unpaid" : ""}
        </Text>
      ))}
      {unmatched.map((id) => (
        <Text key={id} testID={`lock-unmatched-${id}`} style={styles.help}>{`${id} · unpaid`}</Text>
      ))}
      {payFirst ? <Button label="Pay to restore" testID="pay-to-restore" onPress={() => props.onPay?.()} /> : null}
      <Button label="Review workspaces" tone={payFirst ? "ghost" : "primary"} testID="review-workspaces" onPress={props.onReview} />
    </Screen>
  );
}

export function FileTree(props: {
  mode: "upload" | "backup";
  nodes: readonly TreeNode[];
  locked: boolean;
  selected: TreeNode | null;
  onSelect: (node: TreeNode) => void;
  onUpload?: () => void;
  onBackup?: () => void;
  onRefresh: () => void;
}) {
  const actions = actionsForMode(props.mode, props.selected, { uploadsBlocked: props.locked });
  const groups = new Map<string, TreeNode[]>();
  for (const node of props.nodes) {
    const category = categorize({ name: node.name, kind: node.kind === "app" ? "app" : "file" });
    const list = groups.get(category) ?? [];
    list.push(node);
    groups.set(category, list);
  }
  return (
    <Screen testID={props.mode === "backup" ? "backup-screen" : "files-screen"}>
      <Title kicker={props.mode === "backup" ? "Backup" : "Files"}>{props.mode === "backup" ? "Secure backup" : "Library"}</Title>
      <Button label="Refresh" tone="ghost" onPress={props.onRefresh} testID="refresh" />
      {[...groups.entries()].map(([category, nodes]) => (
        <View key={category} style={cardStyle()}>
          <Text style={styles.category}>{category}</Text>
          {nodes.map((node) => (
            <Button
              key={node.id}
              label={node.name}
              tone="ghost"
              testID={`file-${node.name}`}
              onPress={() => props.onSelect(node)}
            />
          ))}
        </View>
      ))}
      {ENCRYPTED_WORKSPACE_ENABLED && actions.canUpload && props.onUpload ? (
        <Button label="Upload" testID="upload-button" onPress={props.onUpload} />
      ) : null}
      {ENCRYPTED_WORKSPACE_ENABLED && actions.canBackup && props.onBackup ? (
        <Button label={actions.primaryLabel ?? "Make secure backup"} testID="backup-button" onPress={props.onBackup} />
      ) : null}
    </Screen>
  );
}

export interface ServerMergePreview {
  confirmName: string;
  sourceId: string;
  targetId: string;
  files: readonly { name: string; renamedTo: string; sizeBytes: number }[];
}

export interface ServerMergeResult {
  merged: boolean;
  sourceDeleted: boolean;
  sourceId: string;
  workspaceId: string;
  copied: number;
}

export type ListedWorkspace = WorkspaceRecord;

export function NewWorkspaceScreen(props: {
  /** Server quote for a hosted workspace. Not a client-side count. */
  quote: unknown;
  /** Server quote for bring-your-own storage. Falls back to rule text when the amount is missing. */
  byoQuote?: unknown;
  onCreate: (input: { name: string; storage: "hosted" | "byo"; providerId: string | null }) => void;
  /** Overrides `WORKSPACE_PRICING_ENABLED` in tests. */
  pricingEnabled?: boolean;
  initialName?: string;
  initialStorage?: "hosted" | "byo";
  initialProviderId?: string | null;
}) {
  const [name, setName] = useState(props.initialName ?? "");
  const [storage, setStorage] = useState<"hosted" | "byo">(props.initialStorage ?? "hosted");
  const [providerId, setProviderId] = useState<string | null>(props.initialProviderId ?? LAUNCH_BYO_PROVIDERS[0]?.id ?? null);
  const showPrice = props.pricingEnabled ?? WORKSPACE_PRICING_ENABLED;
  const quote = storage === "byo" ? (props.byoQuote ?? props.quote) : props.quote;
  const label = showPrice ? serverPriceLabel(quote) : null;
  const explanation = showPrice ? workspaceQuoteExplanation(storage, quote) : null;
  const ready = name.trim().length > 0;
  return (
    <Screen testID="new-workspace-screen">
      <Title kicker="Workspaces">New workspace</Title>
      <Text style={styles.label}>Workspace name</Text>
      <TextInput
        accessibilityLabel="Workspace name"
        placeholder="Workspace name"
        placeholderTextColor={colors.muted}
        style={styles.input}
        value={name}
        onChangeText={setName}
        testID="workspace-name"
      />
      <Text style={styles.label}>Storage</Text>
      <Button
        label="Hosted"
        tone={storage === "hosted" ? "primary" : "ghost"}
        testID="storage-hosted"
        accessibilityLabel="Hosted storage"
        onPress={() => setStorage("hosted")}
      />
      <Button
        label="Bring your own storage"
        tone={storage === "byo" ? "primary" : "ghost"}
        testID="storage-byo"
        accessibilityLabel="Bring your own storage"
        onPress={() => setStorage("byo")}
      />
      {storage === "byo" ? (
        <View testID="create-byo-providers">
          {LAUNCH_BYO_PROVIDERS.map((provider) => (
            <Button
              key={provider.id}
              label={provider.label}
              tone={providerId === provider.id ? "primary" : "ghost"}
              testID={`create-byo-${provider.id}`}
              accessibilityLabel={provider.label}
              onPress={() => setProviderId(provider.id)}
            />
          ))}
          {COMING_SOON_BYO_PROVIDERS.map((provider) => (
            <Text key={provider.id} testID={`create-byo-soon-${provider.id}`} style={styles.soon}>{`${provider.label} · Coming soon`}</Text>
          ))}
        </View>
      ) : null}
      {explanation ? <Text testID="new-workspace-explain" style={styles.help}>{explanation}</Text> : null}
      {label ? <Text testID="new-workspace-price" style={styles.help}>{label}</Text> : null}
      <Button
        label="Create workspace"
        testID="create-workspace"
        disabled={!ready}
        onPress={() => props.onCreate({ name: name.trim(), storage, providerId: storage === "byo" ? providerId : null })}
      />
    </Screen>
  );
}

export function WorkspacesScreen(props: {
  workspaces: readonly ListedWorkspace[];
  unpaidIds: readonly string[];
  /** Server `workspaceMonthlyCents`. The fee banner is omitted when this is missing. */
  additionalMonthlyCents?: number;
  capMessage?: string | null;
  serverPreview?: ServerMergePreview | null;
  mergeError?: string | null;
  mergeResult?: ServerMergeResult | null;
  mergedFiles?: readonly { id: string; name: string }[] | null;
  onDelete: (id: string) => void | Promise<void>;
  onMerge: (sourceId: string, targetId: string) => void;
  /** Opens this workspace. A lapsed one locks only its own screen. */
  onOpen?: (workspaceId: string) => void;
  /** Same checkout path as the lapsed lock screen, for one unpaid workspace. */
  onPay?: (workspaceId: string) => void;
  /**
   * Server grace deadline per workspace id, milliseconds.
   * Provisional until cloud-ssd PR #5 reports the pay-by field.
   */
  gracePayByMs?: Readonly<Record<string, number>>;
  /** Overrides `WORKSPACE_PRICING_ENABLED` in tests. */
  pricingEnabled?: boolean;
}) {
  const showPrice = props.pricingEnabled ?? WORKSPACE_PRICING_ENABLED;
  const feeText = additionalWorkspaceFeeText(props.additionalMonthlyCents);
  const rows = workspacesWithUnpaid(props.workspaces, props.unpaidIds);
  const [sourceId, setSourceId] = useState(rows[0]?.id ?? "");
  const [targetId, setTargetId] = useState(rows[1]?.id ?? rows[0]?.id ?? "");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const deletingIds = new Set(rows.filter((workspace) => isDeletingWorkspace(workspace)).map((workspace) => workspace.id));
  const localPreview = props.serverPreview || !sourceId || !targetId || sourceId === targetId
    ? []
    : planMerge([{ path: "Photos/cat.jpg" }], rows.find((row) => row.id === sourceId)?.name ?? "source", ["Photos/cat.jpg"]);
  async function confirmDelete(id: string) {
    try {
      await props.onDelete(id);
      setPendingDeleteId(null);
      setBusyMessage(null);
    } catch (error) {
      if (!isWorkspaceBusy(error)) throw error;
      setPendingDeleteId(null);
      setBusyMessage(WORKSPACE_BUSY_MESSAGE);
    }
  }
  return (
    <Screen testID="workspaces-screen">
      <Title kicker="Workspaces">Your spaces</Title>
      {feeText ? <Banner testID="workspace-fee">{feeText}</Banner> : null}
      {busyMessage ? <Banner testID="workspace-busy">{busyMessage}</Banner> : null}
      {props.capMessage ? <Banner testID="workspace-cap">{props.capMessage}</Banner> : null}
      {rows.map((workspace) => {
        const deleting = deletingIds.has(workspace.id);
        const graceMs = props.gracePayByMs?.[workspace.id];
        const inGrace = typeof graceMs === "number" && Number.isFinite(graceMs);
        const price = deleting || inGrace
          ? null
          : workspace.unpaid
            ? unpaidWorkspaceSubtitle(workspace.monthlyPriceCents)
            : showPrice ? serverPriceLabel(workspace) : null;
        const confirming = pendingDeleteId === workspace.id;
        return (
          <View key={workspace.id} style={cardStyle()}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${workspace.name}`}
              testID={`open-${workspace.id}`}
              onPress={() => props.onOpen?.(workspace.id)}
            >
              <Text testID={`workspace-name-${workspace.id}`} style={styles.category}>{workspace.name}</Text>
            </Pressable>
            {deleting ? <Text testID={`workspace-deleting-${workspace.id}`} style={styles.help}>Deleting...</Text> : null}
            {inGrace ? <Banner testID={`workspace-grace-${workspace.id}`}>{graceBanner(graceMs)}</Banner> : null}
            {price ? <Text testID={`workspace-price-${workspace.id}`} style={styles.help}>{price}</Text> : null}
            {inGrace ? (
              <Button
                label="Pay"
                testID={`pay-grace-${workspace.id}`}
                accessibilityLabel={`Pay ${workspace.name}`}
                disabled={deleting}
                onPress={() => props.onPay?.(workspace.id)}
              />
            ) : null}
            {workspace.unpaid && !inGrace ? (
              <Button
                label="Pay to restore"
                testID={`pay-to-restore-${workspace.id}`}
                accessibilityLabel={`Pay to restore ${workspace.name}`}
                disabled={deleting}
                onPress={() => props.onPay?.(workspace.id)}
              />
            ) : null}
            {confirming && !deleting ? (
              <View>
                <Text style={styles.help}>{`Delete ${workspace.name}?`}</Text>
                <Button
                  label="Delete workspace"
                  tone="danger"
                  compact
                  testID={`confirm-delete-${workspace.id}`}
                  accessibilityLabel={`Confirm delete ${workspace.name}`}
                  onPress={() => confirmDelete(workspace.id)}
                />
                <Button
                  label="Cancel"
                  tone="ghost"
                  compact
                  testID={`cancel-delete-${workspace.id}`}
                  onPress={() => setPendingDeleteId(null)}
                />
              </View>
            ) : (
              <Button
                label="Delete"
                tone="ghost"
                destructive
                compact
                testID={`delete-${workspace.id}`}
                accessibilityLabel={`Delete ${workspace.name}`}
                disabled={deleting}
                onPress={() => setPendingDeleteId(workspace.id)}
              />
            )}
          </View>
        );
      })}
      {props.serverPreview ? (
        <View testID="merge-preview">
          {props.serverPreview.files.map((file) => (
            <Text key={file.name} style={styles.help}>{`${file.name} → ${file.renamedTo}`}</Text>
          ))}
        </View>
      ) : (
        <Text style={styles.help}>{localPreview[0] ? `${localPreview[0].sourcePath} → ${localPreview[0].targetPath}` : "Choose two workspaces to preview a merge."}</Text>
      )}
      {props.mergeError ? <Banner testID="merge-error">{props.mergeError}</Banner> : null}
      {props.mergeResult?.merged ? (
        <Text testID="merge-result" style={styles.help}>
          {`Merged ${props.mergeResult.copied} into ${props.mergeResult.workspaceId}${props.mergeResult.sourceDeleted ? ". Source deleted." : ""}`}
        </Text>
      ) : null}
      {props.mergedFiles?.map((file) => (
        <Text key={file.id} testID={`merged-file-${file.id}`} style={styles.help}>{file.name}</Text>
      ))}
      <Text style={styles.label}>Source</Text>
      <View testID="merge-source">
        {rows.map((workspace) => (
          <Button
            key={`source-${workspace.id}`}
            label={workspace.name}
            tone={sourceId === workspace.id ? "primary" : "ghost"}
            testID={`merge-source-${workspace.id}`}
            accessibilityLabel={`Merge source ${workspace.name}`}
            disabled={deletingIds.has(workspace.id)}
            onPress={() => setSourceId(workspace.id)}
          />
        ))}
      </View>
      <Text style={styles.label}>Target</Text>
      <View testID="merge-target">
        {rows.map((workspace) => (
          <Button
            key={`target-${workspace.id}`}
            label={workspace.name}
            tone={targetId === workspace.id ? "primary" : "ghost"}
            testID={`merge-target-${workspace.id}`}
            accessibilityLabel={`Merge target ${workspace.name}`}
            disabled={deletingIds.has(workspace.id)}
            onPress={() => setTargetId(workspace.id)}
          />
        ))}
      </View>
      <Button
        label="Merge"
        testID="merge-workspaces"
        disabled={!sourceId || !targetId || sourceId === targetId || deletingIds.has(sourceId) || deletingIds.has(targetId)}
        onPress={() => props.onMerge(sourceId, targetId)}
      />
    </Screen>
  );
}

export function SortScreen(props: {
  overrides: SortOverrides;
  onChange: (overrides: SortOverrides) => void;
}) {
  const sample = "vacation.jpg";
  const category = categorize({ name: sample }, props.overrides);
  return (
    <Screen testID="sort-screen">
      <Title kicker="Settings">Type sort</Title>
      <Text style={styles.help} testID="sort-.jpg">{`${sample} sorts to ${category}`}</Text>
      {SORT_CATEGORIES.map((item) => (
        <Button
          key={item}
          label={item}
          tone="ghost"
          testID={`sort-category-${item}`}
          onPress={() => props.onChange(applySortOverride(props.overrides, { extension: ".jpg", category: item }))}
        />
      ))}
    </Screen>
  );
}

export function ConnectStorageScreen(props: {
  registration?: { endpoint: string; providerType: string; byoRegistered: boolean } | null;
  challengeNonce?: string | null;
  verified?: { verified: boolean; workspaceId: string } | null;
  error?: unknown;
  onSelectProvider?: (providerId: string) => void;
  /**
   * Set when this workspace is grandfathered. Registering BYO ends that
   * pricing. Provisional until the server quote is on the register route.
   */
  endsIncludedPricingCents?: number | null;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [acceptedLoss, setAcceptedLoss] = useState(props.endsIncludedPricingCents == null);
  const ready = byoServerFlowReady();
  const challengeKey = props.challengeNonce ? challengeObjectKey(props.challengeNonce) : null;
  const errorText = props.error ? byoErrorMessage(props.error) : null;
  const providersOpen = ready && acceptedLoss;
  return (
    <Screen testID="connect-storage">
      <Title kicker="Settings">Connect storage</Title>
      {ready ? (
        <Text style={styles.help}>S3-compatible buckets only. Verification runs through the server.</Text>
      ) : (
        <Text testID="byo-unavailable" style={styles.help}>
          Bring-your-own storage is unavailable until the server can register, challenge, and verify the bucket.
        </Text>
      )}
      {props.endsIncludedPricingCents != null ? (
        <Banner testID="byo-included-warning">{includedPricingEndsWarning(props.endsIncludedPricingCents)}</Banner>
      ) : null}
      {props.endsIncludedPricingCents != null && !acceptedLoss ? (
        <Button
          label="Continue"
          testID="byo-end-included"
          onPress={() => setAcceptedLoss(true)}
        />
      ) : null}
      {providersOpen ? LAUNCH_BYO_PROVIDERS.map((provider) => (
        <Button
          key={provider.id}
          label={provider.label}
          tone="ghost"
          testID={`byo-${provider.id}`}
          onPress={() => {
            setSelected(provider.id);
            props.onSelectProvider?.(provider.id);
          }}
        />
      )) : null}
      {providersOpen && selected ? <Text testID="byo-selected" style={styles.help}>{selected}</Text> : null}
      <Text style={styles.help}>Coming soon</Text>
      {COMING_SOON_BYO_PROVIDERS.map((provider) => (
        <Text key={provider.id} testID={`byo-soon-${provider.id}`} style={styles.soon}>{`${provider.label} · Coming soon`}</Text>
      ))}
      {props.registration?.byoRegistered ? (
        <Text testID="byo-registered" style={styles.help}>{`${props.registration.providerType} · ${props.registration.endpoint}`}</Text>
      ) : null}
      {challengeKey ? <Text testID="byo-challenge-key" style={styles.help}>{challengeKey}</Text> : null}
      {props.verified?.verified ? (
        <Text testID="byo-verified" style={styles.help}>{props.verified.workspaceId}</Text>
      ) : null}
      {errorText ? <Banner testID="byo-error">{errorText}</Banner> : null}
    </Screen>
  );
}

const PASSPHRASE_MIN = 8;

export function PassphraseScreen(props: {
  onSubmit: (passphrase: string) => void;
  initialPassphrase?: string;
  initialConfirm?: string;
  initialChecked?: boolean;
  initialRevealed?: boolean;
}) {
  const [value, setValue] = useState(props.initialPassphrase ?? "");
  const [again, setAgain] = useState(props.initialConfirm ?? "");
  const [ack, setAck] = useState(props.initialChecked ?? false);
  const [revealed, setRevealed] = useState(props.initialRevealed ?? false);
  const longEnough = value.length >= PASSPHRASE_MIN;
  const mismatch = again.length > 0 && again !== value;
  const ready = longEnough && value === again && ack;
  return (
    <Screen testID="passphrase-screen">
      <Title kicker="Recovery">Set a passphrase</Title>
      <Banner>{PASSPHRASE_LOSS_WARNING}</Banner>
      <Text style={styles.label}>Passphrase</Text>
      <TextInput
        accessibilityLabel="Passphrase"
        placeholder="Passphrase"
        placeholderTextColor={colors.muted}
        secureTextEntry={!revealed}
        style={styles.input}
        value={value}
        onChangeText={setValue}
        testID="passphrase"
      />
      <Text style={styles.label}>Confirm passphrase</Text>
      <TextInput
        accessibilityLabel="Confirm passphrase"
        placeholder="Confirm passphrase"
        placeholderTextColor={colors.muted}
        secureTextEntry={!revealed}
        style={styles.input}
        value={again}
        onChangeText={setAgain}
        testID="passphrase-confirm"
      />
      <Button
        label={revealed ? "Hide passphrase" : "Show passphrase"}
        tone="ghost"
        compact
        testID="passphrase-visibility"
        accessibilityLabel={revealed ? "Hide passphrase" : "Show passphrase"}
        onPress={() => setRevealed((shown) => !shown)}
      />
      <Text testID="passphrase-hint" style={styles.help}>
        {longEnough ? "At least 8 characters." : "Use at least 8 characters."}
      </Text>
      {mismatch ? <Text testID="passphrase-mismatch" style={styles.error}>Passphrases don't match</Text> : null}
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel="I understand I can lose my files"
        accessibilityState={{ checked: ack }}
        testID="passphrase-ack"
        onPress={() => setAck((checked) => !checked)}
        style={styles.checkRow}
      >
        <Text style={styles.category}>{ack ? "☑" : "☐"}</Text>
        <Text style={styles.help}>I understand I can lose my files</Text>
      </Pressable>
      <Button label="Save passphrase" testID="passphrase-save" disabled={!ready} onPress={() => props.onSubmit(value)} />
    </Screen>
  );
}

export type DeletionFrame = "confirm" | "reauth" | "progress" | "retry" | "dismiss" | "not-retryable";

type DeletionNoticeKind = "progress" | "retry" | "dismiss" | "reauth" | "missing" | "offline" | "not-retryable";

interface DeletionNotice {
  kind: DeletionNoticeKind;
  message: string;
  retry: boolean;
  dismiss: boolean;
  reauth: boolean;
  progress: boolean;
  support: boolean;
  hideSignInHelp: boolean;
  jobId?: string;
}

function deletionNotice(kind: DeletionNoticeKind): DeletionNotice {
  if (kind === "progress") {
    return { kind, message: "Deletion is running.", retry: false, dismiss: false, reauth: false, progress: true, support: false, hideSignInHelp: false };
  }
  if (kind === "retry") {
    return { kind, message: "Deletion didn't finish. Retry picks up where it stopped.", retry: true, dismiss: false, reauth: false, progress: false, support: false, hideSignInHelp: false };
  }
  if (kind === "dismiss") {
    return { kind, message: "Account deletion failed.", retry: false, dismiss: true, reauth: false, progress: false, support: true, hideSignInHelp: false };
  }
  if (kind === "not-retryable") {
    return {
      kind,
      message: "We couldn't finish deleting your account. Contact support and we'll complete it for you.",
      retry: false,
      dismiss: true,
      reauth: false,
      progress: false,
      support: true,
      hideSignInHelp: true,
    };
  }
  if (kind === "reauth") {
    return { kind, message: "Sign in again. Your last sign-in is older than 5 minutes.", retry: false, dismiss: false, reauth: true, progress: false, support: false, hideSignInHelp: false };
  }
  if (kind === "offline") {
    return { kind, message: "Could not reach the server. Try again.", retry: true, dismiss: true, reauth: false, progress: false, support: false, hideSignInHelp: false };
  }
  return { kind, message: "The deletion status could not be loaded.", retry: true, dismiss: true, reauth: false, progress: false, support: false, hideSignInHelp: false };
}

export function DeleteAccountScreen(props: {
  activeTransfers: number;
  secrets: SecretStore;
  workspaceIds: readonly string[];
  idToken: string;
  client: Parameters<typeof deleteSignedInAccount>[0]["client"];
  onReauth: () => void;
  onSignedOut: () => void;
  onDone: () => void;
  onError: (message: string) => void;
  /** Clears the session token only. The progress screen stays mounted and polling continues. */
  onClearSession?: () => void;
  /** Static frame for screenshots. Live deletion ignores it. */
  frame?: DeletionFrame;
  /** Job id used in the support mail subject for a static frame. */
  jobId?: string;
  /** Overrides the build flag in tests. Production reads `DELETION_SUPPORT_ENDPOINT_ENABLED`. */
  supportEndpointEnabled?: boolean;
  apiBase?: string;
  supportFetch?: typeof fetch;
}) {
  const [step, setStep] = useState<"review" | "confirm">(props.frame === "confirm" ? "confirm" : "review");
  const [notice, setNotice] = useState<DeletionNotice | null>(
    props.frame && props.frame !== "confirm" ? { ...deletionNotice(props.frame), jobId: props.jobId } : null,
  );
  const [supportNotice, setSupportNotice] = useState<string | null>(null);
  const blocked = props.activeTransfers > 0;
  function authHooks() {
    return {
      onAuthFailure: (signal: string, error: unknown) => {
        applyAuthFailureSignal(signal, error, {
          // Core also calls `clearSession`. Doing it here as well would clear twice.
          clearSession: () => undefined,
          showReauth: () => setNotice(deletionNotice("reauth")),
        });
      },
      clearSession: () => props.onClearSession?.(),
    };
  }
  function showFailure(error: unknown) {
    if (isDeletionNotRetryableError(error)) {
      setNotice({ ...deletionNotice("not-retryable"), jobId: error.jobId });
      return;
    }
    const action = deletionSessionAction(error);
    // `signed_out` already cleared the session. Leave the progress screen up.
    if (action === "sign-out") return;
    if (action === "reauth" || (error instanceof ApiError && error.status === 401)) {
      setNotice(deletionNotice("reauth"));
      props.onReauth();
      return;
    }
    if (error instanceof ApiError && error.status === 404) {
      setNotice(deletionNotice("missing"));
      return;
    }
    if (error instanceof ApiError && error.status === 0) {
      setNotice(deletionNotice("offline"));
      return;
    }
    props.onError(error instanceof Error ? error.message : "Account deletion failed");
  }
  function applyStatus(status: { status: string; jobId: string; retryable?: boolean }) {
    if (status.status === "done") {
      props.onDone();
      return;
    }
    if (status.status === "failed") {
      const retryable = status.retryable === true;
      setNotice({ ...deletionNotice(retryable ? "retry" : "dismiss"), jobId: status.jobId });
      return;
    }
    props.onError("Account deletion did not finish. Local keys were kept.");
  }
  function deletionInput() {
    return {
      client: props.client,
      idToken: props.idToken,
      workspaceIds: props.workspaceIds,
      secrets: props.secrets,
      ...authHooks(),
    };
  }
  async function confirm() {
    setNotice(deletionNotice("progress"));
    try {
      applyStatus(await deleteSignedInAccount(deletionInput()));
    } catch (error) {
      showFailure(error);
    }
  }
  async function retry() {
    const kind = notice?.kind;
    setNotice(deletionNotice("progress"));
    try {
      const status = kind === "retry"
        ? await retrySignedInDeletion(deletionInput())
        : await resumeSignedInDeletion(deletionInput());
      if (!status) {
        props.onError("Account deletion did not finish. Local keys were kept.");
        return;
      }
      applyStatus(status);
    } catch (error) {
      showFailure(error);
    }
  }
  async function dismiss() {
    await dismissSignedInDeletion(props.secrets);
    setNotice(null);
  }
  async function contact() {
    const jobId = notice?.jobId ?? "";
    const enabled = props.supportEndpointEnabled ?? DELETION_SUPPORT_ENDPOINT_ENABLED;
    if (enabled) {
      const statusToken = await savedDeletionStatusToken(props.secrets);
      if (statusToken) {
        const result = await requestDeletionSupport({
          baseUrl: props.apiBase ?? "https://api.example.test",
          jobId,
          statusToken,
          fetchImpl: props.supportFetch,
        });
        if (result.kind === "sent") {
          setSupportNotice(SUPPORT_REQUEST_SENT);
          return;
        }
        if (result.kind === "already") {
          setSupportNotice(SUPPORT_REQUEST_ALREADY);
          return;
        }
        if (result.kind === "refresh") {
          try {
            applyStatus(await props.client.deletionStatus(jobId, statusToken));
          } catch (error) {
            showFailure(error);
          }
          return;
        }
      }
    }
    await Linking.openURL(supportContactTarget(SUPPORT_CONTACT.value, jobId));
  }
  return (
    <Screen testID="delete-account-screen">
      <Title kicker="Account">Delete account</Title>
      {notice?.hideSignInHelp ? null : (
        <Text testID="deletion-signin-help" style={styles.help}>Sign in again if this sign-in is more than five minutes old. Local keys are removed only when deletion is done.</Text>
      )}
      {blocked ? <Banner>Delete account is disabled during transfers.</Banner> : null}
      {notice ? (
        <Banner testID={notice.progress ? "deletion-progress" : "deletion-error"}>{notice.message}</Banner>
      ) : null}
      {supportNotice === SUPPORT_REQUEST_SENT ? <Banner testID="support-request-sent">{SUPPORT_REQUEST_SENT}</Banner> : null}
      {supportNotice === SUPPORT_REQUEST_ALREADY ? <Banner testID="support-request-already">{SUPPORT_REQUEST_ALREADY}</Banner> : null}
      {notice?.support && __DEV__ && SUPPORT_CONTACT.isPlaceholder ? (
        <Text testID="support-placeholder-note" style={styles.devNote}>placeholder contact</Text>
      ) : null}
      {notice?.retry ? <Button label="Retry" testID="deletion-retry" onPress={() => void retry()} /> : null}
      {notice?.reauth ? <Button label="Sign in again" testID="deletion-reauth" onPress={props.onReauth} /> : null}
      {notice?.support ? (
        <Button
          label="Contact support"
          testID="contact-support"
          accessibilityLabel="Contact support"
          onPress={() => void contact()}
        />
      ) : null}
      {notice?.dismiss ? <Button label="Dismiss" tone="ghost" testID="deletion-dismiss" onPress={() => void dismiss()} /> : null}
      {!notice && step === "review" ? (
        <Button label="Continue" testID="delete-account-continue" disabled={blocked} onPress={() => setStep("confirm")} />
      ) : null}
      {!notice && step === "confirm" ? (
        <Button label="Delete account" tone="danger" testID="delete-account-confirm" disabled={blocked} onPress={() => void confirm()} />
      ) : null}
    </Screen>
  );
}

export function SettingsHome(props: {
  onSort: () => void;
  onConnect?: () => void;
  onDelete: () => void;
  onSignOut: () => void;
  deleteDisabled: boolean;
  /** Launch BYO stays hidden until core can run register, challenge, and verify. */
  connectEnabled?: boolean;
}) {
  return (
    <Screen testID="settings-screen">
      <Title kicker="Settings">Account</Title>
      <Button label="Type sort" tone="ghost" testID="open-sort" onPress={props.onSort} />
      {props.connectEnabled && props.onConnect ? (
        <Button label="Connect storage" tone="ghost" testID="open-connect" onPress={props.onConnect} />
      ) : null}
      <Button label="Delete account" tone="danger" testID="delete-account" disabled={props.deleteDisabled} onPress={props.onDelete} />
      <Button label="Sign out" tone="ghost" testID="sign-out" onPress={props.onSignOut} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  help: { color: colors.muted, fontSize: typeScale.helpSize },
  label: { color: colors.text, fontSize: typeScale.bodySize },
  error: { color: colors.dangerText, fontSize: typeScale.helpSize },
  checkRow: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44 },
  devNote: { color: colors.muted, fontSize: 12 },
  category: { color: colors.text, fontSize: typeScale.bodySize },
  soon: { color: colors.muted, fontSize: typeScale.helpSize },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    color: colors.text,
    paddingHorizontal: space.md,
    backgroundColor: colors.input,
  },
});
