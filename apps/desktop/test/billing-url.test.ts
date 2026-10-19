import { describe, expect, it } from "vitest";
import { isStripeUrl } from "../src/main/billing-url.js";

describe("isStripeUrl", () => {
  it("allows only https Stripe checkout and billing pages", () => {
    expect(isStripeUrl("https://checkout.stripe.com/c/pay/cs_test_1")).toBe(true);
    expect(isStripeUrl("https://billing.stripe.com/p/session/x")).toBe(true);
    for (const url of ["http://checkout.stripe.com/c/pay/x", "https://checkout.stripe.com.evil.test/x", "https://user:pw@checkout.stripe.com/x", "javascript:alert(1)", "file:///etc/passwd", 42, null]) {
      expect(isStripeUrl(url)).toBe(false);
    }
  });
});
