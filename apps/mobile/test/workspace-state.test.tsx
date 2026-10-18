/**
 * Required workspace policy from cloud-ssd PR #5 at 0715b1a.
 * Lapse locks one workspace, grace still accepts writes, and make-hosted
 * reports the demoted workspace's graceEndsAt.
 */
import { WorkspaceLockedError, type LockAssessment, type WorkspaceRecord } from "@gendragoon/core";
import { fireEvent, render } from "@testing-library/react-native";
import { LockScreen, WorkspacesScreen } from "../src/screens";
import {
  accountLockCoversApp,
  graceBanner,
  locksThisWorkspaceOnly,
  noteWorkspaceLock,
} from "../src/workspaceState";
import { WORKSPACE_POLICY_SHA, loadFixture } from "./loadFixture";

interface UploadBody {
  uploadId: string;
  chunkBytes: number;
  totalChunks: number;
}

interface LockBody {
  error: string;
  reason: "lapsed";
  overBy: number;
  unpaidWorkspaceIds: string[];
}

interface MakeHostedBody {
  hosted: boolean;
  workspaceId: string;
  freeWorkspaceId: string;
  demoted: {
    checkoutUrl: string;
    graceEndsAt: number;
    paidThroughMs: number;
    requiresCheckout: boolean;
    workspaceId: string;
    workspaceMonthlyCents: number;
  };
}

function workspaceIdOf(requestPath: string): string {
  const id = requestPath.split("/")[3];
  if (!id) throw new Error(`No workspace id in ${requestPath}`);
  return id;
}

function access(partial: Partial<LockAssessment> = {}): LockAssessment {
  return {
    locked: false,
    cap: 10,
    activeCount: 2,
    overCap: false,
    unpaidIds: [],
    lapsedIds: [],
    readable: true,
    downloadsAllowed: true,
    uploadsBlocked: false,
    normalUseBlocked: false,
    highTier: false,
    ...partial,
  };
}

function row(partial: Pick<WorkspaceRecord, "id" | "name"> & Partial<WorkspaceRecord>): WorkspaceRecord & { feeWaived: boolean } {
  return {
    kind: "paid",
    isFree: false,
    grandfathered: false,
    monthlyPriceCents: 500,
    projectStatus: "active",
    feeWaived: false,
    ...partial,
  };
}

