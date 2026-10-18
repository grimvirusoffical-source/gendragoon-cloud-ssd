import { parseWorkspacePrice, workspacePriceLabel, type WorkspacePrice, type WorkspaceRecord } from "@gendragoon/core";
import { fireEvent, render } from "@testing-library/react-native";
import { WORKSPACE_PRICING_ENABLED } from "../src/flags";
import { additionalWorkspaceFeeText, grandfatheringEndedPrice, includedPricingEndsWarning, parseFeeWaived, serverPriceLabel, workspaceQuoteExplanation } from "../src/pricing";
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

interface CreatedBody {
  isFree: boolean;
  monthlyPriceCents: number;
  project: WorkspaceRecord & WorkspacePrice;
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
        additionalMonthlyCents={body.policy.workspaceMonthlyCents}
        onDelete={() => undefined}
        onMerge={() => undefined}
      />,
    );
    expect(body.workspaces[0]?.monthlyPriceCents).toBe(500);
    expect(body.workspaces[0]?.isFree).toBe(false);
    expect(() => parseFeeWaived(body.workspaces[0])).toThrow(TypeError);
    expect(serverPriceLabel(body.workspaces[0])).toBeNull();
    expect(workspacePriceLabel(parseWorkspacePrice(body.workspaces[0]))).toBe("$5.00");
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
        additionalMonthlyCents={body.policy.workspaceMonthlyCents}
        onDelete={() => undefined}
        onMerge={() => undefined}
      />,
    );
    expect(serverPriceLabel(body.workspaces[0])).toBeNull();
    expect(serverPriceLabel(body.workspaces[1])).toBeNull();
    expect(workspacePriceLabel(parseWorkspacePrice(body.workspaces[0]))).toBe("$5.00");
    expect(workspacePriceLabel(parseWorkspacePrice(body.workspaces[1]))).toBe("Free");
    expect(screen.queryByTestId("workspace-price-11111111-1111-4111-8111-000000000001")).toBeNull();
    expect(screen.queryByTestId("workspace-price-11111111-1111-4111-8111-000000000002")).toBeNull();
    expect(screen.queryByText("$0.00/mo")).toBeNull();
  });

  it("shows the create quote before the confirm button and waits for a name", async () => {
    const free = loadFixture<CreatedBody>("workspaces/free-first.json");
    const paid = loadFixture<CreatedBody>("workspaces/second-paid.json");
    const replaced = loadFixture<CreatedBody>("workspaces/delete-free-then-create.json");
    const byo = loadFixture<{ isFree: boolean; monthlyPriceCents: number }>("workspaces/byo-first-paid.json");
    expect(workspacePriceLabel(parseWorkspacePrice(free.response.body.project))).toBe("Free");
    expect(workspacePriceLabel(parseWorkspacePrice(replaced.response.body.project))).toBe("Free");
    expect(workspacePriceLabel(parseWorkspacePrice(paid.response.body.project))).toBe("$5.00");
    expect(workspaceQuoteExplanation("hosted", free.response.body.project)).toBe("Your first hosted workspace is free");
    expect(workspaceQuoteExplanation("hosted", paid.response.body.project)).toBe("Additional workspaces are $5.00/mo");
    expect(workspaceQuoteExplanation("byo", byo.response.body)).toBe("Bring-your-own storage is $5.00/mo");
    const screen = await render(
      <NewWorkspaceScreen quote={free.response.body.project} byoQuote={byo.response.body} onCreate={() => undefined} />,
    );
    expect(screen.getByTestId("new-workspace-explain").props.children).toBe("Your first hosted workspace is free");
    expect(screen.queryByTestId("new-workspace-price")).toBeNull();
    expect(screen.getByTestId("create-workspace")).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId("workspace-name"), "Vacation photos");
    expect(screen.getByTestId("create-workspace")).not.toBeDisabled();
    await fireEvent.press(screen.getByTestId("storage-byo"));
    expect(screen.getByTestId("new-workspace-explain").props.children).toBe("Bring-your-own storage is $5.00/mo");
    expect(screen.getByTestId("create-byo-aws")).toBeTruthy();
    expect(screen.getByText("SFTP · Coming soon")).toBeTruthy();
    const second = await render(
      <NewWorkspaceScreen quote={paid.response.body.project} onCreate={() => undefined} />,
    );
    expect(second.getByTestId("new-workspace-explain").props.children).toBe("Additional workspaces are $5.00/mo");
    expect(second.queryByTestId("new-workspace-price")).toBeNull();
    const priced = await render(
      <NewWorkspaceScreen
        quote={{ isFree: true, grandfathered: false, monthlyPriceCents: 0, feeWaived: false }}
        onCreate={() => undefined}
      />,
    );
    expect(priced.getByTestId("new-workspace-price").props.children).toBe("Free");
  });

  it("labels a BYO register at 500 cents and keeps one free workspace in a concurrent create", () => {
    const byo = loadFixture<{ isFree: boolean; monthlyPriceCents: number }>("workspaces/byo-first-paid.json");
    const converted = loadFixture<{ isFree: boolean; monthlyPriceCents: number }>("workspaces/free-to-byo-billable.json");
    expect(byo.response.body.monthlyPriceCents).toBe(500);
    expect(serverPriceLabel(byo.response.body)).toBeNull();
    expect(workspaceQuoteExplanation("byo", byo.response.body)).toBe("Bring-your-own storage is $5.00/mo");
    expect(converted.response.body.isFree).toBe(false);
    expect(workspaceQuoteExplanation("byo", converted.response.body)).toBe("Bring-your-own storage is $5.00/mo");
    const concurrent = listed("workspaces/concurrent-create-one-free.json");
    expect(workspacePriceLabel(parseWorkspacePrice(concurrent.workspaces[0]))).toBe("Free");
    expect(workspacePriceLabel(parseWorkspacePrice(concurrent.workspaces[1]))).toBe("$5.00");
  });

  it("uses core's label: Free, Included, or formatted cents", () => {
    expect(workspacePriceLabel({ isFree: true, grandfathered: true, monthlyPriceCents: 0 })).toBe("Free");
    expect(workspacePriceLabel({ isFree: false, grandfathered: true, monthlyPriceCents: 0 })).toBe("Included");
    expect(workspacePriceLabel({ isFree: false, grandfathered: false, monthlyPriceCents: 0 })).toBe("$0.00");
    expect(workspacePriceLabel({ isFree: false, grandfathered: false, monthlyPriceCents: 750 })).toBe("$7.50");
    expect(() => parseWorkspacePrice(null)).toThrow(TypeError);
    expect(() => parseWorkspacePrice({ name: "no price" })).toThrow(TypeError);
    expect(serverPriceLabel(null)).toBeNull();
    expect(serverPriceLabel({ name: "no price" })).toBeNull();
    expect(() => parseFeeWaived({ isFree: false, grandfathered: false, monthlyPriceCents: 500 })).toThrow(TypeError);
    expect(serverPriceLabel({ isFree: false, grandfathered: false, monthlyPriceCents: 500 })).toBeNull();
    expect(serverPriceLabel({ isFree: false, grandfathered: false, monthlyPriceCents: 500, feeWaived: false })).toBe("$5.00");
    expect(serverPriceLabel({ isFree: false, grandfathered: false, monthlyPriceCents: 500, feeWaived: true })).toBe("Included");
    expect(serverPriceLabel({ isFree: true, grandfathered: false, monthlyPriceCents: 0, feeWaived: true })).toBe("Free");
    expect(serverPriceLabel({ feeWaived: true })).toBe("Included");
  });

  it("a BYO register that ends grandfathering shows the price and warns before confirm", async () => {
    const body = {
      byoRegistered: true,
      endpoint: "https://bucket.s3.us-east-1.amazonaws.com",
      providerType: "s3",
      grandfatheringEnded: true,
      grandfathered: false,
      isFree: false,
      monthlyPriceCents: 500,
      feeWaived: false,
    };
    expect(grandfatheringEndedPrice({ ...body, feeWaived: undefined })).toBeNull();
    expect(grandfatheringEndedPrice(body)).toBe("$5.00");
    expect(includedPricingEndsWarning(500)).toBe(
      "Switching to your own storage ends this workspace's included pricing. It will cost $5.00/mo.",
    );
    const screen = await render(<ConnectStorageScreen registration={body} />);
    expect(screen.getByTestId("byo-ended-price").props.children).toBe("$5.00");
    expect(screen.getByTestId("byo-included-warning")).toHaveTextContent(includedPricingEndsWarning(500));
    expect(screen.queryByTestId("byo-registered")).toBeNull();
    await fireEvent.press(screen.getByTestId("byo-confirm-included"));
    expect(screen.getByTestId("byo-registered")).toHaveTextContent(`s3 · ${body.endpoint}`);
  });

  it("labels grandfathered-plus-new from the vendored fixture", async () => {
    const body = listed("workspaces/grandfathered-plus-new.json");
    const screen = await render(
      <WorkspacesScreen
        workspaces={body.workspaces}
        unpaidIds={[]}
        additionalMonthlyCents={body.policy.workspaceMonthlyCents}
        onDelete={() => undefined}
        onMerge={() => undefined}
      />,
    );
    expect(workspacePriceLabel(parseWorkspacePrice(body.workspaces[0]))).toBe("Included");
    expect(workspacePriceLabel(parseWorkspacePrice(body.workspaces[1]))).toBe("Free");
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
    expect(parseFeeWaived(project)).toBe(true);
    expect(parseFeeWaived(fixture.response.body)).toBe(true);
    expect(serverPriceLabel(project)).toBe("Included");
    const withoutFee = { ...project };
    delete (withoutFee as { feeWaived?: boolean }).feeWaived;
    expect(() => parseFeeWaived(withoutFee)).toThrow(TypeError);
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
        additionalMonthlyCents={body.policy.workspaceMonthlyCents}
        onDelete={onDelete}
        onMerge={() => undefined}
        onPay={onPay}
      />,
    );
    expect(additionalWorkspaceFeeText(body.policy.workspaceMonthlyCents)).toBe("An additional workspace is $5.00/mo.");
    expect(screen.getByTestId("workspace-fee")).toHaveTextContent("An additional workspace is $5.00/mo.");
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
