/**
 * PROVISIONAL. cloud-ssd PR #5 at 4c3dd13 does not yet return
 * `workspace_busy`, `projectStatus: "deleting"`, a per-workspace lapse, or
 * the grace `payByMs`. These tests pin the client behavior Avery and Riley
 * described. They are not fixture contracts.
 */
import { ApiError, WorkspaceLockedError, type LockAssessment, type WorkspaceRecord } from "@gendragoon/core";
import { fireEvent, render } from "@testing-library/react-native";
import { includedPricingEndsWarning } from "../src/pricing";
import { ConnectStorageScreen, LockScreen, WorkspacesScreen } from "../src/screens";
import {
  WORKSPACE_BUSY_MESSAGE,
  accountLockCoversApp,
  graceBanner,
  locksThisWorkspaceOnly,
  noteWorkspaceLock,
} from "../src/workspaceState";

const FREE_ID = "11111111-1111-4111-8111-000000000001";
const PAID_ID = "11111111-1111-4111-8111-000000000002";
const PAY_BY = Date.UTC(2026, 9, 21);

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

const free = row({ id: FREE_ID, name: "Free Hosted", isFree: true, monthlyPriceCents: 0 });
const paid = row({ id: PAID_ID, name: "Second Workspace" });

describe("PROVISIONAL workspace policy the server has not shipped", () => {
  it("PROVISIONAL: 409 workspace_busy keeps the workspace and names the in-progress work", async () => {
    const onDelete = jest.fn(async () => {
      throw new ApiError(409, "workspace_busy", "busy");
    });
    const screen = await render(
      <WorkspacesScreen
        workspaces={[free, paid]}
        unpaidIds={[]}
        onDelete={onDelete}
        onMerge={() => undefined}
      />,
    );
    await fireEvent.press(screen.getByLabelText("Delete Free Hosted"));
    await fireEvent.press(screen.getByLabelText("Confirm delete Free Hosted"));
    expect(await screen.findByText(WORKSPACE_BUSY_MESSAGE)).toBeTruthy();
    expect(screen.getByTestId(`workspace-name-${FREE_ID}`)).toBeTruthy();
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("PROVISIONAL: a deleting workspace shows Deleting... and disables its actions", async () => {
    const onDelete = jest.fn();
    const onPay = jest.fn();
    const deleting = row({ id: PAID_ID, name: "Second Workspace", projectStatus: "deleting" as WorkspaceRecord["projectStatus"] });
    const screen = await render(
      <WorkspacesScreen
        workspaces={[free, deleting]}
        unpaidIds={[PAID_ID]}
        onDelete={onDelete}
        onMerge={() => undefined}
        onPay={onPay}
      />,
    );
    expect(screen.getByTestId(`workspace-deleting-${PAID_ID}`)).toHaveTextContent("Deleting...");
    expect(screen.getByLabelText("Delete Second Workspace")).toBeDisabled();
    expect(screen.getByLabelText("Pay to restore Second Workspace")).toBeDisabled();
    expect(screen.getByLabelText("Merge source Second Workspace")).toBeDisabled();
    expect(screen.getByLabelText("Merge target Second Workspace")).toBeDisabled();
    expect(screen.getByLabelText("Delete Free Hosted")).not.toBeDisabled();
    await fireEvent.press(screen.getByLabelText("Delete Second Workspace"));
    expect(onDelete).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText("Pay to restore Second Workspace"));
    expect(onPay).not.toHaveBeenCalled();
  });

  it("PROVISIONAL: a lapsed workspace locks only itself", async () => {
    const current = access();
    const next = noteWorkspaceLock(
      new WorkspaceLockedError({ reason: "lapsed", overBy: 0, unpaidWorkspaceIds: [PAID_ID] }),
      current,
    );
    expect(next.locked).toBe(false);
    expect(next.uploadsBlocked).toBe(false);
    expect(next.unpaidIds).toEqual([PAID_ID]);
    expect(next.lapsedIds).toEqual([PAID_ID]);
    expect(accountLockCoversApp({ ...next, locked: true })).toBe(false);
    expect(locksThisWorkspaceOnly(next, PAID_ID)).toBe(true);
    expect(locksThisWorkspaceOnly(next, FREE_ID)).toBe(false);
    const screen = await render(
      <LockScreen
        workspaceOnly
        workspaces={[paid]}
        lock={{ reason: "lapsed", overBy: 0, unpaidWorkspaceIds: [PAID_ID] }}
        onReview={() => undefined}
        onPay={() => undefined}
      />,
    );
    expect(screen.getByText("This workspace is locked. Your other workspaces stay usable. Downloads stay available.")).toBeTruthy();
    expect(screen.queryByText(/This account is/)).toBeNull();
    expect(screen.getByTestId("pay-to-restore")).toBeTruthy();
  });

  it("an over-cap lock still covers the whole account", () => {
    const next = noteWorkspaceLock(
      new WorkspaceLockedError({ reason: "over_cap", overBy: 1, unpaidWorkspaceIds: [] }),
      access(),
    );
    expect(next.locked).toBe(true);
    expect(accountLockCoversApp(next)).toBe(true);
    expect(locksThisWorkspaceOnly({ ...next, unpaidIds: [PAID_ID], lapsedIds: [PAID_ID] }, PAID_ID)).toBe(false);
  });

  it("PROVISIONAL: losing the free slot shows the grace banner and Pay, not a silent price", async () => {
    const lost = row({ id: PAID_ID, name: "Second Workspace", isFree: false, monthlyPriceCents: 500 });
    const onPay = jest.fn();
    const screen = await render(
      <WorkspacesScreen
        workspaces={[lost, free]}
        unpaidIds={[]}
        gracePayByMs={{ [PAID_ID]: PAY_BY }}
        onDelete={() => undefined}
        onMerge={() => undefined}
        onPay={onPay}
      />,
    );
    expect(graceBanner(PAY_BY)).toBe("Payment due, pay by Oct 21, 2026 to keep using this workspace.");
    expect(screen.getByTestId(`workspace-grace-${PAID_ID}`)).toHaveTextContent(graceBanner(PAY_BY));
    expect(screen.queryByTestId(`workspace-price-${PAID_ID}`)).toBeNull();
    expect(screen.queryByText("$5.00")).toBeNull();
    expect(screen.getByTestId(`workspace-price-${FREE_ID}`).props.children).toBe("Free");
    expect(screen.getByLabelText("Delete Second Workspace")).not.toBeDisabled();
    await fireEvent.press(screen.getByTestId(`pay-grace-${PAID_ID}`));
    expect(onPay).toHaveBeenCalledWith(PAID_ID);
  });

  it("PROVISIONAL: BYO on a grandfathered workspace warns before the providers can be chosen", async () => {
    const onSelect = jest.fn();
    const screen = await render(
      <ConnectStorageScreen endsIncludedPricingCents={500} onSelectProvider={onSelect} />,
    );
    expect(screen.getByTestId("byo-included-warning")).toHaveTextContent(includedPricingEndsWarning(500));
    expect(includedPricingEndsWarning(500)).toBe(
      "Switching to your own storage ends this workspace's included pricing. It will cost $5.00/mo.",
    );
    expect(screen.queryByTestId("byo-aws")).toBeNull();
    await fireEvent.press(screen.getByTestId("byo-end-included"));
    await fireEvent.press(screen.getByTestId("byo-aws"));
    expect(onSelect).toHaveBeenCalledWith("aws");
  });
});
