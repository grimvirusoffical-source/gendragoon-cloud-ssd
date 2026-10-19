using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Gendragoon.Sdk.Tests
{
    /// <summary>The shared contract suite (sdk/spec/CONTRACT.md) against a local backend.</summary>
    static class Contract
    {
        public static string? Base;
        const string Pass = "contract passphrase";
        static string B => Base!;
        static string Uid() => "u" + Bytes.Hex(Bytes.Random(6));
        static AccountClient Account(string user, ClientOptions? o = null) => new AccountClient(B, _ => Task.FromResult("dev-user:" + user), o);

        sealed class Rig
        {
            public AccountClient Acct = null!; public Connection Conn = null!; public Client Client = null!; public Keyring Keys = null!;
            public static async Task<Rig> Create(string workspace, ClientOptions? o = null)
            {
                var r = new Rig { Acct = Account(Uid()) };
                var g = await r.Acct.CreateGrantAsync(workspace, new ClientInfo(".NET contract", "test"));
                r.Conn = await new Connector(B, o).RedeemGrantAsync(g.Code, new ClientInfo(".NET contract"));
                r.Client = new Client(B, r.Conn.ApiKey, o);
                r.Keys = new Keyring(r.Client);
                return r;
            }
        }

        static ClientOptions Max(Level l) => new ClientOptions { Gate = Operations.LevelGate(l) };

        [Test(NeedsServer = true)]
        static async Task C01_ConnectWithGrant()
        {
            var r = await Rig.Create("ws");
            await r.Client.HealthAsync();
            var caps = await r.Client.CapabilitiesAsync();
            Assert.True(caps.EventsPoll && !caps.EventsWebhook && caps.MaxBlobBytes == 16 << 20, "capabilities");
            var e = await Assert.ThrowsAsync<ApiException>(() => new Connector(B).RedeemGrantAsync("gdpg_" + new string('A', 43), new ClientInfo("x")));
            Assert.Equal("invalid_grant", e.Code);
        }

        [Test(NeedsServer = true)]
        static async Task C02_ConnectWithPkce()
        {
            var acct = Account(Uid());
            var p = Pkce.Create();
            var req = AccountClient.ParseConnectLink(Connector.ConnectLink(new ClientInfo(".NET contract"), p, "http://127.0.0.1:9/cb"));
            var redirect = new Uri(await acct.AuthorizeAsync("ws", req));
            var q = redirect.Query.TrimStart('?').Split('&').Select(x => x.Split('=')).ToDictionary(x => x[0], x => Uri.UnescapeDataString(x[1]));
            Assert.Equal(p.State, q["state"]);
            var k = new Connector(B);
            await Assert.ThrowsAsync<ApiException>(() => k.ExchangeCodeAsync(q["code"], Pkce.Create().Verifier));
            Assert.Equal("ws", (await k.ExchangeCodeAsync(q["code"], p.Verifier)).WorkspaceId);
        }

        [Test(NeedsServer = true)]
        static async Task C03_MasterKeyLifecycle()
        {
            var r = await Rig.Create("ws");
            await r.Keys.CreateAsync(Pass);
            var e = await Assert.ThrowsAsync<ApiException>(() => new Keyring(r.Client).CreateAsync(Pass));
            Assert.True(e.PreconditionFailed, "second create is refused");
            var k2 = new Keyring(r.Client);
            await Assert.ThrowsAsync<WrongPassphraseException>(() => k2.UnlockAsync("not the passphrase"));
            await r.Keys.ChangePassphraseAsync("a brand new passphrase");
            await k2.UnlockAsync("a brand new passphrase");
            Assert.Throws<LevelException>(() => r.Keys.ExportMasterKey());
        }

        [Test(NeedsServer = true)]
        static async Task C04_EncryptedFilesAndFolders()
        {
            var r = await Rig.Create("ws");
            await r.Keys.CreateAsync(Pass);
            var d = new Drive(r.Client, "saves", r.Keys, chunkSize: 1024);
            var data = Bytes.Random(5000);
            await d.MkdirAsync("levels/1");
            Assert.Equal(5, (await d.WriteFileAsync("slots/slot1.sav", data)).Chunks.Count);
            Assert.Equal(Bytes.Hex(data), Bytes.Hex(await d.ReadFileAsync("slots/slot1.sav")));
            var ls = await d.ListAsync("");
            Assert.Equal("levels:True,slots:True", string.Join(",", ls.Select(x => x.Name + ":" + x.Folder)));
            await d.MoveAsync("slots/slot1.sav", "slots/slot2.sav");
            await d.StatAsync("slots/slot2.sav");
            Assert.True((await Assert.ThrowsAsync<InvalidOperationException>(() => d.DeleteAsync("levels"))).Message.Contains("not empty"));
            Assert.Equal(0, await d.DeleteFolderAsync("levels"));
            await d.DeleteAsync("slots/slot2.sav");
            Assert.True((await Assert.ThrowsAsync<ApiException>(() => d.ReadFileAsync("slots/slot2.sav"))).NotFound);
            var probe = Bytes.Hex(Bytes.Slice(data, 0, 64));
            foreach (var b in await r.Client.AllBlobsAsync())
                Assert.True(!Bytes.Hex(await r.Client.GetBlobAsync(b.Id)).Contains(probe), "no plaintext on the server");
        }

        [Test(NeedsServer = true)]
        static async Task C05_PlainDrive()
        {
            var r = await Rig.Create("ws");
            var d = new Drive(r.Client, "public", null, plain: true);
            await d.WriteFileAsync("readme.txt", Encoding.ASCII.GetBytes("hello"));
            var e = await d.StatAsync("readme.txt");
            Assert.Equal("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", e.Chunks[0]);
            Assert.True(e.Key == null, "plain entries carry no key");
        }

        [Test(NeedsServer = true)]
        static async Task C06_ConcurrentWriters()
        {
            var r = await Rig.Create("ws");
            await r.Keys.CreateAsync(Pass);
            await Task.WhenAll(Enumerable.Range(0, 2).Select(w => Task.Run(async () =>
            {
                var d = new Drive(r.Client, "shared", r.Keys);
                for (int i = 0; i < 10; i++) await d.WriteFileAsync($"w{w}/f{i}", new[] { (byte)i });
            })));
            Assert.Equal(20, (await new Drive(r.Client, "shared", r.Keys).SnapshotAsync()).Files.Count);
        }

        [Test(NeedsServer = true)]
        static async Task C07_Quota()
        {
            var r = await Rig.Create("small");
            var e = await Assert.ThrowsAsync<ApiException>(() => new Drive(r.Client, "big", null, plain: true).WriteFileAsync("too-big.bin", new byte[100 << 10]));
            Assert.True(e.QuotaExceeded, "quota exceeded");
            var u = await r.Client.UsageAsync();
            Assert.True(u.QuotaBytes == 64 << 10 && u.UsedBytes <= u.QuotaBytes, "usage within quota");
        }

        [Test(NeedsServer = true)]
        static async Task C08_Gate()
        {
            var r = await Rig.Create("ws", Max(Level.L2));
            var e = await Assert.ThrowsAsync<LevelException>(() => new Drive(r.Client, "x", null, plain: true).DeleteFolderAsync("a"));
            Assert.Equal("files.deleteFolder", e.Operation.Id); Assert.Equal(Level.L3, e.Operation.Level);
            await Assert.ThrowsAsync<LevelException>(() => r.Client.WipeAsync());
            var d = new Drive(r.Client, "x", null, plain: true);
            foreach (var (name, call) in new (string, Func<Task>)[] {
                ("files.delete", () => d.DeleteAsync("a.txt")),
                ("blobs.delete", () => r.Client.DeleteBlobAsync(new string('0', 64))),
                ("manifests.delete", () => r.Client.DeleteManifestAsync(d.ManifestKey)),
                ("keyEnvelope.replace", () => r.Keys.ChangePassphraseAsync("new passphrase")) })
            {
                var le = await Assert.ThrowsAsync<LevelException>(call);
                Assert.True(le.Operation.Id == name && le.Operation.Level == Level.L3, name + " refused at L2");
            }
        }

        // What the Unity component does on a fresh binding at its default level (L2).
        [Test(NeedsServer = true)]
        static async Task C15_CloudSaveAtL2()
        {
            var r = await Rig.Create("ws", Max(Level.L2));
            Assert.True((await Assert.ThrowsAsync<ApiException>(() => r.Keys.UnlockAsync("slot passphrase"))).NotFound, "no key before the first save");
            await r.Keys.CreateAsync("slot passphrase");
            Assert.True((await Assert.ThrowsAsync<ApiException>(() => new Keyring(r.Client).CreateAsync("other passphrase"))).PreconditionFailed, "second create");
            Assert.Equal("keyEnvelope.replace", (await Assert.ThrowsAsync<LevelException>(() => r.Keys.ChangePassphraseAsync("new passphrase"))).Operation.Id);
            var d = new Drive(r.Client, "saves", r.Keys);
            foreach (var v in new[] { "first", "second, overwritten in place" }) await d.WriteFileAsync("slots/one.sav", Encoding.UTF8.GetBytes(v));
            Assert.Equal("second, overwritten in place", Encoding.UTF8.GetString(await d.ReadFileAsync("slots/one.sav")));
            await d.MkdirAsync("slots/sub");
            Assert.True((await Assert.ThrowsAsync<ApiException>(() => d.DeleteSlotAsync("slots", "sub"))).NotFound, "slot delete never removes a folder");
            foreach (var bad in new[] { "", "sub/x.sav", "..", "." }) await Assert.ThrowsAsync<ArgumentException>(() => d.DeleteSlotAsync("slots", bad));
            await d.DeleteSlotAsync("slots", "one.sav");
            Assert.True((await Assert.ThrowsAsync<ApiException>(() => d.ReadFileAsync("slots/one.sav"))).NotFound, "deleted slot");
            await new Keyring(r.Client).UnlockAsync("slot passphrase");
        }

        [Test(NeedsServer = true)]
        static async Task C16_SyncStaysInside()
        {
            var r = await Rig.Create("ws");
            var d = new Drive(r.Client, "hostile", null, plain: true);
            await d.WriteFileAsync("ok.txt", Encoding.UTF8.GetBytes("ok"));
            var doc = await d.SnapshotAsync();
            var hostile = new[] { "../dotdot.txt", "a/../../mid.txt", "/abs.txt", "out/link.txt", "in/inner.txt" };
            foreach (var p in hostile) doc.Files[p] = doc.Files["ok.txt"];
            await r.Client.PutManifestAsync(d.ManifestKey, Crypto.SealManifest(null, d.ManifestKey, doc.Encode()));
            var tmp = Path.Combine(Path.GetTempPath(), "gd-c16-" + Bytes.Hex(Bytes.Random(4)));
            var local = Path.Combine(tmp, "local"); var outside = Path.Combine(tmp, "outside");
            try
            {
                Directory.CreateDirectory(Path.Combine(local, "real"));
                Directory.CreateDirectory(outside);
                Symlink(outside, Path.Combine(local, "out"));
                Symlink(Path.Combine(local, "real"), Path.Combine(local, "in"));
                foreach (var p in hostile)
                    await Assert.ThrowsAsync<InvalidOperationException>(() => Sync.PullAsync(r.Client, d, local, new SyncOptions { Skip = rel => rel != p && "/" + rel != p }));
                foreach (var f in new[] { Path.Combine(tmp, "dotdot.txt"), Path.Combine(tmp, "mid.txt"), Path.Combine(outside, "link.txt"), Path.Combine(local, "real", "inner.txt") })
                    Assert.True(!File.Exists(f), "pull wrote " + f);
                await Sync.PullAsync(r.Client, d, local, new SyncOptions { Skip = rel => rel != "ok.txt" });
                File.WriteAllText(Path.Combine(outside, "secret.txt"), "secret");
                Symlink(Path.Combine(outside, "secret.txt"), Path.Combine(local, "real", "secret.txt"));
                var pushed = await Sync.PushAsync(r.Client, new Drive(r.Client, "pushed", null, plain: true), local);
                Assert.Equal("ok.txt", string.Join(",", pushed.Uploaded));
            }
            finally { try { Directory.Delete(tmp, true); } catch (IOException) { } }
        }

        // netstandard2.1 has no symlink API; the tests create links with ln.
        static void Symlink(string target, string link)
        {
            using var p = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("ln", $"-s \"{target}\" \"{link}\"") { UseShellExecute = false })!;
            p.WaitForExit();
            Assert.Equal(0, p.ExitCode, "ln -s");
        }

        [Test(NeedsServer = true)]
        static async Task C09_Events()
        {
            var r = await Rig.Create("ws");
            await r.Keys.CreateAsync(Pass);
            var d = new Drive(r.Client, "watched", r.Keys);
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(40));
            var seen = new System.Collections.Concurrent.ConcurrentQueue<ChangeEvent>();
            var watcher = Task.Run(async () =>
            {
                await foreach (var ev in Events.WatchAsync(r.Client, new WatchOptions { Interval = TimeSpan.FromSeconds(1) }, cts.Token)) seen.Enqueue(ev);
            });
            async Task<ChangeEvent> WaitFor(ChangeType t)
            {
                var end = DateTime.UtcNow.AddSeconds(15);
                while (DateTime.UtcNow < end) { var ev = seen.FirstOrDefault(x => x.Type == t); if (ev != null) return ev; await Task.Delay(100); }
                throw new Exception("no " + t + " event");
            }
            await Task.Delay(1200);
            await d.WriteFileAsync("a", new byte[] { 1 });
            Assert.Equal(d.ManifestKey, (await WaitFor(ChangeType.ManifestCreated)).Key);
            await d.WriteFileAsync("a", new byte[] { 2 });
            await WaitFor(ChangeType.ManifestUpdated);
            await r.Acct.RevokeBindingAsync(r.Conn.BindingId);
            Assert.Equal("binding.revoked", (await WaitFor(ChangeType.BindingRevoked)).Name);
            await watcher;
        }

        [Test(NeedsServer = true)]
        static async Task C10_Sharing()
        {
            var r = await Rig.Create("ws");
            await r.Keys.CreateAsync(Pass);
            var d = new Drive(r.Client, "docs", r.Keys);
            await d.WriteFileAsync("letter.txt", Encoding.UTF8.GetBytes("for your eyes only"));
            var rk = await Sharing.CreateReadKeyAsync(r.Client, "recipient", 1);
            var reader = new Client(B, rk.ApiKey!);
            var id = Identity.Create(reader);
            var share = Share.FromJson((await Sharing.ExportAsync(r.Client, d, "letter.txt", id.Public)).ToJson());
            var (f, data) = await Sharing.OpenAsync(reader, id, share);
            Assert.Equal("letter.txt", f.Path); Assert.Equal("for your eyes only", Encoding.UTF8.GetString(data));
            await Assert.ThrowsAsync<ArgumentException>(() => Sharing.OpenAsync(reader, Identity.Create(reader), share));
            await Assert.ThrowsAsync<ApiException>(() => reader.PutSealedBlobAsync(new string('0', 64), new byte[] { 1 }));
            await Assert.ThrowsAsync<ApiException>(() => new Keyring(reader).UnlockAsync(Pass));
            var keys = await Sharing.ListReadKeysAsync(r.Client);
            Assert.True(keys.Count == 1 && keys[0].ApiKey == null, "listing never returns secrets");
            await Sharing.RevokeReadKeyAsync(r.Client, rk.KeyId);
            Assert.True((await Assert.ThrowsAsync<ApiException>(() => Sharing.OpenAsync(reader, id, share))).Unauthorized, "revoked");
        }

        [Test(NeedsServer = true)]
        static async Task C11_Sync()
        {
            var r = await Rig.Create("ws");
            await r.Keys.CreateAsync(Pass);
            var d = new Drive(r.Client, "sync", r.Keys);
            var tmp = Path.Combine(Path.GetTempPath(), "gd-sync-" + Bytes.Hex(Bytes.Random(4)));
            var src = Path.Combine(tmp, "src"); var dst = Path.Combine(tmp, "dst");
            try
            {
                Directory.CreateDirectory(Path.Combine(src, "a", "b"));
                File.WriteAllText(Path.Combine(src, "a", "b", "one.txt"), "one");
                File.WriteAllText(Path.Combine(src, "two.txt"), "two");
                var o = new SyncOptions { Prefix = "backup" };
                Assert.Equal(2, (await Sync.PushAsync(r.Client, d, src, o)).Uploaded.Count);
                var again = await Sync.PushAsync(r.Client, d, src, o);
                Assert.True(again.Uploaded.Count == 0 && again.Unchanged == 2, "second push uploads nothing");
                Assert.Equal(2, (await Sync.PullAsync(r.Client, d, dst, o)).Downloaded.Count);
                Assert.Equal("one", File.ReadAllText(Path.Combine(dst, "a", "b", "one.txt")));
                File.Delete(Path.Combine(src, "two.txt"));
                var dry = await Sync.MirrorAsync(r.Client, d, src, SyncDirection.ToDrive, new SyncOptions { Prefix = "backup", DryRun = true });
                Assert.Equal("backup/two.txt", string.Join(",", dry.Deleted));
                await d.StatAsync("backup/two.txt");
                await Sync.MirrorAsync(r.Client, d, src, SyncDirection.ToDrive, o);
                await Assert.ThrowsAsync<ApiException>(() => d.StatAsync("backup/two.txt"));
            }
            finally { if (Directory.Exists(tmp)) Directory.Delete(tmp, true); }
        }

        [Test(NeedsServer = true)]
        static async Task C12_GarbageAndWipe()
        {
            var r = await Rig.Create("ws", Max(Level.L4));
            await r.Keys.CreateAsync(Pass);
            var d = new Drive(r.Client, "g", r.Keys);
            await d.WriteFileAsync("keep", Encoding.ASCII.GetBytes("keep"));
            await d.WriteFileAsync("drop", Encoding.ASCII.GetBytes("drop"));
            await d.DeleteAsync("drop");
            Assert.Equal(1, await Drive.CollectGarbageAsync(r.Client, r.Keys));
            Assert.Equal("keep", Encoding.ASCII.GetString(await d.ReadFileAsync("keep")));
            Assert.True((await Assert.ThrowsAsync<InvalidOperationException>(() => Drive.CollectGarbageAsync(r.Client, null))).Message.Contains("refusing"));
            await r.Client.WipeAsync();
            Assert.Equal(0, (await r.Client.AllManifestsAsync()).Count);
            var u = await r.Client.UsageAsync();
            Assert.True(u.UsedBytes == 0 && u.ObjectCount == 0, "empty after wipe");
        }

        [Test(NeedsServer = true)]
        static async Task C13_RotateKey()
        {
            var r = await Rig.Create("ws");
            var old = r.Client.ApiKey;
            Assert.True(await r.Client.RotateApiKeyAsync() != old, "new key");
            await r.Client.HealthAsync();
        }

        [Test(NeedsServer = true)]
        static async Task C14_AccountBindings()
        {
            var r = await Rig.Create("ws");
            await new Drive(r.Client, "p", null, plain: true).WriteFileAsync("x", Encoding.ASCII.GetBytes("12345"));
            var list = await r.Acct.ListBindingsAsync();
            Assert.True(list.Count == 1 && list[0].Active && list[0].UsedBytes > 0, "one active binding with data");
            await Assert.ThrowsAsync<LevelException>(() => r.Acct.RevokeAndDeleteAsync(list[0].Id));
            Assert.True((await Assert.ThrowsAsync<ApiException>(() => Account("nobody", Max(Level.L4)).RevokeAndDeleteAsync(list[0].Id))).NotFound, "not found for another account");
        }
    }
}
