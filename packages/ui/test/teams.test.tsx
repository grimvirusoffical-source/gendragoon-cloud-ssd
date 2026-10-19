import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatMessage, TeamColorChoices, TeamMember } from "@gendragoon/core";
import { AppShell } from "../src/AppShell.js";
import { ColorPicker, CreateTeam, JoinTeam, TeamChat, TeamFiles, TeamMembers, TeamWorkspaces, TeamsHome } from "../src/Teams.js";
import type { TeamWorkspace } from "@gendragoon/core";

const noop = () => {};
const shades = [{ id: "purple-500", hue: "purple", hex: "#a855f7" }, { id: "purple-700", hue: "purple", hex: "#7e22ce" }];
const choices: TeamColorChoices = {
  reservedHue: "purple",
  ownerShades: shades,
  memberColors: ["red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky"].map((hue, i) => ({ id: `${hue}-500`, hue, hex: `#00000${i}`, taken: hue === "red" })),
};
const owner: TeamMember = { memberId: "o", displayName: "Josh's MacBook", color: "purple-500", colorHex: "#a855f7", role: "owner", muted: null };
const member: TeamMember = { memberId: "m", displayName: "Riley", color: "sky-500", colorHex: "#0ea5e9", role: "member", muted: null };
const msg = (over: Partial<ChatMessage>): ChatMessage => ({ seq: 1, memberId: "m", displayName: "Riley", color: "sky-500", colorHex: "#0ea5e9", kind: "text", text: "hi", card: null, createdAtMs: 1, mine: false, ...over });

