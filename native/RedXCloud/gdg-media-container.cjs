'use strict';
// A single RedX pack named red-xai-db, scoped by authenticated account/workspace.
// This consumes the existing RedX HTTP API; no RedX engine code is modified.
const {CloudError,digest}=require('./redx-state.cjs');
const OWNER=/^[a-f0-9]{64}$/, ID=/^[a-f0-9]{32}$/;
const MAX=8*1024*1024;
function prefix(owner,workspace){if(!OWNER.test(owner||'')||!ID.test(workspace||''))throw new CloudError('media_scope_invalid',400);return `accounts/${owner}/workspaces/${workspace}`;}
function objectPath(owner,workspace,id,suffix='png'){
 if(!ID.test(id||'')||!['png','json'].includes(suffix))throw new CloudError('media_object_invalid',400);
 return prefix(owner,workspace)+'/objects/'+id.slice(0,2)+'/'+id+'.'+suffix;
}
class GDGMediaContainer{
 #key;
 constructor({url,key,db='gendragoon_media',pack='red-xai-db',fetchImpl=fetch}){
  const u=new URL(url);
  if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||!(u.protocol==='https:'||u.protocol==='http:'&&u.hostname==='127.0.0.1')||!/^[a-z][a-z0-9_]{1,50}$/.test(db)||pack!=='red-xai-db'||!key)throw new Error('GenDragoon media container configuration invalid');
  this.url=u.origin;this.db=db;this.pack=pack;this.#key=key;this.fetch=fetchImpl;
 }
 async request(method,relative,body,limit=MAX){
  if(typeof relative!=='string'||relative.includes('..')||relative.includes('%')||relative.includes('\\')||!relative.startsWith('accounts/'))throw new CloudError('media_path_invalid',400);
  const url=`${this.url}/v1/db/${this.db}/pack/${this.pack}/file/${relative}`;
  const r=await this.fetch(url,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:'Bearer '+this.#key,...(body?{'content-type':'application/octet-stream','x-redx-sha256':digest(body)}:{})},body});
  if(r.status===404)return null;
  if(!r.ok)throw new CloudError('media_container_unavailable',503);
  const pieces=[];let size=0;for await(const b of r.body){size+=b.length;if(size>limit)throw new CloudError('media_object_too_large',503);pieces.push(b);}
  return Buffer.concat(pieces);
 }
 async ensureWorkspace(owner,workspace,name){
  const location=prefix(owner,workspace)+'/_workspace.json';
  const record={schema:1,owner,workspace};
  // Workspace display names remain in GDGWS, never become path components.
  const existing=await this.request('GET',location,undefined,2048);
  if(existing){let v;try{v=JSON.parse(existing);}catch{throw new CloudError('media_workspace_corrupt',503);}if(v.owner!==owner||v.workspace!==workspace)throw new CloudError('media_scope_invalid',503);return;}
  await this.request('PUT',location,Buffer.from(JSON.stringify(record)),4096);
 }
 async record(owner,workspace,id){
  const raw=await this.request('GET',objectPath(owner,workspace,id,'json'),undefined,4096);
  if(raw===null)return null;
  let v;try{v=JSON.parse(raw);}catch{throw new CloudError('stored_object_corrupt',503);}
  if(v.schema!==1||v.id!==id||v.workspace!==workspace||!Number.isSafeInteger(v.bytes)||v.bytes<8||v.bytes>MAX||!/^[a-f0-9]{64}$/.test(v.sha256||''))throw new CloudError('stored_object_corrupt',503);
  return v;
 }
 async get(owner,workspace,id){
  const record=await this.record(owner,workspace,id);if(!record)return null;
  const bytes=await this.request('GET',objectPath(owner,workspace,id),undefined,MAX);
  if(!bytes||bytes.length!==record.bytes||digest(bytes)!==record.sha256)throw new CloudError('stored_object_corrupt',503);
  return {record,bytes,media:true};
 }
 async put(owner,workspace,id,bytes,record){
  if(!Buffer.isBuffer(bytes)||bytes.length<8||bytes.length>MAX||record.id!==id||record.workspace!==workspace||record.bytes!==bytes.length||record.sha256!==digest(bytes))throw new CloudError('upload_hash_mismatch',422);
  const previous=await this.get(owner,workspace,id);
  if(previous){if(previous.record.sha256!==record.sha256||previous.record.bytes!==record.bytes)throw new CloudError('immutable_object_conflict',409);return previous.record;}
  // PNG data first, metadata as the commit point. Interrupted data remains an
  // unreferenced object and is never advertised as a completed upload.
  await this.request('PUT',objectPath(owner,workspace,id),bytes,4096);
  const verify=await this.request('GET',objectPath(owner,workspace,id),undefined,MAX);
  if(!verify||digest(verify)!==record.sha256)throw new CloudError('stored_object_corrupt',503);
  await this.request('PUT',objectPath(owner,workspace,id,'json'),Buffer.from(JSON.stringify(record)),4096);
  return record;
 }
 async listFolder(relative){
  if(typeof relative!=='string'||!/^accounts\/[a-f0-9]{64}(?:\/workspaces(?:\/[a-f0-9]{32}(?:\/objects(?:\/[a-f0-9]{2})?)?)?)?$/.test(relative))throw new CloudError('media_path_invalid',400);
  const r=await this.fetch(`${this.url}/v1/db/${this.db}/pack/${this.pack}/ls/${relative}`,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:'Bearer '+this.#key}});
  if(r.status===404)return [];
  if(!r.ok)throw new CloudError('media_container_unavailable',503);
  const chunks=[];let length=0;for await(const b of r.body){length+=b.length;if(length>16*1024*1024)throw new CloudError('media_listing_limit',503);chunks.push(b);}
  let value;try{value=JSON.parse(Buffer.concat(chunks));}catch{throw new CloudError('media_listing_invalid',503);}
  if(!Array.isArray(value.entries)||value.entries.length>50000)throw new CloudError('media_listing_invalid',503);
  return value.entries.map(e=>{if(!e||typeof e.name!=='string'||!e.name||e.name.includes('/')||e.name.includes('\\')||e.name==='.'||e.name==='..'||e.path!==relative+'/'+e.name)throw new CloudError('media_listing_invalid',503);return e;});
 }
 async removeWorkspace(owner,workspace){
  const root=prefix(owner,workspace);
  const folders=await this.listFolder(root+'/objects');
  for(const folder of folders){
   if(folder.is_dir!==true||!/^[a-f0-9]{2}$/.test(folder.name))throw new CloudError('media_listing_invalid',503);
   const entries=await this.listFolder(root+'/objects/'+folder.name);
   for(const e of entries){
    if(e.is_dir||!/^[a-f0-9]{32}\.(png|json)$/.test(e.name)||!e.name.startsWith(folder.name))throw new CloudError('media_listing_invalid',503);
   }
   for(const e of entries.sort((a,b)=>Number(b.name.endsWith('.json'))-Number(a.name.endsWith('.json'))))await this.request('DELETE',e.path,undefined,4096);
  }
  await this.request('DELETE',root+'/_workspace.json',undefined,4096);
 }
 async removeAccount(owner){
  if(!OWNER.test(owner||''))throw new CloudError('media_scope_invalid',400);
  const workspaces=await this.listFolder('accounts/'+owner+'/workspaces');
  for(const w of workspaces){if(!w.is_dir||!ID.test(w.name))throw new CloudError('media_listing_invalid',503);await this.removeWorkspace(owner,w.name);}
 }
 async remove(owner,workspace,id){
  // Only called after an authenticated, durable deletion receipt is recorded.
  await this.request('DELETE',objectPath(owner,workspace,id,'json'),undefined,4096);
  await this.request('DELETE',objectPath(owner,workspace,id),undefined,4096);
 }
}
module.exports={GDGMediaContainer,prefix,objectPath};
