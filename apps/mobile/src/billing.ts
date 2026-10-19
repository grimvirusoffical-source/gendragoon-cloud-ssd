/** Web billing page when checkout does not return a URL. Empty until the page exists. */
export const BILLING_PAGE_URL = process.env.EXPO_PUBLIC_BILLING_URL ?? "";

/**
 * Pay for an unpaid workspace. `checkoutWorkspace` is POST /v2/projects/:id/checkout, which
 * resumes the workspace's single plans Checkout (storage + performance, no separate fee).
 * A returned URL is opened. Otherwise (for example a lapsed subscription that is managed in
 * the billing portal) the web billing page is opened.
 */
export async function payToRestore(input: {
  unpaidWorkspaceIds: readonly string[];
  checkoutWorkspace?: (id: string) => Promise<{ url?: string }>;
  openUrl: (url: string) => Promise<unknown> | unknown;
  billingPageUrl?: string;
}): Promise<void> {
  if (input.checkoutWorkspace) {
    for (const id of input.unpaidWorkspaceIds) {
      const checkout = await input.checkoutWorkspace(id);
      if (checkout?.url) {
        await input.openUrl(checkout.url);
        return;
      }
    }
  }
  const page = input.billingPageUrl ?? BILLING_PAGE_URL;
  if (page) {
    await input.openUrl(page);
    return;
  }
  throw new Error("Billing is not available in this build.");
}