describe("Teams UI", () => {
  it("adds one top-level Teams tab", () => {
    const html = renderToStaticMarkup(<AppShell view="teams" onView={noop} locked={false} onSignOut={noop}><div /></AppShell>);
    expect(html.match(/data-testid="nav-teams"/g)).toHaveLength(1);
    expect(html).toMatch(/class="active"[^>]*data-testid="nav-teams"/);
  });
  it("member color picker: at least 9 colors, no purple, taken ones disabled", () => {
    const html = renderToStaticMarkup(<ColorPicker role="member" choices={choices} onChange={noop} />);
    expect(html.match(/class="swatch( active)?"/g)!.length).toBeGreaterThanOrEqual(9);
    expect(html).not.toContain("purple");
    expect(html).toMatch(/aria-label="red-500 \(taken\)"[^>]*disabled=""/);
    expect(html).toContain("Purple is the team owner");
  });
  it("owner picks a purple shade", () => {
    const html = renderToStaticMarkup(<ColorPicker role="owner" choices={choices} value="purple-700" onChange={noop} />);
    expect(html.match(/class="swatch( active)?"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="purple-700"/);
  });
  it("create team: three tiers with approved prices plus Enterprise contact, no pending copy", () => {
    const html = renderToStaticMarkup(<CreateTeam intentId="i" ownerShades={shades} onSubmit={noop} onContactSales={noop} />);
    expect(html).toContain("5 members · $9.99/mo");
    expect(html).toContain("15 members · $24.99/mo");
    expect(html).toContain("50 members · $69.99/mo");
    expect(html).toContain("contact us");
    expect(html).not.toMatch(/pending|proposed|approval/i);
    expect(html.match(/data-testid="team-tiers"/g)).toHaveLength(1);
  });
  it("join: code first, then name (device name by default) and color", () => {
    expect(renderToStaticMarkup(<JoinTeam preview={null} onPreview={noop} onSubmit={noop} />)).toContain('data-testid="invite-code"');
    const html = renderToStaticMarkup(<JoinTeam deviceName="Pixel 9" preview={{ teamName: "Studio", memberCount: 2, memberLimit: 5, colors: choices }} onPreview={noop} onSubmit={noop} />);
    expect(html).toContain("Join Studio");
    expect(html).toContain('value="Pixel 9"');
    expect(html).toMatch(/data-testid="join-submit"[^>]*disabled/);
  });
  it("chat: + button, cards, removed placeholder with the reason, report and owner remove", () => {
    const messages = [
      msg({ seq: 1 }),
      msg({ seq: 2, kind: "workspace_card", text: "", card: { scope: "team", workspaceId: "w1", name: "Assets" } }),
      msg({ seq: 3, kind: "workspace_card", text: "", card: { scope: "personal", workspaceId: "w2", unavailable: true } }),
      msg({ seq: 4, kind: "removed", text: "", removed: { reason: "No insults", by: "owner" } }),
    ];
    const asOwner = renderToStaticMarkup(<TeamChat messages={messages} isOwner canPost pickable={[]} onSend={noop} onShareCard={noop} onDelete={noop} onReport={noop} />);
    expect(asOwner.match(/data-testid="chat-plus"/g)).toHaveLength(1);
    expect(asOwner).toContain("Assets");
    expect(asOwner).toContain("Workspace no longer shared");
    expect(asOwner).toContain("Removed by the team owner: No insults");
    expect(asOwner).toContain('data-testid="remove-1"');
    expect(asOwner).not.toContain('data-testid="remove-4"');
    const asMember = renderToStaticMarkup(<TeamChat messages={messages} isOwner={false} canPost={false} postBlockedReason="You are muted: Spam" pickable={[]} onSend={noop} onShareCard={noop} onReport={noop} />);
    expect(asMember).not.toContain('data-testid="remove-1"');
    expect(asMember).toContain('data-testid="report-1"');
    expect(asMember).toContain("You are muted: Spam");
    expect(asMember).not.toContain('data-testid="chat-input"');
  });
  it("members: only the owner gets moderation controls; you can change your name and color", () => {
    const asOwner = renderToStaticMarkup(<TeamMembers members={[owner, member]} me={owner} isOwner colors={choices} onUpdateMe={noop} onModerate={noop} />);
    expect(asOwner).toContain('data-testid="mute-m"');
    expect(asOwner).toContain('data-testid="ban-m"');
    expect(asOwner).not.toContain('data-testid="mute-o"');
    const asMember = renderToStaticMarkup(<TeamMembers members={[owner, member]} me={member} isOwner={false} colors={choices} onUpdateMe={noop} />);
    expect(asMember).not.toContain('data-testid="mute-');
    expect(asMember).toContain('data-testid="me-display-name"');
    expect(asMember).toContain('value="Riley"');
  });
  it("team workspaces and shares: personal ones only appear when shared", () => {
    const empty = renderToStaticMarkup(<TeamWorkspaces teamWorkspaces={[]} sharedWorkspaces={[]} isOwner onNew={noop} />);
    expect(empty).toContain("Personal workspaces stay private until their owner shares them");
    const html = renderToStaticMarkup(<TeamWorkspaces isOwner onCheckout={noop} onUnshare={noop}
      teamWorkspaces={[{ id: "w1", teamId: "t", name: "Assets", scope: "team", billingModel: "plans", customStorage: false, requiredPlans: { storage: "managed", storageTier: "100GB", performanceTier: "boost", interval: "month" }, plansStatus: "pending", projectStatus: "pending_payment", quotaGB: 0, needsCustomSetup: false }]}
      sharedWorkspaces={[{ id: "p1", scope: "personal", name: "Riley's mix", sharedBy: { memberId: "m", displayName: "Riley" }, mine: false, permission: "view" }]} />);
    expect(html).toContain("100GB + boost");
    expect(html).toContain('data-testid="team-ws-pay-w1"');
    expect(html).toContain("Riley · view");
    expect(html).not.toMatch(/workspace fee|\$5/i);
  });
  it("home: empty state and one create + one join button", () => {
    const html = renderToStaticMarkup(<TeamsHome teams={[]} onOpen={noop} onCreate={noop} onJoin={noop} />);
    expect(html.match(/data-testid="create-team"/g)).toHaveLength(1);
    expect(html.match(/data-testid="join-team"/g)).toHaveLength(1);
    expect(html).toContain('data-testid="teams-empty"');
  });
  const activeWs: TeamWorkspace = { id: "w2", teamId: "t", name: "Shared drive", scope: "team", billingModel: "plans", customStorage: false,
    requiredPlans: { storage: "managed", storageTier: "100GB", performanceTier: "boost", interval: "month" }, plansStatus: "active", projectStatus: "active",
    quotaGB: 100, needsCustomSetup: false, usedBytes: 2048, storageRoutes: { v3: "/v3/cloud/w2", v2: "/v2/workspaces/w2/cloud" }, access: "write" };
  it("owner member controls: role toggle, make owner, delete team behind a typed name", () => {
    const viewer: TeamMember = { ...member, memberId: "v", role: "viewer" };
    const html = renderToStaticMarkup(<TeamMembers members={[owner, member, viewer]} me={owner} isOwner colors={choices} teamName="Studio"
      onUpdateMe={noop} onModerate={noop} onSetRole={noop} onTransfer={noop} onDeleteTeam={noop} />);
    expect(html).toMatch(/data-testid="role-m"[^>]*>Make viewer</);
    expect(html).toMatch(/data-testid="role-v"[^>]*>Allow editing</);
    expect(html).toContain("Viewer");
    expect(html).toContain('data-testid="transfer-m"');
    expect(html).not.toContain('data-testid="transfer-o"');
    expect(html).toContain('data-testid="delete-team"');
    const asMember = renderToStaticMarkup(<TeamMembers members={[owner, member]} me={member} isOwner={false} colors={choices} onUpdateMe={noop} />);
    expect(asMember).not.toMatch(/role-|transfer-|delete-team/);
  });
  it("team workspaces: Files opens storage for active ones; viewers see View only", () => {
    const html = renderToStaticMarkup(<TeamWorkspaces isOwner={false} onOpenFiles={noop} sharedWorkspaces={[]} teamWorkspaces={[activeWs, { ...activeWs, id: "w3", access: "read" }]} />);
    expect(html).toContain('data-testid="team-ws-files-w2"');
    expect(html).toContain('data-testid="team-ws-readonly-w3"');
    expect(html).not.toContain('data-testid="team-ws-readonly-w2"');
  });
  it("team files: writers upload and delete; viewers only download", () => {
    const files = [{ id: "f1", name: "plan.pdf", sizeBytes: 1536 }];
    const w = renderToStaticMarkup(<TeamFiles workspace={activeWs} files={files} quotaBytes={100e9} usedBytes={1536} onBack={noop} onUpload={noop} onDownload={noop} onDelete={noop} />);
    expect(w).toContain('data-testid="team-files-upload"');
    expect(w).toContain('data-testid="team-file-delete-f1"');
    expect(w).toContain("1.5 KB of 93 GB used");
    const r = renderToStaticMarkup(<TeamFiles workspace={{ ...activeWs, access: "read" }} files={files} onBack={noop} onUpload={noop} onDownload={noop} onDelete={noop} />);
    expect(r).not.toContain("team-files-upload");
    expect(r).not.toContain("team-file-delete-f1");
    expect(r).toContain("View only");
    expect(r).toContain(">Download<");
  });
});
