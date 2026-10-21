// Cross-language vectors (sdk/spec/vectors/v1.json), the operation table and the gate. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as gd from "../src/index.js";
import { sealShare } from "../src/share.js";

const SPEC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../spec");
const V = JSON.parse(readFileSync(path.join(SPEC, "vectors/v1.json"), "utf8"));
const OPSPEC = JSON.parse(readFileSync(path.join(SPEC, "operations.json"), "utf8"));
const hex = gd.fromHex, txt = (s: string) => new TextEncoder().encode(s);

test("hkdf vectors", async () => {
  for (const v of V.hkdf) assert.equal(gd.toHex(await gd.subKey(hex(v.ikm), v.purpose)), v.out);
});

test("scrypt envelope vector; wrong passphrase; argon2id needs a plug-in", async () => {
  const e = V.envelopeScrypt;
  assert.equal(gd.toHex(await gd.unwrapMasterKey(e.envelope, e.passphrase)), e.masterKey);
  await assert.rejects(gd.unwrapMasterKey(e.envelope, "not the passphrase"), gd.WrongPassphraseError);
  await assert.rejects(gd.unwrapMasterKey(V.envelopeArgon2id.envelope, V.envelopeArgon2id.passphrase), /setArgon2id/);
  const again = await gd.wrapMasterKey(hex(e.masterKey), e.passphrase, e.envelope.kdf, 1, (n) => (n === 16 ? gd.fromB64u(e.envelope.salt) : gd.fromB64u(e.envelope.iv)));
  assert.deepEqual(again, e.envelope);
});

test("chunk vector, tamper detection", async () => {
  const c = V.chunk;
  const sealed = await gd.sealChunk(hex(c.fileKey), hex(c.plaintext), hex(c.nonce));
  assert.equal(sealed.id, c.id);
  assert.equal(gd.toHex(sealed.blob), c.blob);
  assert.equal(gd.toHex(await gd.openChunk(hex(c.fileKey), c.id, hex(c.blob))), c.plaintext);
  const bad = hex(c.blob); bad[bad.length - 1]! ^= 1;
  await assert.rejects(gd.openChunk(hex(c.fileKey), c.id, bad), gd.CorruptError);
});

test("manifest vector", async () => {
  const m = V.manifest;
  assert.equal(await gd.driveManifestKey(hex(m.masterKey), m.driveName), m.manifestKey);
  assert.equal(await gd.driveManifestKey(null, m.driveName), m.plainManifestKey);
  assert.equal(gd.toHex(await gd.sealManifest(hex(m.masterKey), m.manifestKey, txt(m.plaintext), hex(m.nonce))), m.sealed);
  assert.equal(new TextDecoder().decode(await gd.openManifest(hex(m.masterKey), m.manifestKey, hex(m.sealed))), m.plaintext);
  await assert.rejects(gd.openManifest(null, m.manifestKey, hex(m.sealed)), gd.LockedError);
});

test("share vector: open, and seal byte-for-byte with the fixed ephemeral key", async () => {
  const s = V.share;
  const id = await gd.Identity.fromPrivate(hex(s.recipientPrivate));
  assert.equal(id.public, s.recipientPublic);
  assert.equal(gd.toHex(id.privateBytes()), s.recipientPrivate);
  const f = await gd.openShareEnvelope(id, s.share);
  assert.equal(JSON.stringify(f), s.payload);
  const eph = await gd.Identity.fromPrivate(gd.fromHex(s.ephemeralPrivate + gd.toHex(gd.fromB64u(s.share.epk))));
  assert.deepEqual(await sealShare(gd.fromB64u(s.recipientPublic.slice(6)), txt(s.payload), eph, hex(s.nonce)), s.share);
  const c = new gd.Client("http://x", "gdpk_0123456789abcdef_" + "A".repeat(43));
  const other = await gd.Identity.create(c);
  await assert.rejects(gd.openShareEnvelope(other, s.share), /someone else/);
});

test("pkce vector", async () => {
  assert.equal(await gd.pkceChallenge(V.pkce.verifier), V.pkce.challenge);
});

test("operation table matches the spec; every call is at least its Rotten Apple service level", () => {
  assert.equal(gd.OPERATIONS.length, OPSPEC.operations.length);
  OPSPEC.operations.forEach((o: { id: string; level: string; service: string; risk: string; context: string }, i: number) => {
    const g = gd.OPERATIONS[i]!;
    assert.deepEqual([g.id, g.level, g.service, g.risk, g.context], [o.id, o.level, o.service, o.risk, o.context]);
    assert.ok(Number(g.level[1]) >= Number(OPSPEC.levelSource.services[o.service].level[1]), o.id);
  });
});

test("gate: default L3, environment can only lower it, garbage locks to L0", () => {
  const op = (id: string) => gd.OPERATIONS.find((o) => o.id === id)!;
  const g = gd.levelGate();
  g(op("files.deleteFolder"));
  assert.throws(() => g(op("storage.wipe")), gd.LevelError);
  process.env[gd.MAX_LEVEL_ENV] = "L2";
  assert.throws(() => gd.levelGate("L4")(op("files.deleteFolder")), gd.LevelError);
  process.env[gd.MAX_LEVEL_ENV] = "L4";
  assert.throws(() => gd.levelGate("L3")(op("storage.wipe")), gd.LevelError);
  process.env[gd.MAX_LEVEL_ENV] = "banana";
  assert.throws(() => gd.levelGate("L4")(op("usage")), gd.LevelError);
  delete process.env[gd.MAX_LEVEL_ENV];
});

test("paths and connect links", async () => {
  for (const bad of ["", "/a", "a/", "a//b", "a/../b", ".", "a\\b", "a/\x01", "x".repeat(1025)]) assert.throws(() => gd.cleanPath(bad));
  gd.cleanPath("saves/slot 1.sav");
  const p = await gd.newPKCE();
  const link = gd.connectLink({ name: "My Game" }, p, "http://127.0.0.1:5000/cb");
  const req = gd.parseConnectLink(link);
  assert.equal(req.challenge, p.challenge);
  assert.equal(req.client.name, "My Game");
  assert.throws(() => gd.connectLink({ name: "x" }, p, "https://evil.example/cb"));
  assert.throws(() => gd.parseConnectLink(link.replace("127.0.0.1", "evil.example")));
});