describe("workspace policy fixtures", () => {
  it("loads the 0715b1a lapse, grace, and make-hosted fixtures", () => {
    for (const rel of [
      "workspaces/byo-in-grace.json",
      "workspaces/byo-lapsed-others-open.json",
      "workspaces/make-hosted.json",
      "workspace-lock/byo-lapsed.json",
    ]) {
      const fixture = loadFixture(rel);
      expect(fixture.sourceSha).toBe(WORKSPACE_POLICY_SHA);
      expect(fixture.sourcePath).toBe(`fixtures/${rel}`);
    }
  });

  it("a lapsed BYO workspace locks only itself", async () => {
    const locked = loadFixture<LockBody>("workspace-lock/byo-lapsed.json");
    const open = loadFixture<UploadBody>("workspaces/byo-lapsed-others-open.json");
    const lockedId = workspaceIdOf(locked.request.path);
    const openId = workspaceIdOf(open.request.path);
    expect(locked.response.status).toBe(423);
    expect(locked.response.body).toMatchObject({
      error: "workspace_lock",
      reason: "lapsed",
      overBy: 0,
      unpaidWorkspaceIds: [lockedId],
    });
    expect(open.response.status).toBe(201);
    expect(open.response.body.uploadId).toBeTruthy();
    expect(openId).not.toBe(lockedId);

    const next = noteWorkspaceLock(
      new WorkspaceLockedError({
        reason: locked.response.body.reason,
        overBy: locked.response.body.overBy,
        unpaidWorkspaceIds: locked.response.body.unpaidWorkspaceIds,
      }),
      access(),
    );
    expect(next.locked).toBe(false);
    expect(next.uploadsBlocked).toBe(false);
    expect(next.unpaidIds).toEqual([lockedId]);
    expect(next.lapsedIds).toEqual([lockedId]);
    expect(accountLockCoversApp({ ...next, locked: true })).toBe(false);
    expect(locksThisWorkspaceOnly(next, lockedId)).toBe(true);
    expect(locksThisWorkspaceOnly(next, openId)).toBe(false);

    const screen = await render(
      <LockScreen
        workspaceOnly
        workspaces={[row({ id: lockedId, name: "Lapsed bucket" })]}
        lock={{
          reason: locked.response.body.reason,
          overBy: locked.response.body.overBy,
          unpaidWorkspaceIds: locked.response.body.unpaidWorkspaceIds,
        }}
        onReview={() => undefined}
        onPay={() => undefined}
      />,
    );
    expect(screen.getByText("This workspace is locked. Your other workspaces stay usable. Downloads stay available.")).toBeTruthy();
    expect(screen.queryByText(/This account is/)).toBeNull();
    expect(screen.getByTestId("pay-to-restore")).toBeTruthy();
    expect(screen.getByTestId(`lock-workspace-${lockedId}`)).toHaveTextContent("Lapsed bucket · unpaid");
  });

  it("an over-cap lock still covers the whole account", () => {
    const next = noteWorkspaceLock(
      new WorkspaceLockedError({ reason: "over_cap", overBy: 1, unpaidWorkspaceIds: [] }),
      access(),
    );
    expect(next.locked).toBe(true);
    expect(accountLockCoversApp(next)).toBe(true);
    expect(locksThisWorkspaceOnly({ ...next, unpaidIds: ["ws"], lapsedIds: ["ws"] }, "ws")).toBe(false);
  });

  it("grace still accepts a write, and make-hosted shows Pay from graceEndsAt", async () => {
    const grace = loadFixture<UploadBody>("workspaces/byo-in-grace.json");
    const made = loadFixture<MakeHostedBody>("workspaces/make-hosted.json");
    const graceId = workspaceIdOf(grace.request.path);
    const demoted = made.response.body.demoted;
    expect(grace.response.status).toBe(201);
    expect(grace.response.body.uploadId).toBe("00000000-0000-4000-8000-000000000006");
    expect(made.response.status).toBe(200);
    expect(made.response.body.hosted).toBe(true);
    expect(made.response.body.freeWorkspaceId).toBe(made.response.body.workspaceId);
    expect(demoted.requiresCheckout).toBe(true);
    expect(demoted.workspaceMonthlyCents).toBe(500);
    expect(demoted.workspaceId).not.toBe(graceId);

    const onPay = jest.fn();
    const screen = await render(
      <WorkspacesScreen
        workspaces={[
          row({
            id: demoted.workspaceId,
            name: "Demoted workspace",
            isFree: false,
            monthlyPriceCents: demoted.workspaceMonthlyCents,
            feeWaived: false,
          }),
          row({
            id: made.response.body.freeWorkspaceId,
            name: "Hosted workspace",
            isFree: true,
            monthlyPriceCents: 0,
            feeWaived: false,
          }),
        ]}
        unpaidIds={[]}
        graceEndsAt={{ [demoted.workspaceId]: demoted.graceEndsAt }}
        onDelete={() => undefined}
        onMerge={() => undefined}
        onPay={onPay}
      />,
    );
    expect(graceBanner(demoted.graceEndsAt)).toBe("Payment due, pay by Nov 20, 2023 to keep using this workspace.");
    expect(screen.getByTestId(`workspace-grace-${demoted.workspaceId}`)).toHaveTextContent(graceBanner(demoted.graceEndsAt));
    expect(screen.queryByTestId(`workspace-price-${demoted.workspaceId}`)).toBeNull();
    expect(screen.queryByText("$5.00")).toBeNull();
    expect(screen.getByTestId(`workspace-price-${made.response.body.freeWorkspaceId}`).props.children).toBe("Free");
    expect(screen.getByLabelText("Delete Demoted workspace")).not.toBeDisabled();
    await fireEvent.press(screen.getByTestId(`pay-grace-${demoted.workspaceId}`));
    expect(onPay).toHaveBeenCalledWith(demoted.workspaceId);
  });
});
