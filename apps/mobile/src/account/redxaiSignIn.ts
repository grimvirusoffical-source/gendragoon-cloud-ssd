import * as WebBrowser from "expo-web-browser";
import { beginSignIn, beginSignUp, completeSignIn, exchangeSession, type OidcTokens, type SecretStore } from "@gendragoon/core";

/** Registered for client `gendragoon`; the app scheme is `gendragoon` (app.json). */
export const MOBILE_REDIRECT_URI = "gendragoon://oauth2/callback";

/**
 * Red-XAI Account sign-in in an in-app browser session (ASWebAuthenticationSession
 * / Custom Tabs), authorization code + PKCE. Returns null when the person closes it.
 */
export async function signInWithRedXai(
  issuer: string,
  mode: "sign-in" | "sign-up" = "sign-in",
  openAuthSession: (url: string, redirect: string) => Promise<{ type: string; url?: string }> = WebBrowser.openAuthSessionAsync,
): Promise<OidcTokens | null> {
  const config = { issuer, redirectUri: MOBILE_REDIRECT_URI };
  const { url, pending } = mode === "sign-up" ? await beginSignUp(config) : await beginSignIn(config);
  const result = await openAuthSession(url, MOBILE_REDIRECT_URI);
  if (result.type !== "success" || !result.url) return null;
  return completeSignIn(config, pending, result.url);
}

/** Keychain name of the Red-XAI refresh token. */
export const REDXAI_REFRESH_SECRET = "redxai:refresh";

/**
 * Finishes an in-app sign-up without a browser: trades the one-time session from
 * `/v1/signup` (after any 2FA confirmation) for tokens with the Red-XAI session grant
 * (`urn:red-xai:grant-type:session`, single use, within 10 minutes). The refresh token
 * goes to the keychain; the access token is returned for this run only.
 */
export async function adoptSignupSession(issuer: string, session: string, secrets: SecretStore, fetchImpl?: typeof fetch): Promise<OidcTokens> {
  const tokens = await exchangeSession({ issuer }, session, { fetchImpl });
  if (tokens.refreshToken) await secrets.set(REDXAI_REFRESH_SECRET, new TextEncoder().encode(tokens.refreshToken));
  return tokens;
}
