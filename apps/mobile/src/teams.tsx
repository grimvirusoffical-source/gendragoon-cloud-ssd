import * as Device from "expo-device";
import {
  ApiError,
  TEAM_MESSAGES,
  TEAM_TIERS,
  availableMemberColors,
  defaultDisplayName,
  latestSeq,
  mergeMessages,
  parseInviteCode,
  teamPrice,
  type ChatMessage,
  type CreateTeamRequest,
  type GenDragoonClient,
  type JoinTeamRequest,
  type PlanInterval,
  type Team,
  type TeamMember,
  type TeamColor,
  type TeamColorChoices,
  type TeamTierId,
} from "@gendragoon/core";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { formatCents } from "./pricing";
import { space } from "./theme";
import type { MobileColors } from "./theme";
import { useStyles, useTheme } from "./themeContext";
import { Banner, Button, Field, Screen, SectionLabel, Title } from "./ui";

/** Default chat name: the device model (Android) or the device type (iOS). Changeable in Members. */
type DeviceInfo = { deviceName?: string | null; modelName?: string | null; manufacturer?: string | null };
// iOS 16+ reports a generic "iPhone"/"iPad" as deviceName unless the app has Apple's
// user-assigned-device-name entitlement, so a generic value falls through to the model.
const GENERIC_NAME = /^(iphone|ipad|ipod( touch)?)$/i;

/** Chat name default: the device's own name ("Josh's Pixel"), else its model ("Pixel 9", "iPhone 16 Pro"). */
export function mobileDeviceName(device: DeviceInfo = Device): string {
  const own = device.deviceName?.trim();
  if (own && !GENERIC_NAME.test(own)) return defaultDisplayName(own);
  const model = device.modelName?.trim();
  if (model) {
    const maker = device.manufacturer?.trim();
    const withMaker = Platform.OS === "android" && maker && !model.toLowerCase().startsWith(maker.toLowerCase()) ? `${maker} ${model}` : model;
    return defaultDisplayName(withMaker);
  }
  if (own) return defaultDisplayName(own);
  const c = (Platform.constants ?? {}) as { Brand?: string; Model?: string };
  if (Platform.OS === "android" && c.Model) return defaultDisplayName(`${c.Brand ? `${c.Brand} ` : ""}${c.Model}`);
  return defaultDisplayName(null);
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) return TEAM_MESSAGES[error.code] ?? error.message;
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

