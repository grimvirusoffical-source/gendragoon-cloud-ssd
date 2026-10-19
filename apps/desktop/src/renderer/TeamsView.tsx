import {
  ApiError,
  TEAM_MESSAGES,
  latestSeq,
  mergeMessages,
  type ChatMessage,
  type CreateWorkspaceRequest,
  type GenDragoonClient,
  type PlansPricing,
  type SharedWorkspace,
  type Team,
  type TeamColor,
  type TeamColorChoices,
  type TeamWorkspace,
} from "@gendragoon/core";
import { CreateTeam, JoinTeam, NewWorkspace, TeamChat, TeamMembers, TeamWorkspaces, TeamsHome, type ChatPickable } from "@gendragoon/ui";
import { useEffect, useRef, useState } from "react";

type Mode = "home" | "create" | "join" | "team";
type Tab = "chat" | "workspaces" | "members";

function message(error: unknown): string {
  if (error instanceof ApiError) return TEAM_MESSAGES[error.code] ?? error.message;
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

/** Teams tab: create or join, then chat, team workspaces and members for one team. */
export function TeamsView(props: {
  client: () => Promise<GenDragoonClient | null>;
  openBilling: (url: unknown) => Promise<void>;
  personalWorkspaces: Array<{ id: string; name: string }>;
  pricing: PlansPricing | null;
}) {
  const [mode, setMode] = useState<Mode>("home");
  const [tab, setTab] = useState<Tab>("chat");
  const [teams, setTeams] = useState<Team[]>([]);
  const [team, setTeam] = useState<Team | null>(null);
  const [colors, setColors] = useState<TeamColorChoices | null>(null);
  const [shades, setShades] = useState<TeamColor[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [spaces, setSpaces] = useState<{ teamWorkspaces: TeamWorkspace[]; sharedWorkspaces: SharedWorkspace[] }>({ teamWorkspaces: [], sharedWorkspaces: [] });
  const [preview, setPreview] = useState<{ code: string; teamName: string; memberCount: number; memberLimit: number; colors: TeamColorChoices } | null>(null);
  const [deviceName, setDeviceName] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(true);
  const [intentId, setIntentId] = useState(() => crypto.randomUUID());
  const [newWorkspace, setNewWorkspace] = useState(false);
  const stop = useRef<AbortController | null>(null);

  useEffect(() => { void window.gendragoon?.getDeviceName?.().then((name) => setDeviceName(name ?? undefined)); }, []);
  useEffect(() => { void loadHome(); }, []);
  useEffect(() => () => stop.current?.abort(), []);

  async function run<T>(fn: (client: GenDragoonClient) => Promise<T>): Promise<T | undefined> {
    setError(null);
    const client = await props.client();
    if (!client) { setSignedIn(false); return undefined; }
    setBusy(true);
    try { return await fn(client); } catch (e) { setError(message(e)); return undefined; } finally { setBusy(false); }
  }

  async function loadHome() {
    await run(async (client) => {
      const [list, catalog] = await Promise.all([client.listTeams(), client.teamsCatalog()]);
      setTeams(list.teams);
      setShades(catalog.colors.ownerShades);
    });
  }

  async function openTeam(id: string) {
    stop.current?.abort();
    const loaded = await run(async (client) => {
      const [view, chat, ws] = await Promise.all([client.getTeam(id), client.teamChat(id, 0), client.teamWorkspaces(id)]);
      return { view, chat, ws };
    });
    if (!loaded) return;
    setTeam(loaded.view.team);
    setColors(loaded.view.colors);
    setMessages(loaded.chat.messages);
    setSpaces(loaded.ws);
    setMode("team");
    setTab("chat");
    void follow(id, latestSeq(loaded.chat.messages));
  }

  /** Realtime when the stream works, polling every few seconds otherwise. */
  async function follow(id: string, after: number) {
    const controller = new AbortController();
    stop.current = controller;
    const client = await props.client();
    if (!client) return;
    let seq = after;
    const add = (incoming: ChatMessage[]) => { seq = Math.max(seq, latestSeq(incoming)); setMessages((current) => mergeMessages(current, incoming)); };
    while (!controller.signal.aborted) {
      let result: "ended" | "removed" | "unsupported" = "unsupported";
      try { result = await client.streamTeamChat(id, seq, add, controller.signal); } catch { result = "unsupported"; }
      if (result === "removed") { setMode("home"); setTeam(null); void loadHome(); return; }
      if (result === "unsupported") {
        try { const page = await client.teamChat(id, seq); add(page.messages); } catch { /* retry on the next tick */ }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  async function refreshTeam() {
    if (!team) return;
    const view = await run((client) => client.getTeam(team.id));
    if (view) { setTeam(view.team); setColors(view.colors); }
    const ws = await run((client) => client.teamWorkspaces(team.id));
    if (ws) setSpaces(ws);
  }

  if (!signedIn) {
    return (
      <section className="panel stack" data-testid="teams-signed-out">
        <div className="kicker"><span className="dot" /> TEAMS</div>
        <h3>Sign in to use Teams</h3>
        <p className="help">Teams share workspaces and a chat. Your personal workspaces stay private unless you share one.</p>
      </section>
    );
  }

  if (mode === "create") {
    return (
      <CreateTeam intentId={intentId} deviceName={deviceName} ownerShades={shades.length ? shades : [{ id: "purple-500", hue: "purple", hex: "#a855f7" }]} busy={busy} error={error}
        onCancel={() => setMode("home")}
        onSubmit={(request) => void run(async (client) => {
          const created = await client.createTeam(request);
          setIntentId(crypto.randomUUID());
          if (created.url) await props.openBilling(created.url);
          else if (created.checkoutError) setError(TEAM_MESSAGES[created.checkoutError] ?? null);
          await loadHome();
          await openTeam(created.team.id);
        })} />
    );
  }
  if (mode === "join") {
    return (
      <JoinTeam deviceName={deviceName} busy={busy} error={error} preview={preview}
        onCancel={() => { setMode("home"); setPreview(null); }}
        onPreview={(code) => void run(async (client) => setPreview({ code, ...(await client.previewTeamInvite(code)) }))}
        onSubmit={(request) => void run(async (client) => {
          const joined = await client.joinTeam(request);
          setPreview(null);
          await loadHome();
          await openTeam(joined.teamId);
        })} />
    );
  }
  if (mode === "team" && team) {
    const isOwner = team.role === "owner";
    const muted = team.me.muted;
    const shared = new Set(spaces.sharedWorkspaces.filter((w) => w.mine).map((w) => w.id));
    const pickable: ChatPickable[] = [
      ...spaces.teamWorkspaces.map((w) => ({ scope: "team" as const, id: w.id, name: w.name })),
      ...props.personalWorkspaces.filter((w) => /^[0-9a-f-]{36}$/i.test(w.id)).map((w) => ({ scope: "personal" as const, id: w.id, name: w.name, shared: shared.has(w.id) })),
    ];
    return (
      <section className="stack" data-testid="team-view">
        <header className="topbar">
          <div>
            <div className="kicker"><span className="dot" /> TEAM</div>
            <h2>{team.name}</h2>
            <p className="sub">{team.memberCount}/{team.memberLimit} members{team.subscriptionActive ? "" : " · team subscription needed"}</p>
          </div>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={() => { stop.current?.abort(); setMode("home"); setTeam(null); }}>All teams</button>
            {isOwner && !team.subscriptionActive ? <button type="button" className="btn" data-testid="team-checkout" onClick={() => void run(async (client) => props.openBilling((await client.checkoutTeam(team.id)).url))}>Continue to checkout</button> : null}
            {isOwner && team.subscriptionActive ? <button type="button" className="btn btn-ghost" data-testid="team-invite" onClick={() => void run(async (client) => {
              const invite = await client.createTeamInvite(team.id);
              await navigator.clipboard?.writeText(invite.link);
              setError(`Invite link copied. Code: ${invite.code}`);
            })}>Copy invite link</button> : null}
          </div>
        </header>
        <div className="segmented" role="tablist" aria-label="Team">
          {(["chat", "workspaces", "members"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} data-testid={`team-tab-${t}`} onClick={() => setTab(t)}>
              {{ chat: "Chat", workspaces: "Workspaces", members: "Members" }[t]}
            </button>
          ))}
        </div>
        {error ? <div className="banner" role="status" data-testid="team-notice">{error}</div> : null}
        {tab === "chat" ? (
          <TeamChat messages={messages} isOwner={isOwner} pickable={pickable}
            canPost={team.subscriptionActive && !muted}
            postBlockedReason={!team.subscriptionActive ? TEAM_MESSAGES.TEAM_SUBSCRIPTION_REQUIRED : muted ? `You are muted${muted.reason ? `: ${muted.reason}` : ""}.` : null}
            onSend={(text) => void run(async (client) => { const r = await client.postTeamChat(team.id, { text }); setMessages((m) => mergeMessages(m, [r.message])); })}
            onShareCard={(card) => void run(async (client) => { const r = await client.postTeamChat(team.id, { card }); setMessages((m) => mergeMessages(m, [r.message])); if (r.shared) await refreshTeam(); })}
            onDelete={(seq, reason) => void run(async (client) => { await client.deleteTeamMessage(team.id, seq, reason); setMessages((await client.teamChat(team.id, 0)).messages); })}
            onReport={(seq) => void run(async (client) => { await client.reportTeamMessage(team.id, seq, { category: "abuse" }); setError("Reported. Thanks."); })} />
        ) : tab === "workspaces" ? (
          <>
            {newWorkspace ? (
              <NewWorkspace freeProjectAvailable={false} pricing={props.pricing} intentId={intentId} busy={busy} error={error}
                onCancel={() => setNewWorkspace(false)}
                onSubmit={(request: CreateWorkspaceRequest) => void run(async (client) => {
                  const created = await client.createTeamWorkspace(team.id, request);
                  setIntentId(crypto.randomUUID());
                  setNewWorkspace(false);
                  if (created.url) await props.openBilling(created.url);
                  await refreshTeam();
                })} />
            ) : null}
            <TeamWorkspaces teamWorkspaces={spaces.teamWorkspaces} sharedWorkspaces={spaces.sharedWorkspaces} isOwner={isOwner}
              onNew={team.subscriptionActive && !newWorkspace ? () => setNewWorkspace(true) : undefined}
              onCheckout={(id) => void run(async (client) => props.openBilling((await client.checkoutTeamWorkspace(team.id, id)).url))}
              onUnshare={(id) => void run(async (client) => { await client.unshareWorkspace(team.id, id); await refreshTeam(); })} />
          </>
        ) : (
          <TeamMembers members={team.members ?? []} me={team.me} isOwner={isOwner} colors={colors}
            onUpdateMe={(patch) => void run(async (client) => { await client.updateTeamMe(team.id, patch); await refreshTeam(); })}
            onModerate={(memberId, action, reason, until) => void run(async (client) => { await client.moderateTeamMember(team.id, memberId, action, { reason, until }); await refreshTeam(); })} />
        )}
        {!isOwner ? <button type="button" className="btn-ghost btn-sm" data-testid="team-leave" onClick={() => void run(async (client) => { await client.leaveTeam(team.id); stop.current?.abort(); setMode("home"); setTeam(null); await loadHome(); })}>Leave team</button> : null}
      </section>
    );
  }
  return (
    <>
      {error ? <div className="banner" role="alert" data-testid="teams-error">{error}</div> : null}
      <TeamsHome teams={teams} onOpen={(id) => void openTeam(id)} onCreate={() => setMode("create")} onJoin={() => setMode("join")} />
    </>
  );
}
