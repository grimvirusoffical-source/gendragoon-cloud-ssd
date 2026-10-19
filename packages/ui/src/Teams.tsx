import {
  TEAM_TIERS,
  availableMemberColors,
  defaultDisplayName,
  parseInviteCode,
  teamPrice,
  type ChatMessage,
  type CreateTeamRequest,
  type JoinTeamRequest,
  type ModerationAction,
  type PlanInterval,
  type SharedWorkspace,
  type Team,
  type TeamColor,
  type TeamColorChoices,
  type TeamMember,
  type TeamTierId,
  type TeamWorkspace,
  type WorkspaceCard,
} from "@gendragoon/core";
import { useEffect, useRef, useState } from "react";

function money(cents: number): string {
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** One color picker for owners (purple shades) and members (the rest, taken ones disabled). */
export function ColorPicker(props: { choices: TeamColorChoices | null; role: "owner" | "member"; value?: string; onChange: (id: string) => void }) {
  const owner = props.role === "owner";
  const options: TeamColor[] = owner ? props.choices?.ownerShades ?? [] : props.choices?.memberColors.filter((c) => c.hue !== "purple") ?? [];
  const free = owner ? options : availableMemberColors(props.choices);
  return (
    <fieldset className="color-picker" data-testid="color-picker">
      <legend>{owner ? "Your purple shade" : "Your color"}</legend>
      <div className="swatches" role="radiogroup" aria-label={owner ? "Purple shade" : "Color"}>
        {options.map((c) => {
          const taken = !owner && !free.includes(c);
          return (
            <button key={c.id} type="button" role="radio" aria-checked={props.value === c.id} aria-label={`${c.id}${taken ? " (taken)" : ""}`}
              className={`swatch${props.value === c.id ? " active" : ""}`} style={{ background: c.hex }} disabled={taken}
              data-testid={`color-${c.id}`} onClick={() => props.onChange(c.id)} />
          );
        })}
      </div>
      {!owner ? <p className="help">Purple is the team owner's color. Taken colors are greyed out.</p> : null}
    </fieldset>
  );
}

export function TeamsHome(props: { teams: Team[]; onOpen: (id: string) => void; onCreate: () => void; onJoin: () => void }) {
  return (
    <section className="panel stack teams-home" data-testid="teams-home" aria-labelledby="teams-title">
      <div className="topbar">
        <div>
          <div className="kicker"><span className="dot" /> TEAMS</div>
          <h3 id="teams-title">Your teams</h3>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-ghost" data-testid="join-team" onClick={props.onJoin}>Join with a code</button>
          <button type="button" className="btn" data-testid="create-team" onClick={props.onCreate}>New team</button>
        </div>
      </div>
      {props.teams.length === 0 ? (
        <p className="help" data-testid="teams-empty">Teams share workspaces and a chat. Your personal workspaces stay private unless you share one.</p>
      ) : (
        <ul className="team-list">
          {props.teams.map((team) => (
            <li key={team.id}>
              <button type="button" className="team-row" data-testid={`team-${team.id}`} onClick={() => props.onOpen(team.id)}>
                <span className="member-dot" style={{ background: team.me.colorHex ?? undefined }} aria-hidden="true" />
                <strong>{team.name}</strong>
                <span className="kind">{TEAM_TIERS.find((t) => t.id === team.tier)?.name} · {team.memberCount}/{team.memberLimit}</span>
                {!team.subscriptionActive ? <span className="tag">PAYMENT NEEDED</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function CreateTeam(props: { intentId: string; deviceName?: string; ownerShades: TeamColor[]; busy?: boolean; error?: string | null;
  onSubmit: (request: CreateTeamRequest) => void; onCancel?: () => void; onContactSales?: () => void }) {
  const [name, setName] = useState("");
  const [tier, setTier] = useState<TeamTierId>("team");
  const [interval, setInterval] = useState<PlanInterval>("month");
  const [shade, setShade] = useState(props.ownerShades.find((s) => s.id === "purple-500")?.id ?? props.ownerShades[0]?.id ?? "purple-500");
  const per = interval === "year" ? "/yr" : "/mo";
  return (
    <section className="panel stack" data-testid="create-team-form" aria-labelledby="create-team-title">
      <div>
        <div className="kicker"><span className="dot" /> NEW TEAM</div>
        <h3 id="create-team-title">Create a team</h3>
      </div>
      <label className="field">Team name
        <input data-testid="team-name" value={name} placeholder="e.g. Night Shift Studio" onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="segmented" role="radiogroup" aria-label="Billing period">
        <button type="button" role="radio" aria-checked={interval === "month"} className={interval === "month" ? "active" : ""} data-testid="team-interval-month" onClick={() => setInterval("month")}>Monthly</button>
        <button type="button" role="radio" aria-checked={interval === "year"} className={interval === "year" ? "active" : ""} data-testid="team-interval-year" onClick={() => setInterval("year")}>Yearly · 2 months free</button>
      </div>
      <fieldset className="plan-picker" data-testid="team-tiers">
        <legend>Team plan</legend>
        <div className="plan-grid">
          {TEAM_TIERS.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={tier === t.id} className={`plan-card${tier === t.id ? " active" : ""}`} data-testid={`team-tier-${t.id}`} onClick={() => setTier(t.id)}>
              <strong>{t.name}</strong>
              <span>{t.members} members · {money(teamPrice(t.id, interval))}{per}</span>
            </button>
          ))}
          <button type="button" className="plan-card" data-testid="team-tier-enterprise" onClick={props.onContactSales} disabled={!props.onContactSales}>
            <strong>Enterprise</strong>
            <span>More members · contact us</span>
          </button>
        </div>
      </fieldset>
      <ColorPicker role="owner" choices={{ memberColors: [], ownerShades: props.ownerShades, reservedHue: "purple" }} value={shade} onChange={setShade} />
      <p className="help">Each team workspace adds its own storage plan and performance plan (custom storage: performance only).</p>
      {props.error ? <p className="connection-error" role="alert" data-testid="create-team-error">{props.error}</p> : null}
      <div className="actions">
        {props.onCancel ? <button type="button" className="btn btn-ghost" onClick={props.onCancel}>Cancel</button> : null}
        <button type="button" className="btn" data-testid="create-team-submit" disabled={!name.trim() || props.busy}
          onClick={() => props.onSubmit({ name: name.trim(), intentId: props.intentId, tier, interval, ownerShade: shade, deviceName: defaultDisplayName(props.deviceName) })}>
          Continue to checkout · {money(teamPrice(tier, interval))}{per}
        </button>
      </div>
    </section>
  );
}

export function JoinTeam(props: { deviceName?: string; busy?: boolean; error?: string | null;
  preview: { teamName: string; memberCount: number; memberLimit: number; colors: TeamColorChoices } | null;
  onPreview: (code: string) => void; onSubmit: (request: JoinTeamRequest) => void; onCancel?: () => void }) {
  const [input, setInput] = useState("");
  const [color, setColor] = useState<string | undefined>();
  const [displayName, setDisplayName] = useState(defaultDisplayName(props.deviceName));
  const code = parseInviteCode(input);
  const chosenFree = color !== undefined && availableMemberColors(props.preview?.colors).some((c) => c.id === color);
  return (
    <section className="panel stack" data-testid="join-team-form" aria-labelledby="join-team-title">
      <div>
        <div className="kicker"><span className="dot" /> JOIN A TEAM</div>
        <h3 id="join-team-title">{props.preview ? `Join ${props.preview.teamName}` : "Enter your invite"}</h3>
      </div>
      {!props.preview ? (
        <>
          <label className="field">Invite link or code
            <input data-testid="invite-code" value={input} placeholder="XXXX-XXXX-XXXX" autoComplete="off" onChange={(e) => setInput(e.target.value)} />
          </label>
          <div className="actions">
            {props.onCancel ? <button type="button" className="btn btn-ghost" onClick={props.onCancel}>Cancel</button> : null}
            <button type="button" className="btn" data-testid="invite-continue" disabled={!code || props.busy} onClick={() => code && props.onPreview(code)}>Continue</button>
          </div>
        </>
      ) : (
        <>
          <p className="help">{props.preview.memberCount} of {props.preview.memberLimit} members</p>
          <label className="field">Name in chat
            <input data-testid="join-display-name" value={displayName} maxLength={40} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
          <ColorPicker role="member" choices={props.preview.colors} value={color} onChange={setColor} />
          <div className="actions">
            {props.onCancel ? <button type="button" className="btn btn-ghost" onClick={props.onCancel}>Cancel</button> : null}
            <button type="button" className="btn" data-testid="join-submit" disabled={!chosenFree || !code || props.busy}
              onClick={() => code && color && props.onSubmit({ code, color, displayName: displayName.trim() || undefined, deviceName: props.deviceName })}>Join team</button>
          </div>
        </>
      )}
      {props.error ? <p className="connection-error" role="alert" data-testid="join-team-error">{props.error}</p> : null}
    </section>
  );
}

function CardView(props: { card: WorkspaceCard }) {
  if (props.card.unavailable) return <div className="ws-card unavailable" data-testid="ws-card-unavailable">Workspace no longer shared</div>;
  return (
    <div className="ws-card" data-testid={`ws-card-${props.card.workspaceId}`}>
      <span className="kind">{props.card.scope === "team" ? "Team workspace" : "Shared workspace"}</span>
      <strong>{props.card.name}</strong>
    </div>
  );
}

export interface ChatPickable { scope: "team" | "personal"; id: string; name: string; shared?: boolean }

/** Team chat. The "+" opens one picker of workspaces you may share: team workspaces, and your own personal ones. */
export function TeamChat(props: {
  messages: ChatMessage[];
  isOwner: boolean;
  canPost: boolean;
  postBlockedReason?: string | null;
  pickable: ChatPickable[];
  onSend: (text: string) => void;
  onShareCard: (card: { scope: "team" | "personal"; workspaceId: string; share?: boolean }) => void;
  onDelete?: (seq: number, reason: string) => void;
  onReport: (seq: number) => void;
}) {
  const [text, setText] = useState("");
  const [picker, setPicker] = useState(false);
  const [confirm, setConfirm] = useState<ChatPickable | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const end = useRef<HTMLDivElement | null>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "end" }); }, [props.messages.length]);
  function pick(item: ChatPickable) {
    if (item.scope === "personal" && !item.shared) { setConfirm(item); return; }
    props.onShareCard({ scope: item.scope, workspaceId: item.id });
    setPicker(false);
  }
  return (
    <section className="chat" data-testid="team-chat" aria-label="Team chat">
      <ol className="chat-log" aria-live="polite">
        {props.messages.map((m) => (
          <li key={m.seq} className={`chat-msg${m.mine ? " mine" : ""}${m.kind === "removed" ? " removed" : ""}`} data-testid={`msg-${m.seq}`}>
            <span className="member-dot" style={{ background: m.colorHex ?? undefined }} aria-hidden="true" />
            <div className="chat-body">
              <span className="chat-name" style={{ color: m.colorHex ?? undefined }}>{m.displayName}</span>
              {m.kind === "removed" ? <em>Removed by {m.removed?.by === "auto" ? "automatic moderation" : "the team owner"}: {m.removed?.reason}</em> : null}
              {m.kind === "text" && m.text ? <p>{m.text}</p> : null}
              {m.kind === "workspace_card" && m.text ? <p>{m.text}</p> : null}
              {m.card ? <CardView card={m.card} /> : null}
            </div>
            {m.kind !== "removed" ? (
              <div className="chat-tools">
                {props.isOwner && props.onDelete ? <button type="button" className="btn-ghost btn-sm" data-testid={`remove-${m.seq}`} onClick={() => { setRemoving(m.seq); setReason(""); }}>Remove</button> : null}
                {!m.mine ? <button type="button" className="btn-ghost btn-sm" data-testid={`report-${m.seq}`} onClick={() => props.onReport(m.seq)}>Report</button> : null}
              </div>
            ) : null}
          </li>
        ))}
        <div ref={end} />
      </ol>
      {removing !== null ? (
        <div className="inline-dialog" role="dialog" aria-label="Remove message" data-testid="remove-dialog">
          <label className="field">Reason (shown to the team)
            <input data-testid="remove-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={() => setRemoving(null)}>Cancel</button>
            <button type="button" className="btn-danger" data-testid="remove-confirm" disabled={!reason.trim()} onClick={() => { props.onDelete?.(removing, reason.trim()); setRemoving(null); }}>Remove message</button>
          </div>
        </div>
      ) : null}
      {picker ? (
        <div className="inline-dialog" role="dialog" aria-label="Share a workspace" data-testid="card-picker">
          {confirm ? (
            <>
              <p className="help">Share <strong>{confirm.name}</strong> with this team? Members will see its name. They get no access to its files.</p>
              <div className="actions">
                <button type="button" className="btn btn-ghost" onClick={() => setConfirm(null)}>Back</button>
                <button type="button" className="btn" data-testid="share-confirm" onClick={() => { props.onShareCard({ scope: "personal", workspaceId: confirm.id, share: true }); setConfirm(null); setPicker(false); }}>Share with team</button>
              </div>
            </>
          ) : props.pickable.length === 0 ? (
            <p className="help">No workspaces to share yet.</p>
          ) : (
            <ul className="pick-list">
              {props.pickable.map((item) => (
                <li key={`${item.scope}-${item.id}`}>
                  <button type="button" data-testid={`pick-${item.scope}-${item.id}`} onClick={() => pick(item)}>
                    <strong>{item.name}</strong><span className="kind">{item.scope === "team" ? "Team" : item.shared ? "Yours · shared" : "Yours · private"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {props.canPost ? (
        <form className="composer" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { props.onSend(text.trim()); setText(""); } }}>
          <button type="button" className="btn-ghost composer-plus" aria-label="Share a workspace" aria-expanded={picker} data-testid="chat-plus" onClick={() => { setPicker(!picker); setConfirm(null); }}>+</button>
          <input data-testid="chat-input" value={text} maxLength={2000} placeholder="Message the team" onChange={(e) => setText(e.target.value)} />
          <button type="submit" className="btn" data-testid="chat-send" disabled={!text.trim()}>Send</button>
        </form>
      ) : (
        <p className="help" role="status" data-testid="chat-blocked">{props.postBlockedReason ?? "You can't post right now."}</p>
      )}
    </section>
  );
}

export function TeamMembers(props: { members: TeamMember[]; me: TeamMember; isOwner: boolean; colors: TeamColorChoices | null;
  onUpdateMe: (patch: { displayName?: string; color?: string }) => void;
  onModerate?: (memberId: string, action: ModerationAction, reason: string, until: number | null) => void; nowMs?: number;
  teamName?: string;
  onSetRole?: (memberId: string, role: "member" | "viewer") => void;
  onTransfer?: (memberId: string, myColor: string) => void;
  onDeleteTeam?: (confirmName: string) => void }) {
  const [transferTo, setTransferTo] = useState<TeamMember | null>(null);
  const [myColor, setMyColor] = useState<string | undefined>();
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [name, setName] = useState(props.me.displayName);
  const [target, setTarget] = useState<{ member: TeamMember; action: ModerationAction } | null>(null);
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState<"1h" | "1d" | "7d" | "forever" | "until">("1h");
  const [until, setUntil] = useState("");
  const now = props.nowMs ?? Date.now();
  const untilMs = duration === "forever" ? null : duration === "until" ? (until ? new Date(until).getTime() : NaN)
    : now + { "1h": 3_600_000, "1d": 86_400_000, "7d": 604_800_000 }[duration];
  const needsDuration = target?.action === "mute" || target?.action === "ban";
  const validUntil = !needsDuration || untilMs === null || (Number.isFinite(untilMs) && (untilMs as number) > now);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <section className="stack" data-testid="team-members">
      <div className="panel stack">
        <h3>You</h3>
        <label className="field">Name in chat
          <input data-testid="me-display-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name.trim() !== props.me.displayName && props.onUpdateMe({ displayName: name.trim() })} />
        </label>
        <ColorPicker role={props.me.role === "owner" ? "owner" : "member"} choices={props.colors} value={props.me.color} onChange={(color) => props.onUpdateMe({ color })} />
      </div>
      <ul className="member-list">
        {props.members.map((m) => (
          <li key={m.memberId} className="member-row" data-testid={`member-${m.memberId}`}>
            <span className="member-dot" style={{ background: m.colorHex ?? undefined }} aria-hidden="true" />
            <strong>{m.displayName}</strong>
            <span className="kind">{m.role === "owner" ? "Owner" : m.muted ? "Muted" : m.role === "viewer" ? "Viewer" : "Member"}</span>
            {props.isOwner && m.role !== "owner" && props.onModerate ? (
              <span className="actions">
                {m.muted
                  ? <button type="button" className="btn-ghost btn-sm" data-testid={`unmute-${m.memberId}`} onClick={() => props.onModerate?.(m.memberId, "unmute", "Mute lifted", null)}>Unmute</button>
                  : <button type="button" className="btn-ghost btn-sm" data-testid={`mute-${m.memberId}`} onClick={() => { setTarget({ member: m, action: "mute" }); setReason(""); }}>Mute</button>}
                <button type="button" className="btn-ghost btn-sm" data-testid={`kick-${m.memberId}`} onClick={() => { setTarget({ member: m, action: "kick" }); setReason(""); }}>Remove</button>
                <button type="button" className="btn-danger btn-sm" data-testid={`ban-${m.memberId}`} onClick={() => { setTarget({ member: m, action: "ban" }); setReason(""); }}>Ban</button>
                {props.onSetRole ? (
                  <button type="button" className="btn-ghost btn-sm" data-testid={`role-${m.memberId}`} title={m.role === "viewer" ? "Can upload and delete team files" : "Can only open and download team files"}
                    onClick={() => props.onSetRole?.(m.memberId, m.role === "viewer" ? "member" : "viewer")}>{m.role === "viewer" ? "Allow editing" : "Make viewer"}</button>
                ) : null}
                {props.onTransfer ? (
                  <button type="button" className="btn-ghost btn-sm" data-testid={`transfer-${m.memberId}`} onClick={() => { setTransferTo(m); setMyColor(undefined); }}>Make owner</button>
                ) : null}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {target ? (
        <div className="panel stack inline-dialog" role="dialog" aria-label={`${target.action} ${target.member.displayName}`} data-testid="moderate-dialog">
          <h3>{{ mute: "Mute", kick: "Remove", ban: "Ban", unmute: "Unmute" }[target.action]} {target.member.displayName}</h3>
          <label className="field">Reason (shown to them)
            <input data-testid="moderate-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </label>
          {needsDuration ? (
            <>
              <div className="segmented" role="radiogroup" aria-label="Duration">
                {(["1h", "1d", "7d", "forever", "until"] as const).map((d) => (
                  <button key={d} type="button" role="radio" aria-checked={duration === d} className={duration === d ? "active" : ""} data-testid={`duration-${d}`} onClick={() => setDuration(d)}>
                    {{ "1h": "1 hour", "1d": "1 day", "7d": "7 days", forever: "Forever", until: "Until…" }[d]}
                  </button>
                ))}
              </div>
              {duration === "until" ? <input type="datetime-local" data-testid="moderate-until" value={until} onChange={(e) => setUntil(e.target.value)} /> : null}
              <p className="help" data-testid="moderate-ends">{untilMs === null ? "Until you lift it" : Number.isFinite(untilMs) ? `Ends ${new Date(untilMs as number).toLocaleString()} (${zone})` : "Pick a date and time"}</p>
            </>
          ) : null}
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={() => setTarget(null)}>Cancel</button>
            <button type="button" className="btn-danger" data-testid="moderate-confirm" disabled={!reason.trim() || !validUntil}
              onClick={() => { props.onModerate?.(target.member.memberId, target.action, reason.trim(), needsDuration ? (untilMs as number | null) : null); setTarget(null); }}>Confirm</button>
          </div>
        </div>
      ) : null}
      {transferTo ? (
        <div className="panel stack inline-dialog" role="dialog" aria-label={`Make ${transferTo.displayName} the owner`} data-testid="transfer-dialog">
          <h3>Make {transferTo.displayName} the owner</h3>
          <p className="help">They get owner controls and a purple color. You stay in the team as a member. The team's billing stays on your card until it ends; then the new owner pays.</p>
          <ColorPicker role="member" choices={props.colors ? { ...props.colors, memberColors: props.colors.memberColors.map((c) => c.id === transferTo.color ? { ...c, taken: false } : c) } : null}
            value={myColor} onChange={setMyColor} />
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={() => setTransferTo(null)}>Cancel</button>
            <button type="button" className="btn-danger" data-testid="transfer-confirm" disabled={!myColor}
              onClick={() => { if (myColor) props.onTransfer?.(transferTo.memberId, myColor); setTransferTo(null); }}>Transfer ownership</button>
          </div>
        </div>
      ) : null}
      {props.isOwner && props.onDeleteTeam ? (
        <div className="panel stack" data-testid="danger-zone">
          <h3>Delete team</h3>
          <p className="help">Deletes the chat, invites, team workspaces and their files, and cancels the team's billing. Members' personal workspaces aren't touched.</p>
          {deleting ? (
            <>
              <label className="field">Type <strong>{props.teamName}</strong> to confirm
                <input data-testid="delete-team-name" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
              </label>
              <div className="actions">
                <button type="button" className="btn btn-ghost" onClick={() => { setDeleting(false); setConfirmName(""); }}>Cancel</button>
                <button type="button" className="btn-danger" data-testid="delete-team-confirm" disabled={confirmName.trim() !== props.teamName}
                  onClick={() => props.onDeleteTeam?.(confirmName.trim())}>Delete team</button>
              </div>
            </>
          ) : <button type="button" className="btn-danger" data-testid="delete-team" onClick={() => setDeleting(true)}>Delete team…</button>}
        </div>
      ) : null}
    </section>
  );
}

export function TeamWorkspaces(props: { teamWorkspaces: TeamWorkspace[]; sharedWorkspaces: SharedWorkspace[]; isOwner: boolean;
  onNew?: () => void; onCheckout?: (id: string) => void; onUnshare?: (id: string) => void; onOpenFiles?: (id: string) => void }) {
  return (
    <section className="stack" data-testid="team-workspaces">
      <div className="topbar">
        <h3>Team workspaces</h3>
        {props.isOwner && props.onNew ? <button type="button" className="btn" data-testid="team-new-workspace" onClick={props.onNew}>New team workspace</button> : null}
      </div>
      {props.teamWorkspaces.length === 0 ? <p className="help">No team workspaces yet. Each one needs a storage plan and a performance plan.</p> : (
        <ul className="workspace-list">
          {props.teamWorkspaces.map((w) => (
            <li key={w.id} className="workspace-row" data-testid={`team-ws-${w.id}`}>
              <strong>{w.name}</strong>
              <span className="chip">{w.customStorage ? "Custom storage" : w.requiredPlans.storageTier} + {w.requiredPlans.performanceTier}</span>
              {w.projectStatus === "pending_payment" && props.isOwner && props.onCheckout
                ? <button type="button" className="btn btn-sm" data-testid={`team-ws-pay-${w.id}`} onClick={() => props.onCheckout?.(w.id)}>Continue to checkout</button>
                : <span className="kind">{w.projectStatus === "active" ? "Active" : w.projectStatus === "team_subscription_required" ? "Team subscription needed" : "Payment needed"}</span>}
              {w.access === "read" ? <span className="tag" data-testid={`team-ws-readonly-${w.id}`}>View only</span> : null}
              {w.storageRoutes && w.projectStatus !== "pending_payment" && props.onOpenFiles
                ? <button type="button" className="btn-ghost btn-sm" data-testid={`team-ws-files-${w.id}`} onClick={() => props.onOpenFiles?.(w.id)}>Files</button> : null}
            </li>
          ))}
        </ul>
      )}
      <h3>Shared by members</h3>
      {props.sharedWorkspaces.length === 0 ? <p className="help">Nothing shared. Personal workspaces stay private until their owner shares them.</p> : (
        <ul className="workspace-list">
          {props.sharedWorkspaces.map((w) => (
            <li key={w.id} className="workspace-row" data-testid={`shared-ws-${w.id}`}>
              <strong>{w.name}</strong>
              <span className="kind">{w.mine ? "You" : w.sharedBy.displayName} · view</span>
              {(w.mine || props.isOwner) && props.onUnshare ? <button type="button" className="btn-ghost btn-sm" data-testid={`unshare-${w.id}`} onClick={() => props.onUnshare?.(w.id)}>Stop sharing</button> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export type TeamFile = { id: string; name: string; sizeBytes: number };
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
/** Files of one team workspace (same storage routes as personal workspaces). Viewers get no upload or delete. */
export function TeamFiles(props: { workspace: TeamWorkspace; files: TeamFile[]; quotaBytes?: number; usedBytes?: number;
  busy?: boolean; progress?: number | null; onBack: () => void; onUpload?: (file: File) => void;
  onDownload: (file: TeamFile) => void; onDelete?: (file: TeamFile) => void }) {
  const writable = props.workspace.access !== "read";
  const [confirm, setConfirm] = useState<TeamFile | null>(null);
  return (
    <section className="stack" data-testid="team-files">
      <div className="topbar">
        <button type="button" className="btn-ghost btn-sm" onClick={props.onBack}>Back</button>
        <h3>{props.workspace.name}</h3>
        {writable && props.onUpload ? (
          <label className="btn" data-testid="team-files-upload">Upload
            <input type="file" hidden disabled={props.busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) props.onUpload?.(f); e.target.value = ""; }} />
          </label>
        ) : <span className="tag">View only</span>}
      </div>
      {props.quotaBytes ? <p className="help" data-testid="team-files-usage">{formatBytes(props.usedBytes ?? 0)} of {formatBytes(props.quotaBytes)} used</p> : null}
      {props.progress !== null && props.progress !== undefined ? <progress max={1} value={props.progress} aria-label="Upload progress" /> : null}
      {props.files.length === 0 ? <p className="help">No files yet.{writable ? " Upload one to share it with the team." : ""}</p> : (
        <ul className="workspace-list">
          {props.files.map((f) => (
            <li key={f.id} className="workspace-row" data-testid={`team-file-${f.id}`}>
              <strong>{f.name}</strong>
              <span className="kind">{formatBytes(f.sizeBytes)}</span>
              <button type="button" className="btn-ghost btn-sm" onClick={() => props.onDownload(f)}>Download</button>
              {writable && props.onDelete ? <button type="button" className="btn-ghost btn-sm" data-testid={`team-file-delete-${f.id}`} onClick={() => setConfirm(f)}>Delete</button> : null}
            </li>
          ))}
        </ul>
      )}
      {confirm ? (
        <div className="panel stack inline-dialog" role="dialog" aria-label={`Delete ${confirm.name}`}>
          <p>Delete {confirm.name} for everyone in the team?</p>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={() => setConfirm(null)}>Cancel</button>
            <button type="button" className="btn-danger" onClick={() => { props.onDelete?.(confirm); setConfirm(null); }}>Delete</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
