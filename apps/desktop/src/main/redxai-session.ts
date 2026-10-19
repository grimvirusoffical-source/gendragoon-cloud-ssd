import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { beginSignIn, beginSignUp, completeSignIn, refreshTokens, type OidcTokens } from "@gendragoon/core";

/**
 * Red-XAI Account sign-in for the desktop app: authorization code + PKCE
 * through the system browser, with the redirect caught on a one-shot
 * loopback listener (RFC 8252). The refresh token is kept in the OS keychain
 * through `store`; the access token lives only in memory.
 */
export interface SessionStore {
  read(): Promise<string | null>;
  write(refreshToken: string): Promise<void>;
  clear(): Promise<void>;
}

export interface RedXaiSessionOptions {
  issuer: string;
  openExternal: (url: string) => Promise<void>;
  store: SessionStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** How long to wait for the browser to come back. */
  timeoutMs?: number;
}

const SUCCESS_PAGE = `<!doctype html><meta charset="utf-8"><title>Gendragoon</title>
<body style="background:#0d0b14;color:#f6f3fb;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<p>You're signed in. You can close this tab and return to Gendragoon.</p></body>`;

export class RedXaiSession {
  private tokens: OidcTokens | null = null;
  private refreshing: Promise<OidcTokens | null> | null = null;
  private active: Server | null = null;

  constructor(private readonly options: RedXaiSessionOptions) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Opens the browser on the sign-in (or sign-up) page and waits for the redirect. */
  async signIn(mode: "sign-in" | "sign-up" = "sign-in"): Promise<void> {
    this.active?.close();
    const server = createServer();
    this.active = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const config = { issuer: this.options.issuer, redirectUri: `http://127.0.0.1:${port}/callback` };
    try {
      const { url, pending } = mode === "sign-up" ? await beginSignUp(config) : await beginSignIn(config);
      const redirect = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("sign_in_timeout")), this.options.timeoutMs ?? 10 * 60_000);
        server.on("request", (req, res) => {
          const full = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
          if (full.pathname !== "/callback") {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(SUCCESS_PAGE);
          clearTimeout(timer);
          resolve(full.toString());
        });
      });
      await this.options.openExternal(url);
      const tokens = await completeSignIn(config, pending, await redirect, { fetchImpl: this.options.fetchImpl, now: this.now });
      await this.keep(tokens);
    } finally {
      server.close();
      if (this.active === server) this.active = null;
    }
  }

  /** A current access token, refreshed a minute before it expires. Undefined when signed out. */
  async accessToken(): Promise<string | undefined> {
    if (this.tokens && this.tokens.expiresAtMs - 60_000 > this.now) return this.tokens.accessToken;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return (await this.refreshing)?.accessToken;
  }

  async signOut(): Promise<void> {
    this.tokens = null;
    await this.options.store.clear();
  }

  private async refresh(): Promise<OidcTokens | null> {
    const refreshToken = this.tokens?.refreshToken ?? (await this.options.store.read());
    if (!refreshToken) return null;
    try {
      const tokens = await refreshTokens({ issuer: this.options.issuer, redirectUri: "" }, refreshToken, { fetchImpl: this.options.fetchImpl, now: this.now });
      await this.keep(tokens);
      return tokens;
    } catch (error) {
      // A refused refresh (revoked, reused, expired) ends the session; a network failure does not.
      const code = (error as { code?: string }).code;
      if (code && code !== "token_failed") await this.signOut();
      return null;
    }
  }

  private async keep(tokens: OidcTokens): Promise<void> {
    this.tokens = tokens;
    if (tokens.refreshToken) await this.options.store.write(tokens.refreshToken);
  }
}
