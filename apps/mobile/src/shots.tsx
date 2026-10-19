import { treeNode, type SecretStore, type WorkspaceRecord } from "@gendragoon/core";
import { colors } from "./theme";
import { StyleSheet, View } from "react-native";
import {
  ConnectStorageScreen,
  DeleteAccountScreen,
  FileTree,
  LockScreen,
  NewWorkspaceScreen,
  PassphraseScreen,
  SignInScreen,
  WorkspacesScreen,
  type DeletionFrame,
} from "./screens";

/** Screenshot-only copy of the catalog shape from GET /v2/pricing (the server owns real prices). */
const SHOT_PRICING = {
  storage: { "100GB": { gb: 100, monthlyCents: 640, yearlyCents: 6400 }, "1TB": { gb: 1000, monthlyCents: 3600, yearlyCents: 36000 } },
  performance: { lite: { workers: 2, monthlyCents: 300, yearlyCents: 3000 }, boost: { workers: 4, monthlyCents: 600, yearlyCents: 6000 }, turbo: { workers: 8, monthlyCents: 900, yearlyCents: 9000 } },
};

/** Test-data frames captured by the web screenshot job. No secrets. */
export const SHOTS = [
  "sign-in",
  "workspaces",
  "files",
  "files-encrypted",
  "passphrase",
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
  "byo-s3",
  "pricing-free-first",
  "pricing-free-plus-plans",
  "pricing-new-plans",
  "pricing-new-custom",
  "pricing-grace",
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
            onDelete={() => undefined}
            onMerge={() => undefined}
          />
        ) : null}
        {props.id === "files" || props.id === "files-encrypted" ? (
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
        {props.id === "passphrase" ? (
          <PassphraseScreen
            initialPassphrase="correct horse"
            initialConfirm="correct horse"
            initialChecked
            initialRevealed
            onSubmit={() => undefined}
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
        {props.id === "byo-s3" ? <ConnectStorageScreen /> : null}
        {props.id === "pricing-free-first" ? (
          <NewWorkspaceScreen freeProjectAvailable pricing={SHOT_PRICING} intentId="shot" onCreate={() => undefined} />
        ) : null}
        {props.id === "pricing-new-plans" ? (
          <NewWorkspaceScreen freeProjectAvailable={false} pricing={SHOT_PRICING} intentId="shot" initialName="Music Studio" initialStorageTier="1TB" initialPerformanceTier="turbo" onCreate={() => undefined} />
        ) : null}
        {props.id === "pricing-new-custom" ? (
          <NewWorkspaceScreen freeProjectAvailable={false} pricing={SHOT_PRICING} intentId="shot" initialName="Own S3" initialStorage="custom" initialPerformanceTier="lite" onCreate={() => undefined} />
        ) : null}
        {props.id === "pricing-free-plus-plans" ? (
          <WorkspacesScreen
            workspaces={[
              { id: "11111111-1111-4111-8111-000000000001", name: "Free Hosted", kind: "paid", isFree: true, grandfathered: false, monthlyPriceCents: 0, feeWaived: false },
              {
                id: "11111111-1111-4111-8111-000000000002",
                name: "Second Workspace",
                kind: "paid",
                isFree: false,
                grandfathered: false,
                monthlyPriceCents: 0,
                feeWaived: false,
                billingModel: "plans",
                requiredPlans: { storage: "managed", storageTier: "100GB", performanceTier: "boost", interval: "month" },
              },
            ]}
            unpaidIds={[]}
            onDelete={() => undefined}
            onMerge={() => undefined}
            onPay={() => undefined}
          />
        ) : null}
        {props.id === "pricing-grace" ? (
          <WorkspacesScreen
            workspaces={[
              {
                id: "11111111-1111-4111-8111-000000000002",
                name: "Second Workspace",
                kind: "paid",
                isFree: false,
                grandfathered: false,
                monthlyPriceCents: 500,
                feeWaived: false,
              },
              {
                id: "11111111-1111-4111-8111-000000000001",
                name: "Free Hosted",
                kind: "paid",
                isFree: true,
                grandfathered: false,
                monthlyPriceCents: 0,
                feeWaived: false,
              },
            ]}
            unpaidIds={[]}
            graceEndsAt={{ "11111111-1111-4111-8111-000000000002": Date.UTC(2026, 9, 21) }}
            onDelete={() => undefined}
            onMerge={() => undefined}
            onPay={() => undefined}
          />
        ) : null}
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
