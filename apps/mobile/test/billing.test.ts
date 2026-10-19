import { payToRestore } from "../src/billing";

describe("pay to restore", () => {
  it("opens the plans checkout URL for an unpaid workspace (no fee checkout)", async () => {
    const opened: string[] = [];
    const checkoutWorkspace = jest.fn(async (id: string) => ({ url: `https://checkout.stripe.com/c/pay/${id}`, workspaceId: id }));
    await payToRestore({
      unpaidWorkspaceIds: ["ws-1"],
      checkoutWorkspace,
      openUrl: async (url) => {
        opened.push(url);
      },
    });
    expect(checkoutWorkspace).toHaveBeenCalledWith("ws-1");
    expect(opened).toEqual(["https://checkout.stripe.com/c/pay/ws-1"]);
  });

  it("opens the web billing page when checkout returns no URL", async () => {
    const opened: string[] = [];
    await payToRestore({
      unpaidWorkspaceIds: ["ws-1"],
      checkoutWorkspace: async () => ({ url: undefined, alreadyActivated: true }),
      openUrl: async (url) => {
        opened.push(url);
      },
      billingPageUrl: "https://billing.example.test/account",
    });
    expect(opened).toEqual(["https://billing.example.test/account"]);
  });
});