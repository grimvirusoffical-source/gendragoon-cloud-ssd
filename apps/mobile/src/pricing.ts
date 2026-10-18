/**
 * Sentence copy around `@gendragoon/core`'s `workspacePriceLabel`.
 * Free, Included, and cent formatting live in core.
 * `feeWaived` is not on core's helper yet (296cb96). Until
 * `workspacePriceLabel` returns Included for that flag, this file does.
 * The flag is required: a missing or non-boolean value is a parse error,
 * not `false`.
 */
import { parseWorkspacePrice, workspacePriceLabel, type WorkspacePrice } from "@gendragoon/core";

/** Reads `feeWaived`. Missing and non-booleans throw; they are not false. */
export function parseFeeWaived(value: unknown): boolean {
  if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, "feeWaived")) {
    throw new TypeError("Workspace feeWaived is missing");
  }
  const flag = (value as { feeWaived: unknown }).feeWaived;
  if (typeof flag !== "boolean") throw new TypeError("Workspace feeWaived is missing");
  return flag;
}

export function serverPriceLabel(value: unknown): string | null {
  let waived: boolean;
  try {
    waived = parseFeeWaived(value);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  try {
    const price = parseWorkspacePrice(value);
    const label = workspacePriceLabel(price);
    if (price.isFree) return label;
    if (waived) return "Included";
    return label;
  } catch (error) {
    if (error instanceof TypeError) return waived ? "Included" : null;
    throw error;
  }
}

/** BYO register body that ends grandfathered included pricing. */
export function grandfatheringEnded(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { grandfatheringEnded?: unknown }).grandfatheringEnded === true;
}

/** Price to show once register reports `grandfatheringEnded`. Core formats the cents. */
export function grandfatheringEndedPrice(value: unknown): string | null {
  if (!grandfatheringEnded(value)) return null;
  return serverPriceLabel(value);
}

/** `$5.00/mo` from core's cent formatter. Zero and missing amounts stay blank. */
export function formatMonthlyPrice(cents: number | undefined | null): string | null {
  if (typeof cents !== "number" || !Number.isInteger(cents) || cents === 0) return null;
  const label = workspacePriceLabel({ isFree: false, grandfathered: false, monthlyPriceCents: cents });
  return `${label}/mo`;
}

/** Banner copy from the server monthly amount. Missing or zero cents produce no banner. */
export function additionalWorkspaceFeeText(cents: number | undefined | null): string | null {
  const price = formatMonthlyPrice(cents);
  if (!price) return null;
  return `An additional workspace is ${price}.`;
}

/** Unpaid card subtitle. The amount is `monthlyPriceCents` only. */
export function unpaidWorkspaceSubtitle(cents: number | undefined): string {
  const price = formatMonthlyPrice(cents);
  return price ? `${price} · Payment needed` : "Payment needed";
}

function quotePrice(quote: unknown): WorkspacePrice | null {
  try {
    return parseWorkspacePrice(quote);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function quoteCents(quote: unknown): number | undefined {
  const price = quotePrice(quote);
  if (price) return price.monthlyPriceCents;
  if (!quote || typeof quote !== "object") return undefined;
  const cents = (quote as { monthlyPriceCents?: unknown }).monthlyPriceCents;
  return typeof cents === "number" && Number.isInteger(cents) ? cents : undefined;
}

/**
 * Create-screen explanation for the option the user has selected.
 * When the server did not send `monthlyPriceCents`, the sentence has no number.
 * A BYO register body has the cents without `grandfathered`, so the sentence
 * uses those cents through core's formatter.
 */
export function workspaceQuoteExplanation(storage: "hosted" | "byo", quote: unknown): string {
  const price = quotePrice(quote);
  const amount = formatMonthlyPrice(price?.isFree || price?.grandfathered ? 0 : quoteCents(quote));
  if (storage === "byo") {
    return amount ? `Bring-your-own storage is ${amount}` : "Bring-your-own storage is billed monthly.";
  }
  if (price?.isFree === true) return "Your first hosted workspace is free";
  return amount ? `Additional workspaces are ${amount}` : "Additional workspaces are billed monthly.";
}

/** Shown before BYO register replaces grandfathered included pricing. */
export function includedPricingEndsWarning(cents: number): string {
  const amount = formatMonthlyPrice(cents);
  const cost = amount ?? "the monthly workspace price";
  return `Switching to your own storage ends this workspace's included pricing. It will cost ${cost}.`;
}
