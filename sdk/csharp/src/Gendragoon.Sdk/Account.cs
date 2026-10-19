using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Gendragoon.Sdk
{
    public sealed class Grant { public string Code = "", ExpiresAt = ""; public long TtlSeconds; }

    public sealed class ConnectRequest
    {
        public ClientInfo Client = new ClientInfo();
        public List<string> Scopes = new List<string>();
        public string Challenge = "", RedirectUri = "", State = "";
    }

    public sealed class Binding
    {
        public string Id = "", WorkspaceId = "", CreatedAt = "";
        public string? LastUsedAt;
        public ClientInfo Client = new ClientInfo();
        public List<string> Scopes = new List<string>();
        public long UsedBytes, QuotaBytes, ObjectCount;
        public bool Active;
    }

    /// <summary>Calls of a signed-in GenDragoon user (Firebase ID token): connect codes, approving connect links and
    /// managing connected apps. They act on the person's account; a Rotten Apple app should not make them on the
    /// person's behalf (docs/LEVELS.md).</summary>
    public sealed class AccountClient : Transport
    {
        readonly Func<CancellationToken, Task<string>> token;
        public string Base { get; }

        public AccountClient(string baseUrl, Func<CancellationToken, Task<string>> idToken, ClientOptions? opts = null) : base(opts)
        {
            Base = baseUrl.TrimEnd('/'); token = idToken;
        }

        /// <summary>Validates a connect link the way GenDragoon does before showing it to the user.</summary>
        public static ConnectRequest ParseConnectLink(string link)
        {
            const string pre = "gendragoon://connect";
            if (!link.StartsWith(pre)) throw new ArgumentException("gendragoon: not a connect link");
            var rest = link.Substring(pre.Length).TrimStart('/');
            var q = rest.StartsWith("?") ? rest.Substring(1) : rest == "" ? "" : throw new ArgumentException("gendragoon: not a connect link");
            var v = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var part in q.Split(new[] { '&' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var i = part.IndexOf('=');
                string Dec(string s) => Uri.UnescapeDataString(s.Replace('+', ' '));
                var k = Dec(i < 0 ? part : part.Substring(0, i));
                if (!v.ContainsKey(k)) v[k] = i < 0 ? "" : Dec(part.Substring(i + 1));
            }
            string G(string k) => v.TryGetValue(k, out var x) ? x : "";
            var scopes = G("scope").Replace(',', ' ').Split(new[] { ' ', '\t', '\n' }, StringSplitOptions.RemoveEmptyEntries).ToList();
            var req = new ConnectRequest
            {
                Client = new ClientInfo(G("client"), G("host") == "" ? null : G("host")),
                Scopes = scopes.Count > 0 ? scopes : new List<string> { "blobs:rw" },
                Challenge = G("code_challenge"), RedirectUri = G("redirect_uri"), State = G("state"),
            };
            if (req.Client.Name == "") throw new ArgumentException("gendragoon: the app did not say who it is");
            if (G("code_challenge_method") != "S256" || req.Challenge.Length != 43) throw new ArgumentException("gendragoon: missing PKCE challenge");
            if (!Connector.IsLoopback(req.RedirectUri)) throw new ArgumentException("gendragoon: the code can only go to an app on this device");
            if (req.State == "") throw new ArgumentException("gendragoon: missing state");
            foreach (var s in req.Scopes) if (s != "blobs:rw" && s != "blobs:r") throw new ArgumentException("gendragoon: unknown scope " + s);
            return req;
        }

        async Task<Dictionary<string, object?>> Call(string op, string method, string path, Dictionary<string, object?>? body, CancellationToken ct)
        {
            Check(op);
            var tok = await token(ct).ConfigureAwait(false);
            var r = await Send(method, Base + path, body == null ? null : Encoding.UTF8.GetBytes(Json.Write(body)),
                body == null ? null : new Dictionary<string, string> { ["Content-Type"] = "application/json" }, "Bearer " + tok, ct).ConfigureAwait(false);
            return r.Status == 204 || r.Body.Length == 0 ? new Dictionary<string, object?>() : r.Obj;
        }

        /// <summary>Issues a one-time connect code for a workspace. Level L3, risk sharing.</summary>
        public async Task<Grant> CreateGrantAsync(string workspaceId, ClientInfo requester, IEnumerable<string>? scopes = null, CancellationToken ct = default)
        {
            var d = await Call("account.createGrant", "POST", "/connect/grants", new Dictionary<string, object?> {
                ["workspaceId"] = workspaceId, ["scopes"] = (scopes ?? new[] { "blobs:rw" }).ToList(), ["requester"] = requester.ToJson() }, ct).ConfigureAwait(false);
            var g = new Grant { Code = d.S("grant"), ExpiresAt = d.S("expiresAt"), TtlSeconds = d.L("ttlSeconds") };
            if (!Connector.GrantRe.IsMatch(g.Code)) throw new InvalidOperationException("gendragoon: unexpected grant response");
            return g;
        }

        /// <summary>Approves a connect link; returns the loopback redirect (with code and state) to open. Level L3, risk sharing.</summary>
        public async Task<string> AuthorizeAsync(string workspaceId, ConnectRequest req, CancellationToken ct = default)
        {
            var d = await Call("account.authorize", "POST", "/connect/authorize", new Dictionary<string, object?> {
                ["workspaceId"] = workspaceId, ["scopes"] = req.Scopes, ["requester"] = req.Client.ToJson(), ["codeChallenge"] = req.Challenge, ["codeChallengeMethod"] = "S256" }, ct).ConfigureAwait(false);
            var code = d.S("code");
            if (!Connector.CodeRe.IsMatch(code)) throw new InvalidOperationException("gendragoon: unexpected authorize response");
            var sep = req.RedirectUri.Contains("?") ? "&" : "?";
            return req.RedirectUri + sep + "code=" + Uri.EscapeDataString(code) + "&state=" + Uri.EscapeDataString(req.State);
        }

        /// <summary>The account's connected apps. Level L2, risk read.</summary>
        public async Task<List<Binding>> ListBindingsAsync(CancellationToken ct = default)
        {
            var d = await Call("account.listBindings", "GET", "/bindings", null, ct).ConfigureAwait(false);
            return d.A("bindings").OfType<Dictionary<string, object?>>().Select(b => new Binding
            {
                Id = b.S("id"), WorkspaceId = b.S("workspaceId"), CreatedAt = b.S("createdAt"), LastUsedAt = b.TryGetValue("lastUsedAt", out var l) ? l as string : null,
                Client = ClientInfo.FromJson(b.O("client")), Scopes = b.A("scopes").OfType<string>().ToList(),
                UsedBytes = b.L("usedBytes"), QuotaBytes = b.L("quotaBytes"), ObjectCount = b.L("objectCount"), Active = b.B("active"),
            }).ToList();
        }

        /// <summary>Disconnects an app at once; its data is kept. Level L3, risk sharing.</summary>
        public Task RevokeBindingAsync(string id, CancellationToken ct = default) =>
            Call("account.revokeBinding", "DELETE", "/bindings/" + Uri.EscapeDataString(id), null, ct);

        /// <summary>Disconnects an app and deletes everything it stored. Level L4, risk bulk-destructive: the default gate refuses it.</summary>
        public async Task<long> RevokeAndDeleteAsync(string id, CancellationToken ct = default) =>
            (await Call("account.revokeAndDelete", "DELETE", "/bindings/" + Uri.EscapeDataString(id) + "?deleteData=true", null, ct).ConfigureAwait(false)).L("purgedObjects");
    }
}
