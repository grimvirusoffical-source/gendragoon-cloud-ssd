import {
  ApiError,
  COMING_SOON_BYO_PROVIDERS,
  LAUNCH_BYO_PROVIDERS,
  PASSPHRASE_LOSS_WARNING,
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
import { StyleSheet, Text, TextInput, View } from "react-native";
import { deletionSessionAction, deleteSignedInAccount, dismissSignedInDeletion, savedDeletionUid } from "./account/deleteAccount";
import { SAME_ACCOUNT_MESSAGE, sessionMaySwap } from "./account/session";
import { byoServerFlowReady } from "./byoReady";
import { ENCRYPTED_WORKSPACE_ENABLED } from "./flags";
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

export function lockReasonMessage(reason: string, overBy = 0): string {
  const lead = LOCK_REASON[reason] ?? "This workspace is locked.";
  return `${lead} Over by ${overBy}.`;
}

export function LockScreen(props: {
  access?: LockAssessment;
  workspaces: readonly WorkspaceRecord[];
  /** HTTP 423 `workspace_lock` body. Displayed as sent. */
  lock?: WorkspaceLockBody;
  onReview: () => void;
}) {
  const summary = props.access ? planSummary(props.access) : null;
  const unpaidIds = props.lock?.unpaidWorkspaceIds ?? props.access?.unpaidIds ?? [];
  const rows = workspacesWithUnpaid(props.workspaces, unpaidIds);
  const known = new Set(rows.map((workspace) => workspace.id));
  const unmatched = unpaidIds.filter((id) => !known.has(id));
  return (
    <Screen testID="lock-screen">
      <Title kicker="Signed in">Resolve workspaces to continue</Title>
      {summary ? (
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
      <Button label="Review workspaces" testID="review-workspaces" onPress={props.onReview} />
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

export function WorkspacesScreen(props: {
  workspaces: readonly WorkspaceRecord[];
  unpaidIds: readonly string[];
  monthlyCents: number;
  capMessage?: string | null;
  serverPreview?: ServerMergePreview | null;
  mergeError?: string | null;
  mergeResult?: ServerMergeResult | null;
  mergedFiles?: readonly { id: string; name: string }[] | null;
  onDelete: (id: string) => void;
  onMerge: (sourceId: string, targetId: string) => void;
}) {
  const rows = workspacesWithUnpaid(props.workspaces, props.unpaidIds);
  const [sourceId, setSourceId] = useState(rows[1]?.id ?? rows[0]?.id ?? "");
  const [targetId, setTargetId] = useState(rows[0]?.id ?? "");
  const localPreview = props.serverPreview || !sourceId || !targetId || sourceId === targetId
    ? []
    : planMerge([{ path: "Photos/cat.jpg" }], rows.find((row) => row.id === sourceId)?.name ?? "source", ["Photos/cat.jpg"]);
  return (
    <Screen testID="workspaces-screen">
      <Title kicker="Workspaces">Your spaces</Title>
      <Banner testID="workspace-fee">{`An additional workspace is $${props.monthlyCents / 100} per month.`}</Banner>
      {props.capMessage ? <Banner testID="workspace-cap">{props.capMessage}</Banner> : null}
      {rows.map((workspace) => (
        <View key={workspace.id} style={cardStyle()}>
          <Text testID={`workspace-name-${workspace.id}`} style={styles.category}>{workspace.name}{workspace.unpaid ? " · unpaid" : ""}</Text>
          <Button label="Delete" tone="danger" testID={`delete-${workspace.id}`} onPress={() => props.onDelete(workspace.id)} />
        </View>
      ))}
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
      <Button label="Use first as source" tone="ghost" onPress={() => setSourceId(rows[0]?.id ?? "")} testID="merge-source" />
      <Button label="Use second as target" tone="ghost" onPress={() => setTargetId(rows[1]?.id ?? "")} testID="merge-target" />
      <Button
        label="Merge"
        testID="merge-workspaces"
        disabled={!sourceId || !targetId || sourceId === targetId}
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
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const ready = byoServerFlowReady();
  const challengeKey = props.challengeNonce ? challengeObjectKey(props.challengeNonce) : null;
  const errorText = props.error ? byoErrorMessage(props.error) : null;
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
      {ready ? LAUNCH_BYO_PROVIDERS.map((provider) => (
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
      {ready && selected ? <Text testID="byo-selected" style={styles.help}>{selected}</Text> : null}
      <Text style={styles.help}>Coming soon</Text>
      {COMING_SOON_BYO_PROVIDERS.map((provider) => (
        <Text key={provider.id} testID={`byo-soon-${provider.id}`} style={styles.soon}>{provider.label}</Text>
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

export function PassphraseScreen(props: { onSubmit: (passphrase: string) => void }) {
  const [value, setValue] = useState("");
  const [again, setAgain] = useState("");
  const [ack, setAck] = useState(false);
  const ready = value.length >= 8 && value === again && ack;
  return (
    <Screen testID="passphrase-screen">
      <Title kicker="Recovery">Set a passphrase</Title>
      <Banner>{PASSPHRASE_LOSS_WARNING}</Banner>
      <TextInput
        accessibilityLabel="Passphrase"
        secureTextEntry
        style={styles.input}
        value={value}
        onChangeText={setValue}
        testID="passphrase"
      />
      <TextInput
        accessibilityLabel="Confirm passphrase"
        secureTextEntry
        style={styles.input}
        value={again}
        onChangeText={setAgain}
        testID="passphrase-confirm"
      />
      <Button label={ack ? "Acknowledged" : "I understand I can lose my files"} tone="ghost" testID="passphrase-ack" onPress={() => setAck(true)} />
      <Button label="Save passphrase" testID="passphrase-save" disabled={!ready} onPress={() => props.onSubmit(value)} />
    </Screen>
  );
}

export type DeletionFrame = "confirm" | "reauth" | "progress" | "retry" | "dismiss";

interface DeletionNotice {
  message: string;
  retry: boolean;
  dismiss: boolean;
  reauth: boolean;
  progress: boolean;
}

function deletionNotice(kind: "progress" | "retry" | "dismiss" | "reauth" | "missing" | "offline"): DeletionNotice {
  if (kind === "progress") {
    return { message: "Deletion is running.", retry: false, dismiss: false, reauth: false, progress: true };
  }
  if (kind === "retry") {
    return { message: "Account deletion failed. You can try again.", retry: true, dismiss: false, reauth: false, progress: false };
  }
  if (kind === "dismiss") {
    return { message: "Account deletion failed.", retry: false, dismiss: true, reauth: false, progress: false };
  }
  if (kind === "reauth") {
    return { message: "Sign in again. Your last sign-in is older than 5 minutes.", retry: false, dismiss: false, reauth: true, progress: false };
  }
  if (kind === "offline") {
    return { message: "Could not reach the server. Try again.", retry: true, dismiss: true, reauth: false, progress: false };
  }
  return { message: "The deletion status could not be loaded.", retry: true, dismiss: true, reauth: false, progress: false };
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
  /** Static frame for screenshots. Live deletion ignores it. */
  frame?: DeletionFrame;
}) {
  const [step, setStep] = useState<"review" | "confirm">(props.frame === "confirm" ? "confirm" : "review");
  const [notice, setNotice] = useState<DeletionNotice | null>(props.frame && props.frame !== "confirm" ? deletionNotice(props.frame) : null);
  const blocked = props.activeTransfers > 0;
  async function confirm() {
    setNotice(deletionNotice("progress"));
    try {
      const status = await deleteSignedInAccount({
        client: props.client,
        idToken: props.idToken,
        workspaceIds: props.workspaceIds,
        secrets: props.secrets,
      });
      if (status.status === "done") {
        props.onDone();
        return;
      }
      if (status.status === "failed") {
        const retryable = (status as { retryable?: boolean }).retryable === true;
        setNotice(deletionNotice(retryable ? "retry" : "dismiss"));
        return;
      }
      props.onError("Account deletion did not finish. Local keys were kept.");
    } catch (error) {
      const action = deletionSessionAction(error);
      if (action === "reauth") {
        setNotice(deletionNotice("reauth"));
        props.onReauth();
      } else if (action === "sign-out") props.onSignedOut();
      else if (error instanceof ApiError && error.status === 404) setNotice(deletionNotice("missing"));
      else if (error instanceof ApiError && error.status === 0) setNotice(deletionNotice("offline"));
      else props.onError(error instanceof Error ? error.message : "Account deletion failed");
    }
  }
  async function dismiss() {
    await dismissSignedInDeletion(props.secrets);
    setNotice(null);
  }
  return (
    <Screen testID="delete-account-screen">
      <Title kicker="Account">Delete account</Title>
      <Text style={styles.help}>Sign in again if this sign-in is more than five minutes old. Local keys are removed only when deletion is done.</Text>
      {blocked ? <Banner>Delete account is disabled during transfers.</Banner> : null}
      {notice ? (
        <Banner testID={notice.progress ? "deletion-progress" : "deletion-error"}>{notice.message}</Banner>
      ) : null}
      {notice?.retry ? <Button label="Retry" testID="deletion-retry" onPress={() => void confirm()} /> : null}
      {notice?.reauth ? <Button label="Sign in again" testID="deletion-reauth" onPress={props.onReauth} /> : null}
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
