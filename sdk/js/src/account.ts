// Calls of a signed-in GenDragoon user (Firebase ID token): connect codes, approving connect links and
// managing connected apps. These act on the person's account; a Rotten Apple app should not make them on
// the person's behalf (docs/LEVELS.md).
import { Gated, type Options } from "./client.js";
import { CODE_RE, GRANT_RE, isLoopback, type ClientInfo } from "./connect.js";
import type { OperationId } from "./operations.js";

export interface Grant { grant: string; expiresAt: string; ttlSeconds: number }
export interface ConnectRequest { client: ClientInfo; scopes: string[]; challenge: string; redirectUri: string; state: string }
export interface Binding { id: string; workspaceId: string; client: ClientInfo; scopes: string[]; usedBytes: number; quotaBytes: number; objectCount: number; createdAt: string; lastUsedAt: string | null; active: boolean }

/** Validates a connect link the way GenDragoon does before showing it to the user. */
export function parseConnectLink(link: string): ConnectRequest {
  let u: URL;
  try { u = new URL(link); } catch { throw new Error("gendragoon: not a connect link"); }
  if (u.protocol !== "gendragoon:" || (u.host !== "connect" && u.pathname.replace(/^\/+|\/+$/g, "") !== "connect")) throw new Error("gendragoon: not a connect link");
  const q = u.searchParams;
  const scopes = (q.get("scope") ?? "").replace(/,/g, " ").split(/\s+/).filter(Boolean);
  const req: ConnectRequest = { client: { name: q.get("client") ?? "", ...(q.get("host") ? { host: q.get("host")! } : {}) }, scopes: scopes.length ? scopes : ["blobs:rw"],
    challenge: q.get("code_challenge") ?? "", redirectUri: q.get("redirect_uri") ?? "", state: q.get("state") ?? "" };
  if (!req.client.name) throw new Error("gendragoon: the app did not say who it is");
  if (q.get("code_challenge_method") !== "S256" || req.challenge.length !== 43) throw new Error("gendragoon: missing PKCE challenge");
  if (!isLoopback(req.redirectUri)) throw new Error("gendragoon: the code can only go to an app on this device");
  if (!req.state) throw new Error("gendragoon: missing state");
  for (const s of req.scopes) if (s !== "blobs:rw" && s !== "blobs:r") throw new Error(`gendragoon: unknown scope ${s}`);
  return req;
}

export class AccountClient extends Gated {
  readonly base: string;
  constructor(base: string, private readonly token: () => Promise<string> | string, opts: Options = {}) {
    super(opts);
    this.base = base.replace(/\/+$/, "");
  }
  private async call<T>(op: OperationId, method: string, path: string, body?: unknown): Promise<T | null> {
    this.check(op);
    const tok = await this.token();
    const r = await this.send(method, this.base + path, body === undefined ? null : JSON.stringify(body), body === undefined ? {} : { "Content-Type": "application/json" }, `Bearer ${tok}`);
    return r.status === 204 ? null : ((await r.json()) as T);
  }
  /** Issues a one-time connect code for a workspace. Level L3, risk sharing. */
  async createGrant(workspaceId: string, requester: ClientInfo, scopes: string[] = ["blobs:rw"]): Promise<Grant> {
    const g = await this.call<Grant>("account.createGrant", "POST", "/connect/grants", { workspaceId, scopes, requester });
    if (!g || !GRANT_RE.test(g.grant)) throw new Error("gendragoon: unexpected grant response");
    return g;
  }
  /** Approves a connect link; returns the loopback redirect (with code and state) to open. Level L3, risk sharing. */
  async authorize(workspaceId: string, req: ConnectRequest): Promise<string> {
    const out = await this.call<{ code: string }>("account.authorize", "POST", "/connect/authorize",
      { workspaceId, scopes: req.scopes, requester: req.client, codeChallenge: req.challenge, codeChallengeMethod: "S256" });
    if (!out || !CODE_RE.test(out.code)) throw new Error("gendragoon: unexpected authorize response");
    const u = new URL(req.redirectUri);
    u.searchParams.set("code", out.code);
    u.searchParams.set("state", req.state);
    return u.toString();
  }
  /** The account's connected apps. Level L2, risk read. */
  async listBindings(): Promise<Binding[]> {
    return (await this.call<{ bindings: Binding[] }>("account.listBindings", "GET", "/bindings"))?.bindings ?? [];
  }
  /** Disconnects an app at once; its data is kept. Level L3, risk sharing. */
  async revokeBinding(id: string): Promise<void> {
    await this.call("account.revokeBinding", "DELETE", `/bindings/${encodeURIComponent(id)}`);
  }
  /** Disconnects an app and deletes everything it stored. Level L4, risk bulk-destructive: the default gate refuses it. */
  async revokeAndDelete(id: string): Promise<number> {
    return (await this.call<{ purgedObjects: number }>("account.revokeAndDelete", "DELETE", `/bindings/${encodeURIComponent(id)}?deleteData=true`))?.purgedObjects ?? 0;
  }
}
