// App-side connect: a one-time connect code (gdpg_) or a connect link with PKCE (gdpc_ code + verifier).
import { random, toB64u } from "./bytes.js";
import { sha256, text } from "./crypto.js";
import { API_KEY_RE, Gated, type Capabilities, type Options } from "./client.js";

export interface Connection { bindingId: string; apiKey: string; keyExpiresAt: string; scopes: string[]; workspaceId: string; quotaBytes: number; capabilities?: Capabilities }
export interface ClientInfo { name: string; host?: string }
export interface PKCE { verifier: string; challenge: string; state: string }

export const GRANT_RE = /^gdpg_[A-Za-z0-9_-]{43}$/;
export const CODE_RE = /^gdpc_[A-Za-z0-9_-]{43}$/;

export class Connector extends Gated {
  readonly base: string;
  constructor(base: string, opts: Options = {}) {
    super(opts);
    this.base = base.replace(/\/+$/, "");
  }
  private async post(op: "connect.redeemGrant" | "connect.exchangeCode", path: string, body: unknown): Promise<Connection> {
    this.check(op);
    const r = await this.send("POST", this.base + path, JSON.stringify(body), { "Content-Type": "application/json" }, null);
    const c = (await r.json()) as Connection;
    if (!c.apiKey || !API_KEY_RE.test(c.apiKey)) throw new Error("gendragoon: unexpected connect response");
    return c;
  }
  /** Exchanges a one-time connect code for an API key. Level L2, risk credential. */
  redeemGrant(grant: string, client: ClientInfo): Promise<Connection> {
    grant = grant.trim();
    if (!GRANT_RE.test(grant)) throw new Error("gendragoon: that is not a GenDragoon connect code");
    return this.post("connect.redeemGrant", "/connect/redeem", { grant, client });
  }
  /** Exchanges an authorization code and the PKCE verifier for an API key. Level L2, risk credential. */
  exchangeCode(code: string, verifier: string): Promise<Connection> {
    if (!CODE_RE.test(code)) throw new Error("gendragoon: that is not a GenDragoon authorization code");
    return this.post("connect.exchangeCode", "/connect/token", { code, codeVerifier: verifier });
  }
}

/** A fresh verifier (43 characters), its S256 challenge and a random state value. */
export async function newPKCE(): Promise<PKCE> {
  const verifier = toB64u(random(32));
  return { verifier, challenge: toB64u(await sha256(text.encode(verifier))), state: toB64u(random(16)) };
}
/** The challenge for a given verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return toB64u(await sha256(text.encode(verifier)));
}

export function isLoopback(redirect: string): boolean {
  let u: URL;
  try { u = new URL(redirect); } catch { return false; }
  return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "[::1]") && u.port !== "" && !u.username && !u.password;
}

/** Go-compatible query encoding (url.Values.Encode: keys sorted, spaces as "+"). */
function encodeQuery(q: Record<string, string>): string {
  return Object.keys(q).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(q[k]!).replace(/%20/g, "+")}`).join("&");
}

/** The gendragoon://connect link to open. redirect must be http://127.0.0.1:<port>/… */
export function connectLink(client: ClientInfo, p: PKCE, redirect: string, scopes: string[] = ["blobs:rw"]): string {
  if (!isLoopback(redirect)) throw new Error("gendragoon: redirect must be http://127.0.0.1:<port>/…");
  const q: Record<string, string> = { client: client.name, scope: scopes.join(" "), code_challenge: p.challenge, code_challenge_method: "S256", redirect_uri: redirect, state: p.state };
  if (client.host) q["host"] = client.host;
  return "gendragoon://connect?" + encodeQuery(q);
}
