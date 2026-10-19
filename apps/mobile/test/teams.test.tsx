import type { ChatMessage, Team, TeamColorChoices } from "@gendragoon/core";
import { act, fireEvent, render } from "@testing-library/react-native";
import { CreateTeamScreen, JoinTeamScreen, Swatches, TeamChatScreen, TeamMembersScreen, TeamsTab } from "../src/teams";

const choices: TeamColorChoices = {
  reservedHue: "purple",
  ownerShades: [{ id: "purple-500", hue: "purple", hex: "#a855f7" }, { id: "purple-700", hue: "purple", hex: "#7e22ce" }],
  memberColors: ["red", "orange", "amber", "yellow", "lime", "green", "teal", "cyan", "sky", "blue"].map((hue) => ({ id: `${hue}-500`, hue, hex: "#123456", taken: hue === "red" })),
};
const me = { memberId: "m", displayName: "Pixel 9", color: "sky-500", colorHex: "#0ea5e9", role: "member" as const, muted: null };
const owner = { memberId: "o", displayName: "Josh", color: "purple-500", colorHex: "#a855f7", role: "owner" as const, muted: null };
const team = (over: Partial<Team> = {}): Team => ({ id: "t1", name: "Studio", tier: "team", interval: "month", memberLimit: 5, memberCount: 2, priceCents: 999, subscriptionStatus: "active", subscriptionActive: true, role: "member", me, members: [owner, me], ...over });
const msg = (over: Partial<ChatMessage>): ChatMessage => ({ seq: 1, memberId: "o", displayName: "Josh", color: "purple-500", colorHex: "#a855f7", kind: "text", text: "hi", card: null, createdAtMs: 1, mine: false, ...over });

