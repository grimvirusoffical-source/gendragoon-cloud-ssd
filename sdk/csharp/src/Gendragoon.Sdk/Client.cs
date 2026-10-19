using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Gendragoon.Sdk
{
    public sealed class ClientOptions
    {
        /// <summary>Checks every operation first. Default: Operations.LevelGate(Operations.DefaultMaxLevel).</summary>
        public Gate? Gate { get; set; }
        /// <summary>Shared HttpClient. Default: one per client that never follows redirects.</summary>
        public HttpClient? Http { get; set; }
        public string UserAgent { get; set; } = "";
    }

    internal sealed class Reply
    {
        public int Status;
        public byte[] Body = Array.Empty<byte>();
        public Dictionary<string, string> Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public string Text => Encoding.UTF8.GetString(Body);
        public Dictionary<string, object?> Obj => Json.Obj(Text);
        public string ETag => Headers.TryGetValue("ETag", out var e) ? e.Trim('"') : "";
    }

    /// <summary>The gate and HTTP transport shared by every client type.</summary>
    public abstract class Transport
    {
        public const string Version = "0.1.0";
        readonly Gate gate;
        readonly HttpClient http;
        readonly string ua;

        protected Transport(ClientOptions? opts)
        {
            gate = opts?.Gate ?? Operations.LevelGate();
            http = opts?.Http ?? new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(60) };
            ua = "gendragoon-sdk-dotnet/" + Version + (string.IsNullOrEmpty(opts?.UserAgent) ? "" : " " + opts!.UserAgent);
        }

        /// <summary>Throws LevelException if the gate refuses the operation.</summary>
        public void Check(string op) => gate(Operations.Get(op));

        internal async Task<Reply> Send(string method, string url, byte[]? body, IDictionary<string, string>? headers, string? authorization, CancellationToken ct)
        {
            using (var req = new HttpRequestMessage(new HttpMethod(method), url))
            {
                req.Headers.TryAddWithoutValidation("User-Agent", ua);
                if (authorization != null) req.Headers.TryAddWithoutValidation("Authorization", authorization);
                if (body != null) req.Content = new ByteArrayContent(body);
                if (headers != null)
                    foreach (var kv in headers)
                    {
                        if (kv.Key.Equals("Content-Type", StringComparison.OrdinalIgnoreCase)) { req.Content ??= new ByteArrayContent(Array.Empty<byte>()); req.Content.Headers.TryAddWithoutValidation(kv.Key, kv.Value); }
                        else req.Headers.TryAddWithoutValidation(kv.Key, kv.Value);
                    }
                HttpResponseMessage res;
                try { res = await http.SendAsync(req, ct).ConfigureAwait(false); }
                catch (HttpRequestException e) { throw new HttpRequestException($"gendragoon: {method} {url.Split('?')[0]}: {e.Message}"); }
                using (res)
                {
                    var r = new Reply { Status = (int)res.StatusCode, Body = await res.Content.ReadAsByteArrayAsync().ConfigureAwait(false) };
                    foreach (var h in res.Headers.Concat(res.Content.Headers)) r.Headers[h.Key] = string.Join(",", h.Value);
                    if (r.Status >= 300)
                    {
                        string code = "";
                        try { code = r.Obj.S("error"); } catch (FormatException) { }
                        int.TryParse(r.Headers.TryGetValue("Retry-After", out var ra) ? ra : "0", out var retry);
                        throw new ApiException(r.Status, code, retry);
                    }
                    return r;
                }
            }
        }
    }

    public sealed class Capabilities
    {
        public long MaxBlobBytes, MaxManifestBytes, BatchHasMax, ListMax;
        public bool ManifestCas, EventsPoll, EventsWebhook, EventsStream;
    }

    public sealed class Usage
    {
        public long UsedBytes, QuotaBytes, ObjectCount, ChangeSeq;
        public string WorkspaceId = "";
        public string? LastChangeAt;
        public long Remaining => Math.Max(0, QuotaBytes - UsedBytes);
    }

    public sealed class ListItem { public string Id = ""; public long Size; public string? Generation; }
    public sealed class ListPage { public List<ListItem> Items = new List<ListItem>(); public string? Next; }
    public sealed class PutResult { public bool Created; public string Generation = ""; }
    public sealed class Manifest { public byte[] Data = Array.Empty<byte>(); public string Generation = ""; }

    /// <summary>One binding, authenticated with its gdpk_ API key. Safe for concurrent use.</summary>
    public sealed class Client : Transport
    {
        internal static readonly Regex ApiKeyRe = new Regex("^gdpk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$");
        static readonly Regex Hex64 = new Regex("^[0-9a-f]{64}$");
        public string Base { get; }
        string key;

        public Client(string baseUrl, string apiKey, ClientOptions? opts = null) : base(opts)
        {
            if (!ApiKeyRe.IsMatch(apiKey ?? "")) throw new ArgumentException("gendragoon: malformed API key");
            Base = baseUrl.TrimEnd('/');
            key = apiKey!;
        }

        /// <summary>The key in use (after RotateApiKeyAsync, the new one).</summary>
        public string ApiKey => Volatile.Read(ref key);
        public override string ToString() => $"Client({Base})";

        internal Task<Reply> Request(string op, string method, string path, byte[]? body = null, IDictionary<string, string>? headers = null, bool auth = true, CancellationToken ct = default)
        {
            Check(op);
            return Send(method, Base + path, body, headers, auth ? "Bearer " + ApiKey : null, ct);
        }

        static void NeedHex(string id, string what) { if (!Hex64.IsMatch(id ?? "")) throw new ArgumentException($"gendragoon: {what} must be 64 lower-case hex characters"); }
        static Dictionary<string, string> Pre(Dictionary<string, string> h, bool ifAbsent, string? ifGeneration)
        {
            if (ifAbsent) h["If-None-Match"] = "*";
            else if (!string.IsNullOrEmpty(ifGeneration)) h["If-Match"] = "\"" + ifGeneration + "\"";
            return h;
        }

        public async Task<Capabilities> CapabilitiesAsync(CancellationToken ct = default)
        {
            var d = (await Request("capabilities", "GET", "/capabilities", auth: false, ct: ct).ConfigureAwait(false)).Obj;
            var e = d.O("events");
            return new Capabilities { MaxBlobBytes = d.L("maxBlobBytes"), MaxManifestBytes = d.L("maxManifestBytes"), BatchHasMax = d.L("batchHasMax"), ListMax = d.L("listMax"),
                ManifestCas = d.B("manifestCas"), EventsPoll = e.B("poll"), EventsWebhook = e.B("webhook"), EventsStream = e.B("stream") };
        }

        public Task HealthAsync(CancellationToken ct = default) => Request("health", "GET", "/health", ct: ct);

        public async Task<Usage> UsageAsync(CancellationToken ct = default)
        {
            var d = (await Request("usage", "GET", "/usage", ct: ct).ConfigureAwait(false)).Obj;
            return new Usage { UsedBytes = d.L("usedBytes"), QuotaBytes = d.L("quotaBytes"), ObjectCount = d.L("objectCount"), ChangeSeq = d.L("changeSeq"),
                WorkspaceId = d.S("workspaceId"), LastChangeAt = d.TryGetValue("lastChangeAt", out var l) ? l as string : null };
        }

        // ---- blobs ----
        /// <summary>Stores data content-addressed (id = SHA-256) and returns the id.</summary>
        public async Task<(string Id, PutResult Result)> PutBlobAsync(byte[] data, CancellationToken ct = default)
        {
            var id = Bytes.Hex(Bytes.Sha256(data));
            return (id, await PutBlobAs(id, data, "content", ct).ConfigureAwait(false));
        }

        /// <summary>Stores data under an id the caller chose (for example an HMAC of the plaintext).</summary>
        public Task<PutResult> PutSealedBlobAsync(string id, byte[] data, CancellationToken ct = default) => PutBlobAs(id, data, "sealed", ct);

        async Task<PutResult> PutBlobAs(string id, byte[] data, string mode, CancellationToken ct)
        {
            NeedHex(id, "blob id");
            var r = await Request("blobs.put", "PUT", "/blobs/" + id, data, new Dictionary<string, string> {
                ["Content-Type"] = "application/octet-stream", ["X-Id-Mode"] = mode, ["X-Content-SHA256"] = Bytes.Hex(Bytes.Sha256(data)) }, ct: ct).ConfigureAwait(false);
            return new PutResult { Created = r.Status == 201, Generation = r.ETag };
        }

        /// <summary>Reads a blob and verifies its checksum.</summary>
        public async Task<byte[]> GetBlobAsync(string id, CancellationToken ct = default)
        {
            NeedHex(id, "blob id");
            var r = await Request("blobs.get", "GET", "/blobs/" + id, ct: ct).ConfigureAwait(false);
            if (r.Headers.TryGetValue("X-Content-SHA256", out var want) && want != Bytes.Hex(Bytes.Sha256(r.Body))) throw new ChecksumException();
            return r.Body;
        }

        /// <summary>Level L2, risk destructive. Deleting a missing blob succeeds.</summary>
        public Task DeleteBlobAsync(string id, CancellationToken ct = default) { NeedHex(id, "blob id"); return Request("blobs.delete", "DELETE", "/blobs/" + id, ct: ct); }

        async Task<ListPage> List(string op, string path, string? cursor, int limit, CancellationToken ct)
        {
            var q = new List<string>();
            if (!string.IsNullOrEmpty(cursor)) q.Add("cursor=" + Uri.EscapeDataString(cursor));
            if (limit > 0) q.Add("limit=" + limit);
            var d = (await Request(op, "GET", path + (q.Count > 0 ? "?" + string.Join("&", q) : ""), ct: ct).ConfigureAwait(false)).Obj;
            var page = new ListPage { Next = d.TryGetValue("next", out var n) ? n as string : null };
            if (d.TryGetValue("items", out var items) && items is List<object?> l)
                foreach (var o in l.OfType<Dictionary<string, object?>>())
                    page.Items.Add(new ListItem { Id = o.S("id"), Size = o.L("size"), Generation = o.TryGetValue("generation", out var g) ? g as string : null });
            else
                foreach (var id in d.A("ids").OfType<string>()) page.Items.Add(new ListItem { Id = id });
            return page;
        }

        public Task<ListPage> ListBlobsAsync(string? cursor = null, int limit = 0, CancellationToken ct = default) => List("blobs.list", "/blobs", cursor, limit, ct);
        public Task<ListPage> ListManifestsAsync(string? cursor = null, int limit = 0, CancellationToken ct = default) => List("manifests.list", "/manifests", cursor, limit, ct);

        async Task<List<ListItem>> All(Func<string?, Task<ListPage>> page)
        {
            var o = new List<ListItem>(); string? cursor = null;
            do { var p = await page(cursor).ConfigureAwait(false); o.AddRange(p.Items); cursor = p.Next; } while (!string.IsNullOrEmpty(cursor));
            return o;
        }

        public Task<List<ListItem>> AllBlobsAsync(CancellationToken ct = default) => All(c => ListBlobsAsync(c, 0, ct));
        public Task<List<ListItem>> AllManifestsAsync(CancellationToken ct = default) => All(c => ListManifestsAsync(c, 0, ct));

        /// <summary>The subset of ids that exist, in input order.</summary>
        public async Task<List<string>> HasBlobsAsync(IList<string> ids, CancellationToken ct = default)
        {
            var present = new List<string>();
            for (int i = 0; i < ids.Count; i += 1000)
            {
                var body = Encoding.UTF8.GetBytes(Json.Write(new Dictionary<string, object?> { ["ids"] = ids.Skip(i).Take(1000).ToList() }));
                var r = await Request("blobs.batchHas", "POST", "/blobs/batch-has", body, new Dictionary<string, string> { ["Content-Type"] = "application/json" }, ct: ct).ConfigureAwait(false);
                present.AddRange(r.Obj.A("present").OfType<string>());
            }
            return present;
        }

        // ---- manifests ----
        public async Task<Manifest> GetManifestAsync(string key, CancellationToken ct = default)
        {
            NeedHex(key, "manifest key");
            var r = await Request("manifests.get", "GET", "/manifests/" + key, ct: ct).ConfigureAwait(false);
            return new Manifest { Data = r.Body, Generation = r.ETag };
        }

        /// <summary>Losing a compare-and-swap race throws ApiException with PreconditionFailed set.</summary>
        public async Task<PutResult> PutManifestAsync(string key, byte[] data, bool ifAbsent = false, string? ifGeneration = null, CancellationToken ct = default)
        {
            NeedHex(key, "manifest key");
            var h = Pre(new Dictionary<string, string> { ["Content-Type"] = "application/octet-stream", ["X-Content-SHA256"] = Bytes.Hex(Bytes.Sha256(data)) }, ifAbsent, ifGeneration);
            var r = await Request("manifests.put", "PUT", "/manifests/" + key, data, h, ct: ct).ConfigureAwait(false);
            return new PutResult { Created = r.Status == 201, Generation = r.ETag };
        }

        /// <summary>Level L2, risk destructive.</summary>
        public Task DeleteManifestAsync(string key, string? ifGeneration = null, CancellationToken ct = default)
        {
            NeedHex(key, "manifest key");
            return Request("manifests.delete", "DELETE", "/manifests/" + key, null, Pre(new Dictionary<string, string>(), false, ifGeneration), ct: ct);
        }

        // ---- key envelope ----
        public async Task<KeyEnvelope> GetKeyEnvelopeAsync(CancellationToken ct = default) =>
            KeyEnvelope.FromJson((await Request("keyEnvelope.get", "GET", "/key-envelope", ct: ct).ConfigureAwait(false)).Text);

        internal Task PutKeyEnvelope(string op, KeyEnvelope env, Dictionary<string, string> pre, CancellationToken ct)
        {
            env.Validate();
            pre["Content-Type"] = "application/json";
            return Request(op, "PUT", "/key-envelope", Encoding.UTF8.GetBytes(env.ToJson()), pre, ct: ct);
        }

        /// <summary>Replaces the API key (the old one works for ten more minutes) and returns the new one to store.</summary>
        public async Task<string> RotateApiKeyAsync(CancellationToken ct = default)
        {
            var k = (await Request("apiKey.rotate", "POST", "/connect/rotate", ct: ct).ConfigureAwait(false)).Obj.S("apiKey");
            if (!ApiKeyRe.IsMatch(k)) throw new InvalidOperationException("gendragoon: unexpected rotate response");
            Volatile.Write(ref key, k);
            return k;
        }

        /// <summary>Deletes every manifest and blob of this binding. Level L4, risk bulk-destructive: the default gate refuses it.</summary>
        public async Task<int> WipeAsync(CancellationToken ct = default)
        {
            Check("storage.wipe");
            int n = 0;
            foreach (var it in await AllManifestsAsync(ct).ConfigureAwait(false)) { await Request("storage.wipe", "DELETE", "/manifests/" + it.Id, ct: ct).ConfigureAwait(false); n++; }
            foreach (var it in await AllBlobsAsync(ct).ConfigureAwait(false)) { await Request("storage.wipe", "DELETE", "/blobs/" + it.Id, ct: ct).ConfigureAwait(false); n++; }
            return n;
        }
    }
}
