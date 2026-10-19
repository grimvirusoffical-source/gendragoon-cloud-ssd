// Teams calls of a signed-in GenDragoon user (/v2/teams on the API origin, Firebase ID token). The server
// refuses gdsk_ API keys for teams and team workspaces. Calls that start a subscription return a Stripe
// Checkout URL for the person to open; the SDK never completes a payment. Levels: docs/LEVELS.md.
import { APIError, Gated, type Options } from "./client.js";
import type { OperationId } from "./operations.js";

export type TeamRole = "owner" | "member" | "viewer";
export interface TeamMember { memberId: string; displayName: string; color: string; colorHex: string; role: TeamRole; muted: { until: number | null; reason: string | null } | null }
export interface Team {
  id: string; name: string; tier: string; interval: string; memberLimit: number; memberCount: number; priceCents: number;
  subscriptionStatus: string; subscriptionActive: boolean; role: TeamRole; me: TeamMember; members?: TeamMember[];
}
export interface MemberColor { id: string; hue: string; hex: string; taken: boolean }
export interface ColorChoices { memberColors: MemberColor[]; ownerShades: unknown[]; reservedHue: string }
export interface TeamView { team: Team; colors: ColorChoices }
/** Result of a call that may need payment: open `url` when it is set. */
export interface Checkout { url?: string; totalCents?: number; resumed?: boolean; alreadyActivated?: boolean; complimentary?: boolean; checkoutError?: string }
export interface CreateTeamRequest { intentId: string; name: string; tier: "team" | "team_plus" | "business"; interval?: "month" | "year"; ownerShade?: string }
export interface Invite { code: string; inviteId: string; link: string; expiresAtMs: number; maxUses: number }
export interface InvitePreview { teamName: string; memberCount: number; memberLimit: number; colors: ColorChoices }
export interface JoinRequest { code: string; color: string; displayName?: string; deviceName?: string }
export interface TeamWorkspace {
  id: string; teamId: string; name: string; scope: "team"; customStorage: boolean; requiredPlans: Record<string, unknown>; plansStatus: string;
  quotaGB: number; needsCustomSetup: boolean; usedBytes: number; storageRoutes: { v3: string; v2: string } | null; projectStatus?: string; access?: "read" | "write";
}
export interface SharedWorkspace { id: string; scope: "personal"; name: string; sharedBy: { memberId: string; displayName: string }; mine: boolean; permission: "view" }
export interface TeamWorkspaces { teamWorkspaces: TeamWorkspace[]; sharedWorkspaces: SharedWorkspace[]; subscriptionActive: boolean }
export interface CreateWorkspaceRequest { intentId: string; name: string; storage?: "managed" | "custom"; plans: Record<string, unknown> }
export interface ChatCard { scope: "team" | "personal"; workspaceId: string; name?: string }
export interface ChatMessage { seq: number; kind: string; text: string; card: ChatCard | null; removed?: { reason: string; by: string }; [field: string]: unknown }
export interface ChatPage { messages: ChatMessage[]; latestSeq: number; pollAfterMs: number }
export interface AuditEntry { seq: number; prev: string; hash: string; action: string; actor: string; target: string | null; reason: string | null; untilMs?: number | null; source: string; rule: string | null; atMs: number }
export interface TransferRequest { memberId: string; color: string; ownerShade?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const seg = (s: string | number): string => {
  const v = String(s);
  if (!v || v.length > 128 || /[/?#]/.test(v)) throw new Error(`gendragoon: invalid id ${JSON.stringify(v)}`);
  return encodeURIComponent(v);
};
const until = (d?: Date | null) => (d ? { until: d.getTime() } : {});

/** Checks that audit entries are consecutive and each links to the previous hash. The digests themselves are recomputed by the server. */
export function verifyAuditChain(entries: AuditEntry[]): boolean {
  let prev = "0".repeat(64);
  for (const [i, e] of entries.entries()) {
    if (e.seq !== i + 1 || e.prev !== prev || !/^[0-9a-f]{64}$/.test(e.hash)) return false;
    prev = e.hash;
  }
  return true;
}

export class TeamsClient extends Gated {
  readonly origin: string;
  /** origin is the GenDragoon API origin; token returns a current Firebase ID token. */
  constructor(origin: string, private readonly token: () => Promise<string> | string, opts: Options = {}) {
    super(opts);
    this.origin = origin.replace(/\/+$/, "");
  }
  private async call<T>(op: OperationId, method: string, path: string, body?: unknown): Promise<T> {
    this.check(op);
    const tok = await this.token();
    const r = await this.send(method, this.origin + "/v2/teams" + path, body === undefined ? null : JSON.stringify(body),
      body === undefined ? {} : { "Content-Type": "application/json" }, `Bearer ${tok}`);
    return (r.status === 204 ? {} : await r.json()) as T;
  }

  /** Team tiers, the Enterprise contact and the color palette. Level L2, risk read. */
  catalog(): Promise<Record<string, unknown>> { return this.call("teams.catalog", "GET", "/catalog"); }
  /** Teams the account belongs to. Level L2, risk read. */
  async list(): Promise<Team[]> { return (await this.call<{ teams: Team[] }>("teams.list", "GET", "")).teams; }
  /** Creates a team and opens its subscription checkout. Reuse intentId on retry. Level L3, risk billing. */
  create(req: CreateTeamRequest): Promise<{ team: Team } & Checkout> {
    if (!UUID.test(req.intentId)) throw new Error("gendragoon: intentId must be a UUID");
    return this.call("teams.create", "POST", "", req);
  }
  /** A team with its members and color choices. Level L2, risk read. */
  get(teamId: string): Promise<TeamView> { return this.call("teams.get", "GET", `/${seg(teamId)}`); }
  /** Resumes or replaces the team subscription checkout. Level L3, risk billing. */
  checkout(teamId: string, change: { tier?: string; interval?: string } = {}): Promise<Checkout> {
    return this.call("teams.checkout", "POST", `/${seg(teamId)}/checkout`, change);
  }
  /** Creates an invite code (owner); the code is shown once. Level L3, risk sharing. */
  createInvite(teamId: string, opts: { expiresInHours?: number; maxUses?: number } = {}): Promise<Invite> {
    return this.call("teams.createInvite", "POST", `/${seg(teamId)}/invites`, opts);
  }
  /** Revokes an invite code (owner). Level L3, risk sharing. */
  async revokeInvite(teamId: string, inviteId: string): Promise<void> {
    await this.call("teams.revokeInvite", "POST", `/${seg(teamId)}/invites/${seg(inviteId)}/revoke`, {});
  }
  /** Team name, size and free colors for an invite code. Level L2, risk read. */
  previewInvite(code: string): Promise<InvitePreview> { return this.call("teams.previewInvite", "POST", "/join/preview", { code }); }
  /** Joins a team with an invite code and a free member color. Level L3, risk sharing. */
  join(req: JoinRequest): Promise<{ teamId: string; alreadyMember: boolean }> { return this.call("teams.join", "POST", "/join", req); }
  /** Changes your display name or color in a team. Level L2, risk write. */
  async updateMe(teamId: string, change: { displayName?: string; color?: string }): Promise<void> {
    await this.call("teams.updateMe", "PATCH", `/${seg(teamId)}/me`, change);
  }
  /** Leaves a team; your shared personal workspaces are unshared. Level L3, risk destructive. */
  async leave(teamId: string): Promise<void> { await this.call("teams.leave", "POST", `/${seg(teamId)}/leave`, {}); }
  /** Team workspaces (files over storageRoutes) and shared personal workspaces. Level L2, risk read. */
  workspaces(teamId: string): Promise<TeamWorkspaces> { return this.call("teams.workspaces", "GET", `/${seg(teamId)}/workspaces`); }
  /** Creates a team workspace and opens its plans checkout (owner). Level L3, risk billing. */
  createWorkspace(teamId: string, req: CreateWorkspaceRequest): Promise<{ workspace: TeamWorkspace } & Checkout> {
    if (!UUID.test(req.intentId)) throw new Error("gendragoon: intentId must be a UUID");
    return this.call("teams.createWorkspace", "POST", `/${seg(teamId)}/workspaces`, req);
  }
  /** Resumes a team workspace's plans checkout (owner). Level L3, risk billing. */
  checkoutWorkspace(teamId: string, workspaceId: string): Promise<Checkout> {
    return this.call("teams.checkoutWorkspace", "POST", `/${seg(teamId)}/workspaces/${seg(workspaceId)}/checkout`, {});
  }
  /** Shows one of your personal workspaces to the team, view only. Level L3, risk sharing. */
  async share(teamId: string, workspaceId: string): Promise<void> { await this.call("teams.share", "POST", `/${seg(teamId)}/shares`, { workspaceId }); }
  /** Stops showing a personal workspace to the team. Level L3, risk sharing. */
  async unshare(teamId: string, workspaceId: string): Promise<void> { await this.call("teams.unshare", "DELETE", `/${seg(teamId)}/shares/${seg(workspaceId)}`); }
  /** Chat messages with a sequence number above `after` (0 for the latest page). Level L2, risk read. */
  messages(teamId: string, after = 0, limit?: number): Promise<ChatPage> {
    return this.call("teams.chat.list", "GET", `/${seg(teamId)}/chat?after=${after}` + (limit ? `&limit=${limit}` : ""));
  }
  /**
   * Yields new chat messages until the signal aborts or you lose access to the team. Polls every
   * pollAfterMs (the server also offers Server-Sent Events at /chat/stream; this SDK polls). Level L2, risk read.
   */
  async *watchChat(teamId: string, opts: { after?: number; signal?: AbortSignal; intervalMs?: number } = {}): AsyncGenerator<ChatMessage> {
    this.check("teams.chat.watch");
    let after = opts.after ?? 0, wait = 3000;
    while (!opts.signal?.aborted) {
      try {
        const p = await this.messages(teamId, after, 100);
        for (const m of p.messages) if (m.seq > after) { after = m.seq; yield m; }
        if (p.pollAfterMs > 0) wait = p.pollAfterMs;
      } catch (e) {
        if (e instanceof APIError && [401, 403, 404].includes(e.status)) return;
        if (!(e instanceof APIError) && !(e instanceof Error && e.message.startsWith("gendragoon:"))) throw e;
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.max(wait, opts.intervalMs ?? 0));
        opts.signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
  }
  /** Posts a text message. Level L2, risk write. */
  async post(teamId: string, text: string): Promise<ChatMessage> {
    return (await this.call<{ message: ChatMessage }>("teams.chat.post", "POST", `/${seg(teamId)}/chat`, { text })).message;
  }
  /** Posts a workspace card. A personal-workspace card also shares it with the team, so it needs the sharing level too. Level L2, risk write. */
  async postCard(teamId: string, card: ChatCard, text = ""): Promise<ChatMessage> {
    if (card.scope === "personal") this.check("teams.share");
    return (await this.call<{ message: ChatMessage }>("teams.chat.post", "POST", `/${seg(teamId)}/chat`, { text, card: { scope: card.scope, workspaceId: card.workspaceId } })).message;
  }
  /** Reports a message to the platform. Level L2, risk write. */
  async report(teamId: string, seq: number, category: "spam" | "abuse" | "harassment" | "illegal" | "other", note = ""): Promise<void> {
    await this.call("teams.chat.report", "POST", `/${seg(teamId)}/chat/${seg(seq)}/report`, { category, note });
  }
  /** Removes a message (owner; reason required). Level L3, risk destructive. */
  async deleteMessage(teamId: string, seq: number, reason: string): Promise<void> {
    await this.call("teams.chat.delete", "POST", `/${seg(teamId)}/chat/${seg(seq)}/delete`, { reason });
  }
  private async moderate(action: "mute" | "unmute" | "kick" | "ban", teamId: string, memberId: string, body: Record<string, unknown>): Promise<void> {
    await this.call(`teams.members.${action}` as OperationId, "POST", `/${seg(teamId)}/members/${seg(memberId)}/${action}`, body);
  }
  /** Mutes a member until a time, or until lifted (owner; reason required). Level L3, risk destructive. */
  mute(teamId: string, memberId: string, reason: string, untilDate?: Date | null): Promise<void> { return this.moderate("mute", teamId, memberId, { reason, ...until(untilDate) }); }
  /** Lifts a mute (owner). Level L3, risk write. */
  unmute(teamId: string, memberId: string, reason = ""): Promise<void> { return this.moderate("unmute", teamId, memberId, { reason }); }
  /** Removes a member; they can rejoin with a new invite (owner; reason required). Level L3, risk destructive. */
  kick(teamId: string, memberId: string, reason: string): Promise<void> { return this.moderate("kick", teamId, memberId, { reason }); }
  /** Removes a member and blocks rejoining until a time, or for good (owner; reason required). Level L3, risk destructive. */
  ban(teamId: string, memberId: string, reason: string, untilDate?: Date | null): Promise<void> { return this.moderate("ban", teamId, memberId, { reason, ...until(untilDate) }); }
  /** Makes a member a viewer (read team files) or a member (read and write) (owner). Level L3, risk sharing. */
  async setRole(teamId: string, memberId: string, role: "viewer" | "member"): Promise<void> {
    if (role !== "viewer" && role !== "member") throw new Error('gendragoon: role must be "viewer" or "member"');
    await this.call("teams.members.setRole", "POST", `/${seg(teamId)}/members/${seg(memberId)}/role`, { role });
  }
  /** The team's hash-chained audit log, oldest first (owner). Level L2, risk read. */
  async audit(teamId: string): Promise<AuditEntry[]> { return (await this.call<{ entries: AuditEntry[] }>("teams.audit", "GET", `/${seg(teamId)}/audit`)).entries; }
  /** Hands the team to another member (owner). Level L4, risk sharing: the default gate refuses it. */
  async transfer(teamId: string, req: TransferRequest): Promise<void> { await this.call("teams.transfer", "POST", `/${seg(teamId)}/transfer`, req); }
  /** Deletes the team, its chat and its team workspaces with their files (owner). Level L4, risk bulk-destructive: the default gate refuses it. */
  async delete(teamId: string, confirmName: string): Promise<void> { await this.call("teams.delete", "POST", `/${seg(teamId)}/delete`, { confirmName }); }
}
