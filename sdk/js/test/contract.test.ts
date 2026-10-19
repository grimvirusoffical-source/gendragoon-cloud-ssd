// Shared contract suite (sdk/spec/CONTRACT.md) against a local backend. Set GD_SDK_BASE to a running
// provider_dev_server, or GD_DEV_SERVER to its script path to start one; otherwise these tests skip.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import * as gd from "../src/node.js";

let base = process.env.GD_SDK_BASE ?? "";
let server: ChildProcess | null = null;
const skip = !base && !process.env.GD_DEV_SERVER ? "set GD_SDK_BASE or GD_DEV_SERVER to run the contract suite" : false;

before(async () => {
  if (base || !process.env.GD_DEV_SERVER) return;
  server = spawn("node", [process.env.GD_DEV_SERVER, "--exit-with-stdin"], { env: { ...process.env, PROVIDER_V1_ENABLED: "true" }, stdio: ["pipe", "pipe", "inherit"] });
  const line = await new Promise<string>((resolve, reject) => {
    createInterface({ input: server!.stdout! }).once("line", resolve);
    server!.once("exit", (c) => reject(new Error(`dev server exited ${c}`)));
  });
  base = JSON.parse(line).base;
});
after(() => { server?.stdin?.end(); server?.kill(); });

const uid = () => "u" + randomBytes(6).toString("hex");
const account = (user: string, opts?: gd.Options) => new gd.AccountClient(base, () => `dev-user:${user}`, opts);
async function connect(workspace: string, opts?: gd.Options) {
  const acct = account(uid());
  const g = await acct.createGrant(workspace, { name: "JS contract", host: "test" });
  const conn = await new gd.Connector(base, opts).redeemGrant(g.grant, { name: "JS contract" });
  const client = new gd.Client(base, conn.apiKey, opts);
  return { acct, conn, client, keys: new gd.Keyring(client) };
}
const PASS = "contract passphrase";
const rejectsWith = async (p: Promise<unknown>, pred: (e: unknown) => boolean, msg: string) => {
  try { await p; } catch (e) { assert.ok(pred(e), `${msg}: ${e}`); return; }
  assert.fail(`${msg}: no error`);
};

test("C01 connect with a grant", { skip }, async () => {
  const r = await connect("ws");
  await r.client.health();
  const caps = await r.client.capabilities();
  assert.ok(caps.events?.poll);
  assert.equal(caps.maxBlobBytes, 16 << 20);
  await rejectsWith(new gd.Connector(base).redeemGrant("gdpg_" + "A".repeat(43), { name: "x" }), (e) => e instanceof gd.APIError && e.code === "invalid_grant", "unknown grant");
});

test("C02 connect with PKCE", { skip }, async () => {
  const acct = account(uid());
  const p = await gd.newPKCE();
  const req = gd.parseConnectLink(gd.connectLink({ name: "JS contract" }, p, "http://127.0.0.1:9/cb"));
  const u = new URL(await acct.authorize("ws", req));
  assert.equal(u.searchParams.get("state"), p.state);
  const k = new gd.Connector(base);
  await assert.rejects(k.exchangeCode(u.searchParams.get("code")!, (await gd.newPKCE()).verifier));
  const conn = await k.exchangeCode(u.searchParams.get("code")!, p.verifier);
  assert.equal(conn.workspaceId, "ws");
});

test("C03 master key lifecycle", { skip }, async () => {
  const r = await connect("ws");
  await r.keys.create(PASS);
  await rejectsWith(new gd.Keyring(r.client).create(PASS), gd.isPreconditionFailed, "second create");
  const k2 = new gd.Keyring(r.client);
  await assert.rejects(k2.unlock("not the passphrase"), gd.WrongPassphraseError);
  await r.keys.changePassphrase("a brand new passphrase");
  await k2.unlock("a brand new passphrase");
  assert.throws(() => r.keys.exportMasterKey(), gd.LevelError);
});

