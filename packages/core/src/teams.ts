/**
 * Teams: types for the cloud-ssd `feature/teams` routes (docs/API-teams.md) and the
 * client-side rules that mirror the server. The server is authoritative for every
 * rule here (colors, ACL, plans, moderation); these helpers only keep the UI honest.
 */
import type { PerformancePlanTier, PlanInterval, StoragePlanTier, WorkspaceStorageChoice } from "./workspace-plans.js";

export type TeamTierId = "team" | "team_plus" | "business";
export interface TeamTier { id: TeamTierId; name: string; members: number; monthlyCents: number; yearlyCents: number }

/** Approved 2026-10-19. Yearly = 10x monthly. Per-workspace plans are on top. */
export const TEAM_TIERS: readonly TeamTier[] = Object.freeze([
  { id: "team", name: "Team", members: 5, monthlyCents: 999, yearlyCents: 9990 },
  { id: "team_plus", name: "Team Plus", members: 15, monthlyCents: 2499, yearlyCents: 24990 },
  { id: "business", name: "Business", members: 50, monthlyCents: 6999, yearlyCents: 69990 },
]);

export interface TeamColor { id: string; hue: string; hex: string; taken?: boolean }
export interface TeamColorChoices { memberColors: TeamColor[]; ownerShades: TeamColor[]; reservedHue: "purple" }

export interface TeamMember {
  memberId: string;
  displayName: string;
  color: string;
  colorHex: string | null;
  role: "owner" | "member" | "viewer";
  muted: { until: number | null; reason: string | null } | null;
}

export interface Team {
  id: string;
  name: string;
  tier: TeamTierId;
  interval: PlanInterval;
  memberLimit: number;
  memberCount: number;
  priceCents: number;
  subscriptionStatus: string;
  subscriptionActive: boolean;
  role: "owner" | "member" | "viewer";
  me: TeamMember;
  members?: TeamMember[];
}

export interface TeamWorkspace {
  id: string;
  teamId: string;
  name: string;
  scope: "team";
  billingModel: "plans";
  customStorage: boolean;
  requiredPlans: { storage: WorkspaceStorageChoice; storageTier?: StoragePlanTier; performanceTier: PerformancePlanTier; interval: PlanInterval };
  plansStatus: string;
  projectStatus: "pending_payment" | "team_subscription_required" | "active";
  quotaGB: number;
  needsCustomSetup: boolean;
  /** Bytes stored. Files use the personal-workspace routes with this id. */
  usedBytes?: number;
  storageRoutes?: { v3: string; v2: string } | null;
  /** "read" for viewers: list and download only. */
  access?: "read" | "write";
}

export interface SharedWorkspace {
  id: string;
  scope: "personal";
  name: string;
  sharedBy: { memberId: string; displayName: string };
  mine: boolean;
  permission: "view";
}

export interface WorkspaceCard { scope: "team" | "personal"; workspaceId: string; name?: string; unavailable?: boolean }

export interface ChatMessage {
  seq: number;
  memberId: string;
  displayName: string;
  color: string;
  colorHex: string | null;
  kind: "text" | "workspace_card" | "removed";
  text: string;
  card: WorkspaceCard | null;
  createdAtMs: number;
  mine: boolean;
  removed?: { reason: string; by: "owner" | "auto" };
}

export interface TeamInvite { code: string; inviteId: string; link: string; expiresAtMs: number; maxUses: number }

export interface CreateTeamRequest {
  name: string;
  intentId: string;
  tier: TeamTierId;
  interval: PlanInterval;
  ownerShade?: string;
  displayName?: string;
  deviceName?: string;
}

export interface JoinTeamRequest { code: string; color: string; displayName?: string; deviceName?: string }

export type ModerationAction = "mute" | "unmute" | "kick" | "ban";

