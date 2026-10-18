/**
 * TODO: delete this shim when `@gendragoon/core` exports the pricing label
 * helper. Core PR #1 is adding that helper for `isFree`, `grandfathered`
 * ("Included"), and `monthlyPriceCents`. Until it lands, this file is the
 * only copy of the rules.
 *
 * "Free" only when `isFree` is true.
 * "Included" when `grandfathered` is true (`isFree` is false and the price is 0).
 * Otherwise the formatted `monthlyPriceCents`. Never "$0.00/mo".
 */
export interface WorkspacePriceInput {
  isFree?: boolean;
  grandfathered?: boolean;
  monthlyPriceCents?: number;
}

/** Reads the server price fields. Missing fields stay unset. Core types do not include them yet. */
export function readWorkspacePrice(value: unknown): WorkspacePriceInput | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const price: WorkspacePriceInput = {};
  if (typeof record.isFree === "boolean") price.isFree = record.isFree;
  if (record.grandfathered === true) price.grandfathered = true;
  if (record.grandfathered === false) price.grandfathered = false;
  if (typeof record.monthlyPriceCents === "number" && Number.isFinite(record.monthlyPriceCents)) {
    price.monthlyPriceCents = record.monthlyPriceCents;
  }
  if (price.isFree === undefined && price.grandfathered === undefined && price.monthlyPriceCents === undefined) {
    return null;
  }
  return price;
}

export function workspacePriceLabel(value: unknown): "Free" | "Included" | `${string}/mo` | null {
  const price = readWorkspacePrice(value);
  if (!price) return null;
  if (price.isFree === true) return "Free";
  if (price.grandfathered === true) return "Included";
  return formatMonthly(price.monthlyPriceCents);
}

export function formatMonthlyPrice(cents: number | undefined): `${string}/mo` | null {
  if (typeof cents !== "number" || !Number.isFinite(cents) || cents === 0) return null;
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
  return `${amount}/mo`;
}

function formatMonthly(cents: number | undefined): `${string}/mo` | null {
  return formatMonthlyPrice(cents);
}

/** Banner copy from the server monthly amount. Missing or zero cents produce no banner. */
export function additionalWorkspaceFeeText(cents: number | undefined | null): string | null {
  const price = formatMonthlyPrice(cents ?? undefined);
  if (!price) return null;
  return `An additional workspace is ${price}.`;
}

/** Unpaid card subtitle. The amount is `monthlyPriceCents` only. */
export function unpaidWorkspaceSubtitle(cents: number | undefined): string {
  const price = formatMonthlyPrice(cents);
  return price ? `${price} · Payment needed` : "Payment needed";
}

/**
 * Create-screen explanation for the option the user has selected.
 * When the server did not send `monthlyPriceCents`, the sentence has no number.
 */
export function workspaceQuoteExplanation(storage: "hosted" | "byo", quote: unknown): string {
  const price = readWorkspacePrice(quote);
  const amount = formatMonthlyPrice(price?.monthlyPriceCents);
  if (storage === "byo") {
    return amount ? `Bring-your-own storage is ${amount}` : "Bring-your-own storage is billed monthly.";
  }
  if (price?.isFree === true) return "Your first hosted workspace is free";
  return amount ? `Additional workspaces are ${amount}` : "Additional workspaces are billed monthly.";
}
