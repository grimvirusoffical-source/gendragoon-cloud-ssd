using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Gendragoon.Sdk.Tests
{
    /// <summary>The Teams contract suite (sdk/spec/CONTRACT.md, T01-T11) against contract/teams_dev_server.cjs.</summary>
    static class Teams
    {
        public static string? Origin;
        static TeamsClient User(string uid, Level max = Level.L3) =>
            new TeamsClient(Origin!, _ => Task.FromResult("dev-user:" + uid), new ClientOptions { Gate = Operations.LevelGate(max) });

        static async Task Pay(string url)
        {
            using var http = new HttpClient();
            var r = await http.PostAsync(Origin + "/__dev/pay", new StringContent("{\"url\":" + Json.Write(url) + "}", Encoding.UTF8, "application/json"));
            Assert.Equal(200, (int)r.StatusCode, "dev pay");
        }

        [Test(NeedsTeams = true)]
        static async Task T01_T11_TeamsContract()
        {
            var aliceUid = "alice" + Bytes.Hex(Bytes.Random(4));
            var alice = User(aliceUid);
            var bob = User("bob" + Bytes.Hex(Bytes.Random(4)));

            // T01 catalog
            Assert.True((await alice.CatalogAsync()).A("tiers").Count >= 3, "tiers");

            // T02 create and pay
            await Assert.ThrowsAsync<LevelException>(() => User("x", Level.L2).CreateAsync(Guid.NewGuid().ToString(), "Studio", "team"));
            var (team, checkout) = await alice.CreateAsync(Guid.NewGuid().ToString(), "Studio", "team");
            Assert.True(checkout.Url != null && team.Role == "owner", "checkout");
            await Pay(checkout.Url!);
            var list = await alice.ListAsync();
            Assert.True(list.Count == 1 && list[0].SubscriptionActive, "active team");
            var id = team.Id;

            // T03 invite, preview, join
            var inv = await alice.CreateInviteAsync(id, maxUses: 2);
            var p = await bob.PreviewInviteAsync(inv.Code);
            Assert.Equal("Studio", p.TeamName);
            var color = p.MemberColors.First(c => !c.Taken).Id;
            var j = await bob.JoinAsync(inv.Code, color, "Bob");
            Assert.True(j.TeamId == id && !j.AlreadyMember, "joined");
            Assert.True((await bob.JoinAsync(inv.Code, color)).AlreadyMember, "already member");
            await alice.RevokeInviteAsync(id, inv.InviteId);

            // T04 view and update me
            await bob.UpdateMeAsync(id, displayName: "Bobby");
            var view = await alice.GetAsync(id);
            Assert.Equal(2, view.Team.Members.Count, "members");
            var b = view.Team.Members.First(m => m.Role == "member");
            Assert.Equal("Bobby", b.DisplayName);
            var bobId = b.MemberId;

            // T05 chat post, list, watch
            var msg = await bob.PostAsync(id, "hello");
            var page = await alice.MessagesAsync(id);
            Assert.True(page.LatestSeq == msg.Seq && page.Messages.Last().Text == "hello", "chat page");
            using (var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15)))
            {
                var it = bob.WatchChatAsync(id, page.LatestSeq, ct: cts.Token).GetAsyncEnumerator(cts.Token);
                var next = it.MoveNextAsync().AsTask();
                await alice.PostAsync(id, "welcome");
                Assert.True(await next && it.Current.Text == "welcome", "watched message");
                cts.Cancel();
                await it.DisposeAsync();
            }

            // T06 report and delete
            await alice.ReportAsync(id, msg.Seq, "spam", "test");
            Assert.Equal(403, (await Assert.ThrowsAsync<ApiException>(() => bob.DeleteMessageAsync(id, msg.Seq, "cleanup"))).Status);
            await alice.DeleteMessageAsync(id, msg.Seq, "off topic");
            Assert.Equal("removed", (await alice.MessagesAsync(id, msg.Seq - 1, 1)).Messages[0].Kind);

            // T07 team workspace and roles
            var (ws, wc) = await alice.CreateWorkspaceAsync(id, Guid.NewGuid().ToString(), "Art", new Dictionary<string, object?> { ["storageTier"] = "100GB", ["performanceTier"] = "boost" });
            Assert.True(wc.Url != null && ws.StorageRoutes!["v3"] == "/v3/cloud/" + ws.Id, "workspace routes");
            await Pay(wc.Url!);
            await alice.SetRoleAsync(id, bobId, "viewer");
            var spaces = await bob.WorkspacesAsync(id);
            Assert.True(spaces.Team.Count == 1 && spaces.Team[0].Access == "read" && spaces.SubscriptionActive, "viewer access");
            await alice.SetRoleAsync(id, bobId, "member");

            // T11 personal workspace card
            var wid = Guid.NewGuid().ToString();
            using (var http = new HttpClient())
            {
                var seeded = await http.PostAsync(Origin + "/__dev/personal-workspace", new StringContent(
                    "{\"uid\":" + Json.Write(aliceUid) + ",\"workspaceId\":" + Json.Write(wid) + ",\"name\":\"Sketches\"}", Encoding.UTF8, "application/json"));
                Assert.Equal(200, (int)seeded.StatusCode, "seed personal workspace");
            }
            await Assert.ThrowsAsync<LevelException>(() => User(aliceUid, Level.L2).PostCardAsync(id, "personal", wid, "", share: true));
            var refused = await Assert.ThrowsAsync<ApiException>(() => alice.PostCardAsync(id, "personal", wid, "not shared yet"));
            Assert.True(refused.Status == 403 && refused.Code == "SHARE_REQUIRED", "unshared personal card");
            var card = await alice.PostCardAsync(id, "personal", wid, "have a look", share: true);
            Assert.True(card.Kind == "workspace_card", "card posted");
            Assert.Equal(1, (await bob.WorkspacesAsync(id)).Shared.Count, "shared by the card");
            await alice.PostCardAsync(id, "personal", wid, "again");
            await alice.UnshareAsync(id, wid);

            // T08 mute and unmute
            await alice.MuteAsync(id, bobId, "cool down");
            Assert.Equal(403, (await Assert.ThrowsAsync<ApiException>(() => bob.PostAsync(id, "hi"))).Status);
            await alice.UnmuteAsync(id, bobId);
            await bob.PostAsync(id, "back");

            // T09 audit
            Assert.Equal(403, (await Assert.ThrowsAsync<ApiException>(() => bob.AuditAsync(id))).Status);
            var audit = await alice.AuditAsync(id);
            Assert.True(audit.Count >= 4 && TeamsClient.VerifyAuditChain(audit), "audit chain");
            audit[1].Prev = audit[0].Prev;
            Assert.True(!TeamsClient.VerifyAuditChain(audit), "tampered chain refused");

            // T10 levels and removal
            await Assert.ThrowsAsync<LevelException>(() => alice.TransferAsync(id, bobId, "blue-500"));
            await Assert.ThrowsAsync<LevelException>(() => alice.DeleteAsync(id, "Studio"));
            await alice.KickAsync(id, bobId, "done");
            var gone = await Assert.ThrowsAsync<ApiException>(() => bob.GetAsync(id));
            Assert.True(gone.Status == 403 || gone.Status == 404, "kicked member refused");
        }
    }
}
