'use strict';
// Private development integration, deliberately separate from the serving
// Firebase backend. No cloud resource purchase, migration, or paid entitlement.
const fs = require('node:fs/promises');
const syncFS = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {createOidcVerifier} = require('../Backend/accounts/oidc');
const {RedXState, CloudError, digest, origin} = require('./redx-state.cjs');
const exec = promisify(execFile);
const MAX_BYTES = 8 * 1024 * 1024;
const ID = /^[a-f0-9]{32}$/;
const json = (res, status, data) => { res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'}); res.end(JSON.stringify(data)); };
async function read(req, max) {
  const chunks = []; let n = 0;
  for await (const chunk of req) { n += chunk.length; if (n > max) throw new CloudError('body_too_large', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function directory(p) {
  await fs.mkdir(p, {recursive: true, mode: 0o700});
  const stat = await fs.lstat(p);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022)) throw new Error('Unsafe storage directory');
  if (await fs.realpath(p) !== path.resolve(p)) throw new Error('Storage path must not contain symlinks');
}
async function fsyncDirectory(p) { const f = await fs.open(p, 'r'); try { await f.sync(); } finally { await f.close(); } }
async function createCloud(config) {
  // Restrict this preview to loopback. Public deployment needs the documented
  // readiness gates, rate limiting, TLS and paid entitlement integration.
  const issuer = origin(config.issuer, config.dev);
  const root = path.resolve(config.root);
  const quota = config.quota ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(quota) || quota < 1 || quota > 1024**3) throw new Error('Invalid development quota');
  await directory(root);
  const lock = path.join(root, '.writer-lock');
  await fs.mkdir(lock, {mode: 0o700}); // refuse two writers or an unreconciled crash
  const store = config.store || new RedXState({url: config.redxURL, key: config.redxKey, db: config.redxDB, dev: config.dev});
  const secureFetch = async (url, opts = {}) => {
    if (new URL(url).origin !== issuer) throw new CloudError('issuer_endpoint_invalid', 503);
    return fetch(url, {...opts, redirect: 'error'});
  };
  const verifier = createOidcVerifier({issuer, audience: 'gendragoon', typ: 'at+jwt', fetchImpl: secureFetch});
  const busy = new Set(); let requests = 0; let decoderBusy = false;
  async function identify(req) {
    const header = req.headers.authorization || '';
    if (!/^Bearer [A-Za-z0-9_.-]{1,16000}$/.test(header)) throw new CloudError('login_required', 401);
    const token = header.slice(7);
    let claims;
    try {
      claims = await verifier.verify(token);
      const info = await secureFetch(issuer + '/oauth2/userinfo', {headers: {authorization: header}, signal: AbortSignal.timeout(8000)});
      if (!info.ok) throw new Error('inactive');
      const user = await info.json();
      if (user.sub !== claims.sub) throw new Error('subject');
      if (!user.email_verified || !['13to17', '18plus'].includes(user.age_band) ||
          (config.requiredTos && user.app_tos_version !== config.requiredTos) ||
          user.twofactor_state === 'pending') throw new CloudError('account_setup_required', 403);
    } catch(e) { if (e instanceof CloudError) throw e; throw new CloudError('invalid_or_inactive_session', 401); }
    return digest(JSON.stringify(['red-xai-receiver/v1', issuer, claims.sub]));
  }
  async function validatePNG(file) {
    if (decoderBusy) throw new CloudError('decoder_busy_retry', 503);
    decoderBusy = true;
    try {
      const {stdout} = await exec(config.python || 'python3', [path.join(__dirname, 'png-carrier.py'), file], {
        timeout: 25000, maxBuffer: 16384, env: {...process.env, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1'},
      });
      const v = JSON.parse(stdout);
      if (v.format !== 'redsecretsxai-png-v1') throw new Error('format');
    } catch(e) { throw new CloudError('invalid_redx_png_carrier', 422); }
    finally { decoderBusy = false; }
  }
  function publicState(s) {
    return {id: s.id, state: 'ready', developmentOnly: true, storageFormat: 'redsecretsxai-png-v1', quotaBytes: s.quota,
      usedBytes: s.used, workspaces: Object.values(s.workspaces), objects: Object.values(s.objects).filter(o => o.status === 'ready')};
  }
  async function existing(file, entry) {
    try {
      const st = await fs.lstat(file);
      if (!st.isFile() || st.isSymbolicLink() || st.size !== entry.bytes || st.size > MAX_BYTES) throw new CloudError('stored_object_corrupt', 503);
      const b = await fs.readFile(file);
      if (digest(b) !== entry.sha256) throw new CloudError('stored_object_corrupt', 503);
      return b;
    } catch(e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  const server = http.createServer(async (req, res) => {
    requests++;
    try {
      if (requests > 8) throw new CloudError('busy_retry', 503);
      const host = req.headers.host;
      if (host !== '127.0.0.1:' + server.address().port || req.headers.origin) throw new CloudError('invalid_origin', 403);
      const u = new URL(req.url, 'http://' + host);
      if (u.search || /%|\\|\.\./.test(req.url)) throw new CloudError('invalid_path', 400);
      if (req.method === 'GET' && u.pathname === '/healthz') return json(res, 200, {service: 'Red-XAI-Reiceivers', developmentOnly: true, productionReady: false});
      const owner = await identify(req);
      const base = '/v1/receivers/me';
      if (u.pathname === base && req.method === 'PUT') {
        const state = await store.ensure(owner, quota);
        await directory(path.join(root, owner));
        return json(res, 200, publicState(state));
      }
      let state = await store.get(owner);
      if (!state) throw new CloudError('receiver_not_found', 404);
      if (u.pathname === base && req.method === 'GET') return json(res, 200, publicState(state));
      if (u.pathname === base + '/workspaces' && req.method === 'POST') {
        const id = req.headers['idempotency-key'];
        if (!ID.test(id || '')) throw new CloudError('idempotency_key_required');
        let body; try { body = JSON.parse((await read(req, 4096)).toString()); } catch(e) { throw new CloudError('bad_json'); }
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80 || /[\x00-\x1f]/.test(body.name)) throw new CloudError('workspace_name_invalid');
        state = await store.change(owner, s => {
          if (s.workspaces[id]) { if (s.workspaces[id].name !== body.name) throw new CloudError('idempotency_conflict', 409); return; }
          if (Object.keys(s.workspaces).length >= 10) throw new CloudError('workspace_limit', 409);
          s.workspaces[id] = {id, name: body.name};
        });
        return json(res, 200, state.workspaces[id]);
      }
      const match = /^\/v1\/receivers\/me\/workspaces\/([a-f0-9]{32})\/objects\/([a-f0-9]{32})$/.exec(u.pathname);
      if (!match) throw new CloudError('not_found', 404);
      const [, workspace, id] = match;
      if (!state.workspaces[workspace]) throw new CloudError('not_found', 404);
      const dir = path.join(root, owner); await directory(dir);
      const file = path.join(dir, id + '.png');
      if (req.method === 'GET') {
        const entry = state.objects[id];
        if (!entry || entry.workspace !== workspace || entry.status !== 'ready') throw new CloudError('not_found', 404);
        const bytes = await existing(file, entry);
        if (!bytes) throw new CloudError('stored_object_missing', 503);
        res.writeHead(200, {'content-type': 'application/octet-stream', 'content-length': bytes.length, 'content-disposition': 'attachment; filename="' + id + '.png"', 'cache-control': 'no-store', 'x-content-sha256': entry.sha256, 'x-content-type-options': 'nosniff'});
        return res.end(bytes);
      }
      if (req.method !== 'PUT') throw new CloudError('method_not_allowed', 405);
      const bytes = Number(req.headers['content-length']), sha256 = req.headers['x-content-sha256'];
      if (req.headers['content-type'] !== 'image/png') throw new CloudError('png_required', 415);
      if (!Number.isSafeInteger(bytes) || bytes < 8 || bytes > MAX_BYTES || !/^[a-f0-9]{64}$/.test(sha256 || '')) throw new CloudError('invalid_size_or_hash', 400);
      const key = owner + '/' + id;
      if (busy.has(key)) throw new CloudError('upload_busy', 409);
      busy.add(key);
      let temporary, reserved = false, installed = false;
      try {
        const previous = state.objects[id];
        if (previous && (previous.sha256 !== sha256 || previous.bytes !== bytes || previous.workspace !== workspace)) throw new CloudError('immutable_object_conflict', 409);
        if (previous) {
          const data = await existing(file, previous);
          if (data) {
            if (previous.status !== 'ready') await store.change(owner, s => {s.objects[id].status = 'ready';});
            req.resume(); return json(res, 200, {id, status: 'ready', reused: true});
          }
          if (previous.status === 'ready') throw new CloudError('stored_object_missing', 503);
          // No active writer: safely release an interrupted reservation with no final object.
          await store.change(owner, s => {s.used -= s.objects[id].bytes; delete s.objects[id];});
        }
        const stats = await fs.statfs(root);
        if (Number(stats.bavail) * Number(stats.bsize) < bytes * 2 + 2 * 1024**3) throw new CloudError('disk_reserve', 507);
        await store.change(owner, s => {
          if (Object.keys(s.objects).length >= 1000) throw new CloudError('object_limit', 507);
          if (s.objects[id]) throw new CloudError('upload_busy', 409);
          s.used += bytes; s.objects[id] = {id, workspace, bytes, sha256, status: 'uploading', encoding: 'redsecretsxai-png-v1'};
        });
        reserved = true;
        const body = await read(req, bytes);
        if (body.length !== bytes || digest(body) !== sha256) throw new CloudError('upload_hash_mismatch', 422);
        temporary = path.join(dir, '.' + id + '.' + crypto.randomBytes(8).toString('hex') + '.partial');
        const output = await fs.open(temporary, 'wx', 0o600);
        try { await output.writeFile(body); await output.sync(); } finally { await output.close(); }
        await validatePNG(temporary);
        await fs.link(temporary, file); installed = true; await fsyncDirectory(dir);
        await store.change(owner, s => {s.objects[id].status = 'ready';});
        return json(res, 201, {id, status: 'ready', bytes, sha256});
      } finally {
        if (temporary) await fs.unlink(temporary).catch(() => {});
        // Never release the quota after an uncertain final metadata commit: the
        // durable object can be reconciled by retrying its immutable ID + hash.
        if (reserved && !installed) await store.change(owner, s => {if (s.objects[id]?.status === 'uploading') {s.used -= s.objects[id].bytes; delete s.objects[id];}}).catch(() => {});
        busy.delete(key);
      }
    } catch(e) {
      if (!res.headersSent) json(res, e instanceof CloudError ? e.status : 503, {error: e instanceof CloudError ? e.code : 'service_unavailable'});
      else res.destroy();
    } finally { requests--; }
  });
  server.requestTimeout = 60000; server.headersTimeout = 10000;
  server.maxHeadersCount = 30;
  return {
    server, store,
    async listen(port = 0) { await new Promise((resolve,reject) => {server.once('error',reject);server.listen(port,'127.0.0.1',resolve);}); return 'http://127.0.0.1:' + server.address().port; },
    async close() { await new Promise(resolve => server.close(resolve)); await fs.rmdir(lock); },
  };
}
if (require.main === module) {
  if (process.env.REDXAI_CLOUD_PREVIEW !== '1') { console.error('This is a private integration preview, not the production GenDragoon backend. Set REDXAI_CLOUD_PREVIEW=1 explicitly.'); process.exit(2); }
  createCloud({issuer: process.env.REDXAI_ISSUER, dev: process.env.REDXAI_LOOPBACK_DEV === '1', redxURL: process.env.REDX_URL,
    redxKey: process.env.REDX_RECEIVERS_KEY, redxDB: process.env.REDX_RECEIVERS_DB || 'gendragoon_receivers', root: process.env.REDX_RECEIVERS_ROOT,
    python: process.env.REDX_PYTHON || 'python3', requiredTos: process.env.REDXAI_REQUIRED_TOS}).then(async cloud => {
      console.log('Red-XAI-Reiceivers PRIVATE PREVIEW: ' + await cloud.listen(Number(process.env.REDX_CLOUD_PORT || 17779)));
      for (const sig of ['SIGINT','SIGTERM']) process.once(sig, () => cloud.close().then(() => process.exit(0)));
  }).catch(() => {console.error('Cloud preview startup failed; verify configuration and storage lock. No secrets logged.'); process.exitCode=1;});
}
module.exports = {createCloud, MAX_BYTES};
