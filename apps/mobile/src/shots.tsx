import { treeNode, type SecretStore, type WorkspaceRecord } from "@gendragoon/core";
import { colors } from "@gendragoon/ui/theme";
import { StyleSheet, View } from "react-native";
import {
  ConnectStorageScreen,
  DeleteAccountScreen,
  FileTree,
  LockScreen,
  SignInScreen,
  WorkspacesScreen,
  type DeletionFrame,
} from "./screens";

/** Test-data frames captured by the web screenshot job. No secrets. */
export const SHOTS = [
  "sign-in",
  "workspaces",
  "files",
  "lock-over-cap",
  "lock-lapsed",
  "lock-over-cap-and-lapsed",
  "lock-scope-unavailable",
  "lock-merge-in-progress",
  "delete-confirm",
  "delete-reauth",
  "delete-progress",
  "delete-retry",
  "delete-dismiss",
  "delete-not-retryable",
  "byo-hidden",
] as const;

export type ShotId = (typeof SHOTS)[number];

const WORKSPACE_ID = "11111111-1111-4111-8111-000000000001";

const WORKSPACE: WorkspaceRecord = {
  id: WORKSPACE_ID,
  name: "Fixture Project",
  kind: "paid",
  projectStatus: "active",
};

const secrets: SecretStore = {
  async get() {
    return null;
  },
  async set() {
    return undefined;
  },
  async delete() {
    return undefined;
  },
};

const idleClient = {
  async deleteAccount() {
    return { jobId: "preview" };
  },
  async deletionStatus() {
    return { jobId: "preview", status: "done" as const };
  },
};

function lockReason(shot: ShotId): { reason: string; overBy: number } | null {
  if (shot === "lock-over-cap") return { reason: "over_cap", overBy: 1 };
  if (shot === "lock-lapsed") return { reason: "lapsed", overBy: 0 };
  if (shot === "lock-over-cap-and-lapsed") return { reason: "over_cap_and_lapsed", overBy: 1 };
  if (shot === "lock-scope-unavailable") return { reason: "scope_unavailable", overBy: 0 };
  if (shot === "lock-merge-in-progress") return { reason: "merge_in_progress", overBy: 0 };
  return null;
}

function deleteFrame(shot: ShotId): DeletionFrame | null {
  if (shot === "delete-confirm") return "confirm";
  if (shot === "delete-reauth") return "reauth";
  if (shot === "delete-progress") return "progress";
  if (shot === "delete-retry") return "retry";
  if (shot === "delete-dismiss") return "dismiss";
  if (shot === "delete-not-retryable") return "not-retryable";
  return null;
}

export function webShot(): ShotId | null {
  if (typeof window === "undefined" || typeof window.location?.search !== "string") return null;
  const shot = new URLSearchParams(window.location.search).get("shot");
  return SHOTS.find((id) => id === shot) ?? null;
}

export function ShotFrame(props: { id: ShotId }) {
  const lock = lockReason(props.id);
  const frame = deleteFrame(props.id);
  const file = treeNode({ path: "Pictures/vacation.jpg", directory: false });
  return (
    <View style={styles.stage} testID="shot-ready">
      <View style={styles.phone}>
        {props.id === "sign-in" ? <SignInScreen googleEnabled={false} onSignIn={() => undefined} /> : null}
        {props.id === "workspaces" ? (
          <WorkspacesScreen
            workspaces={[WORKSPACE]}
            unpaidIds={[]}
            monthlyCents={500}
            onDelete={() => undefined}
            onMerge={() => undefined}
          />
        ) : null}
        {props.id === "files" ? (
          <FileTree
            mode="upload"
            nodes={[file, treeNode({ path: "Documents/notes.pdf", directory: false })]}
            locked={false}
            selected={file}
            onSelect={() => undefined}
            onRefresh={() => undefined}
            onUpload={() => undefined}
          />
        ) : null}
        {lock ? (
          <LockScreen
            workspaces={[WORKSPACE]}
            lock={{ reason: lock.reason, overBy: lock.overBy, unpaidWorkspaceIds: [WORKSPACE_ID] }}
            onReview={() => undefined}
          />
        ) : null}
        {frame ? (
          <DeleteAccountScreen
            frame={frame}
            jobId={frame === "not-retryable" ? "22222222-2222-4222-8222-000000000004" : undefined}
            activeTransfers={0}
            secrets={secrets}
            workspaceIds={[WORKSPACE_ID]}
            idToken=""
            client={idleClient}
            onReauth={() => undefined}
            onSignedOut={() => undefined}
            onDone={() => undefined}
            onError={() => undefined}
          />
        ) : null}
        {props.id === "byo-hidden" ? <ConnectStorageScreen /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
  },
  phone: {
    width: "100%",
    maxWidth: 390,
    flex: 1,
    backgroundColor: colors.bg,
  },
});
