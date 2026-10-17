import assert from "node:assert/strict";
import fs from "node:fs";
import {mkdtemp, readFile, readdir, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn, spawnSync} from "node:child_process";
import {Writable} from "node:stream";
import test from "node:test";
import {GenDragoon} from "../gendragoon.mjs";

const KEY = "gdsk_disposable_sdk_fixture";
const FETCH = globalThis.fetch;

async function fixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), "gd-sdk-js-"));
  const client = new GenDragoon(KEY, "https://fixture.invalid");
  try {
    await callback({directory, client, destination: join(directory, "download")});
  } finally {
    globalThis.fetch = FETCH;
    await rm(directory, {recursive: true, force: true});
  }
}

async function assertClean(directory) {
  assert.deepEqual((await readdir(directory)).filter(name => name.startsWith(".gendragoon-download-")), []);
}

test("complete streamed download publishes private bytes only after completion", {timeout: 3000}, () => fixture(async ({client, destination, directory}) => {
  globalThis.fetch = async (url, options) => {
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer " + KEY);
    assert.equal(options.headers["Accept-Encoding"], "identity");
    assert.equal(options.signal.aborted, false);
    assert.equal(fs.existsSync(destination), false);
    return new Response("file data", {headers: {"Content-Length": "9"}});
  };
  assert.equal(await client.download("file/id", destination), destination);
  assert.equal(await readFile(destination, "utf8"), "file data");
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  await assertClean(directory);
}));

test("JSON files remain raw downloads instead of being parsed as API metadata", () => fixture(async ({client, destination}) => {
  globalThis.fetch = async () => new Response('{"raw":true}', {headers: {"Content-Type": "application/json", "Content-Length": "12"}});
  await client.download("id", destination);
  assert.equal(await readFile(destination, "utf8"), '{"raw":true}');
}));

test("existing destinations and dangling symlinks reject before any request", () => fixture(async ({client, destination, directory}) => {
  await writeFile(destination, "keep original");
  const dangling = join(directory, "dangling");
  await symlink(join(directory, "absent"), dangling);
  globalThis.fetch = () => { assert.fail("Network request must not start for an existing destination"); };
  for (const path of [destination, dangling]) {
    await assert.rejects(client.download("id", path), {code: "EEXIST"});
  }
  assert.equal(await readFile(destination, "utf8"), "keep original");
  assert.equal(fs.lstatSync(dangling).isSymbolicLink(), true);
  await assertClean(directory);
}));

test("concurrently created destination wins without being removed or overwritten", () => fixture(async ({client, destination, directory}) => {
  globalThis.fetch = async () => {
    await writeFile(destination, "concurrent owner data");
    return new Response("new bytes", {headers: {"Content-Length": "9"}});
  };
  await assert.rejects(client.download("id", destination), {code: "EEXIST"});
  assert.equal(await readFile(destination, "utf8"), "concurrent owner data");
  await assertClean(directory);
}));

