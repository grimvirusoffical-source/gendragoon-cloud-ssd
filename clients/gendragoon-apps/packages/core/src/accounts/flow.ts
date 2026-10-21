import type { TwoFactorMethod } from "./rules.js";

export const FALSE_INFO_WARNING =
  "Use your real details. If any of them are false, we won't be able to recover your account.";

export const NO_TWO_FACTOR_WARNING =
  "Without two-factor sign-in, anyone who learns your password can get into your account. " +
  "Red-XAI LLC isn't responsible if your account is compromised while two-factor sign-in is off.";

export const NO_TWO_FACTOR_ACK_LABEL = "I understand and accept this risk";

export interface TwoFactorOption {
  method: TwoFactorMethod;
  label: string;
  detail: string;
  available: boolean;
  /** Offered only when the server's rules say it is available (phone needs a configured SMS provider). */
  serverGated?: boolean;
}

export const TWO_FACTOR_OPTIONS: readonly TwoFactorOption[] = [
  { method: "app", label: "Authenticator app", detail: "Scan a QR code with an app like 1Password, Authy or Google Authenticator.", available: true },
  { method: "phone", label: "Phone (text message)", detail: "We text a 6-digit code to your phone.", available: true, serverGated: true },
  { method: "redxai_auth", label: "Red-XAI Auth", detail: "Coming soon", available: false },
  { method: "none", label: "No two-factor sign-in", detail: "Not recommended.", available: true },
];

/**
 * Whether a 2FA choice can be picked. The server's `rules.twoFactor` list has the last word: anything it marks
 * unavailable is off, and server-gated methods (phone) stay off until the server says they are available, so
 * Phone appears only once the backend has a text-message provider configured.
 */
export function twoFactorOptionAvailable(
  option: TwoFactorOption,
  server?: ReadonlyArray<{ method: TwoFactorMethod; available: boolean }> | null,
): boolean {
  if (!option.available) return false;
  const said = server?.find((m) => m.method === option.method)?.available;
  return option.serverGated ? said === true : said !== false;
}

/**
 * Terms gate. The person scrolls to the end, presses "Read ToS" (the server
 * issues a read grant), then "Agree to ToS" (the server advances the grant).
 * Each step only opens after the one before it, here and on the server.
 */
export interface TosGateState {
  scrolledToEnd: boolean;
  read: boolean;
  agreed: boolean;
}

export type TosGateEvent = { type: "scrolled_end" } | { type: "read" } | { type: "agree" } | { type: "reset" };

export const TOS_GATE_START: TosGateState = { scrolledToEnd: false, read: false, agreed: false };

export function reduceTosGate(state: TosGateState, event: TosGateEvent): TosGateState {
  switch (event.type) {
    case "scrolled_end":
      return state.scrolledToEnd ? state : { ...state, scrolledToEnd: true };
    case "read":
      return state.scrolledToEnd ? { ...state, read: true } : state;
    case "agree":
      return state.read ? { ...state, agreed: true } : state;
    case "reset":
      return TOS_GATE_START;
    default:
      return state;
  }
}

/** True when a scrolled box shows its last line (2 px tolerance for fractional scrolling). */
export function scrolledToEnd(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  return scrollTop + clientHeight >= scrollHeight - 2;
}

/** The arrow buttons between a field and its confirm box. */
export type CopyDirection = "down" | "up";

export function copyAcross(direction: CopyDirection, pair: { value: string; confirm: string }): { value: string; confirm: string } {
  return direction === "down" ? { value: pair.value, confirm: pair.value } : { value: pair.confirm, confirm: pair.confirm };
}
