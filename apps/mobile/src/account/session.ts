/** Shown when a new sign-in is not the account that owns the saved deletion job. */
export const SAME_ACCOUNT_MESSAGE = "Sign in with the same account to continue.";

/**
 * A deletion job pins the session to its uid. Any other account is refused
 * before the session token is replaced. With no saved job, sign-in may proceed.
 */
export function sessionMaySwap(savedUid: string | null, nextUid: string | null): boolean {
  if (savedUid === null || savedUid.length === 0) return true;
  return nextUid === savedUid;
}
