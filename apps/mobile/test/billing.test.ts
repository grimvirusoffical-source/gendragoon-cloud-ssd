import { payToRestore } from "../src/billing";

describe("pay to restore", () => {
  it("opens the checkout URL for an unpaid workspace", async () => {
    const opened: string[] = [];
    const checkoutWorkspaceFee = jest.fn(async (id: string) => ({ url: `https://billing.example.test/${id}`, workspaceId: id, monthlyCents: 500 as const }));
    await payToRestore({
      unpaidWorkspaceIds: ["ws-1"],
      checkoutWorkspaceFee,
      openUrl: async (url) => {
        opened.push(url);
      },
    });
    expect(checkoutWorkspaceFee).toHaveBeenCalledWith("ws-1");
    expect(opened).toEqual(["https://billing.example.test/ws-1"]);
  });

  it("opens the web billing page when checkout returns no URL", async () => {
    const opened: string[] = [];
    await payToRestore({
      unpaidWorkspaceIds: ["ws-1"],
      checkoutWorkspaceFee: async () => ({ url: undefined, workspaceId: "ws-1", monthlyCents: 500 as const }),
      openUrl: async (url) => {
        opened.push(url);
      },
      billingPageUrl: "https://billing.example.test/account",
    });
    expect(opened).toEqual(["https://billing.example.test/account"]);
  });
});