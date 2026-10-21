using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Gendragoon.Sdk
{
    public sealed class ClientInfo
    {
        public string Name = "";
        public string? Host;
        public ClientInfo() { }
        public ClientInfo(string name, string? host = null) { Name = name; Host = host; }
        internal Dictionary<string, object?> ToJson() { var d = new Dictionary<string, object?> { ["name"] = Name }; if (!string.IsNullOrEmpty(Host)) d["host"] = Host; return d; }
        internal static ClientInfo FromJson(Dictionary<string, object?> d) => new ClientInfo(d.S("name"), d.TryGetValue("host", out var h) ? h as string : null);
    }

    public sealed class Connection
    {
        public string BindingId = "", ApiKey = "", KeyExpiresAt = "", WorkspaceId = "";
        public List<string> Scopes = new List<string>();
        public long QuotaBytes;
    }

    public sealed class Pkce
    {
        public string Verifier = "", Challenge = "", State = "";

        /// <summary>A fresh verifier (43 characters), its S256 challenge and a random state value.</summary>
        public static Pkce Create()
        {
            var v = Bytes.B64u(Bytes.Random(32));
            return new Pkce { Verifier = v, Challenge = ChallengeOf(v), State = Bytes.B64u(Bytes.Random(16)) };
        }
        public static string ChallengeOf(string verifier) => Bytes.B64u(Bytes.Sha256(Encoding.ASCII.GetBytes(verifier)));
    }

    /// <summary>App-side connect: a one-time connect code (gdpg_) or a connect link with PKCE (gdpc_ code plus verifier).</summary>
    public sealed class Connector : Transport
    {
        public static readonly Regex GrantRe = new Regex("^gdpg_[A-Za-z0-9_-]{43}$"), CodeRe = new Regex("^gdpc_[A-Za-z0-9_-]{43}$");
        public string Base { get; }
        public Connector(string baseUrl, ClientOptions? opts = null) : base(opts) { Base = baseUrl.TrimEnd('/'); }

        async Task<Connection> Post(string op, string path, Dictionary<string, object?> body, CancellationToken ct)
        {
            Check(op);
            var r = await Send("POST", Base + path, Encoding.UTF8.GetBytes(Json.Write(body)), new Dictionary<string, string> { ["Content-Type"] = "application/json" }, null, ct).ConfigureAwait(false);
            var d = r.Obj;
            var c = new Connection { BindingId = d.S("bindingId"), ApiKey = d.S("apiKey"), KeyExpiresAt = d.S("keyExpiresAt"), WorkspaceId = d.S("workspaceId"), QuotaBytes = d.L("quotaBytes"), Scopes = d.A("scopes").OfType<string>().ToList() };
            if (!Client.ApiKeyRe.IsMatch(c.ApiKey)) throw new InvalidOperationException("gendragoon: unexpected connect response");
            return c;
        }

        /// <summary>Exchanges a one-time connect code for an API key. Level L2, risk credential.</summary>
        public Task<Connection> RedeemGrantAsync(string grant, ClientInfo client, CancellationToken ct = default)
        {
            grant = grant.Trim();
            if (!GrantRe.IsMatch(grant)) throw new ArgumentException("gendragoon: that is not a GenDragoon connect code");
            return Post("connect.redeemGrant", "/connect/redeem", new Dictionary<string, object?> { ["grant"] = grant, ["client"] = client.ToJson() }, ct);
        }

        /// <summary>Exchanges an authorization code and the PKCE verifier for an API key. Level L2, risk credential.</summary>
        public Task<Connection> ExchangeCodeAsync(string code, string verifier, CancellationToken ct = default)
        {
            if (!CodeRe.IsMatch(code)) throw new ArgumentException("gendragoon: that is not a GenDragoon authorization code");
            return Post("connect.exchangeCode", "/connect/token", new Dictionary<string, object?> { ["code"] = code, ["codeVerifier"] = verifier }, ct);
        }

        public static bool IsLoopback(string redirect)
        {
            if (!Uri.TryCreate(redirect, UriKind.Absolute, out var u)) return false;
            if (u.Scheme != "http" || !string.IsNullOrEmpty(u.UserInfo)) return false;
            if (u.Host != "127.0.0.1" && u.Host != "[::1]") return false;
            // Uri reports the default port when none is given; require an explicit one.
            var auth = redirect.Substring(7).Split('/')[0];
            return auth.LastIndexOf(':') > auth.LastIndexOf(']');
        }

        static string Esc(string s) => Uri.EscapeDataString(s).Replace("%20", "+");

        /// <summary>The gendragoon://connect link to open. redirect must be http://127.0.0.1:&lt;port&gt;/…</summary>
        public static string ConnectLink(ClientInfo client, Pkce p, string redirect, IEnumerable<string>? scopes = null)
        {
            if (!IsLoopback(redirect)) throw new ArgumentException("gendragoon: redirect must be http://127.0.0.1:<port>/…");
            var q = new SortedDictionary<string, string>(StringComparer.Ordinal)
            {
                ["client"] = client.Name, ["scope"] = string.Join(" ", scopes ?? new[] { "blobs:rw" }), ["code_challenge"] = p.Challenge,
                ["code_challenge_method"] = "S256", ["redirect_uri"] = redirect, ["state"] = p.State,
            };
            if (!string.IsNullOrEmpty(client.Host)) q["host"] = client.Host!;
            return "gendragoon://connect?" + string.Join("&", q.Select(kv => Esc(kv.Key) + "=" + Esc(kv.Value)));
        }
    }

    /// <summary>A one-shot listener on 127.0.0.1 that receives the connect redirect and checks its state value.</summary>
    public sealed class Loopback : IDisposable
    {
        readonly TcpListener listener;
        readonly byte[] want;
        public string RedirectUri { get; }

        Loopback(TcpListener l, string state)
        {
            listener = l; want = Encoding.UTF8.GetBytes(state);
            RedirectUri = $"http://127.0.0.1:{((IPEndPoint)l.LocalEndpoint).Port}/gendragoon/callback";
        }

        public static Loopback Listen(Pkce p)
        {
            var l = new TcpListener(IPAddress.Loopback, 0);
            l.Start();
            return new Loopback(l, p.State);
        }

        static bool SameBytes(byte[] a, byte[] b)
        {
            if (a.Length != b.Length) return false;
            int d = 0; for (int i = 0; i < a.Length; i++) d |= a[i] ^ b[i];
            return d == 0;
        }

        static string Query(string q, string name)
        {
            foreach (var part in q.Split('&'))
            {
                var i = part.IndexOf('=');
                var k = Uri.UnescapeDataString((i < 0 ? part : part.Substring(0, i)).Replace('+', ' '));
                if (k == name) return i < 0 ? "" : Uri.UnescapeDataString(part.Substring(i + 1).Replace('+', ' '));
            }
            return "";
        }

        /// <summary>The authorization code; throws TimeoutException after timeout (default five minutes). Closes the listener either way.</summary>
        public async Task<string> WaitAsync(TimeSpan? timeout = null, CancellationToken ct = default)
        {
            using (var cts = CancellationTokenSource.CreateLinkedTokenSource(ct))
            using (cts.Token.Register(() => listener.Stop()))
            {
                cts.CancelAfter(timeout ?? TimeSpan.FromMinutes(5));
                try
                {
                    while (true)
                    {
                        TcpClient conn;
                        try { conn = await listener.AcceptTcpClientAsync().ConfigureAwait(false); }
                        catch (Exception) when (cts.IsCancellationRequested)
                        {
                            ct.ThrowIfCancellationRequested();
                            throw new TimeoutException("gendragoon: timed out waiting for the connect redirect");
                        }
                        using (conn)
                        {
                            var s = conn.GetStream();
                            var buf = new byte[8192]; int n = 0;
                            while (n < buf.Length)
                            {
                                var r = await s.ReadAsync(buf, n, buf.Length - n, cts.Token).ConfigureAwait(false);
                                if (r == 0) break;
                                n += r;
                                if (Encoding.ASCII.GetString(buf, 0, n).Contains("\r\n\r\n")) break;
                            }
                            var line = Encoding.ASCII.GetString(buf, 0, n).Split(new[] { "\r\n" }, StringSplitOptions.None)[0].Split(' ');
                            var target = line.Length >= 2 && line[0] == "GET" ? line[1] : "";
                            var qi = target.IndexOf('?');
                            var path = qi < 0 ? target : target.Substring(0, qi);
                            var query = qi < 0 ? "" : target.Substring(qi + 1);
                            var code = Query(query, "code");
                            bool ok = path == "/gendragoon/callback" && SameBytes(Encoding.UTF8.GetBytes(Query(query, "state")), want) && Connector.CodeRe.IsMatch(code);
                            var msg = ok ? "Connected. You can close this window and return to the app.\n" : "This link is not for this app.\n";
                            var resp = Encoding.UTF8.GetBytes($"HTTP/1.1 {(ok ? "200 OK" : "400 Bad Request")}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {Encoding.UTF8.GetByteCount(msg)}\r\nConnection: close\r\n\r\n{msg}");
                            await s.WriteAsync(resp, 0, resp.Length, cts.Token).ConfigureAwait(false);
                            if (ok) return code;
                        }
                    }
                }
                finally { listener.Stop(); }
            }
        }

        public void Dispose() => listener.Stop();
    }
}
