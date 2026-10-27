'use strict';
const crypto = require('node:crypto');
const {CloudError} = require('./redx-state.cjs');
const ID = /^[a-f0-9]{32}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PLATFORMS = new Set(['macos', 'windows', 'linux', 'android', 'ios', 'other']);
const MAX_PER_WORKSPACE = 20;
const of = (state,workspace) => state.deviceAssignments?.[workspace] || {};

function visible(state,workspace) {
  return Object.values(of(state,workspace)).map(({id,name,platform,createdMs})=>({id,name,platform,createdMs}));
}
function attach(state,workspace,input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 80 || Array.from(name).some(c=>c.charCodeAt(0)<32))
    throw new CloudError('device_name_invalid',400);
  if (!PLATFORMS.has(input?.platform)) throw new CloudError('device_platform_invalid',400);
  state.deviceAssignments ||= {};
  const assigned = state.deviceAssignments[workspace] ||= {};
  if (Object.keys(assigned).length >= MAX_PER_WORKSPACE) throw new CloudError('device_limit',409);
  const id = crypto.randomBytes(16).toString('hex');
  const credential = crypto.randomBytes(32).toString('base64url');
  const createdMs = Date.now();
  assigned[id] = {id,name,platform:input.platform,createdMs,hash:crypto.createHash('sha256').update(credential).digest('hex')};
  return {device:{id,name,platform:input.platform,createdMs},credential};
}
function detach(state,workspace,id) {
  if(!ID.test(id||''))throw new CloudError('device_id_invalid',400);
  const assigned=of(state,workspace);
  if(!assigned[id])throw new CloudError('device_not_found',404);
  delete assigned[id];
}
function requireDevice(state,workspace,headers) {
  const id=headers?.['x-gendragoon-device-id'];
  const credential=headers?.['x-gendragoon-device-token'];
  const item=of(state,workspace)[id];
  if(!ID.test(id||'') || !TOKEN.test(credential||'') || !item)
    throw new CloudError('device_assignment_required',423);
  const actual=crypto.createHash('sha256').update(credential).digest();
  const expected=Buffer.from(item.hash,'hex');
  if(expected.length!==32 || !crypto.timingSafeEqual(actual,expected))
    throw new CloudError('device_assignment_required',423);
}
module.exports={attach,visible,detach,requireDevice,MAX_PER_WORKSPACE};