test("simultaneous downloads publish exactly one complete result", {timeout: 3000}, () => fixture(async ({client, destination, directory}) => {
  const pending = [];
  globalThis.fetch = () => new Promise(resolve => {
    pending.push(resolve);
    if (pending.length === 2) {
      for (const finish of pending) finish(new Response("winner bytes", {headers: {"Content-Length": "12"}}));
    }
  });
  const results = await Promise.allSettled([client.download("id", destination), client.download("id", destination)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected");
  assert.equal(rejected.reason.code, "EEXIST");
  assert.equal(await readFile(destination, "utf8"), "winner bytes");
  await assertClean(directory);
}));

test("truncated and excess bodies never publish partial output", {timeout: 3000}, () => fixture(async ({client, destination, directory}) => {
  for (const length of ["20", "1"]) {
    globalThis.fetch = async () => new Response("data", {headers: {"Content-Length": length}});
    await assert.rejects(client.download("id", destination), /Incomplete download|exceeds its Content-Length/);
    assert.equal(fs.existsSync(destination), false);
    await assertClean(directory);
  }
}));

test("invalid Content-Length and encoded responses fail closed", () => fixture(async ({client, destination, directory}) => {
  for (const headers of [
    {"Content-Length": "1, 1"}, {"Content-Length": "invalid"},
    {"Content-Length": "9007199254740992"},
    {"Content-Length": "4", "Content-Encoding": "gzip"},
    {"Content-Length": "4", "Content-Encoding": "identity, gzip"},
  ]) {
    globalThis.fetch = async () => new Response("data", {headers});
    await assert.rejects(client.download("id", destination), /Invalid download Content-Length|Encoded download/);
    assert.equal(fs.existsSync(destination), false);
    await assertClean(directory);
  }
}));

test("unknown and zero content lengths are supported", () => fixture(async ({client, destination, directory}) => {
  globalThis.fetch = async () => new Response("unknown length");
  await client.download("id", destination);
  assert.equal(await readFile(destination, "utf8"), "unknown length");
  const empty = join(directory, "empty");
  globalThis.fetch = async () => new Response(new Uint8Array(), {headers: {"Content-Length": "0"}});
  await client.download("id", empty);
  assert.equal((await readFile(empty)).length, 0);
  await assertClean(directory);
}));

test("network stream errors reject without hanging or deleting concurrent files", {timeout: 3000}, () => fixture(async ({client, destination, directory}) => {
  globalThis.fetch = async () => {
    await writeFile(destination, "keep concurrent data");
    return new Response(new ReadableStream({
      start(controller) { controller.error(Error("fixture stream reset")); }
    }));
  };
  await assert.rejects(client.download("id", destination), /fixture stream reset/);
  assert.equal(await readFile(destination, "utf8"), "keep concurrent data");
  await assertClean(directory);
}));

test("asynchronous output errors reject through pipeline without unhandled errors", {timeout: 3000}, () => fixture(async ({client, destination, directory}) => {
  globalThis.fetch = async () => new Response("data");
  const original = fs.createWriteStream;
  fs.createWriteStream = () => new Writable({write(chunk, encoding, callback) { callback(Error("fixture disk full")); }});
  try {
    await assert.rejects(client.download("id", destination), /fixture disk full/);
  } finally {
    fs.createWriteStream = original;
  }
  assert.equal(fs.existsSync(destination), false);
  await assertClean(directory);
}));

test("HTTP failure explanation is bounded, redacted, and staging is removed", () => fixture(async ({client, destination, directory}) => {
  globalThis.fetch = async () => new Response(KEY + " " + "x".repeat(5000), {status: 503});
  await assert.rejects(client.download("id", destination), error => {
    assert.match(error.message, /HTTP 503/);
    assert.equal(error.message.includes(KEY), false);
    assert.ok(error.message.length < 900);
    return true;
  });
  assert.equal(fs.existsSync(destination), false);
  await assertClean(directory);
}));

test("HTTP errors redact an echoed key crossing the display boundary", () => fixture(async ({client}) => {
  for (const body of ["x".repeat(790) + KEY + "suffix", KEY.repeat(2) + "x".repeat(800 - 2 * KEY.length - 6) + KEY]) {
    globalThis.fetch = async () => new Response(body, {status: 503});
    await assert.rejects(client.status(), error => {
      assert.equal(error.message.includes("gdsk_"), false);
      assert.ok(error.message.length < 850);
      return true;
    });
  }
}));

test("endpoint validation rejects HTTP and URL credentials", () => {
  for (const base of ["http://example.test", "https://user:password@example.test", "https://example.test/?secret=x", "https://example.test/#fragment"]) {
    assert.throws(() => new GenDragoon(KEY, base), /HTTPS endpoint/);
  }
});

test("real local HTTPS verifies trust and blocks cross-origin/downgrade redirects", {timeout: 20000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gd-sdk-js-tls-"));
  try {
    const certificate = join(directory, "cert.pem"), privateKey = join(directory, "key.pem");
    const generated = spawnSync("openssl", [
      "req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1",
      "-keyout", privateKey, "-out", certificate, "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ], {stdio: "ignore", timeout: 10000});
    assert.equal(generated.status, 0, "OpenSSL fixture certificate generation failed");
    fs.chmodSync(privateKey, 0o600);
    const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "tls-fixture.mjs");
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fixturePath], {
        env: {...process.env, NODE_EXTRA_CA_CERTS: certificate, GD_SDK_TEST_CERT: certificate, GD_SDK_TEST_KEY: privateKey},
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk.toString().slice(0, 2000); });
      child.stderr.on("data", chunk => { output += chunk.toString().slice(0, 2000); });
      const deadline = setTimeout(() => { child.kill("SIGKILL"); reject(Error("TLS fixture timed out")); }, 15000);
      child.on("error", error => { clearTimeout(deadline); reject(error); });
      child.on("exit", code => {
        clearTimeout(deadline);
        if (code === 0) resolve(); else reject(Error(`TLS fixture failed (${code}): ${output}`));
      });
    });
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
