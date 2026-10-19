import { parseWorkspacePrice, workspacePriceLabel, type WorkspacePrice, type WorkspaceRecord } from "@gendragoon/core";
import { fireEvent, render } from "@testing-library/react-native";
import { WORKSPACE_PRICING_ENABLED } from "../src/flags";
import { readFileSync } from "node:fs";
import path from "node:path";
import { serverPriceLabel } from "../src/pricing";
import { ConnectStorageScreen, LockScreen, NewWorkspaceScreen, WorkspacesScreen } from "../src/screens";
import { FIXTURE_SOURCE_SHA_BY_AREA, OWNER_FEE_WAIVED_SHA, loadFixture } from "./loadFixture";

const PRICING_SHA = "4c3dd13587fae1ddfa907ad2b84c0886d7794ade";

const PRICING_FIXTURES = [
  "free-first",
  "byo-first-paid",
  "second-paid",
  "delete-free-then-create",
  "free-to-byo-billable",
  "concurrent-create-one-free",
  "list-byo-only",
  "list-hosted-plus-byo",
  "grandfathered-plus-new",
] as const;

interface ListedBody {
  policy: { workspaceMonthlyCents: number };
  workspaces: Array<WorkspaceRecord & WorkspacePrice>;
}


function listed(rel: string): ListedBody {
  const fixture = loadFixture<ListedBody>(rel);
  expect(fixture.sourceSha).toBe(PRICING_SHA);
  expect(fixture.sourceSha).toBe(FIXTURE_SOURCE_SHA_BY_AREA.workspaces);
  return fixture.response.body;
}

