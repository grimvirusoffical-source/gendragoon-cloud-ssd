import type { WorkspaceRecord } from "@gendragoon/core";
import { render } from "@testing-library/react-native";
import { WORKSPACE_PRICING_ENABLED } from "../src/flags";
import { readWorkspacePrice, workspacePriceLabel, type WorkspacePriceInput } from "../src/pricing";
import { LockScreen, NewWorkspaceScreen, WorkspacesScreen } from "../src/screens";
import { FIXTURE_SOURCE_SHA_BY_AREA, loadFixture } from "./loadFixture";

const PRICING_SHA = "568f2236ffe2520758fb8f20cf22566aefc14cf3";

const PRICING_FIXTURES = [
  "free-first",
  "byo-first-paid",
  "second-paid",
  "delete-free-then-create",
  "free-to-byo-billable",
  "concurrent-create-one-free",
  "list-byo-only",
  "list-hosted-plus-byo",
] as const;

interface ListedBody {
  policy: { workspaceMonthlyCents: number };
  workspaces: Array<WorkspaceRecord & WorkspacePriceInput>;
}

interface CreatedBody {
  isFree: boolean;
  monthlyPriceCents: number;
  project: WorkspaceRecord & WorkspacePriceInput;
}

function listed(rel: string): ListedBody {
  const fixture = loadFixture<ListedBody>(rel);
  expect(fixture.sourceSha).toBe(PRICING_SHA);
  expect(fixture.sourceSha).toBe(FIXTURE_SOURCE_SHA_BY_AREA.workspaces);
  return fixture.response.body;
}

/**
 * PROVISIONAL. Riley is adding `workspaces/grandfathered-plus-new.json` to PR #5.
 * These two rows stand in for that file. They are not a vendored server fixture.
 */
const PROVISIONAL_GRANDFATHERED_PLUS_NEW: ListedBody["workspaces"] = [
  {
    id: "grandfathered",
    name: "Grandfathered",
    kind: "paid",
    isFree: false,
    grandfathered: true,
    monthlyPriceCents: 0,
  },
  {
    id: "new-paid",
    name: "New workspace",
    kind: "paid",
    isFree: false,
    grandfathered: false,
    monthlyPriceCents: 500,
  },
];

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
        monthlyCents={body.policy.workspaceMonthlyCents}
        onDelete={() => undefined}
        onMerge={() => undefined}
      />,
    );
    expect(body.workspaces[0]?.monthlyPriceCents).toBe(500);
    expect(body.workspaces[0]?.isFree).toBe(false);
    expect(screen.getByTestId("workspace-price-11111111-1111-4111-8111-000000000003").props.children).toBe("$5.00/mo");
    expect(screen.queryByText("Free")).toBeNull();
    expect(screen.queryByText("$0.00/mo")).toBeNull();
  });

  it("labels list-hosted-plus-byo from isFree and monthlyPriceCents", async () => {
    const body = listed("workspaces/list-hosted-plus-byo.json");
    const screen = await render(
      <WorkspacesScreen
        workspaces={body.workspaces}
        unpaidIds={[]}
        monthlyCents={body.policy.workspaceMonthlyCents}
        onDelete={() => undefined}
        onMerge={() => undefined}
      />,
    );
    expect(screen.getByTestId("workspace-price-11111111-1111-4111-8111-000000000001").props.children).toBe("$5.00/mo");
    expect(screen.getByTestId("workspace-price-11111111-1111-4111-8111-000000000002").props.children).toBe("Free");
    expect(screen.queryByText("$0.00/mo")).toBeNull();
  });

  it("shows the create quote before the confirm button", async () => {
    const free = loadFixture<CreatedBody>("workspaces/free-first.json");
    const paid = loadFixture<CreatedBody>("workspaces/second-paid.json");
    const replaced = loadFixture<CreatedBody>("workspaces/delete-free-then-create.json");
    expect(workspacePriceLabel(free.response.body.project)).toBe("Free");
    expect(workspacePriceLabel(replaced.response.body.project)).toBe("Free");
    expect(workspacePriceLabel(paid.response.body.project)).toBe("$5.00/mo");
    const screen = await render(
      <NewWorkspaceScreen quote={free.response.body.project} onCreate={() => undefined} />,
    );
    expect(screen.getByTestId("new-workspace-price").props.children).toBe("Free");
    expect(screen.getByTestId("create-workspace")).toBeTruthy();
    const second = await render(
      <NewWorkspaceScreen quote={paid.response.body.project} onCreate={() => undefined} />,
    );
    expect(second.getByTestId("new-workspace-price").props.children).toBe("$5.00/mo");
  });

  it("labels a BYO register at 500 cents and keeps one free workspace in a concurrent create", () => {
    const byo = loadFixture<{ isFree: boolean; monthlyPriceCents: number }>("workspaces/byo-first-paid.json");
    const converted = loadFixture<{ isFree: boolean; monthlyPriceCents: number }>("workspaces/free-to-byo-billable.json");
    expect(byo.response.body.monthlyPriceCents).toBe(500);
    expect(workspacePriceLabel(byo.response.body)).toBe("$5.00/mo");
    expect(converted.response.body.isFree).toBe(false);
    expect(workspacePriceLabel(converted.response.body)).toBe("$5.00/mo");
    const concurrent = listed("workspaces/concurrent-create-one-free.json");
    expect(workspacePriceLabel(concurrent.workspaces[0])).toBe("Free");
    expect(workspacePriceLabel(concurrent.workspaces[1])).toBe("$5.00/mo");
  });

  it("shows Free only for isFree, Included for grandfathered, and never $0.00/mo", () => {
    expect(workspacePriceLabel({ isFree: true, grandfathered: true, monthlyPriceCents: 0 })).toBe("Free");
    expect(workspacePriceLabel({ isFree: false, grandfathered: true, monthlyPriceCents: 0 })).toBe("Included");
    expect(workspacePriceLabel({ isFree: false, grandfathered: false, monthlyPriceCents: 0 })).toBeNull();
    expect(workspacePriceLabel({ isFree: false, monthlyPriceCents: 750 })).toBe("$7.50/mo");
    expect(readWorkspacePrice(null)).toBeNull();
    expect(readWorkspacePrice({ name: "no price" })).toBeNull();
  });

  it("PROVISIONAL grandfathered-plus-new: Included beside the new workspace price", async () => {
    const screen = await render(
      <WorkspacesScreen
        workspaces={PROVISIONAL_GRANDFATHERED_PLUS_NEW}
        unpaidIds={[]}
        monthlyCents={500}
        onDelete={() => undefined}
        onMerge={() => undefined}
      />,
    );
    expect(screen.getByTestId("workspace-price-grandfathered").props.children).toBe("Included");
    expect(screen.getByTestId("workspace-price-new-paid").props.children).toBe("$5.00/mo");
    expect(screen.queryByText("$0.00/mo")).toBeNull();
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
