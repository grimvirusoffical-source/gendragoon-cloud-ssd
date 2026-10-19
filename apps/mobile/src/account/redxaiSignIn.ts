import * as WebBrowser from "expo-web-browser";
import { beginSignIn, beginSignUp, completeSignIn, type OidcTokens } from "@gendragoon/core";

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