describe("workspace price labels", () => {
  it("uses the vendored PR #5 pricing fixtures", () => {
    expect(WORKSPACE_PRICING_ENABLED).toBe(true);
    expect(FIXTURE_SOURCE_SHA_BY_AREA.workspaces).toBe(PRICING_SHA);
    for (const name of PRICING_FIXTURES) {
      const fixture = loadFixture(`workspaces/${name}.json`);
      expect(fixture.sourceSha).toBe(PRICING_SHA);
      expect(fixture.sourcePath).toBe(`fixtures/workspaces/${name}.json`);
    }
  });

  it("labels list-byo-only from monthlyPriceCents", async () => {
    const body = listed("workspaces/list-byo-only.json");
    const screen = await render(
      <WorkspacesScreen
        workspaces={body.workspaces}
        unpaidIds={[]}
        onDelete={() => undefined}
        onMerge={() => undefined}
      />,
    );
    expect(body.workspaces[0]?.monthlyPriceCents).toBe(500);
    expect(body.workspaces[0]?.isFree).toBe(false);
    expect(() => parseWorkspacePrice(body.workspaces[0])).toThrow(TypeError);
    expect(serverPriceLabel(body.workspaces[0])).toBeNull();
    expect(screen.queryByTestId("workspace-price-11111111-1111-4111-8111-000000000003")).toBeNull();
    expect(screen.queryByText("Free")).toBeNull();
    expect(screen.queryByText("$0.00/mo")).toBeNull();
  });

  it("labels list-hosted-plus-byo from isFree and monthlyPriceCents", async () => {
    const body = listed("workspaces/list-hosted-plus-byo.json");
    const screen = await render(
      <WorkspacesScreen
        workspaces={body.workspaces}
        unpaidIds={[]}
        onDelete={() => undefined}
        onMerge={() => undefined}
      />,
    );
    expect(() => parseWorkspacePrice(body.workspaces[0])).toThrow(TypeError);
    expect(() => parseWorkspacePrice(body.workspaces[1])).toThrow(TypeError);
    expect(serverPriceLabel(body.workspaces[0])).toBeNull();
    expect(serverPriceLabel(body.workspaces[1])).toBeNull();
    expect(screen.queryByTestId("workspace-price-11111111-1111-4111-8111-000000000001")).toBeNull();
    expect(screen.queryByTestId("workspace-price-11111111-1111-4111-8111-000000000002")).toBeNull();
    expect(screen.queryByText("$0.00/mo")).toBeNull();
  });

  it("new workspace: first is free; the next needs storage + performance; no fee line", async () => {
    const free = await render(<NewWorkspaceScreen freeProjectAvailable pricing={null} intentId="i" onCreate={() => undefined} />);
    expect(free.getByTestId("first-free")).toHaveTextContent(/2 GB storage and the free performance plan/);
    expect(free.queryByTestId("storage-plans")).toBeNull();
    expect(free.getByTestId("create-workspace")).toBeDisabled();
    await fireEvent.changeText(free.getByTestId("workspace-name"), "Vacation photos");
    expect(free.getByTestId("create-workspace")).not.toBeDisabled();
    const onCreate = jest.fn();
    const pricing = { storage: { "100GB": { gb: 100, monthlyCents: 640, yearlyCents: 6400 } }, performance: { boost: { workers: 4, monthlyCents: 600, yearlyCents: 6000 } } };
    const second = await render(<NewWorkspaceScreen freeProjectAvailable={false} pricing={pricing} intentId="11111111-1111-4111-8111-000000000002" initialName="Second Workspace" onCreate={onCreate} />);
    expect(second.getByTestId("storage-plans")).toBeTruthy();
    expect(second.getByTestId("performance-plans")).toBeTruthy();
    await fireEvent.press(second.getByTestId("storage-100GB"));
    expect(second.getByTestId("create-workspace")).toBeDisabled();
    await fireEvent.press(second.getByTestId("performance-boost"));
    expect(second.getByTestId("plan-total-amount")).toHaveTextContent("Total $12.40/mo");
    expect(second.queryByText(/fee/i)).toBeNull();
    await fireEvent.press(second.getByTestId("create-workspace"));
    // Same body the cloud-ssd handlers accepted (fixtures generated on feature/workspace-plans).
    const accepted = JSON.parse(readFileSync(path.join(__dirname, "../../../packages/core/test/fixtures/server-plans/workspaces/second-plans-checkout.json"), "utf8"));
    expect(onCreate).toHaveBeenLastCalledWith(accepted.request.body);
    expect(accepted.response.body.totalCents).toBe(1240);
  });

  it("labels a BYO register at 500 cents and keeps one free workspace in a concurrent create", () => {
    const byo = loadFixture<{ isFree: boolean; monthlyPriceCents: number }>("workspaces/byo-first-paid.json");
    const converted = loadFixture<{ isFree: boolean; monthlyPriceCents: number }>("workspaces/free-to-byo-billable.json");
    expect(byo.response.body.monthlyPriceCents).toBe(500);
    expect(serverPriceLabel(byo.response.body)).toBeNull();
    expect(converted.response.body.isFree).toBe(false);
    const concurrent = listed("workspaces/concurrent-create-one-free.json");
    expect(() => parseWorkspacePrice(concurrent.workspaces[0])).toThrow(TypeError);
    expect(() => parseWorkspacePrice(concurrent.workspaces[1])).toThrow(TypeError);
  });

  it("uses core's label: Free, Included, or formatted cents", () => {
    expect(workspacePriceLabel({ isFree: true, grandfathered: true, feeWaived: false, monthlyPriceCents: 0 })).toBe("Free");
    expect(workspacePriceLabel({ isFree: false, grandfathered: true, feeWaived: false, monthlyPriceCents: 0 })).toBe("Included");
    expect(workspacePriceLabel({ isFree: false, grandfathered: false, feeWaived: true, monthlyPriceCents: 0 })).toBe("Included");
    expect(workspacePriceLabel({ isFree: false, grandfathered: false, feeWaived: false, monthlyPriceCents: 0 })).toBe("$0.00");
    expect(workspacePriceLabel({ isFree: false, grandfathered: false, feeWaived: false, monthlyPriceCents: 750 })).toBe("$7.50");
    expect(() => parseWorkspacePrice(null)).toThrow(TypeError);
    expect(() => parseWorkspacePrice({ name: "no price" })).toThrow(TypeError);
    expect(() => parseWorkspacePrice({ isFree: false, grandfathered: false, monthlyPriceCents: 500 })).toThrow(TypeError);
    expect(serverPriceLabel(null)).toBeNull();
    expect(serverPriceLabel({ name: "no price" })).toBeNull();
    expect(serverPriceLabel({ isFree: false, grandfathered: false, monthlyPriceCents: 500 })).toBeNull();
    expect(serverPriceLabel({ feeWaived: true })).toBeNull();
    expect(serverPriceLabel({ isFree: false, grandfathered: false, monthlyPriceCents: 500, feeWaived: false })).toBe("$5.00");
    expect(serverPriceLabel({ isFree: false, grandfathered: false, monthlyPriceCents: 500, feeWaived: true })).toBe("Included");
    expect(serverPriceLabel({ isFree: true, grandfathered: false, monthlyPriceCents: 0, feeWaived: true })).toBe("Free");
  });

  it("plans workspaces are labelled by their plans, never $0.00", () => {
    expect(serverPriceLabel({ isFree: false, grandfathered: false, feeWaived: false, monthlyPriceCents: 0, billingModel: "plans", requiredPlans: { storage: "managed", storageTier: "100GB", performanceTier: "boost", interval: "month" } })).toBe("100GB + Boost");
    expect(serverPriceLabel({ isFree: false, grandfathered: false, feeWaived: false, monthlyPriceCents: 0, billingModel: "plans", requiredPlans: { storage: "custom", performanceTier: "lite", interval: "month" } })).toBe("Custom storage + Lite");
  });

  it("custom storage setup shows provider → credentials → test → finish with no pricing warnings", async () => {
    const screen = await render(<ConnectStorageScreen />);
    expect(screen.getByTestId("custom-steps")).toHaveTextContent(/\[1\. Provider\]/);
    expect(screen.queryByTestId("byo-included-warning")).toBeNull();
    const registered = await render(<ConnectStorageScreen registration={{ byoRegistered: true, endpoint: "https://a.r2.cloudflarestorage.com", providerType: "s3" }} challengeNonce="abc" />);
    expect(registered.getByTestId("custom-steps")).toHaveTextContent(/\[3\. Connection test\]/);
    expect(registered.getByTestId("byo-registered")).toHaveTextContent("s3 · https://a.r2.cloudflarestorage.com");
    const done = await render(<ConnectStorageScreen verified={{ verified: true, workspaceId: "w3" }} />);
    expect(done.getByTestId("custom-steps")).toHaveTextContent(/\[4\. Finish\]/);
  });

  it("labels grandfathered-plus-new from the vendored fixture", async () => {
    const body = listed("workspaces/grandfathered-plus-new.json");
    const screen = await render(
      <WorkspacesScreen
        workspaces={body.workspaces}
        unpaidIds={[]}
        onDelete={() => undefined}
        onMerge={() => undefined}
      />,
    );
    expect(() => parseWorkspacePrice(body.workspaces[0])).toThrow(TypeError);
    expect(() => parseWorkspacePrice(body.workspaces[1])).toThrow(TypeError);
    expect(serverPriceLabel(body.workspaces[0])).toBeNull();
    expect(serverPriceLabel(body.workspaces[1])).toBeNull();
    expect(screen.queryByTestId("workspace-price-11111111-1111-4111-8111-000000000008")).toBeNull();
    expect(screen.queryByTestId("workspace-price-11111111-1111-4111-8111-000000000009")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByText("$0.00/mo")).toBeNull();
  });

  it("labels owner-fee-waived as Included", async () => {
    const fixture = loadFixture<{
      feeWaived: boolean;
      project: { id: string; name: string; kind: "paid"; isFree: boolean; grandfathered: boolean; monthlyPriceCents: number; feeWaived: boolean };
    }>("workspaces/owner-fee-waived.json");
    expect(fixture.sourceSha).toBe(OWNER_FEE_WAIVED_SHA);
    expect(fixture.sourcePath).toBe("fixtures/workspaces/owner-fee-waived.json");
    const project = fixture.response.body.project;
    expect(parseWorkspacePrice(project).feeWaived).toBe(true);
    expect(workspacePriceLabel(parseWorkspacePrice(project))).toBe("Included");
    expect(serverPriceLabel(project)).toBe("Included");
    const withoutFee = { ...project };
    delete (withoutFee as { feeWaived?: boolean }).feeWaived;
    expect(() => parseWorkspacePrice(withoutFee)).toThrow(TypeError);
    expect(serverPriceLabel(withoutFee)).toBeNull();
    const screen = await render(
      <WorkspacesScreen
        workspaces={[project]}
        unpaidIds={[]}
        onDelete={() => undefined}
        onMerge={() => undefined}
      />,
    );
    expect(screen.getByTestId(`workspace-price-${project.id}`).props.children).toBe("Included");
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByText("$0.00/mo")).toBeNull();
  });

  it("an unpaid card uses monthlyPriceCents and the lapsed pay action", async () => {
    const body = listed("workspaces/list-hosted-plus-byo.json");
    const onPay = jest.fn();
    const onDelete = jest.fn();
    const screen = await render(
      <WorkspacesScreen
        workspaces={body.workspaces}
        unpaidIds={["11111111-1111-4111-8111-000000000001"]}
        onDelete={onDelete}
        onMerge={() => undefined}
        onPay={onPay}
      />,
    );
    expect(screen.queryByTestId("workspace-fee")).toBeNull();
    expect(screen.getByTestId("workspace-price-11111111-1111-4111-8111-000000000001").props.children).toBe("$5.00/mo · Payment needed");
    expect(screen.getByLabelText("Merge source Free Hosted")).toBeTruthy();
    expect(screen.getByLabelText("Merge target Second Workspace")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("pay-to-restore-11111111-1111-4111-8111-000000000001"));
    expect(onPay).toHaveBeenCalledWith("11111111-1111-4111-8111-000000000001");
    await fireEvent.press(screen.getByLabelText("Delete Free Hosted"));
    expect(onDelete).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText("Confirm delete Free Hosted"));
    expect(onDelete).toHaveBeenCalledWith("11111111-1111-4111-8111-000000000001");
  });

  it("an unpaid BYO 423 lapsed uses the existing lapsed lock screen", async () => {
    const lapsed = loadFixture<{ reason: string; overBy: number; unpaidWorkspaceIds: string[] }>("workspace-lock/lapsed.json");
    expect(lapsed.response.status).toBe(423);
    expect(lapsed.response.body.reason).toBe("lapsed");
    const screen = await render(
      <LockScreen
        workspaces={[{
          id: lapsed.response.body.unpaidWorkspaceIds[0] ?? "byo-only",
          name: "Only bucket",
          kind: "byo",
        }]}
        lock={lapsed.response.body}
        onReview={() => undefined}
        onPay={() => undefined}
      />,
    );
    expect(screen.getByTestId("pay-to-restore")).toBeTruthy();
    expect(screen.getByTestId("lock-reason").props.children).toContain("lapsed");
  });
});
