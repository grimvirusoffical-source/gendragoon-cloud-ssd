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
const MAX_QUOTA = 8 * 1024**4;
const ID = /^[a-f0-9]{32}$/;
const LIBRARY_KEY = /^[a-f0-9]{18}$/;
const SHA256 = /^[a-f0-9]{64}$/;
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
  if (!Number.isSafeInteger(quota) || quota < 1 || quota > MAX_QUOTA) throw new Error('Invalid Receiver quota');
  await directory(root);
  const lock = path.join(root, '.writer-lock');
  await fs.mkdir(lock, {mode: 0o700}); // refuse two writers or an unreconciled crash
  const store = config.store || new RedXState({url: config.redxURL, key: config.redxKey, db: config.redxDB, dev: config.dev, local: config.redxLocal === true});
  const fetchImpl = config.fetchImpl || fetch;
  const secureFetch = async (url, opts = {}) => {
    if (new URL(url).origin !== issuer) throw new CloudError('issuer_endpoint_invalid', 503);
    return fetchImpl(url, {...opts, redirect: 'error'});
  };
  const authProvider = config.authProvider || 'red-xai-accounts';
  if (!['red-xai-accounts','redx-site-session'].includes(authProvider)) throw new Error('Unsupported authentication provider');
  const entitlementURL = config.entitlementURL || null;
  if (entitlementURL) {
    const eu = new URL(entitlementURL);
    if (eu.protocol !== 'https:' || eu.username || eu.password || eu.search || eu.hash ||
        !['/v2/receiver-entitlements','/gendragoon/v2/receiver-entitlements'].includes(eu.pathname))
      throw new Error('Invalid entitlement endpoint');
  }
  const verifier = authProvider === 'red-xai-accounts'
    ? createOidcVerifier({issuer, audience: 'gendragoon', typ: 'at+jwt', fetchImpl: secureFetch})
    : null;
  const developmentOnly = config.dev === true;
  const productionReady = config.productionReady === true && !developmentOnly && authProvider === 'redx-site-session';
  const busy = new Set(); let requests = 0; let decoderBusy = false;
  async function responseJSON(response, max = 65536) {
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > max) throw new CloudError('identity_response_too_large', 503);
      chunks.push(Buffer.from(chunk));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new CloudError('identity_response_invalid', 503); }
  }
  async function identify(req) {
    const header = req.headers.authorization || '';
    if (!/^Bearer [A-Za-z0-9_.-]{1,16000}$/.test(header)) throw new CloudError('login_required', 401);
    let subject;
    try {
      if (authProvider === 'redx-site-session') {
        if (!/^Bearer rxca_[A-Za-z0-9_-]{43}$/.test(header)) throw new CloudError('invalid_or_inactive_session', 401);
        const info = await secureFetch(issuer + '/redxai-connect/userinfo', {headers: {authorization: header}, signal: AbortSignal.timeout(8000)});
        if (!info.ok) throw new CloudError('invalid_or_inactive_session', 401);
        const user = await responseJSON(info);
        if (user.protocol !== 'redx-site-session-v1' || user.client_id !== 'gendragoon' ||
            user.scope !== 'gendragoon.receiver' || typeof user.sub !== 'string' || !user.sub ||
            user.email_verified !== true) throw new CloudError('account_setup_required', 403);
        subject = user.sub;
      } else {
        const token = header.slice(7);
        const claims = await verifier.verify(token);
        const info = await secureFetch(issuer + '/oauth2/userinfo', {headers: {authorization: header}, signal: AbortSignal.timeout(8000)});
        if (!info.ok) throw new Error('inactive');
        const user = await responseJSON(info);
        if (user.sub !== claims.sub) throw new Error('subject');
        if (!user.email_verified || !['13to17', '18plus'].includes(user.age_band) ||
            (config.requiredTos && user.app_tos_version !== config.requiredTos) ||
            user.twofactor_state === 'pending') throw new CloudError('account_setup_required', 403);
        subject = claims.sub;
      }
    } catch(e) { if (e instanceof CloudError) throw e; throw new CloudError('invalid_or_inactive_session', 401); }
    return {owner: digest(JSON.stringify(['red-xai-receiver/v1', issuer, subject])), bearer: header};
  }
  async function readJSONFile(file, max = 64 * 1024) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > max) throw new CloudError('stored_object_corrupt', 503);
    const raw = await fs.readFile(file, 'utf8');
    try { return JSON.parse(raw); } catch { throw new CloudError('stored_object_corrupt', 503); }
  }
  async function writeJSONExclusive(file, value) {
    const temporary = file + '.' + crypto.randomBytes(8).toString('hex') + '.partial';
    const out = await fs.open(temporary, 'wx', 0o600);
    try { await out.writeFile(JSON.stringify(value)); await out.sync(); } finally { await out.close(); }
    try { await fs.link(temporary, file); } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async function blobDirectory(owner, workspace) {
    const dir = path.join(root, owner, workspace);
    await directory(dir);
    return dir;
  }
  async function blobRecord(owner, workspace, id) {
    const dir = await blobDirectory(owner, workspace);
    const file = path.join(dir, id + '.png'), meta = path.join(dir, id + '.json');
    let record;
    try { record = await readJSONFile(meta, 4096); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (!record || record.schema !== 1 || record.id !== id || record.workspace !== workspace
        || !Number.isSafeInteger(record.bytes) || record.bytes < 8 || record.bytes > MAX_BYTES
        || !SHA256.test(record.sha256 || '')) throw new CloudError('stored_object_corrupt', 503);
    const bytes = await existing(file, record);
    if (!bytes) throw new CloudError('stored_object_missing', 503);
    return {record, bytes, file, meta, dir};
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
  async function entitlementState(identity) {
    if (!entitlementURL) return null;
    let response;
    try {
      response = await fetchImpl(entitlementURL, {headers: {authorization: identity.bearer, accept: 'application/json'},
        redirect: 'error', signal: AbortSignal.timeout(10000)});
    } catch { throw new CloudError('entitlement_service_unavailable', 503); }
    if (response.status === 401 || response.status === 403) throw new CloudError('entitlement_login_required', 401);
    if (!response.ok) throw new CloudError('entitlement_service_unavailable', 503);
    const body = await responseJSON(response, 256 * 1024);
    if (body.schema !== 1 || !Number.isInteger(body.projectLimit) || body.projectLimit < 1 || body.projectLimit > 20 ||
        !Array.isArray(body.workspaces) || body.workspaces.length > 20) throw new CloudError('entitlement_response_invalid', 503);
    const ids = new Set();
    for (const w of body.workspaces) {
      if (!w || !ID.test(w.id || '') || ids.has(w.id) || typeof w.projectId !== 'string' ||
          typeof w.name !== 'string' || !w.name || w.name.length > 80 || /[\x00-]/.test(w.name) ||
          typeof w.active !== 'boolean' || typeof w.readOnly !== 'boolean' ||
          !Number.isSafeInteger(w.quotaBytes) || w.quotaBytes < 0 || w.quotaBytes > MAX_QUOTA ||
          !Number.isInteger(w.workers) || w.workers < 0 || w.workers > 24) throw new CloudError('entitlement_response_invalid', 503);
      ids.add(w.id);
    }
    return body;
  }
  async function syncEntitlements(owner, state, entitlement) {
    if (!entitlement) return state;
    const byId = new Map(entitlement.workspaces.map(w => [w.id, w]));
    state = await store.change(owner, s => {
      s.projectLimit = entitlement.projectLimit;
      s.ownerBenefits = entitlement.ownerBenefits === true;
      for (const [id, existing] of Object.entries(s.workspaces || {})) {
        if (existing.billingManaged === true && !byId.has(id)) Object.assign(existing, {active:false, readOnly:true, quotaBytes:0, workers:0});
      }
      for (const w of entitlement.workspaces) {
        const existing = s.workspaces[w.id] || {id:w.id, usedBytes:0};
        const used = Number.isSafeInteger(existing.usedBytes) && existing.usedBytes >= 0 ? existing.usedBytes : 0;
        s.workspaces[w.id] = {...existing, id:w.id, name:w.name, projectId:w.projectId, billingManaged:true,
          active:w.active, readOnly:w.readOnly, quotaBytes:w.quotaBytes, workers:w.workers,
          status:w.status || null, storageTier:w.storageTier || null, performanceTier:w.performanceTier || null,
          entitlementSource:w.entitlementSource || 'subscription', usedBytes:used};
      }
      const entitled = Object.values(s.workspaces).filter(w => w.billingManaged === true)
        .reduce((n,w) => n + (Number.isSafeInteger(w.quotaBytes) ? w.quotaBytes : 0), 0);
      s.quota = Math.max(s.used, entitled, 1);
    });
    return state;
  }
  function publicState(s) {
    const workspaces = Object.values(s.workspaces || {}).filter(w => !entitlementURL || w.billingManaged === true);
    const entitledQuota = entitlementURL ? workspaces.reduce((n,w) => n + (Number.isSafeInteger(w.quotaBytes) ? w.quotaBytes : 0), 0) : s.quota;
    return {id: s.id, state: 'ready', developmentOnly, storageFormat: 'redsecretsxai-png-v1', quotaBytes: entitledQuota,
      usedBytes: s.used, projectLimit:s.projectLimit || 10, ownerBenefits:s.ownerBenefits === true, workspaces,
      objects: Object.values(s.objects || {}).filter(o => o.status === 'ready'), libraryItems: Object.keys(s.library || {}).length};
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
      if (req.method === 'GET' && ['/healthz','/v1/receivers/healthz'].includes(u.pathname)) return json(res, 200, {service: 'Red-XAI-Reiceivers', developmentOnly, productionReady, authProvider});
      const identity = await identify(req), owner = identity.owner;
      const entitlement = await entitlementState(identity);
      const base = '/v1/receivers/me';
      if (u.pathname === base && req.method === 'PUT') {
        let state = await store.ensure(owner, quota);
        state = await syncEntitlements(owner, state, entitlement);
        await directory(path.join(root, owner));
        return json(res, 200, publicState(state));
      }
      let state = await store.get(owner);
      if (!state) throw new CloudError('receiver_not_found', 404);
      state = await syncEntitlements(owner, state, entitlement);
      if (u.pathname === base && req.method === 'GET') return json(res, 200, publicState(state));
      if (u.pathname === base + '/workspaces' && req.method === 'POST') {
        if (entitlementURL) throw new CloudError('create_project_through_billing', 409);
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
      const workspaceDelete = /^\/v1\/receivers\/me\/workspaces\/([a-f0-9]{32})$/.exec(u.pathname);
      if (workspaceDelete && req.method === 'DELETE') {
        const workspace = workspaceDelete[1];
        if (req.headers['x-confirm-workspace'] !== workspace) throw new CloudError('workspace_delete_confirmation_required', 409);
        const ws = state.workspaces[workspace];
        if (!ws) throw new CloudError('not_found', 404);
        if ([...busy].some(key => key.startsWith(owner + '/' + workspace + '/'))) throw new CloudError('workspace_busy', 409);
        const dir = path.join(root, owner, workspace);
        try {
          const st = await fs.lstat(dir);
          if (!st.isDirectory() || st.isSymbolicLink()) throw new CloudError('stored_object_corrupt', 503);
          await fs.rm(dir, {recursive: true, force: true});
          await fsyncDirectory(path.join(root, owner));
        } catch(e) { if (e.code !== 'ENOENT') throw e; }
        const legacy = Object.values(state.objects || {}).filter(o => o.workspace === workspace);
        for (const object of legacy) {
          const file = path.join(root, owner, object.id + '.png');
          await fs.unlink(file).catch(e => {if (e.code !== 'ENOENT') throw e;});
        }
        const freed = Number.isSafeInteger(ws.usedBytes) && ws.usedBytes >= 0 ? ws.usedBytes : 0;
        state = await store.change(owner, s => {
          const current = s.workspaces[workspace];
          if (!current) throw new CloudError('not_found', 404);
          const currentUsed = Number.isSafeInteger(current.usedBytes) && current.usedBytes >= 0 ? current.usedBytes : 0;
          if (s.used < currentUsed) throw new CloudError('quota_state_corrupt', 503);
          s.used -= currentUsed;
          for (const [id,o] of Object.entries(s.objects || {})) if (o.workspace === workspace) delete s.objects[id];
          for (const [key,item] of Object.entries(s.library || {})) if (item.workspace === workspace) delete s.library[key];
          for (const [id,r] of Object.entries(s.reservations || {})) if (r.workspace === workspace) delete s.reservations[id];
          for (const [id,d] of Object.entries(s.deletions || {})) if (d.workspace === workspace) delete s.deletions[id];
          delete s.workspaces[workspace];
        });
        return json(res, 200, {ok:true, workspace, freedBytes:freed, usedBytes:state.used});
      }
      const libraryBase = base + '/library';
      if (u.pathname === libraryBase && req.method === 'GET') {
        return json(res, 200, {items: Object.values(state.library || {}).sort((a,b) => String(a.name).localeCompare(String(b.name)))});
      }
      const libraryMatch = /^\/v1\/receivers\/me\/library\/([a-f0-9]{18})$/.exec(u.pathname);
      if (libraryMatch && req.method === 'PUT') {
        const key = libraryMatch[1];
        let body; try { body = JSON.parse((await read(req, 64 * 1024)).toString()); } catch { throw new CloudError('bad_json'); }
        const name = body.name, kind = body.kind, workspace = body.workspace, manifestId = body.manifestId;
        if (!LIBRARY_KEY.test(key) || typeof name !== 'string' || !name || name.length > 255 || /[\x00-\x1f\/\\]/.test(name)
            || !['app','folder','file'].includes(kind) || !ID.test(workspace || '') || !ID.test(manifestId || '')
            || !Number.isSafeInteger(body.archiveBytes) || body.archiveBytes < 0 || body.archiveBytes > MAX_QUOTA
            || !SHA256.test(body.archiveSha256 || '')) throw new CloudError('library_metadata_invalid', 400);
        if (!state.workspaces[workspace]) throw new CloudError('not_found', 404);
        const manifest = await blobRecord(owner, workspace, manifestId);
        if (!manifest) throw new CloudError('manifest_not_found', 409);
        const now = Date.now();
        state = await store.change(owner, s => {
          s.library ||= {};
          const previous = s.library[key];
          const generation = previous ? previous.generation + 1 : 1;
          const history = previous ? [...(previous.previous || []), {
            generation: previous.generation, manifestId: previous.manifestId, archiveBytes: previous.archiveBytes,
            archiveSha256: previous.archiveSha256, updatedMs: previous.updatedMs
          }].slice(-20) : [];
          s.library[key] = {key, name, kind, workspace, manifestId, archiveBytes: body.archiveBytes,
            archiveSha256: body.archiveSha256, generation, updatedMs: now, previous: history};
        });
        return json(res, 200, state.library[key]);
      }
      if (libraryMatch && req.method === 'DELETE') {
        const key = libraryMatch[1];
        state = await store.change(owner, s => {s.library ||= {}; if (!s.library[key]) throw new CloudError('not_found', 404); delete s.library[key];});
        return json(res, 200, {ok: true, key});
      }
      const blobMatch = /^\/v1\/receivers\/me\/workspaces\/([a-f0-9]{32})\/blobs\/([a-f0-9]{32})$/.exec(u.pathname);
      if (blobMatch) {
        const [, workspace, id] = blobMatch;
        const workspaceState = state.workspaces[workspace];
        if (!workspaceState) throw new CloudError('not_found', 404);
        if (req.method === 'GET') {
          const found = await blobRecord(owner, workspace, id);
          if (!found) throw new CloudError('not_found', 404);
          res.writeHead(200, {'content-type': 'image/png', 'content-length': found.bytes.length,
            'content-disposition': 'attachment; filename="' + id + '.png"', 'cache-control': 'no-store',
            'x-content-sha256': found.record.sha256, 'x-content-type-options': 'nosniff'});
          return res.end(found.bytes);
        }
        if (req.method === 'DELETE') {
          const deleteKey = owner + '/' + workspace + '/' + id;
          if (busy.has(deleteKey)) throw new CloudError('upload_busy', 409);
          busy.add(deleteKey);
          try {
            const dir = await blobDirectory(owner, workspace);
            const file = path.join(dir, id + '.png'), meta = path.join(dir, id + '.json');
            let deletion = state.deletions?.[id];
            if (!deletion) {
              let record;
              try { record = await readJSONFile(meta, 4096); }
              catch (e) { if (e.code === 'ENOENT') throw new CloudError('not_found', 404); throw e; }
              if (!record || record.schema !== 1 || record.id !== id || record.workspace !== workspace
                  || !Number.isSafeInteger(record.bytes) || record.bytes < 8 || record.bytes > MAX_BYTES
                  || !SHA256.test(record.sha256 || '')) throw new CloudError('stored_object_corrupt', 503);
              const existingBlob = await existing(file, record);
              if (!existingBlob) throw new CloudError('stored_object_missing', 503);
              deletion = {workspace, bytes: record.bytes, sha256: record.sha256};
              state = await store.change(owner, s => {
                s.deletions ||= {};
                if (s.deletions[id]) throw new CloudError('busy_retry', 409);
                s.deletions[id] = deletion;
              });
            } else if (deletion.workspace !== workspace || !Number.isSafeInteger(deletion.bytes)
                       || deletion.bytes < 8 || deletion.bytes > MAX_BYTES || !SHA256.test(deletion.sha256 || '')) {
              throw new CloudError('quota_state_corrupt', 503);
            }
            await fs.unlink(meta).catch(e => {if (e.code !== 'ENOENT') throw e;});
            await fs.unlink(file).catch(e => {if (e.code !== 'ENOENT') throw e;});
            await fsyncDirectory(dir);
            state = await store.change(owner, s => {
              s.deletions ||= {}; s.reservations ||= {};
              const d = s.deletions[id];
              if (!d || d.workspace !== workspace || d.bytes !== deletion.bytes || d.sha256 !== deletion.sha256) throw new CloudError('quota_state_corrupt', 503);
              if (s.used < deletion.bytes) throw new CloudError('quota_state_corrupt', 503);
              s.used -= deletion.bytes;
              if(s.workspaces[workspace])s.workspaces[workspace].usedBytes=Math.max(0,(s.workspaces[workspace].usedBytes||0)-deletion.bytes);
              delete s.deletions[id];
              delete s.reservations[id];
            });
            return json(res, 200, {ok: true, id, freedBytes: deletion.bytes, usedBytes: state.used});
          } finally { busy.delete(deleteKey); }
        }
        if (req.method !== 'PUT') throw new CloudError('method_not_allowed', 405);
        if (entitlementURL && (workspaceState.active !== true || workspaceState.readOnly === true || workspaceState.quotaBytes <= 0))
          throw new CloudError('workspace_subscription_required', 402);
        const bytes = Number(req.headers['content-length']), sha256 = req.headers['x-content-sha256'];
        if (req.headers['content-type'] !== 'image/png') throw new CloudError('png_required', 415);
        if (!Number.isSafeInteger(bytes) || bytes < 8 || bytes > MAX_BYTES || !SHA256.test(sha256 || '')) throw new CloudError('invalid_size_or_hash', 400);
        const busyKey = owner + '/' + workspace + '/' + id;
        if (busy.has(busyKey)) throw new CloudError('upload_busy', 409);
        busy.add(busyKey);
        let reserved = false, installed = false, blobLinked = false, metaLinked = false;
        let temporary, metaTemporary, file, meta;
        try {
          const dir = await blobDirectory(owner, workspace);
          file = path.join(dir, id + '.png'); meta = path.join(dir, id + '.json');
          let prior = null;
          try { prior = await readJSONFile(meta, 4096); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          if (prior) {
            if (prior.id !== id || prior.workspace !== workspace || prior.bytes !== bytes || prior.sha256 !== sha256) throw new CloudError('immutable_object_conflict', 409);
            const existingBlob = await existing(file, prior);
            if (!existingBlob) throw new CloudError('stored_object_missing', 503);
            const stale = state.reservations?.[id];
            if (stale && stale.workspace === workspace && stale.bytes === bytes && stale.sha256 === sha256) {
              state = await store.change(owner, s => {s.reservations ||= {}; const r=s.reservations[id]; if(r&&r.workspace===workspace&&r.bytes===bytes&&r.sha256===sha256)delete s.reservations[id];});
            }
            req.resume(); return json(res, 200, {id, status: 'ready', reused: true, bytes, sha256});
          }
          // A final PNG without its sidecar is not a committed object. Only
          // remove it when the durable reservation proves it belongs to this
          // exact interrupted immutable upload; otherwise retain for review.
          try {
            const orphan = await fs.lstat(file);
            if (orphan.isSymbolicLink() || !orphan.isFile()) throw new CloudError('stored_object_corrupt', 503);
            const r = state.reservations?.[id];
            if (!r || r.workspace !== workspace || r.bytes !== bytes || r.sha256 !== sha256) throw new CloudError('orphan_object_requires_review', 503);
            await fs.unlink(file); await fsyncDirectory(dir);
          } catch (e) { if (e.code !== 'ENOENT') throw e; }
          state = await store.change(owner, s => {
            s.reservations ||= {};
            const old = s.reservations[id];
            if (old) {
              if (old.workspace !== workspace || old.bytes !== bytes || old.sha256 !== sha256) throw new CloudError('upload_busy', 409);
              // Interrupted prior writer; this reservation already counts quota.
            } else {
              const ws=s.workspaces[workspace];
              if (!ws) throw new CloudError('not_found',404);
              const wsUsed=Number.isSafeInteger(ws.usedBytes)?ws.usedBytes:0;
              if (entitlementURL && wsUsed + bytes > ws.quotaBytes) throw new CloudError('quota_exceeded', 507);
              if (s.used + bytes > s.quota) throw new CloudError('quota_exceeded', 507);
              s.used += bytes; ws.usedBytes = wsUsed + bytes;
              s.reservations[id] = {workspace, bytes, sha256};
            }
          });
          reserved = true;
          const stats = await fs.statfs(root);
          if (Number(stats.bavail) * Number(stats.bsize) < bytes * 2 + 2 * 1024**3) throw new CloudError('disk_reserve', 507);
          const body = await read(req, bytes);
          if (body.length !== bytes || digest(body) !== sha256) throw new CloudError('upload_hash_mismatch', 422);
          temporary = path.join(dir, '.' + id + '.' + crypto.randomBytes(8).toString('hex') + '.partial');
          const output = await fs.open(temporary, 'wx', 0o600);
          try { await output.writeFile(body); await output.sync(); } finally { await output.close(); }
          await validatePNG(temporary);
          await fs.link(temporary, file); blobLinked = true;
          const record = {schema: 1, id, workspace, bytes, sha256, encoding: 'redsecretsxai-png-v1'};
          metaTemporary = path.join(dir, '.' + id + '.' + crypto.randomBytes(8).toString('hex') + '.json.partial');
          const mf = await fs.open(metaTemporary, 'wx', 0o600);
          try { await mf.writeFile(JSON.stringify(record)); await mf.sync(); } finally { await mf.close(); }
          await fs.link(metaTemporary, meta); metaLinked = true;
          await fsyncDirectory(dir);
          installed = true;
          await store.change(owner, s => {s.reservations ||= {}; delete s.reservations[id];});
          return json(res, 201, {id, status: 'ready', bytes, sha256});
        } finally {
          if (temporary) await fs.unlink(temporary).catch(() => {});
          if (metaTemporary) await fs.unlink(metaTemporary).catch(() => {});
          if (!installed) {
            if (metaLinked && meta) await fs.unlink(meta).catch(() => {});
            if (blobLinked && file) await fs.unlink(file).catch(() => {});
          }
          if (reserved && !installed) await store.change(owner, s => {
            s.reservations ||= {};
            const r = s.reservations[id];
            if (r && r.workspace === workspace && r.bytes === bytes && r.sha256 === sha256) {
              s.used -= bytes; if(s.workspaces[workspace])s.workspaces[workspace].usedBytes=Math.max(0,(s.workspaces[workspace].usedBytes||0)-bytes);
              delete s.reservations[id];
            }
          }).catch(() => {});
          busy.delete(busyKey);
        }
      }
      const match = /^\/v1\/receivers\/me\/workspaces\/([a-f0-9]{32})\/objects\/([a-f0-9]{32})$/.exec(u.pathname);
      if (!match) throw new CloudError('not_found', 404);
      const [, workspace, id] = match;
      const objectWorkspace = state.workspaces[workspace];
      if (!objectWorkspace) throw new CloudError('not_found', 404);
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
      if (entitlementURL && (objectWorkspace.active !== true || objectWorkspace.readOnly === true || objectWorkspace.quotaBytes <= 0))
        throw new CloudError('workspace_subscription_required', 402);
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
        if (reserved && !installed) await store.change(owner, s => {if (s.objects[id]?.status === 'uploading') {
          const b=s.objects[id].bytes;s.used-=b;if(s.workspaces[workspace])s.workspaces[workspace].usedBytes=Math.max(0,(s.workspaces[workspace].usedBytes||0)-b);delete s.objects[id];
        }}).catch(() => {});
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
  const dev = process.env.REDXAI_LOOPBACK_DEV === '1';
  const productionReady = process.env.REDXAI_RECEIVER_PRODUCTION_READY === '1';
  if (!productionReady && process.env.REDXAI_CLOUD_PREVIEW !== '1') { console.error('Set REDXAI_CLOUD_PREVIEW=1 for private testing or REDXAI_RECEIVER_PRODUCTION_READY=1 for reviewed production startup.'); process.exit(2); }
  if (productionReady && dev) { console.error('Production readiness cannot be combined with loopback development mode.'); process.exit(2); }
  createCloud({issuer: process.env.REDXAI_ISSUER, dev, productionReady, authProvider: process.env.REDXAI_AUTH_PROVIDER || 'red-xai-accounts', redxURL: process.env.REDX_URL,
    redxLocal: process.env.REDX_LOCAL_LOOPBACK === '1', entitlementURL: process.env.REDX_ENTITLEMENT_URL || null,
    redxKey: process.env.REDX_RECEIVERS_KEY, redxDB: process.env.REDX_RECEIVERS_DB || 'gendragoon_receivers', root: process.env.REDX_RECEIVERS_ROOT,
    quota: Number(process.env.REDX_RECEIVER_QUOTA_BYTES || 64 * 1024 * 1024), python: process.env.REDX_PYTHON || 'python3', requiredTos: process.env.REDXAI_REQUIRED_TOS}).then(async cloud => {
      console.log('Red-XAI-Reiceivers ' + (productionReady ? 'PRODUCTION' : 'PRIVATE PREVIEW') + ': ' + await cloud.listen(Number(process.env.REDX_CLOUD_PORT || 17779)));
      for (const sig of ['SIGINT','SIGTERM']) process.once(sig, () => cloud.close().then(() => process.exit(0)));
  }).catch(() => {console.error('Cloud preview startup failed; verify configuration and storage lock. No secrets logged.'); process.exitCode=1;});
}
module.exports = {createCloud, MAX_BYTES};
