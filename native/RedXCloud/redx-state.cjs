'use strict';
// One complete account ledger per durable RedX record. CAS performs only ONE
// record write, not a multi-record transaction whose crash atomicity is weaker.
const crypto = require('node:crypto');
class CloudError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function origin(value, dev = false) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' ||
      (u.protocol !== 'https:' && !(dev && u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname)))) throw new Error('HTTPS origin required (explicit loopback development only)');
  return u.origin;
}
class RedXState {
  #key;
  constructor({url, key, db, dev = false, fetchImpl = fetch}) {
    this.url = origin(url, dev);
    if (!key || !/^[a-z][a-z0-9_]{1,50}$/.test(db) || db === 'redxai_accounts') throw new Error('Separate Receiver metadata database and scoped service key required');
    this.#key = key; this.db = db; this.fetch = fetchImpl;
  }
  async call(method, route, body) {
    const r = await this.fetch(this.url + '/v1/db/' + this.db + '/' + route, {
      method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: {authorization: 'Bearer ' + this.#key, 'content-type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 404) throw new CloudError('not_found', 404);
    if (r.status === 409) throw new CloudError('concurrent_update', 409);
    if (!r.ok) throw new CloudError('metadata_unavailable', 503);
    const text = await r.text();
    if (text.length > 2 * 1024 * 1024) throw new CloudError('metadata_limit', 503);
    return text ? JSON.parse(text) : {};
  }
  address(owner) { return Number.parseInt(owner.slice(0, 13), 16); }
  async get(owner) {
    const id = this.address(owner);
    try {
      const result = await this.call('GET', 'path/' + encodeURIComponent(`receivers.red-xai.db:Receiver[ID=${id}].State`));
      const state = JSON.parse(JSON.parse(result.value));
      if (state.owner !== owner || state.id !== owner || !Number.isSafeInteger(state.revision)) throw new CloudError('metadata_collision', 503);
      return state;
    } catch (e) { if (e.status === 404) return null; throw e; }
  }
  async ensure(owner, quota) {
    const current = await this.get(owner);
    if (current) return current;
    const state = {schema: 1, owner, id: owner, revision: 0, quota, used: 0, workspaces: {}, objects: {}};
    try {
      await this.call('POST', 'bx', {q: '{Add[]} = "receivers.red-xai.db":Receiver[ID=$id] = [ {Owner[]} = $owner, {Revision[]} = 0, {State[]} = $state ]',
        params: {id: this.address(owner), owner, state: JSON.stringify(state)}});
      return state;
    } catch (e) { if (e.status === 409) { const existing = await this.get(owner); if (existing) return existing; } throw e; }
  }
  async change(owner, update) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const before = await this.get(owner);
      if (!before) throw new CloudError('receiver_not_found', 404);
      const next = structuredClone(before);
      update(next);
      next.revision = before.revision + 1;
      if (next.used < 0 || next.used > next.quota || !Number.isSafeInteger(next.used)) throw new CloudError('quota_exceeded', 507);
      const encoded = JSON.stringify(next);
      if (Buffer.byteLength(encoded) > 1024 * 1024) throw new CloudError('metadata_limit', 507);
      try {
        await this.call('POST', 'bx', {q: '{Tx[]} = [ {Require[]} = "receivers.red-xai.db":Receiver[ID=$id, Owner=$owner, Revision=$previous], {Set[]} = "receivers.red-xai.db":Receiver[ID=$id] = [ {Owner[]} = $owner, {Revision[]} = $next, {State[]} = $state ] ]',
          params: {id: this.address(owner), owner, previous: before.revision, next: next.revision, state: encoded}});
        return next;
      } catch (e) { if (e.status !== 409) throw e; }
    }
    throw new CloudError('busy_retry', 409);
  }
}
module.exports = {RedXState, CloudError, digest, origin};
