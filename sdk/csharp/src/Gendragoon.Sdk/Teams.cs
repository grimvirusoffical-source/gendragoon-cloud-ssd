using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Gendragoon.Sdk
{
    using JObj = Dictionary<string, object?>;

    public sealed class TeamMember
    {
        public string MemberId = "", DisplayName = "", Color = "", ColorHex = "", Role = "";
        public bool Muted;
        /// <summary>End of the mute, or null while muted until lifted.</summary>
        public DateTimeOffset? MutedUntil;
        public string? MuteReason;
        internal static TeamMember From(JObj d)
        {
            var m = new TeamMember { MemberId = d.S("memberId"), DisplayName = d.S("displayName"), Color = d.S("color"), ColorHex = d.S("colorHex"), Role = d.S("role") };
            if (d.TryGetValue("muted", out var mu) && mu is JObj mo)
            {
                m.Muted = true;
                m.MuteReason = mo.TryGetValue("reason", out var r) ? r as string : null;
                if (mo.TryGetValue("until", out var u) && u != null) m.MutedUntil = DateTimeOffset.FromUnixTimeMilliseconds(mo.L("until"));
            }
            return m;
        }
    }

    public sealed class Team
    {
        public string Id = "", Name = "", Tier = "", Interval = "", SubscriptionStatus = "", Role = "";
        public int MemberLimit, MemberCount;
        public long PriceCents;
        public bool SubscriptionActive;
        public TeamMember Me = new TeamMember();
        public List<TeamMember> Members = new List<TeamMember>();
        public JObj Raw = new JObj();
        internal static Team From(JObj d) => new Team
        {
            Id = d.S("id"), Name = d.S("name"), Tier = d.S("tier"), Interval = d.S("interval"), SubscriptionStatus = d.S("subscriptionStatus"), Role = d.S("role"),
            MemberLimit = (int)d.L("memberLimit"), MemberCount = (int)d.L("memberCount"), PriceCents = d.L("priceCents"), SubscriptionActive = d.B("subscriptionActive"),
            Me = TeamMember.From(d.O("me")), Members = d.A("members").OfType<JObj>().Select(TeamMember.From).ToList(), Raw = d,
        };
    }

    public sealed class MemberColor { public string Id = "", Hue = "", Hex = ""; public bool Taken; }

    /// <summary>Result of a call that may need payment: open <see cref="Url"/> when it is set.</summary>
    public sealed class Checkout
    {
        public string? Url, CheckoutError;
        public long TotalCents;
        public bool Resumed, AlreadyActivated, Complimentary;
        internal static Checkout From(JObj d) => new Checkout
        {
            Url = d.S("url") == "" ? null : d.S("url"), CheckoutError = d.S("checkoutError") == "" ? null : d.S("checkoutError"),
            TotalCents = d.L("totalCents"), Resumed = d.B("resumed"), AlreadyActivated = d.B("alreadyActivated"), Complimentary = d.B("complimentary"),
        };
    }

    public sealed class Invite { public string Code = "", InviteId = "", Link = ""; public long ExpiresAtMs; public int MaxUses; }

    public sealed class InvitePreview
    {
        public string TeamName = "";
        public int MemberCount, MemberLimit;
        public List<MemberColor> MemberColors = new List<MemberColor>();
    }

    public sealed class TeamWorkspace
    {
        public string Id = "", TeamId = "", Name = "", PlansStatus = "", ProjectStatus = "", Access = "";
        public bool CustomStorage, NeedsCustomSetup;
        public double QuotaGB;
        public long UsedBytes;
        /// <summary>The file routes for this workspace ("v3": /v3/cloud/&lt;id&gt;, "v2": /v2/workspaces/&lt;id&gt;/cloud), or null for custom storage.</summary>
        public Dictionary<string, string>? StorageRoutes;
        public JObj Raw = new JObj();
        internal static TeamWorkspace From(JObj d) => new TeamWorkspace
        {
            Id = d.S("id"), TeamId = d.S("teamId"), Name = d.S("name"), PlansStatus = d.S("plansStatus"), ProjectStatus = d.S("projectStatus"), Access = d.S("access"),
            CustomStorage = d.B("customStorage"), NeedsCustomSetup = d.B("needsCustomSetup"), UsedBytes = d.L("usedBytes"),
            QuotaGB = d.TryGetValue("quotaGB", out var q) ? Convert.ToDouble(q ?? 0) : 0,
            StorageRoutes = d.TryGetValue("storageRoutes", out var r) && r is JObj ro ? ro.ToDictionary(kv => kv.Key, kv => kv.Value as string ?? "") : null,
            Raw = d,
        };
    }

    public sealed class SharedWorkspace { public string Id = "", Name = "", SharedByMemberId = "", SharedByName = "", Permission = ""; public bool Mine; }

    public sealed class TeamWorkspaces
    {
        public List<TeamWorkspace> Team = new List<TeamWorkspace>();
        public List<SharedWorkspace> Shared = new List<SharedWorkspace>();
        public bool SubscriptionActive;
    }

    public sealed class ChatMessage
    {
        public long Seq;
        public string Kind = "", Text = "";
        public string? CardScope, CardWorkspaceId, CardName, RemovedReason;
        public JObj Raw = new JObj();
        internal static ChatMessage From(JObj d)
        {
            var m = new ChatMessage { Seq = d.L("seq"), Kind = d.S("kind"), Text = d.S("text"), Raw = d };
            if (d.TryGetValue("card", out var c) && c is JObj co) { m.CardScope = co.S("scope"); m.CardWorkspaceId = co.S("workspaceId"); m.CardName = co.S("name"); }
            if (d.TryGetValue("removed", out var r) && r is JObj ro) m.RemovedReason = ro.S("reason");
            return m;
        }
    }

    public sealed class ChatPage { public List<ChatMessage> Messages = new List<ChatMessage>(); public long LatestSeq; public int PollAfterMs; }

    public sealed class AuditEntry
    {
        public long Seq, AtMs;
        public long? UntilMs;
        public string Prev = "", Hash = "", Action = "", Actor = "", Source = "";
        public string? Target, Reason, Rule;
    }

    /// <summary>Teams calls of a signed-in GenDragoon user (/v2/teams on the API origin, Firebase ID token). The server
    /// refuses gdsk_ API keys for teams and team workspaces. Calls that start a subscription return a Stripe Checkout URL
    /// for the person to open; the SDK never completes a payment. Levels are listed in docs/LEVELS.md.</summary>
    public sealed class TeamsClient : Transport
    {
        static readonly Regex Uuid = new Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
        static readonly Regex Hex64 = new Regex("^[0-9a-f]{64}$");
        readonly Func<CancellationToken, Task<string>> token;
        public string Origin { get; }

        /// <param name="origin">The GenDragoon API origin.</param>
        /// <param name="idToken">Returns a current Firebase ID token.</param>
        /// <param name="opts">Gate, HTTP client and user agent.</param>
        public TeamsClient(string origin, Func<CancellationToken, Task<string>> idToken, ClientOptions? opts = null) : base(opts)
        {
            Origin = origin.TrimEnd('/'); token = idToken;
        }

        static string Seg(object v)
        {
            var s = Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture) ?? "";
            if (s.Length == 0 || s.Length > 128 || s.IndexOfAny(new[] { '/', '?', '#' }) >= 0) throw new ArgumentException("gendragoon: invalid id " + s);
            return Uri.EscapeDataString(s);
        }

        static void Intent(string id) { if (!Uuid.IsMatch(id ?? "")) throw new ArgumentException("gendragoon: intentId must be a UUID"); }

        async Task<JObj> Call(string op, string method, string path, JObj? body, CancellationToken ct)
        {
            Check(op);
            var tok = await token(ct).ConfigureAwait(false);
            var r = await Send(method, Origin + "/v2/teams" + path, body == null ? null : Encoding.UTF8.GetBytes(Json.Write(body)),
                body == null ? null : new Dictionary<string, string> { ["Content-Type"] = "application/json" }, "Bearer " + tok, ct).ConfigureAwait(false);
            return r.Status == 204 || r.Body.Length == 0 ? new JObj() : r.Obj;
        }

        static List<MemberColor> Colors(JObj colors) => colors.A("memberColors").OfType<JObj>()
            .Select(c => new MemberColor { Id = c.S("id"), Hue = c.S("hue"), Hex = c.S("hex"), Taken = c.B("taken") }).ToList();

        /// <summary>Team tiers, the Enterprise contact and the color palette. Level L2, risk read.</summary>
        public Task<JObj> CatalogAsync(CancellationToken ct = default) => Call("teams.catalog", "GET", "/catalog", null, ct);

        /// <summary>Teams the account belongs to. Level L2, risk read.</summary>
        public async Task<List<Team>> ListAsync(CancellationToken ct = default) =>
            (await Call("teams.list", "GET", "", null, ct).ConfigureAwait(false)).A("teams").OfType<JObj>().Select(Team.From).ToList();

        /// <summary>Creates a team and opens its subscription checkout. Reuse <paramref name="intentId"/> on retry.
        /// <paramref name="tier"/> is team, team_plus or business. Level L3, risk billing.</summary>
        public async Task<(Team Team, Checkout Checkout)> CreateAsync(string intentId, string name, string tier, string interval = "month", string? ownerShade = null, CancellationToken ct = default)
        {
            Intent(intentId);
            var body = new JObj { ["intentId"] = intentId, ["name"] = name, ["tier"] = tier, ["interval"] = interval };
            if (ownerShade != null) body["ownerShade"] = ownerShade;
            var d = await Call("teams.create", "POST", "", body, ct).ConfigureAwait(false);
            return (Team.From(d.O("team")), Checkout.From(d));
        }

        /// <summary>A team with its members and the member colors. Level L2, risk read.</summary>
        public async Task<(Team Team, List<MemberColor> Colors)> GetAsync(string teamId, CancellationToken ct = default)
        {
            var d = await Call("teams.get", "GET", "/" + Seg(teamId), null, ct).ConfigureAwait(false);
            return (Team.From(d.O("team")), Colors(d.O("colors")));
        }

        /// <summary>Resumes or replaces the team subscription checkout. Level L3, risk billing.</summary>
        public async Task<Checkout> CheckoutAsync(string teamId, string? tier = null, string? interval = null, CancellationToken ct = default)
        {
            var body = new JObj();
            if (tier != null) body["tier"] = tier;
            if (interval != null) body["interval"] = interval;
            return Checkout.From(await Call("teams.checkout", "POST", "/" + Seg(teamId) + "/checkout", body, ct).ConfigureAwait(false));
        }

        /// <summary>Creates an invite code (owner); the code is shown once. Level L3, risk sharing.</summary>
        public async Task<Invite> CreateInviteAsync(string teamId, int expiresInHours = 0, int maxUses = 0, CancellationToken ct = default)
        {
            var body = new JObj();
            if (expiresInHours > 0) body["expiresInHours"] = expiresInHours;
            if (maxUses > 0) body["maxUses"] = maxUses;
            var d = await Call("teams.createInvite", "POST", "/" + Seg(teamId) + "/invites", body, ct).ConfigureAwait(false);
            return new Invite { Code = d.S("code"), InviteId = d.S("inviteId"), Link = d.S("link"), ExpiresAtMs = d.L("expiresAtMs"), MaxUses = (int)d.L("maxUses") };
        }

        /// <summary>Revokes an invite code (owner). Level L3, risk sharing.</summary>
        public Task RevokeInviteAsync(string teamId, string inviteId, CancellationToken ct = default) =>
            Call("teams.revokeInvite", "POST", "/" + Seg(teamId) + "/invites/" + Seg(inviteId) + "/revoke", new JObj(), ct);

        /// <summary>Team name, size and free colors for an invite code. Level L2, risk read.</summary>
        public async Task<InvitePreview> PreviewInviteAsync(string code, CancellationToken ct = default)
        {
            var d = await Call("teams.previewInvite", "POST", "/join/preview", new JObj { ["code"] = code }, ct).ConfigureAwait(false);
            return new InvitePreview { TeamName = d.S("teamName"), MemberCount = (int)d.L("memberCount"), MemberLimit = (int)d.L("memberLimit"), MemberColors = Colors(d.O("colors")) };
        }

        /// <summary>Joins a team with an invite code and a free member color. Level L3, risk sharing.</summary>
        public async Task<(string TeamId, bool AlreadyMember)> JoinAsync(string code, string color, string? displayName = null, string? deviceName = null, CancellationToken ct = default)
        {
            var body = new JObj { ["code"] = code, ["color"] = color };
            if (displayName != null) body["displayName"] = displayName;
            if (deviceName != null) body["deviceName"] = deviceName;
            var d = await Call("teams.join", "POST", "/join", body, ct).ConfigureAwait(false);
            return (d.S("teamId"), d.B("alreadyMember"));
        }

        /// <summary>Changes your display name or color in a team. Level L2, risk write.</summary>
        public Task UpdateMeAsync(string teamId, string? displayName = null, string? color = null, CancellationToken ct = default)
        {
            var body = new JObj();
            if (displayName != null) body["displayName"] = displayName;
            if (color != null) body["color"] = color;
            return Call("teams.updateMe", "PATCH", "/" + Seg(teamId) + "/me", body, ct);
        }

        /// <summary>Leaves a team; your shared personal workspaces are unshared. Level L3, risk destructive.</summary>
        public Task LeaveAsync(string teamId, CancellationToken ct = default) => Call("teams.leave", "POST", "/" + Seg(teamId) + "/leave", new JObj(), ct);

        /// <summary>Team workspaces (files over StorageRoutes) and shared personal workspaces. Level L2, risk read.</summary>
        public async Task<TeamWorkspaces> WorkspacesAsync(string teamId, CancellationToken ct = default)
        {
            var d = await Call("teams.workspaces", "GET", "/" + Seg(teamId) + "/workspaces", null, ct).ConfigureAwait(false);
            return new TeamWorkspaces
            {
                Team = d.A("teamWorkspaces").OfType<JObj>().Select(TeamWorkspace.From).ToList(),
                Shared = d.A("sharedWorkspaces").OfType<JObj>().Select(s => new SharedWorkspace
                {
                    Id = s.S("id"), Name = s.S("name"), SharedByMemberId = s.O("sharedBy").S("memberId"), SharedByName = s.O("sharedBy").S("displayName"),
                    Permission = s.S("permission"), Mine = s.B("mine"),
                }).ToList(),
                SubscriptionActive = d.B("subscriptionActive"),
            };
        }

        /// <summary>Creates a team workspace and opens its plans checkout (owner). <paramref name="plans"/> carries the plan
        /// ids, for example storageTier and performanceTier. Level L3, risk billing.</summary>
        public async Task<(TeamWorkspace Workspace, Checkout Checkout)> CreateWorkspaceAsync(string teamId, string intentId, string name, IDictionary<string, object?> plans, string storage = "managed", CancellationToken ct = default)
        {
            Intent(intentId);
            var d = await Call("teams.createWorkspace", "POST", "/" + Seg(teamId) + "/workspaces",
                new JObj { ["intentId"] = intentId, ["name"] = name, ["storage"] = storage, ["plans"] = new JObj(plans) }, ct).ConfigureAwait(false);
            return (TeamWorkspace.From(d.O("workspace")), Checkout.From(d));
        }

        /// <summary>Resumes a team workspace's plans checkout (owner). Level L3, risk billing.</summary>
        public async Task<Checkout> CheckoutWorkspaceAsync(string teamId, string workspaceId, CancellationToken ct = default) =>
            Checkout.From(await Call("teams.checkoutWorkspace", "POST", "/" + Seg(teamId) + "/workspaces/" + Seg(workspaceId) + "/checkout", new JObj(), ct).ConfigureAwait(false));

        /// <summary>Shows one of your personal workspaces to the team, view only. Level L3, risk sharing.</summary>
        public Task ShareAsync(string teamId, string workspaceId, CancellationToken ct = default) =>
            Call("teams.share", "POST", "/" + Seg(teamId) + "/shares", new JObj { ["workspaceId"] = workspaceId }, ct);

        /// <summary>Stops showing a personal workspace to the team. Level L3, risk sharing.</summary>
        public Task UnshareAsync(string teamId, string workspaceId, CancellationToken ct = default) =>
            Call("teams.unshare", "DELETE", "/" + Seg(teamId) + "/shares/" + Seg(workspaceId), null, ct);

        /// <summary>Chat messages above <paramref name="after"/> (0 for the latest page). Level L2, risk read.</summary>
        public async Task<ChatPage> MessagesAsync(string teamId, long after = 0, int limit = 0, CancellationToken ct = default)
        {
            var q = "?after=" + after + (limit > 0 ? "&limit=" + limit : "");
            var d = await Call("teams.chat.list", "GET", "/" + Seg(teamId) + "/chat" + q, null, ct).ConfigureAwait(false);
            return new ChatPage { Messages = d.A("messages").OfType<JObj>().Select(ChatMessage.From).ToList(), LatestSeq = d.L("latestSeq"), PollAfterMs = (int)d.L("pollAfterMs") };
        }

        /// <summary>Yields new chat messages until cancelled or you lose access to the team. Polls every pollAfterMs (the
        /// server also offers Server-Sent Events at /chat/stream; this SDK polls). Level L2, risk read.</summary>
        public async IAsyncEnumerable<ChatMessage> WatchChatAsync(string teamId, long after = 0, TimeSpan? interval = null, [EnumeratorCancellation] CancellationToken ct = default)
        {
            Check("teams.chat.watch");
            var wait = TimeSpan.FromSeconds(3);
            while (!ct.IsCancellationRequested)
            {
                ChatPage? p = null;
                try { p = await MessagesAsync(teamId, after, 100, ct).ConfigureAwait(false); }
                catch (ApiException e) when (e.Status == 401 || e.Status == 403 || e.Status == 404) { yield break; }
                catch (Exception e) when (!(e is OperationCanceledException) && !(e is LevelException)) { }
                if (p != null)
                {
                    foreach (var m in p.Messages) if (m.Seq > after) { after = m.Seq; yield return m; }
                    if (p.PollAfterMs > 0) wait = TimeSpan.FromMilliseconds(p.PollAfterMs);
                }
                var delay = interval.HasValue && interval.Value > wait ? interval.Value : wait;
                try { await Task.Delay(delay, ct).ConfigureAwait(false); } catch (OperationCanceledException) { yield break; }
            }
        }

        /// <summary>Posts a text message. Level L2, risk write.</summary>
        public async Task<ChatMessage> PostAsync(string teamId, string text, CancellationToken ct = default) =>
            ChatMessage.From((await Call("teams.chat.post", "POST", "/" + Seg(teamId) + "/chat", new JObj { ["text"] = text }, ct).ConfigureAwait(false)).O("message"));

        /// <summary>Posts a workspace card (<paramref name="scope"/> team or personal). A personal-workspace card also shares
        /// it with the team, so it needs the sharing level too. Level L2, risk write.</summary>
        public async Task<ChatMessage> PostCardAsync(string teamId, string scope, string workspaceId, string text = "", CancellationToken ct = default)
        {
            if (scope == "personal") Check("teams.share");
            var d = await Call("teams.chat.post", "POST", "/" + Seg(teamId) + "/chat",
                new JObj { ["text"] = text, ["card"] = new JObj { ["scope"] = scope, ["workspaceId"] = workspaceId } }, ct).ConfigureAwait(false);
            return ChatMessage.From(d.O("message"));
        }

        /// <summary>Reports a message (spam, abuse, harassment, illegal or other). Level L2, risk write.</summary>
        public Task ReportAsync(string teamId, long seq, string category, string note = "", CancellationToken ct = default) =>
            Call("teams.chat.report", "POST", "/" + Seg(teamId) + "/chat/" + seq + "/report", new JObj { ["category"] = category, ["note"] = note }, ct);

        /// <summary>Removes a message (owner; reason required). Level L3, risk destructive.</summary>
        public Task DeleteMessageAsync(string teamId, long seq, string reason, CancellationToken ct = default) =>
            Call("teams.chat.delete", "POST", "/" + Seg(teamId) + "/chat/" + seq + "/delete", new JObj { ["reason"] = reason }, ct);

        Task Moderate(string action, string teamId, string memberId, string reason, DateTimeOffset? until, CancellationToken ct)
        {
            var body = new JObj { ["reason"] = reason };
            if (until.HasValue) body["until"] = until.Value.ToUnixTimeMilliseconds();
            return Call("teams.members." + action, "POST", "/" + Seg(teamId) + "/members/" + Seg(memberId) + "/" + action, body, ct);
        }

        /// <summary>Mutes a member until a time, or until lifted when null (owner; reason required). Level L3, risk destructive.</summary>
        public Task MuteAsync(string teamId, string memberId, string reason, DateTimeOffset? until = null, CancellationToken ct = default) => Moderate("mute", teamId, memberId, reason, until, ct);
        /// <summary>Lifts a mute (owner). Level L3, risk write.</summary>
        public Task UnmuteAsync(string teamId, string memberId, string reason = "", CancellationToken ct = default) => Moderate("unmute", teamId, memberId, reason, null, ct);
        /// <summary>Removes a member; they can rejoin with a new invite (owner; reason required). Level L3, risk destructive.</summary>
        public Task KickAsync(string teamId, string memberId, string reason, CancellationToken ct = default) => Moderate("kick", teamId, memberId, reason, null, ct);
        /// <summary>Removes a member and blocks rejoining until a time, or for good when null (owner; reason required). Level L3, risk destructive.</summary>
        public Task BanAsync(string teamId, string memberId, string reason, DateTimeOffset? until = null, CancellationToken ct = default) => Moderate("ban", teamId, memberId, reason, until, ct);

        /// <summary>Makes a member a "viewer" (read team files) or a "member" (read and write) (owner). Level L3, risk sharing.</summary>
        public Task SetRoleAsync(string teamId, string memberId, string role, CancellationToken ct = default)
        {
            if (role != "viewer" && role != "member") throw new ArgumentException("gendragoon: role must be \"viewer\" or \"member\"");
            return Call("teams.members.setRole", "POST", "/" + Seg(teamId) + "/members/" + Seg(memberId) + "/role", new JObj { ["role"] = role }, ct);
        }

        /// <summary>The team's hash-chained audit log, oldest first (owner). Level L2, risk read.</summary>
        public async Task<List<AuditEntry>> AuditAsync(string teamId, CancellationToken ct = default)
        {
            var d = await Call("teams.audit", "GET", "/" + Seg(teamId) + "/audit", null, ct).ConfigureAwait(false);
            string? N(JObj e, string k) => e.TryGetValue(k, out var v) ? v as string : null;
            return d.A("entries").OfType<JObj>().Select(e => new AuditEntry
            {
                Seq = e.L("seq"), AtMs = e.L("atMs"), UntilMs = e.TryGetValue("untilMs", out var u) && u != null ? e.L("untilMs") : (long?)null,
                Prev = e.S("prev"), Hash = e.S("hash"), Action = e.S("action"), Actor = e.S("actor"), Source = e.S("source"),
                Target = N(e, "target"), Reason = N(e, "reason"), Rule = N(e, "rule"),
            }).ToList();
        }

        /// <summary>Checks that audit entries are consecutive and each links to the previous hash. The digests themselves
        /// are recomputed by the server.</summary>
        public static bool VerifyAuditChain(IReadOnlyList<AuditEntry> entries)
        {
            var prev = new string('0', 64);
            for (int i = 0; i < entries.Count; i++)
            {
                var e = entries[i];
                if (e.Seq != i + 1 || e.Prev != prev || !Hex64.IsMatch(e.Hash)) return false;
                prev = e.Hash;
            }
            return true;
        }

        /// <summary>Hands the team to another member (owner). Level L4, risk sharing: the default gate refuses it.</summary>
        public Task TransferAsync(string teamId, string memberId, string color, string? ownerShade = null, CancellationToken ct = default)
        {
            var body = new JObj { ["memberId"] = memberId, ["color"] = color };
            if (ownerShade != null) body["ownerShade"] = ownerShade;
            return Call("teams.transfer", "POST", "/" + Seg(teamId) + "/transfer", body, ct);
        }

        /// <summary>Deletes the team, its chat and its team workspaces with their files (owner). Level L4, risk bulk-destructive:
        /// the default gate refuses it.</summary>
        public Task DeleteAsync(string teamId, string confirmName, CancellationToken ct = default) =>
            Call("teams.delete", "POST", "/" + Seg(teamId) + "/delete", new JObj { ["confirmName"] = confirmName }, ct);
    }
}
