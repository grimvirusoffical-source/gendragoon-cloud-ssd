/** Only https Stripe-hosted checkout and billing pages may leave the app. */
export function isStripeUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && ["checkout.stripe.com", "billing.stripe.com"].includes(parsed.hostname);
  } catch {
    return false;
  }
}