export const TEAM_MESSAGES: Record<string, string> = {
  COLOR_TAKEN: "That color is taken. Pick another one.",
  COLOR_RESERVED: "Purple is reserved for the team owner. Pick another color.",
  INVALID_COLOR: "Pick one of the team colors.",
  INVITE_INVALID: "This invite is not valid. Ask the team owner for a new one.",
  TEAM_FULL: "This team is full.",
  TEAM_BANNED: "You can't join this team.",
  TEAM_SUBSCRIPTION_REQUIRED: "This team needs an active team subscription.",
  TEAM_MUTED: "You are muted in this team.",
  TEAM_RATE_LIMITED: "Sending messages too quickly. You can post again in 5 minutes.",
  SHARE_REQUIRED: "Share this workspace with the team first.",
  ENTERPRISE_CONTACT: "Enterprise teams are set up with sales. Contact us for Enterprise.",
  TEAM_PRICE_UNCONFIGURED: "Team checkout isn't open yet. Your team is saved.",
  TEAM_CHECKOUT_UNAVAILABLE: "Team checkout isn't open yet. Your team is saved.",
  REASON_REQUIRED: "A reason is required. It is shown to the member.",
  TEAM_ROLE_READ_ONLY: "Viewers can open team files but not change them.",
  TEAM_STORAGE_INACTIVE: "This team workspace's plans aren't active yet.",
  INVALID_ROLE: "Choose member or viewer.",
  CONFIRM_NAME_REQUIRED: "Type the team name to confirm.",
  TEAM_DELETE_UNAVAILABLE: "Team deletion isn't available right now. Try again later.",
  TEAM_BILLING_CANCEL_FAILED: "Couldn't cancel the team's billing. Nothing was deleted. Try again.",
  TEAM_OWNER_ONLY: "Only the team owner can do this.",
  team_owner_must_transfer: "Transfer ownership of your teams or delete them before deleting your account.",
};

export function teamPrice(tier: TeamTierId, interval: PlanInterval): number {
  const t = TEAM_TIERS.find((x) => x.id === tier);
  if (!t) throw new Error("Unknown team tier");
  return interval === "year" ? t.yearlyCents : t.monthlyCents;
}

/** Colors a member may pick: not taken by someone else, and never purple. */
export function availableMemberColors(choices: TeamColorChoices | null | undefined): TeamColor[] {
  if (!choices) return [];
  return choices.memberColors.filter((c) => !c.taken && !/purple|violet|fuchsia|indigo/i.test(c.hue));
}

/** Reads an invite code out of a pasted link (`…/teams/join#CODE`) or a typed code. */
export function parseInviteCode(input: string): string | null {
  const raw = input.trim().split("#").pop() ?? "";
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length !== 12) return null;
  return `${clean.slice(0, 4)}-${clean.slice(4, 8)}-${clean.slice(8, 12)}`;
}

/** A display name: the device name until the user picks one. */
export function defaultDisplayName(deviceName: string | null | undefined): string {
  const name = (deviceName ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  return name || "Member";
}

/** Merges polled or streamed messages into the list, by seq, without duplicates. */
export function mergeMessages(current: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  const bySeq = new Map(current.map((m) => [m.seq, m]));
  for (const m of incoming) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function latestSeq(messages: readonly ChatMessage[]): number {
  return messages.reduce((n, m) => Math.max(n, m.seq), 0);
}

/** Parses one Server-Sent Events chunk stream into message events. Returns the leftover buffer. */
export function parseChatEvents(buffer: string): { messages: ChatMessage[]; removed: boolean; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const messages: ChatMessage[] = [];
  let removed = false;
  for (const block of parts) {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (event === "removed") removed = true;
    else if (event === "message" && data) {
      try { messages.push(JSON.parse(data) as ChatMessage); } catch { /* ignore a torn event */ }
    }
  }
  return { messages, removed, rest };
}

/** "forever" or a future time from the owner's duration picker. */
export function moderationUntil(choice: "forever" | { untilMs: number }, nowMs = Date.now()): number | null {
  if (choice === "forever") return null;
  if (!Number.isSafeInteger(choice.untilMs) || choice.untilMs <= nowMs) throw new Error("Choose forever or a time in the future");
  return choice.untilMs;
}
