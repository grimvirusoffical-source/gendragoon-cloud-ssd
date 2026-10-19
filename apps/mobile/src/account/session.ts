/** Shown when a new sign-in is not the account that is already signed in. */
export const SAME_ACCOUNT_MESSAGE = "Sign in with the same account to continue.";

/**
 * The account check runs before the session token is replaced.
 * A current uid, and a uid saved with a deletion job, both have to match.
 * An empty current uid is a signed-out session and may sign in.
 */
export function sessionMaySwap(currentUid: string | null, nextUid: string | null): boolean {
  if (currentUid === null || currentUid.length === 0) return true;
  return nextUid === currentUid;
}

/** `invalid_token` drops only the session token. A bare 401 keeps it. */
export function sessionTokenAfterAuthFailure(action: "reauth" | "sign-out" | null, token: string): string {
  return action === "sign-out" ? "" : token;
}
