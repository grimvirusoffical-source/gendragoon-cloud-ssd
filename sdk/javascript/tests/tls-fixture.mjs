// Invoked by the test runner in a fresh Node process so its generated fixture
// CA is configured before Node's verified fetch transport starts.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import {spawnSync} from "node:child_process";
import {dirname, join} from "node:path";
import {GenDragoon} from "../gendragoon.mjs";

const cert = await fs.readFile(process.env.GD_SDK_TEST_CERT);
const key = await fs.readFile(process.env.GD_SDK_TEST_KEY);
const servers = [];
const listen = server => new Promise(resolve => { servers.push(server); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
let redirectedRequests = 0;
try {
  const target = (req, res) => { redirectedRequests++; res.end("must not receive credentials"); };
  const secureTarget = await listen(https.createServer({cert, key}, target));
  const insecureTarget = await listen(http.createServer(target));
  const origin = await listen(https.createServer({cert, key}, (req, res) => {
    assert.equal(req.headers.authorization, "Bearer gdsk_disposable_sdk_fixture");
    if (req.url === "/redirect" || req.url === "/downgrade") {
      const location = req.url === "/redirect" ? `https://127.0.0.1:${secureTarget}/capture` : `http://127.0.0.1:${insecureTarget}/capture`;
      res.writeHead(302, {Location: location, "Content-Length": "0"});
      res.end();
    } else if (req.url.includes("/short/")) {
      res.writeHead(200, {"Content-Length": "100", Connection: "close"});
      res.end("short body");
    } else {
      res.writeHead(200, {"Content-Type": "application/json", "Content-Length": "14"});
      res.end('{"ready":true}');
    }
  }));
  const base = `https://127.0.0.1:${origin}`;
  const client = new GenDragoon("gdsk_disposable_sdk_fixture", base);
  assert.deepEqual(await client.status(), {ready: true});
  const downloaded = join(dirname(process.env.GD_SDK_TEST_CERT), "downloaded.json");
  await client.download("complete", downloaded);
  assert.equal(await fs.readFile(downloaded, "utf8"), '{"ready":true}');
  const incomplete = join(dirname(process.env.GD_SDK_TEST_CERT), "incomplete");
  await assert.rejects(client.download("short", incomplete));
  await assert.rejects(fs.stat(incomplete), {code: "ENOENT"});
  assert.deepEqual((await fs.readdir(dirname(downloaded))).filter(name => name.startsWith(".gendragoon-download-")), []);
  for (const path of ["/redirect", "/downgrade"]) {
    await assert.rejects(client.request("GET", path), /fetch failed/);
  }
  assert.equal(redirectedRequests, 0);

  // A second self-signed identity is deliberately NOT in NODE_EXTRA_CA_CERTS.
  const untrustedCert = join(dirname(process.env.GD_SDK_TEST_CERT), "untrusted.pem");
  const untrustedKey = join(dirname(process.env.GD_SDK_TEST_CERT), "untrusted-key.pem");
  const generated = spawnSync("openssl", [
    "req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1",
    "-keyout", untrustedKey, "-out", untrustedCert, "-subj", "/CN=untrusted",
    "-addext", "subjectAltName=IP:127.0.0.1",
  ], {stdio: "ignore", timeout: 5000});
  assert.equal(generated.status, 0);
  const untrusted = await listen(https.createServer({cert: await fs.readFile(untrustedCert), key: await fs.readFile(untrustedKey)}, target));
  await assert.rejects(new GenDragoon("gdsk_disposable_sdk_fixture", `https://127.0.0.1:${untrusted}`).status(), /fetch failed/);
  assert.equal(redirectedRequests, 0);
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  })));
}
