import { describe, expect, it, vi } from "vitest";
import { GenDragoonClient, TeamOwnerMustTransferError, TEAM_TIERS, availableMemberColors, defaultDisplayName, latestSeq, mergeMessages, moderationUntil, parseChatEvents, parseInviteCode, teamPrice, type ChatMessage } from "../src/index.js";

const msg = (seq: number, text = "m" + seq): ChatMessage => ({ seq, memberId: "m", displayName: "A", color: "red-500", colorHex: "#ef4444", kind: "text", text, card: null, createdAtMs: seq, mine: false });

describe("teams helpers", () => {
  it("tiers match the approved prices; yearly is 10x", () => {
    expect(TEAM_TIERS.map((t) => [t.id, t.members, t.monthlyCents])).toEqual([["team", 5, 999], ["team_plus", 15, 2499], ["business", 50, 6999]]);
    for (const t of TEAM_TIERS) expect(teamPrice(t.id, "year")).toBe(t.monthlyCents * 10);
  });
  it("members never get purple or a taken color", () => {
    const colors = availableMemberColors({ reservedHue: "purple", ownerShades: [{ id: "purple-500", hue: "purple", hex: "#a855f7" }],
      memberColors: [{ id: "red-500", hue: "red", hex: "#ef4444", taken: true }, { id: "sky-500", hue: "sky", hex: "#0ea5e9" }, { id: "purple-1", hue: "purple", hex: "#a855f7" }] });
    expect(colors.map((c) => c.id)).toEqual(["sky-500"]);
  });
  it("reads invite codes from links or typed codes", () => {
    expect(parseInviteCode("https://x.example/teams/join#ab2c-d3ef-gh4j")).toBe("AB2C-D3EF-GH4J");
    expect(parseInviteCode(" ab2cd3efgh4j ")).toBe("AB2C-D3EF-GH4J");
    expect(parseInviteCode("short")).toBeNull();
  });
  it("display name defaults to the device name", () => {
    expect(defaultDisplayName("  Josh's   MacBook Pro ")).toBe("Josh's MacBook Pro");
    expect(defaultDisplayName("")).toBe("Member");
  });
  it("merges polled and streamed messages by seq", () => {
    const merged = mergeMessages([msg(1), msg(2)], [msg(2, "edited"), msg(3)]);
    expect(merged.map((m) => m.text)).toEqual(["m1", "edited", "m3"]);
    expect(latestSeq(merged)).toBe(3);
  });
  it("parses SSE chunks and keeps a torn tail", () => {
    const one = parseChatEvents(`retry: 3000\n\nid: 1\nevent: message\ndata: ${JSON.stringify(msg(1))}\n\nid: 2\nevent: mess`);
    expect(one.messages.map((m) => m.seq)).toEqual([1]);
    expect(one.rest).toBe("id: 2\nevent: mess");
    expect(parseChatEvents("event: removed\ndata: {}\n\n").removed).toBe(true);
  });
  it("moderation durations are forever or in the future", () => {
    expect(moderationUntil("forever")).toBeNull();
    expect(moderationUntil({ untilMs: 2000 }, 1000)).toBe(2000);
    expect(() => moderationUntil({ untilMs: 500 }, 1000)).toThrow(/future/);
  });
});

describe("teams client", () => {
  it("calls the team routes with the signed-in token", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new GenDragoonClient({ baseUrl: "https://api.example", getToken: async () => "tok", fetch: fetchImpl as unknown as typeof fetch });
    await client.joinTeam({ code: "AB2C-D3EF-GH4J", color: "sky-500", deviceName: "Pixel" });
    await client.updateTeamMe("t1", { displayName: "Riley" });
    await client.postTeamChat("t1", { card: { scope: "personal", workspaceId: "w1", share: true } });
    await client.moderateTeamMember("t1", "m1", "mute", { reason: "Spam", until: null });
    await client.unshareWorkspace("t1", "w1");
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://api.example", "")}`)).toEqual([
      "POST /v2/teams/join", "PATCH /v2/teams/t1/me", "POST /v2/teams/t1/chat", "POST /v2/teams/t1/members/m1/mute", "DELETE /v2/teams/t1/shares/w1"]);
    expect(calls[3]?.body).toEqual({ reason: "Spam", until: null });
  });
  it("role, transfer and delete-team routes", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new GenDragoonClient({ baseUrl: "https://api.example", getToken: async () => "tok", fetch: fetchImpl as unknown as typeof fetch });
    await client.setTeamMemberRole("t1", "m2", "viewer");
    await client.transferTeam("t1", { memberId: "m2", color: "red-500" });
    await client.deleteTeam("t1", "Studio");
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://api.example", "")}`)).toEqual([
      "POST /v2/teams/t1/members/m2/role", "POST /v2/teams/t1/transfer", "POST /v2/teams/t1/delete"]);
    expect(calls.map((c) => c.body)).toEqual([{ role: "viewer" }, { memberId: "m2", color: "red-500" }, { confirmName: "Studio" }]);
  });
  it("account deletion blocked by owned teams becomes TeamOwnerMustTransferError with the team names", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "team_owner_must_transfer",
      teams: [{ teamId: "t1", name: "Studio", otherMembers: 2 }], message: "x" }), { status: 409, headers: { "Content-Type": "application/json" } }));
    const client = new GenDragoonClient({ baseUrl: "https://api.example", getToken: async () => "tok", fetch: fetchImpl as unknown as typeof fetch });
    const error = await client.deleteAccount({ reauthenticatedAt: new Date().toISOString() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamOwnerMustTransferError);
    expect((error as TeamOwnerMustTransferError).teams).toEqual([{ teamId: "t1", name: "Studio", otherMembers: 2 }]);
    expect((error as Error).message).toMatch(/Transfer ownership of Studio or delete it/);
  });
});
