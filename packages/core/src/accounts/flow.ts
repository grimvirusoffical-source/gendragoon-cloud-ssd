import type { TwoFactorMethod } from "./rules.js";

/** The Terms of Service version this build shows. Must match the server's current version. */
export const TOS_VERSION = "gendragoon-tos-2026-10-19";

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
}

export const TWO_FACTOR_OPTIONS: readonly TwoFactorOption[] = [
  { method: "totp", label: "Authenticator app", detail: "Scan a QR code with an app like 1Password, Authy or Google Authenticator.", available: true },
  { method: "sms", label: "Phone (text message)", detail: "We text a 6-digit code to your phone.", available: true },
  { method: "redxai_auth", label: "Red-XAI Auth", detail: "Coming soon", available: false },
  { method: "none", label: "No two-factor sign-in", detail: "Not recommended.", available: true },
];

/**
 * Terms gate. The person scrolls to the end, presses "Read ToS", then
 * "Agree to ToS". Each step only opens after the one before it.
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