describe("mobile Teams", () => {
  it("member swatches: at least 9 colors, no purple, taken ones disabled", async () => {
    const s = await render(<Swatches role="member" choices={choices} onChange={() => undefined} />);
    expect(s.queryByTestId("color-purple-500")).toBeNull();
    expect(s.getByTestId("color-red-500").props.accessibilityState.disabled).toBe(true);
    expect(s.getByTestId("color-sky-500").props.accessibilityState.disabled).toBe(false);
    expect(s.getAllByRole("radio").length).toBeGreaterThanOrEqual(9);
  });
  it("create team shows the approved tiers and Enterprise contact", async () => {
    const onSubmit = jest.fn();
    const s = await render(<CreateTeamScreen intentId="i" deviceName="Pixel 9" ownerShades={choices.ownerShades} onSubmit={onSubmit} onCancel={() => undefined} />);
    expect(s.getByTestId("team-tier-team")).toHaveTextContent(/Team · 5 · \$9\.99\/mo/);
    expect(s.getByTestId("team-tier-business")).toHaveTextContent(/\$69\.99\/mo/);
    await fireEvent.press(s.getByTestId("team-interval-year"));
    expect(s.getByTestId("team-tier-team_plus")).toHaveTextContent(/\$249\.90\/yr/);
    expect(s.getByTestId("team-enterprise")).toHaveTextContent(/contact us/);
    await fireEvent.changeText(s.getByTestId("team-name"), "Studio");
    await fireEvent.press(s.getByTestId("create-team-submit"));
    expect(onSubmit).toHaveBeenCalledWith({ name: "Studio", intentId: "i", tier: "team", interval: "year", ownerShade: "purple-500", deviceName: "Pixel 9" });
  });
  it("join: code, then the device name by default and an untaken color", async () => {
    const onPreview = jest.fn(), onSubmit = jest.fn();
    const first = await render(<JoinTeamScreen deviceName="Pixel 9" preview={null} onPreview={onPreview} onSubmit={onSubmit} onCancel={() => undefined} />);
    await fireEvent.changeText(first.getByTestId("invite-code"), "https://x/teams/join#ab2c-d3ef-gh4j");
    await fireEvent.press(first.getByTestId("invite-continue"));
    expect(onPreview).toHaveBeenCalledWith("AB2C-D3EF-GH4J");
    await first.rerender(<JoinTeamScreen deviceName="Pixel 9" preview={{ teamName: "Studio", memberCount: 2, memberLimit: 5, colors: choices }} onPreview={onPreview} onSubmit={onSubmit} onCancel={() => undefined} />);
    expect(first.getByTestId("join-display-name").props.value).toBe("Pixel 9");
    expect(first.getByTestId("join-submit").props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(first.getByTestId("color-sky-500"));
    await fireEvent.press(first.getByTestId("join-submit"));
    expect(onSubmit).toHaveBeenCalledWith({ code: "AB2C-D3EF-GH4J", color: "sky-500", displayName: "Pixel 9", deviceName: "Pixel 9" });
  });
  it("chat: + shares a team workspace directly and asks before sharing a personal one", async () => {
    const onCard = jest.fn();
    const s = await render(<TeamChatScreen team={team()} messages={[msg({}), msg({ seq: 2, kind: "removed", text: "", removed: { reason: "No insults", by: "owner" } })]}
      pickable={[{ scope: "team", id: "w1", name: "Assets" }, { scope: "personal", id: "11111111-1111-4111-8111-000000000001", name: "Mine", shared: false }]}
      onSend={() => undefined} onCard={onCard} onReport={() => undefined} onBack={() => undefined} onMembers={() => undefined} />);
    expect(s.getByTestId("msg-2")).toHaveTextContent(/Removed by the team owner: No insults/);
    expect(s.queryByTestId("remove-1")).toBeNull();
    await fireEvent.press(s.getByTestId("chat-plus"));
    await fireEvent.press(s.getByTestId("pick-team-w1"));
    expect(onCard).toHaveBeenLastCalledWith({ scope: "team", workspaceId: "w1" });
    await fireEvent.press(s.getByTestId("chat-plus"));
    await fireEvent.press(s.getByTestId("pick-personal-11111111-1111-4111-8111-000000000001"));
    expect(onCard).toHaveBeenCalledTimes(1);
    await fireEvent.press(s.getByTestId("share-confirm"));
    expect(onCard).toHaveBeenLastCalledWith({ scope: "personal", workspaceId: "11111111-1111-4111-8111-000000000001", share: true });
  });
  it("chat is read-only while muted, with the reason", async () => {
    const s = await render(<TeamChatScreen team={team({ me: { ...me, muted: { until: null, reason: "Spam" } } })} messages={[]} pickable={[]}
      onSend={() => undefined} onCard={() => undefined} onReport={() => undefined} onBack={() => undefined} onMembers={() => undefined} />);
    expect(s.getByTestId("chat-blocked")).toHaveTextContent("You are muted: Spam.");
    expect(s.queryByTestId("chat-input")).toBeNull();
  });
  it("members: owner moderation needs a reason; members can't moderate", async () => {
    const onModerate = jest.fn();
    const asOwner = await render(<TeamMembersScreen team={team({ role: "owner", me: owner })} colors={choices} nowMs={1000} onUpdateMe={() => undefined} onModerate={onModerate} onBack={() => undefined} />);
    expect(asOwner.getByTestId("ban-m").props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(asOwner.getByTestId("moderate-reason"), "Spam");
    await fireEvent.press(asOwner.getByTestId("mute-m"));
    expect(onModerate).toHaveBeenCalledWith("m", "mute", "Spam", 1000 + 3_600_000);
    const asMember = await render(<TeamMembersScreen team={team()} colors={choices} onUpdateMe={() => undefined} onModerate={onModerate} onBack={() => undefined} />);
    expect(asMember.queryByTestId("mute-o")).toBeNull();
    expect(asMember.queryByTestId("moderate-reason")).toBeNull();
  });
  it("members: owner can make a member a viewer and transfer ownership after picking a member color", async () => {
    const onSetRole = jest.fn(), onTransfer = jest.fn();
    const s = await render(<TeamMembersScreen team={team({ role: "owner", me: owner })} colors={choices} onUpdateMe={() => undefined} onModerate={() => undefined}
      onBack={() => undefined} onSetRole={onSetRole} onTransfer={onTransfer} />);
    await fireEvent.press(s.getByTestId("role-m"));
    expect(onSetRole).toHaveBeenCalledWith("m", "viewer");
    await fireEvent.press(s.getByTestId("transfer-m"));
    expect(s.getByTestId("transfer-confirm").props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(s.getAllByTestId("color-sky-500").at(-1)!);
    await fireEvent.press(s.getByTestId("transfer-confirm"));
    expect(onTransfer).toHaveBeenCalledWith("m", "sky-500");
    const viewerTeam = team({ members: [owner, { ...me, role: "viewer" }] });
    const v = await render(<TeamMembersScreen team={viewerTeam} colors={choices} onUpdateMe={() => undefined} onModerate={() => undefined} onBack={() => undefined} />);
    expect(v.getAllByText("Viewer").length).toBe(1);
    expect(v.queryByTestId("transfer-o")).toBeNull();
  });
  it("Teams tab polls the chat with after=seq", async () => {
    jest.useFakeTimers();
    const calls: number[] = [];
    const client = {
      listTeams: async () => ({ teams: [team()] }),
      teamsCatalog: async () => ({ tiers: [], enterprise: { contact: true }, colors: choices }),
      getTeam: async () => ({ team: team(), colors: choices }),
      teamWorkspaces: async () => ({ teamWorkspaces: [], sharedWorkspaces: [], subscriptionActive: true }),
      teamChat: async (_id: string, after: number) => { calls.push(after); return { messages: after === 0 ? [msg({ seq: 1 })] : [msg({ seq: 2, text: "new" })], latestSeq: 2, pollAfterMs: 3000 }; },
    };
    const s = await render(<TeamsTab client={client as never} personalWorkspaces={[]} openUrl={() => undefined} pollMs={50} />);
    await act(async () => { await Promise.resolve(); });
    await fireEvent.press(await s.findByTestId("team-t1"));
    await s.findByTestId("msg-1");
    await act(async () => { jest.advanceTimersByTime(60); });
    await s.findByTestId("msg-2");
    expect(calls.slice(0, 2)).toEqual([0, 1]);
    jest.useRealTimers();
  });
});
