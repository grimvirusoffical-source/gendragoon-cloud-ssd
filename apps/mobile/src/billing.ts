/** Web billing page when checkout does not return a URL. Empty until the page exists. */
export const BILLING_PAGE_URL = process.env.EXPO_PUBLIC_BILLING_URL ?? "";

/**
 * Lapsed locks use checkout for each unpaid workspace. A returned URL is opened.
 * With no in-app checkout URL, the web billing page is opened instead.
 */
export async function payToRestore(input: {
  unpaidWorkspaceIds: readonly string[];
  checkoutWorkspaceFee?: (id: string) => Promise<{ url?: string }>;
  openUrl: (url: string) => Promise<unknown> | unknown;
  billingPageUrl?: string;
}): Promise<void> {
  if (input.checkoutWorkspaceFee) {
    for (const id of input.unpaidWorkspaceIds) {
      const checkout = await input.checkoutWorkspaceFee(id);
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