test("C04 encrypted files and folders", { skip }, async () => {
  const r = await connect("ws");
  await r.keys.create(PASS);
  const d = await gd.Drive.open(r.client, "saves", r.keys, { chunkSize: 1024 });
  const data = new Uint8Array(randomBytes(5000));
  await d.mkdir("levels/1");
  const e = await d.writeFile("slots/slot1.sav", data);
  assert.equal(e.chunks.length, 5);
  assert.deepEqual(await d.readFile("slots/slot1.sav"), data);
  const root = await d.list("");
  assert.deepEqual(root.map((x) => [x.name, x.folder]), [["levels", true], ["slots", true]]);
  await d.move("slots/slot1.sav", "slots/slot2.sav");
  await d.stat("slots/slot2.sav");
  await assert.rejects(d.delete("levels"), /not empty/);
  assert.equal(await d.deleteFolder("levels"), 0);
  await d.delete("slots/slot2.sav");
  await rejectsWith(d.readFile("slots/slot2.sav"), gd.isNotFound, "deleted file");
  const needle = Buffer.from(data.subarray(0, 64));
  for (const b of await r.client.allBlobs()) assert.ok(!Buffer.from(await r.client.getBlob(b.id)).includes(needle), "plaintext stored");
});

test("C05 plain drive is content-addressed", { skip }, async () => {
  const r = await connect("ws");
  const d = await gd.Drive.open(r.client, "public", null, { plain: true });
  await d.writeFile("readme.txt", new TextEncoder().encode("hello"));
  const e = await d.stat("readme.txt");
  assert.equal(e.chunks[0], "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.equal(e.key, undefined);
});

test("C06 concurrent writers lose nothing", { skip }, async () => {
  const r = await connect("ws");
  await r.keys.create(PASS);
  await Promise.all([0, 1].map(async (w) => {
    const d = await gd.Drive.open(r.client, "shared", r.keys);
    for (let i = 0; i < 10; i++) await d.writeFile(`w${w}/f${i}`, new Uint8Array([i]));
  }));
  const snap = await (await gd.Drive.open(r.client, "shared", r.keys)).snapshot();
  assert.equal(Object.keys(snap.files).length, 20);
});

test("C07 quota", { skip }, async () => {
  const r = await connect("small");
  const d = await gd.Drive.open(r.client, "big", null, { plain: true });
  await rejectsWith(d.writeFile("too-big.bin", new Uint8Array(100 << 10)), gd.isQuotaExceeded, "quota");
  const u = await r.client.usage();
  assert.equal(u.quotaBytes, 64 << 10);
  assert.ok(u.usedBytes <= u.quotaBytes);
});

test("C08 gate refuses above the client's level before any request", { skip }, async () => {
  const r = await connect("ws", { gate: gd.levelGate("L2") });
  const d = await gd.Drive.open(r.client, "x", null, { plain: true });
  await rejectsWith(d.deleteFolder("a"), (e) => e instanceof gd.LevelError && e.op.id === "files.deleteFolder" && e.op.level === "L3", "L3 call");
  await rejectsWith(r.client.wipe(), (e) => e instanceof gd.LevelError, "wipe");
});

test("C09 events by polling", { skip, timeout: 40_000 }, async () => {
  const r = await connect("ws");
  await r.keys.create(PASS);
  const d = await gd.Drive.open(r.client, "watched", r.keys);
  const ac = new AbortController();
  const it = gd.watch(r.client, { intervalMs: 1000, signal: ac.signal });
  const next = async (want: gd.EventType) => {
    for (;;) {
      const { value, done } = await it.next();
      if (done) assert.fail(`no ${want} event`);
      if (value.type === want) return value;
    }
  };
  const first = it.next(); // baseline poll
  await new Promise((res) => setTimeout(res, 1200));
  await d.writeFile("a", new Uint8Array([1]));
  let e = (await first).value as gd.ChangeEvent;
  if (e.type !== "manifest.created") e = await next("manifest.created");
  assert.equal(e.key, d.manifestKey);
  await d.writeFile("a", new Uint8Array([2]));
  await next("manifest.updated");
  await r.acct.revokeBinding(r.conn.bindingId);
  await next("binding.revoked");
  ac.abort();
});

test("C10 sharing with a read-only key", { skip }, async () => {
  const r = await connect("ws");
  await r.keys.create(PASS);
  const d = await gd.Drive.open(r.client, "docs", r.keys);
  await d.writeFile("letter.txt", new TextEncoder().encode("for your eyes only"));
  const rk = await gd.createReadKey(r.client, "recipient", 1);
  const reader = new gd.Client(base, rk.apiKey!);
  const id = await gd.Identity.create(reader);
  const share = await gd.exportShare(d, r.client, "letter.txt", id.public);
  const got = await gd.openShare(reader, id, share);
  assert.equal(got.file.path, "letter.txt");
  assert.equal(new TextDecoder().decode(got.data), "for your eyes only");
  await assert.rejects(gd.openShare(reader, await gd.Identity.create(reader), share));
  await assert.rejects(reader.putSealedBlob("0".repeat(64), new Uint8Array([1])));
  await assert.rejects(new gd.Keyring(reader).unlock(PASS));
  const keys = await gd.listReadKeys(r.client);
  assert.equal(keys.length, 1);
  assert.equal(keys[0]!.apiKey, undefined);
  await gd.revokeReadKey(r.client, rk.keyId);
  await rejectsWith(gd.openShare(reader, id, share), gd.isUnauthorized, "revoked read key");
});

test("C11 folder sync", { skip }, async () => {
  const r = await connect("ws");
  await r.keys.create(PASS);
  const d = await gd.Drive.open(r.client, "sync", r.keys);
  const src = await mkdtemp(path.join(tmpdir(), "gd-src-")), dst = await mkdtemp(path.join(tmpdir(), "gd-dst-"));
  try {
    await mkdir(path.join(src, "a/b"), { recursive: true });
    await writeFile(path.join(src, "a/b/one.txt"), "one");
    await writeFile(path.join(src, "two.txt"), "two");
    assert.equal((await gd.pushFolder(r.client, d, src, { prefix: "backup" })).uploaded.length, 2);
    const again = await gd.pushFolder(r.client, d, src, { prefix: "backup" });
    assert.deepEqual([again.uploaded.length, again.unchanged], [0, 2]);
    assert.equal((await gd.pullFolder(r.client, d, dst, { prefix: "backup" })).downloaded.length, 2);
    assert.equal(await readFile(path.join(dst, "a/b/one.txt"), "utf8"), "one");
    await rm(path.join(src, "two.txt"));
    const dry = await gd.mirrorFolder(r.client, d, src, "toDrive", { prefix: "backup", dryRun: true });
    assert.deepEqual(dry.deleted, ["backup/two.txt"]);
    await d.stat("backup/two.txt");
    await gd.mirrorFolder(r.client, d, src, "toDrive", { prefix: "backup" });
    await rejectsWith(d.stat("backup/two.txt"), gd.isNotFound, "mirror kept a deleted file");
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});

test("C12 garbage collection and wipe", { skip }, async () => {
  const r = await connect("ws", { gate: gd.levelGate("L4") });
  await r.keys.create(PASS);
  const d = await gd.Drive.open(r.client, "g", r.keys);
  await d.writeFile("keep", new TextEncoder().encode("keep"));
  await d.writeFile("drop", new TextEncoder().encode("drop"));
  await d.delete("drop");
  assert.equal(await gd.collectGarbage(r.client, r.keys), 1);
  assert.equal(new TextDecoder().decode(await d.readFile("keep")), "keep");
  await assert.rejects(gd.collectGarbage(r.client, null), /refusing/);
  await r.client.wipe();
  assert.equal((await r.client.allManifests()).length, 0);
  const u = await r.client.usage();
  assert.deepEqual([u.usedBytes, u.objectCount], [0, 0]);
});

test("C13 rotate the API key", { skip }, async () => {
  const r = await connect("ws");
  const old = r.client.apiKey;
  assert.notEqual(await r.client.rotateApiKey(), old);
  await r.client.health();
});

test("C14 account bindings", { skip }, async () => {
  const r = await connect("ws");
  await (await gd.Drive.open(r.client, "p", null, { plain: true })).writeFile("x", new TextEncoder().encode("12345"));
  const list = await r.acct.listBindings();
  assert.equal(list.length, 1);
  assert.ok(list[0]!.active && list[0]!.usedBytes > 0);
  await assert.rejects(r.acct.revokeAndDelete(list[0]!.id), gd.LevelError);
  await rejectsWith(account("nobody", { gate: gd.levelGate("L4") }).revokeAndDelete(list[0]!.id), gd.isNotFound, "another account");
});
