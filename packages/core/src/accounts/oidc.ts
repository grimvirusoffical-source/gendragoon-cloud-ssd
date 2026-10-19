/**
 * Red-XAI Accounts sign-in for Gendragoon apps: OIDC authorization code with
 * PKCE (S256), as the v1 contract requires for every client. Platform code
 * opens the URL (system browser, Expo AuthSession, or the extension's web auth
 * flow) and hands the redirect back to `completeSignIn`.
 */
export const REDXAI_CLIENT_ID = "gendragoon";
/** The v1 contract scopes. The token endpoint always returns a rotating refresh token. */
export const REDXAI_SCOPES = "openid profile email";

export interface OidcConfig {
  issuer: string;
  clientId?: string;
  redirectUri: string;
  scope?: string;
}

export interface PendingSignIn {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface OidcTokens {
  accessToken: string;
  idToken: string;
  refreshToken: string | null;
  expiresAtMs: number;
  scope: string;
}

export class OidcError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const base64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function randomString(bytes = 32): string {
  const out = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(out);
  return base64Url(out);
}

/** RFC 7636 S256 challenge. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export async function beginSignIn(config: OidcConfig, extra: Record<string, string> = {}): Promise<{ url: string; pending: PendingSignIn }> {
  const pending: PendingSignIn = { state: randomString(16), nonce: randomString(16), codeVerifier: randomString(48), redirectUri: config.redirectUri };
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId ?? REDXAI_CLIENT_ID,
    redirect_uri: config.redirectUri,
    scope: config.scope ?? REDXAI_SCOPES,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: await pkceChallenge(pending.codeVerifier),
    code_challenge_method: "S256",
    ...extra,
  });
  return { url: `${config.issuer.replace(/\/+$/, "")}/oauth2/authorize?${params.toString()}`, pending };
}

/** The hosted sign-up page, for platforms that can't show the native form. */
export function beginSignUp(config: OidcConfig): Promise<{ url: string; pending: PendingSignIn }> {
  return beginSignIn(config, { prompt: "create" });
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new OidcError("id_token_malformed");
  const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

async function tokenRequest(config: OidcConfig, body: Record<string, string>, fetchImpl: typeof fetch, now: number): Promise<OidcTokens> {
  const res = await fetchImpl(`${config.issuer.replace(/\/+$/, "")}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== "string") throw new OidcError(typeof json.error === "string" ? json.error : "token_failed");
  return {
    accessToken: json.access_token,
    idToken: typeof json.id_token === "string" ? json.id_token : "",
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    expiresAtMs: now + (typeof json.expires_in === "number" ? json.expires_in : 600) * 1000,
    scope: typeof json.scope === "string" ? json.scope : "",
  };
}

/**
 * Checks the redirect (state, error) and exchanges the code. The ID token's
 * nonce, audience and issuer are checked here; its signature is checked by the
 * Gendragoon backend, which never trusts the client's view of the token.
 */
export async function completeSignIn(
  config: OidcConfig,
  pending: PendingSignIn,
  redirectUrl: string,
  options: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<OidcTokens> {
  const url = new URL(redirectUrl);
  const error = url.searchParams.get("error");
  if (error) throw new OidcError(error);
  if (url.searchParams.get("state") !== pending.state) throw new OidcError("state_mismatch");
  const code = url.searchParams.get("code");
  if (!code) throw new OidcError("code_missing");
  const now = options.now ?? Date.now();
  const tokens = await tokenRequest(config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: pending.redirectUri,
    client_id: config.clientId ?? REDXAI_CLIENT_ID,
    code_verifier: pending.codeVerifier,
  }, options.fetchImpl ?? fetch, now);
  const claims = decodeJwtPayload(tokens.idToken);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== config.issuer.replace(/\/+$/, "")) throw new OidcError("id_token_issuer");
  if (!aud.includes(config.clientId ?? REDXAI_CLIENT_ID)) throw new OidcError("id_token_audience");
  if (claims.nonce !== pending.nonce) throw new OidcError("id_token_nonce");
  return tokens;
}

/** Refresh tokens rotate on every use; keep the new one and drop the old. */
export function refreshTokens(config: OidcConfig, refreshToken: string, options: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<OidcTokens> {
  return tokenRequest(config, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: config.clientId ?? REDXAI_CLIENT_ID }, options.fetchImpl ?? fetch, options.now ?? Date.now());
}
