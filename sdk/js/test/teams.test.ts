// Teams contract suite (sdk/spec/CONTRACT.md, T01-T11) against contract/teams_dev_server.cjs. Set GD_TEAMS_ORIGIN to a
// running server, or GD_TEAMS_SERVER to the script path (with GD_TEAMS_BACKEND) to start one; otherwise these tests skip.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes, randomUUID } from "node:crypto";
import * as gd from "../src/index.js";

let origin = process.env.GD_TEAMS_ORIGIN ?? "";
let server: ChildProcess | null = null;
const skip = !origin && !process.env.GD_TEAMS_SERVER ? "set GD_TEAMS_ORIGIN or GD_TEAMS_SERVER to run the Teams contract suite" : false;

before(async () => {
  if (origin || !process.env.GD_TEAMS_SERVER) return;
  server = spawn("node", [process.env.GD_TEAMS_SERVER, "--exit-with-stdin"], { stdio: ["pipe", "pipe", "inherit"] });
  const line = await new Promise<string>((resolve, reject) => {
    createInterface({ input: server!.stdout! }).once("line", resolve);
    server!.once("exit", (c) => reject(new Error(`teams dev server exited ${c}`)));
  });
  origin = JSON.parse(line).origin;
});
after(() => { server?.stdin?.end(); server?.kill(); });

const user = (uid: string, max: gd.Level = "L3") => new gd.TeamsClient(origin, () => `dev-user:${uid}`, { gate: gd.levelGate(max) });
const pay = async (url: string) => assert.equal((await fetch(origin + "/__dev/pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) })).status, 200);
const status = async (p: Promise<unknown>) => { try { await p; return 0; } catch (e) { return e instanceof gd.APIError ? e.status : -1; } };
const levelRefused = async (p: () => Promise<unknown>) => { try { await p(); } catch (e) { return e instanceof gd.LevelError; } return false; };

test("Teams contract T01-T11", { skip }, async (t) => {
  const aliceUid = "alice" + randomBytes(4).toString("hex");
  const alice = user(aliceUid), bob = user("bob" + randomBytes(4).toString("hex"));
  let teamId = "", bobId = "", lastSeq = 0;
  await t.test("T01 catalog", async () => { assert.ok(((await alice.catalog()).tiers as unknown[]).length >= 3); });
  await t.test("T02 create and pay", async () => {
    assert.ok(await levelRefused(() => user("x", "L2").create({ intentId: randomUUID(), name: "Studio", tier: "team" })));
    const r = await alice.create({ intentId: randomUUID(), name: "Studio", tier: "team", interval: "month" });
    assert.ok(r.url); assert.equal(r.team.role, "owner");
    teamId = r.team.id;
    await pay(r.url!);
    const list = await alice.list();
    assert.equal(list.length, 1); assert.ok(list[0].subscriptionActive);
  });
  await t.test("T03 invite, preview, join", async () => {
    const inv = await alice.createInvite(teamId, { maxUses: 2 });
    const p = await bob.previewInvite(inv.code);
    assert.equal(p.teamName, "Studio");
    const color = p.colors.memberColors.find((c) => !c.taken)!.id;
    assert.deepEqual(await bob.join({ code: inv.code, color, displayName: "Bob" }), { teamId, alreadyMember: false });
    assert.equal((await bob.join({ code: inv.code, color })).alreadyMember, true);
    await alice.revokeInvite(teamId, inv.inviteId);
  });
  await t.test("T04 view and update me", async () => {
    await bob.updateMe(teamId, { displayName: "Bobby" });
    const v = await alice.get(teamId);
    assert.equal(v.team.members!.length, 2);
    const b = v.team.members!.find((m) => m.role === "member")!;
    assert.equal(b.displayName, "Bobby");
    bobId = b.memberId;
  });
  await t.test("T05 chat post, list, watch", async () => {
    const m = await bob.post(teamId, "hello");
    lastSeq = m.seq;
    const p = await alice.messages(teamId);
    assert.equal(p.latestSeq, m.seq); assert.equal(p.messages.at(-1)!.text, "hello");
    const ac = new AbortController();
    const it = bob.watchChat(teamId, { after: p.latestSeq, signal: ac.signal });
    const next = it.next();
    await alice.post(teamId, "welcome");
    assert.equal((await next).value!.text, "welcome");
    ac.abort(); await it.return(undefined);
  });
  await t.test("T06 report and delete", async () => {
    await alice.report(teamId, lastSeq, "spam", "test");
    assert.equal(await status(bob.deleteMessage(teamId, lastSeq, "cleanup")), 403);
    await alice.deleteMessage(teamId, lastSeq, "off topic");
    assert.equal((await alice.messages(teamId, lastSeq - 1, 1)).messages[0].kind, "removed");
  });
  await t.test("T07 team workspace and roles", async () => {
    const w = await alice.createWorkspace(teamId, { intentId: randomUUID(), name: "Art", plans: { storageTier: "100GB", performanceTier: "boost" } });
    assert.ok(w.url); assert.equal(w.workspace.storageRoutes!.v3, "/v3/cloud/" + w.workspace.id);
    await pay(w.url!);
    await alice.setRole(teamId, bobId, "viewer");
    const ws = await bob.workspaces(teamId);
    assert.equal(ws.teamWorkspaces.length, 1); assert.equal(ws.teamWorkspaces[0].access, "read"); assert.ok(ws.subscriptionActive);
    await alice.setRole(teamId, bobId, "member");
  });
  await t.test("T11 personal workspace card", async () => {
    const wid = randomUUID();
    const seeded = await fetch(origin + "/__dev/personal-workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uid: aliceUid, workspaceId: wid, name: "Sketches" }) });
    assert.equal(seeded.status, 200);
    const card = { scope: "personal" as const, workspaceId: wid };
    assert.ok(await levelRefused(() => user(aliceUid, "L2").postCard(teamId, card, "", { share: true })));
    await assert.rejects(alice.postCard(teamId, card, "not shared yet"), (e) => e instanceof gd.APIError && e.status === 403 && e.code === "SHARE_REQUIRED");
    const m = await alice.postCard(teamId, card, "have a look", { share: true });
    assert.equal(m.kind, "workspace_card"); assert.equal(m.card?.workspaceId, wid);
    assert.equal((await bob.workspaces(teamId)).sharedWorkspaces.length, 1);
    await alice.postCard(teamId, card, "again");
    await alice.unshare(teamId, wid);
  });
  await t.test("T08 mute and unmute", async () => {
    await alice.mute(teamId, bobId, "cool down");
    assert.equal(await status(bob.post(teamId, "hi")), 403);
    await alice.unmute(teamId, bobId);
    await bob.post(teamId, "back");
  });
  await t.test("T09 audit", async () => {
    assert.equal(await status(bob.audit(teamId)), 403);
    const a = await alice.audit(teamId);
    assert.ok(a.length >= 4); assert.ok(gd.verifyAuditChain(a));
    a[1].prev = a[0].prev;
    assert.equal(gd.verifyAuditChain(a), false);
  });
  await t.test("T10 levels and removal", async () => {
    assert.ok(await levelRefused(() => alice.transfer(teamId, { memberId: bobId, color: "blue-500" })));
    assert.ok(await levelRefused(() => alice.delete(teamId, "Studio")));
    await alice.kick(teamId, bobId, "done");
    assert.ok([403, 404].includes(await status(bob.get(teamId))));
  });
});
