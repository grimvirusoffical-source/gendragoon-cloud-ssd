/**
 * Sentence copy around `@gendragoon/core`'s price and plan helpers.
 * The workspace fee is included in the storage plans, so there is no fee copy here.
 * A plans workspace shows its plans ("100GB + Boost"); other rows use core's
 * Free / Included / cents label. A missing `feeWaived` is a parse error, so no label.
 */
import { parseWorkspacePrice, workspacePlansLabel, workspacePriceLabel } from "@gendragoon/core";

export function serverPriceLabel(value: unknown): string | null {
  const plans = workspacePlansLabel(value);
  if (plans) return plans;
  try {
    return workspacePriceLabel(parseWorkspacePrice(value));
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

/** `$12.50/mo` from core's cent formatter. Zero and missing amounts stay blank. */
export function formatMonthlyPrice(cents: number | undefined | null): string | null {
  if (typeof cents !== "number" || !Number.isInteger(cents) || cents === 0) return null;
  const label = workspacePriceLabel({ isFree: false, grandfathered: false, feeWaived: false, monthlyPriceCents: cents });
  return `${label}/mo`;
}

/** Unpaid card subtitle. The amount is `monthlyPriceCents` only (0 for plans workspaces). */
export function unpaidWorkspaceSubtitle(cents: number | undefined): string {
  const price = formatMonthlyPrice(cents);
  return price ? `${price} · Payment needed` : "Payment needed";
}

/** `$12.40` for a plan quote. */
export function formatCents(cents: number): string {
  return workspacePriceLabel({ isFree: false, grandfathered: false, feeWaived: false, monthlyPriceCents: cents });
}
