import { AccountsApiError, AccountsClient, beginSignIn, beginSignUp, completeSignIn, refreshTokens, type OidcTokens } from "@gendragoon/core";

/**
 * Red-XAI Account sign-in for the extension: authorization code + PKCE through
 * the browser's web auth flow (`identity.launchWebAuthFlow`). "Create account"
 * opens the hosted sign-up page, which applies the same rules as the apps
 * (Terms, date of birth, username, password, second factor).
 */
export interface ExtensionAuthDeps {
  issuer: string;
  apiBase: string;
  /** `identity.getRedirectURL("oauth2")`. */
  redirectUri: string;
  /** `identity.launchWebAuthFlow({url, interactive: true})`, resolving to the redirect URL. */
  launchWebAuthFlow: (url: string) => Promise<string>;
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void> };
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const KEY = "redxaiSession";

export type AccountStatus =
  | { state: "signed-out" }
  | { state: "ready"; username: string }
  | { state: "needs-setup"; reason: "account_setup_required" | "tos_required" | "two_factor_setup_required" | "two_factor_required" | "tos" }
  | { state: "error"; code: string };

export async function signIn(deps: ExtensionAuthDeps, mode: "sign-in" | "sign-up"): Promise<AccountStatus> {
  const config = { issuer: deps.issuer, redirectUri: deps.redirectUri };
  const { url, pending } = mode === "sign-up" ? await beginSignUp(config) : await beginSignIn(config);
  const redirect = await deps.launchWebAuthFlow(url);
  const tokens = await completeSignIn(config, pending, redirect, { fetchImpl: deps.fetchImpl, now: deps.now?.() });
  await deps.storage.set(KEY, tokens);
  return status(deps);
}

export async function signOut(deps: ExtensionAuthDeps): Promise<void> {
  await deps.storage.remove(KEY);
}

async function accessToken(deps: ExtensionAuthDeps): Promise<string | null> {
  const tokens = (await deps.storage.get(KEY)) as OidcTokens | undefined;
  if (!tokens) return null;
  const now = deps.now?.() ?? Date.now();
  if (tokens.expiresAtMs - 60_000 > now) return tokens.accessToken;
  if (!tokens.refreshToken) return null;
  try {
    const next = await refreshTokens({ issuer: deps.issuer, redirectUri: deps.redirectUri }, tokens.refreshToken, { fetchImpl: deps.fetchImpl, now });
    await deps.storage.set(KEY, next);
    return next.accessToken;
  } catch (error) {
    if ((error as { code?: string }).code !== "token_failed") await deps.storage.remove(KEY);
    return null;
  }
}

/** Gendragoon's side of the account: present, current Terms, second factor. */
export async function status(deps: ExtensionAuthDeps): Promise<AccountStatus> {
  const token = await accessToken(deps);
  if (!token) return { state: "signed-out" };
  const client = new AccountsClient({ baseUrl: deps.apiBase, getToken: async () => token, fetchImpl: deps.fetchImpl });
  try {
    const me = await client.me();
    if (me.pending.length) return { state: "needs-setup", reason: me.pending.includes("tos") ? "tos" : "two_factor_setup_required" };
    return { state: "ready", username: me.username };
  } catch (error) {
    if (error instanceof AccountsApiError && ["account_setup_required", "tos_required", "two_factor_setup_required", "two_factor_required"].includes(error.code)) {
      return { state: "needs-setup", reason: error.code as "account_setup_required" };
    }
    return { state: "error", code: error instanceof AccountsApiError ? error.code : "unavailable" };
  }
}

/**
 * The redirect registered with Red-XAI for this build: Chrome and Edge give
 * `https://<extension id>.chromiumapp.org/oauth2`, Firefox gives
 * `https://<sha1 of the add-on id>.extensions.allizom.org/oauth2`. Opera has
 * `launchWebAuthFlow` but no `getRedirectURL`, and catches the same chromiumapp.org
 * pattern, so the URL is built from the runtime id there.
 */
export function extensionRedirectUri(identity: { getRedirectURL?(path?: string): string }, runtimeId: string | undefined): string {
  if (identity.getRedirectURL) return identity.getRedirectURL("oauth2");
  if (!runtimeId) throw new Error("no_extension_id");
  return `https://${runtimeId}.chromiumapp.org/oauth2`;
}