export function Swatches(props: { choices: TeamColorChoices | null; role: "owner" | "member"; value?: string; onChange: (id: string) => void }) {
  const styles = useStyles(makeStyles);
  const owner = props.role === "owner";
  const options: TeamColor[] = owner ? props.choices?.ownerShades ?? [] : props.choices?.memberColors.filter((c) => c.hue !== "purple") ?? [];
  const free = new Set((owner ? options : availableMemberColors(props.choices)).map((c) => c.id));
  return (
    <View testID="color-picker">
      <SectionLabel>{owner ? "Your purple shade" : "Your color"}</SectionLabel>
      <View style={styles.swatches} accessibilityRole="radiogroup">
        {options.map((c) => (
          <Pressable key={c.id} testID={`color-${c.id}`} accessibilityRole="radio" accessibilityLabel={`${c.id}${free.has(c.id) ? "" : " (taken)"}`}
            accessibilityState={{ checked: props.value === c.id, disabled: !free.has(c.id) }} disabled={!free.has(c.id)}
            onPress={() => props.onChange(c.id)}
            style={[styles.swatch, { backgroundColor: c.hex, opacity: free.has(c.id) ? 1 : 0.2 }, props.value === c.id ? styles.swatchOn : null]} />
        ))}
      </View>
      {!owner ? <Text style={styles.help}>Purple is the team owner's color. Taken colors are greyed out.</Text> : null}
    </View>
  );
}

export function TeamsHomeScreen(props: { teams: Team[]; error?: string | null; onOpen: (id: string) => void; onCreate: () => void; onJoin: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <Screen testID="teams-home">
      <Title kicker="Teams" subtitle="Shared workspaces and a team chat. Personal workspaces stay private unless you share one.">Your teams</Title>
      {props.error ? <Banner alert testID="teams-error">{props.error}</Banner> : null}
      {props.teams.map((team) => (
        <Pressable key={team.id} testID={`team-${team.id}`} accessibilityRole="button" onPress={() => props.onOpen(team.id)} style={styles.row}>
          <View style={[styles.dot, { backgroundColor: team.me.colorHex ?? undefined }]} />
          <Text style={styles.name}>{team.name}</Text>
          <Text style={styles.help}>{`${team.memberCount}/${team.memberLimit}${team.subscriptionActive ? "" : " · payment needed"}`}</Text>
        </Pressable>
      ))}
      <View style={styles.choices}>
        <Button label="New team" testID="create-team" onPress={props.onCreate} />
        <Button label="Join with a code" tone="ghost" testID="join-team" onPress={props.onJoin} />
      </View>
    </Screen>
  );
}

export function CreateTeamScreen(props: { intentId: string; deviceName: string; ownerShades: TeamColor[]; error?: string | null; onSubmit: (r: CreateTeamRequest) => void; onCancel: () => void }) {
  const styles = useStyles(makeStyles);
  const [name, setName] = useState("");
  const [tier, setTier] = useState<TeamTierId>("team");
  const [interval, setInterval] = useState<PlanInterval>("month");
  const [shade, setShade] = useState("purple-500");
  const per = interval === "year" ? "/yr" : "/mo";
  return (
    <Screen testID="create-team-screen">
      <Title kicker="Teams" subtitle="Each team workspace adds its own storage and performance plans.">New team</Title>
      <Field label="Team name" value={name} onChangeText={setName} autoCapitalize="words" testID="team-name" />
      <View accessibilityRole="radiogroup" style={styles.choices}>
        <Button label="Monthly" compact tone={interval === "month" ? "secondary" : "ghost"} selected={interval === "month"} testID="team-interval-month" onPress={() => setInterval("month")} />
        <Button label="Yearly" compact tone={interval === "year" ? "secondary" : "ghost"} selected={interval === "year"} testID="team-interval-year" onPress={() => setInterval("year")} />
      </View>
      <SectionLabel>Team plan</SectionLabel>
      <View testID="team-tiers" accessibilityRole="radiogroup" style={styles.choices}>
        {TEAM_TIERS.map((t) => (
          <Button key={t.id} compact label={`${t.name} · ${t.members} · ${formatCents(teamPrice(t.id, interval))}${per}`} tone={tier === t.id ? "secondary" : "ghost"} selected={tier === t.id} testID={`team-tier-${t.id}`} onPress={() => setTier(t.id)} />
        ))}
      </View>
      <Text style={styles.help} testID="team-enterprise">Need more than 50 members? Enterprise: contact us.</Text>
      <Swatches role="owner" choices={{ memberColors: [], ownerShades: props.ownerShades, reservedHue: "purple" }} value={shade} onChange={setShade} />
      {props.error ? <Banner alert testID="create-team-error">{props.error}</Banner> : null}
      <Button label={`Continue to checkout · ${formatCents(teamPrice(tier, interval))}${per}`} testID="create-team-submit" disabled={!name.trim()}
        onPress={() => props.onSubmit({ name: name.trim(), intentId: props.intentId, tier, interval, ownerShade: shade, deviceName: props.deviceName })} />
      <Button label="Cancel" tone="ghost" onPress={props.onCancel} />
    </Screen>
  );
}

export function JoinTeamScreen(props: { deviceName: string; preview: { teamName: string; memberCount: number; memberLimit: number; colors: TeamColorChoices } | null;
  error?: string | null; onPreview: (code: string) => void; onSubmit: (r: JoinTeamRequest) => void; onCancel: () => void }) {
  const [input, setInput] = useState("");
  const [name, setName] = useState(props.deviceName);
  const [color, setColor] = useState<string | undefined>();
  const code = parseInviteCode(input);
  const ok = !!color && availableMemberColors(props.preview?.colors).some((c) => c.id === color);
  return (
    <Screen testID="join-team-screen">
      <Title kicker="Teams">{props.preview ? `Join ${props.preview.teamName}` : "Join a team"}</Title>
      {!props.preview ? (
        <>
          <Field label="Invite link or code" placeholder="XXXX-XXXX-XXXX" value={input} onChangeText={setInput} autoCapitalize="characters" testID="invite-code" />
          <Button label="Continue" testID="invite-continue" disabled={!code} onPress={() => code && props.onPreview(code)} />
        </>
      ) : (
        <>
          <Field label="Name in chat" value={name} onChangeText={setName} testID="join-display-name" />
          <Swatches role="member" choices={props.preview.colors} value={color} onChange={setColor} />
          <Button label="Join team" testID="join-submit" disabled={!ok || !code} onPress={() => code && color && props.onSubmit({ code, color, displayName: name.trim() || undefined, deviceName: props.deviceName })} />
        </>
      )}
      {props.error ? <Banner alert testID="join-team-error">{props.error}</Banner> : null}
      <Button label="Cancel" tone="ghost" onPress={props.onCancel} />
    </Screen>
  );
}

export interface MobilePickable { scope: "team" | "personal"; id: string; name: string; shared?: boolean }

export function TeamChatScreen(props: { team: Team; messages: ChatMessage[]; pickable: MobilePickable[]; error?: string | null;
  onSend: (text: string) => void; onCard: (card: { scope: "team" | "personal"; workspaceId: string; share?: boolean }) => void;
  onReport: (seq: number) => void; onDelete?: (seq: number, reason: string) => void; onBack: () => void; onMembers: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [text, setText] = useState("");
  const [picker, setPicker] = useState(false);
  const [confirm, setConfirm] = useState<MobilePickable | null>(null);
  const muted = props.team.me.muted;
  const blocked = !props.team.subscriptionActive ? TEAM_MESSAGES.TEAM_SUBSCRIPTION_REQUIRED : muted ? `You are muted${muted.reason ? `: ${muted.reason}` : ""}.` : null;
  return (
    <Screen testID="team-chat">
      <Title kicker="Team" subtitle={`${props.team.memberCount}/${props.team.memberLimit} members`}>{props.team.name}</Title>
      <View style={styles.choices}>
        <Button label="All teams" compact tone="ghost" onPress={props.onBack} />
        <Button label="Members" compact tone="ghost" testID="team-members-open" onPress={props.onMembers} />
      </View>
      {props.error ? <Banner tone="info" testID="team-notice">{props.error}</Banner> : null}
      {props.messages.map((m) => (
        <View key={m.seq} testID={`msg-${m.seq}`} style={[styles.msg, m.mine ? styles.mine : null]}>
          <Text style={[styles.author, { color: m.colorHex ?? colors.text }]}>{m.displayName}</Text>
          {m.kind === "removed" ? <Text style={styles.help}>{`Removed by ${m.removed?.by === "auto" ? "automatic moderation" : "the team owner"}: ${m.removed?.reason ?? ""}`}</Text> : null}
          {m.kind !== "removed" && m.text ? <Text style={styles.body}>{m.text}</Text> : null}
          {m.card ? (
            <View testID={`card-${m.card.workspaceId}`} style={styles.card}>
              <Text style={styles.help}>{m.card.unavailable ? "Workspace no longer shared" : m.card.scope === "team" ? "Team workspace" : "Shared workspace"}</Text>
              {!m.card.unavailable ? <Text style={styles.name}>{m.card.name}</Text> : null}
            </View>
          ) : null}
          {m.kind !== "removed" && !m.mine ? <Button label="Report" compact tone="ghost" testID={`report-${m.seq}`} onPress={() => props.onReport(m.seq)} /> : null}
          {m.kind !== "removed" && props.team.role === "owner" && props.onDelete ? <Button label="Remove" compact destructive tone="ghost" testID={`remove-${m.seq}`} onPress={() => props.onDelete?.(m.seq, "Removed by the team owner")} /> : null}
        </View>
      ))}
      {picker ? (
        <View testID="card-picker" style={styles.card}>
          {confirm ? (
            <>
              <Text style={styles.body}>{`Share ${confirm.name} with this team? Members see its name, not its files.`}</Text>
              <Button label="Share with team" testID="share-confirm" onPress={() => { props.onCard({ scope: "personal", workspaceId: confirm.id, share: true }); setConfirm(null); setPicker(false); }} />
              <Button label="Back" tone="ghost" onPress={() => setConfirm(null)} />
            </>
          ) : props.pickable.map((p) => (
            <Button key={`${p.scope}-${p.id}`} compact tone="ghost" label={`${p.name} · ${p.scope === "team" ? "Team" : p.shared ? "Yours, shared" : "Yours, private"}`} testID={`pick-${p.scope}-${p.id}`}
              onPress={() => { if (p.scope === "personal" && !p.shared) setConfirm(p); else { props.onCard({ scope: p.scope, workspaceId: p.id }); setPicker(false); } }} />
          ))}
        </View>
      ) : null}
      {blocked ? <Text testID="chat-blocked" style={styles.help}>{blocked}</Text> : (
        <View style={styles.composer}>
          <Button label="+" compact tone="secondary" accessibilityLabel="Share a workspace" testID="chat-plus" onPress={() => { setPicker(!picker); setConfirm(null); }} />
          <TextInput testID="chat-input" accessibilityLabel="Message" value={text} maxLength={2000} placeholder="Message the team" placeholderTextColor={colors.muted}
            onChangeText={setText} style={styles.input} />
          <Button label="Send" compact testID="chat-send" disabled={!text.trim()} onPress={() => { props.onSend(text.trim()); setText(""); }} />
        </View>
      )}
    </Screen>
  );
}

export function TeamMembersScreen(props: { team: Team; colors: TeamColorChoices | null; onUpdateMe: (p: { displayName?: string; color?: string }) => void;
  onModerate: (memberId: string, action: "mute" | "unmute" | "kick" | "ban", reason: string, until: number | null) => void; onBack: () => void; nowMs?: number;
  onSetRole?: (memberId: string, role: "member" | "viewer") => void; onTransfer?: (memberId: string, myColor: string) => void }) {
  const styles = useStyles(makeStyles);
  const [name, setName] = useState(props.team.me.displayName);
  const [transferTo, setTransferTo] = useState<TeamMember | null>(null);
  const [myColor, setMyColor] = useState<string | undefined>();
  const [reason, setReason] = useState("");
  const owner = props.team.role === "owner";
  const now = props.nowMs ?? Date.now();
  return (
    <Screen testID="team-members">
      <Title kicker="Team">Members</Title>
      <Field label="Name in chat" value={name} onChangeText={setName} testID="me-display-name" />
      <Button label="Save name" compact tone="secondary" testID="me-save-name" disabled={!name.trim() || name.trim() === props.team.me.displayName} onPress={() => props.onUpdateMe({ displayName: name.trim() })} />
      <Swatches role={props.team.me.role === "owner" ? "owner" : "member"} choices={props.colors} value={props.team.me.color} onChange={(color) => props.onUpdateMe({ color })} />
      {owner ? <Field label="Reason (shown to the member)" value={reason} onChangeText={setReason} testID="moderate-reason" helper="Required for mute, remove and ban." /> : null}
      {(props.team.members ?? []).map((m) => (
        <View key={m.memberId} testID={`member-${m.memberId}`} style={styles.row}>
          <View style={[styles.dot, { backgroundColor: m.colorHex ?? undefined }]} />
          <Text style={styles.name}>{m.displayName}</Text>
          <Text style={styles.help}>{m.role === "owner" ? "Owner" : m.muted ? "Muted" : m.role === "viewer" ? "Viewer" : "Member"}</Text>
          {owner && m.role !== "owner" ? (
            <View style={styles.choices}>
              {m.muted
                ? <Button label="Unmute" compact tone="ghost" testID={`unmute-${m.memberId}`} onPress={() => props.onModerate(m.memberId, "unmute", "Mute lifted", null)} />
                : <Button label="Mute 1 h" compact tone="ghost" testID={`mute-${m.memberId}`} disabled={!reason.trim()} onPress={() => props.onModerate(m.memberId, "mute", reason.trim(), now + 3_600_000)} />}
              <Button label="Remove" compact tone="ghost" testID={`kick-${m.memberId}`} disabled={!reason.trim()} onPress={() => props.onModerate(m.memberId, "kick", reason.trim(), null)} />
              <Button label="Ban" compact destructive tone="ghost" testID={`ban-${m.memberId}`} disabled={!reason.trim()} onPress={() => props.onModerate(m.memberId, "ban", reason.trim(), null)} />
              {props.onSetRole ? <Button label={m.role === "viewer" ? "Allow editing" : "Make viewer"} compact tone="ghost" testID={`role-${m.memberId}`}
                onPress={() => props.onSetRole?.(m.memberId, m.role === "viewer" ? "member" : "viewer")} /> : null}
              {props.onTransfer ? <Button label="Make owner" compact tone="ghost" testID={`transfer-${m.memberId}`} onPress={() => { setTransferTo(m); setMyColor(undefined); }} /> : null}
            </View>
          ) : null}
        </View>
      ))}
      {transferTo ? (
        <View testID="transfer-panel">
          <SectionLabel>{`Make ${transferTo.displayName} the owner`}</SectionLabel>
          <Text style={styles.help}>You stay as a member with the color you pick. Billing stays on your card until it ends.</Text>
          <Swatches role="member" value={myColor} onChange={setMyColor}
            choices={props.colors ? { ...props.colors, memberColors: props.colors.memberColors.map((c) => c.id === transferTo.color ? { ...c, taken: false } : c) } : null} />
          <Button label="Transfer ownership" destructive testID="transfer-confirm" disabled={!myColor} onPress={() => { if (myColor) props.onTransfer?.(transferTo.memberId, myColor); setTransferTo(null); }} />
          <Button label="Cancel" tone="ghost" onPress={() => setTransferTo(null)} />
        </View>
      ) : null}
      <Button label="Back to chat" tone="ghost" onPress={props.onBack} />
    </Screen>
  );
}

/** The Teams tab. Polls the chat every 3 s (React Native fetch has no streaming body). */
export function TeamsTab(props: { client: GenDragoonClient | null; personalWorkspaces: Array<{ id: string; name: string }>; openUrl: (url: string) => void; pollMs?: number }) {
  const [page, setPage] = useState<"home" | "create" | "join" | "chat" | "members">("home");
  const [teams, setTeams] = useState<Team[]>([]);
  const [team, setTeam] = useState<Team | null>(null);
  const [colors, setColors] = useState<TeamColorChoices | null>(null);
  const [shades, setShades] = useState<TeamColor[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [shared, setShared] = useState<Set<string>>(new Set());
  const [teamSpaces, setTeamSpaces] = useState<Array<{ id: string; name: string }>>([]);
  const [preview, setPreview] = useState<{ teamName: string; memberCount: number; memberLimit: number; colors: TeamColorChoices } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [intentId, setIntentId] = useState(() => globalThis.crypto?.randomUUID?.() ?? "");
  const seq = useRef(0);
  const deviceName = mobileDeviceName();
  const client = props.client;

  async function run(fn: (c: GenDragoonClient) => Promise<void>) {
    if (!client) { setError("Sign in to use Teams."); return; }
    setError(null);
    try { await fn(client); } catch (e) { setError(errorText(e)); }
  }
  async function loadHome() {
    await run(async (c) => {
      const [list, catalog] = await Promise.all([c.listTeams(), c.teamsCatalog()]);
      setTeams(list.teams); setShades(catalog.colors.ownerShades);
    });
  }
  async function openTeam(id: string) {
    await run(async (c) => {
      const [view, chat, ws] = await Promise.all([c.getTeam(id), c.teamChat(id, 0), c.teamWorkspaces(id)]);
      setTeam(view.team); setColors(view.colors); setMessages(chat.messages); seq.current = latestSeq(chat.messages);
      setShared(new Set(ws.sharedWorkspaces.filter((w) => w.mine).map((w) => w.id)));
      setTeamSpaces(ws.teamWorkspaces.map((w) => ({ id: w.id, name: w.name })));
      setPage("chat");
    });
  }
  useEffect(() => { void loadHome(); }, [client]);
  useEffect(() => {
    if (page !== "chat" || !team || !client) return;
    const timer = setInterval(() => {
      void client.teamChat(team.id, seq.current).then((r) => {
        if (r.messages.length) { seq.current = Math.max(seq.current, latestSeq(r.messages)); setMessages((m) => mergeMessages(m, r.messages)); }
      }).catch((e: unknown) => { if (e instanceof ApiError && e.status === 404) { setPage("home"); setTeam(null); void loadHome(); } });
    }, props.pollMs ?? 3000);
    return () => clearInterval(timer);
  }, [page, team?.id, client]);

  if (page === "create") {
    return <CreateTeamScreen intentId={intentId} deviceName={deviceName} ownerShades={shades.length ? shades : [{ id: "purple-500", hue: "purple", hex: "#a855f7" }]} error={error}
      onCancel={() => setPage("home")}
      onSubmit={(r) => void run(async (c) => { const created = await c.createTeam(r); setIntentId(globalThis.crypto?.randomUUID?.() ?? ""); if (created.url) props.openUrl(created.url); await loadHome(); await openTeam(created.team.id); })} />;
  }
  if (page === "join") {
    return <JoinTeamScreen deviceName={deviceName} preview={preview} error={error} onCancel={() => { setPreview(null); setPage("home"); }}
      onPreview={(code) => void run(async (c) => setPreview(await c.previewTeamInvite(code)))}
      onSubmit={(r) => void run(async (c) => { const joined = await c.joinTeam(r); setPreview(null); await loadHome(); await openTeam(joined.teamId); })} />;
  }
  if (page === "members" && team) {
    return <TeamMembersScreen team={team} colors={colors} onBack={() => setPage("chat")}
      onUpdateMe={(p) => void run(async (c) => { await c.updateTeamMe(team.id, p); await openTeam(team.id); setPage("members"); })}
      onModerate={(memberId, action, reason, until) => void run(async (c) => { await c.moderateTeamMember(team.id, memberId, action, { reason, until }); await openTeam(team.id); setPage("members"); })}
      onSetRole={team.role === "owner" ? (memberId, role) => void run(async (c) => { await c.setTeamMemberRole(team.id, memberId, role); await openTeam(team.id); setPage("members"); }) : undefined}
      onTransfer={team.role === "owner" ? (memberId, color) => void run(async (c) => { await c.transferTeam(team.id, { memberId, color }); await openTeam(team.id); setPage("members"); }) : undefined} />;
  }
  if (page === "chat" && team) {
    const pickable: MobilePickable[] = [
      ...teamSpaces.map((w) => ({ scope: "team" as const, ...w })),
      ...props.personalWorkspaces.filter((w) => /^[0-9a-f-]{36}$/i.test(w.id)).map((w) => ({ scope: "personal" as const, ...w, shared: shared.has(w.id) })),
    ];
    return <TeamChatScreen team={team} messages={messages} pickable={pickable} error={error} onBack={() => { setPage("home"); setTeam(null); }} onMembers={() => setPage("members")}
      onSend={(text) => void run(async (c) => { const r = await c.postTeamChat(team.id, { text }); setMessages((m) => mergeMessages(m, [r.message])); })}
      onCard={(card) => void run(async (c) => { const r = await c.postTeamChat(team.id, { card }); setMessages((m) => mergeMessages(m, [r.message])); if (r.shared) setShared((s) => new Set([...s, card.workspaceId])); })}
      onReport={(s) => void run(async (c) => { await c.reportTeamMessage(team.id, s, { category: "abuse" }); setError("Reported. Thanks."); })}
      onDelete={(s, reason) => void run(async (c) => { await c.deleteTeamMessage(team.id, s, reason); setMessages((await c.teamChat(team.id, 0)).messages); })} />;
  }
  return <TeamsHomeScreen teams={teams} error={error} onOpen={(id) => void openTeam(id)} onCreate={() => setPage("create")} onJoin={() => setPage("join")} />;
}

const makeStyles = (colors: MobileColors) => StyleSheet.create({
  help: { color: colors.muted, fontSize: 13 },
  body: { color: colors.text, fontSize: 15 },
  name: { color: colors.text, fontSize: 15, fontWeight: "600", flexShrink: 1 },
  author: { fontSize: 12, fontWeight: "700" },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  dot: { width: 12, height: 12, borderRadius: 6 },
  swatches: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  swatch: { width: 32, height: 32, borderRadius: 16, borderWidth: 2, borderColor: "transparent" },
  swatchOn: { borderColor: colors.focus },
  msg: { gap: 4, padding: space.sm, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceRaised },
  mine: { borderColor: colors.primary },
  card: { gap: 4, padding: space.sm, borderRadius: 10, borderWidth: 1, borderColor: colors.secondaryBorder, backgroundColor: colors.secondaryBg },
  composer: { flexDirection: "row", alignItems: "center", gap: space.sm },
  input: { flex: 1, minHeight: 44, color: colors.text, borderWidth: 1, borderColor: colors.controlBorder, borderRadius: 10, paddingHorizontal: 12 },
});
