'use strict';
// GenDragoon extension records in the EXISTING website account database.
// Never reads/writes acct-account, passwords, MFA, sessions, or Quick Login code.
const crypto=require('node:crypto');
const {CloudError,digest}=require('./redx-state.cjs');
const OWNER=/^[a-f0-9]{64}$/, WORKSPACE=/^[a-f0-9]{32}$/;
const FILE='gdg-user.red-xai.db', MAX_STATE=1024*1024;
function actor(identity){
 if(!identity||!OWNER.test(identity.owner||'')||typeof identity.subject!=='string'||!identity.subject||identity.subject.length>200||typeof identity.issuer!=='string')throw new CloudError('account_session_required',401);
 if(digest(JSON.stringify(['red-xai-receiver/v1',identity.issuer,identity.subject]))!==identity.owner)throw new CloudError('account_identity_mismatch',403);
 return {owner:identity.owner,subject:identity.subject,issuer:identity.issuer};
}
function initial(identity){const a=actor(identity);return {schema:1,...a,revision:0,workspaceRevision:-1,GDGSigned:{},GDGWS:{}};}
function decode(value){for(let i=0;i<3&&typeof value==='string';i++)value=JSON.parse(value);return value;}
function workspaceRecords(state,owner){
 const result={};
 for(const [id,w] of Object.entries(state.workspaces||{})){
  if(!WORKSPACE.test(id)||!w||state.deletedWorkspaces?.[id]||state.workspaceDeletions?.[id])continue;
  const name=typeof w.name==='string'&&w.name.length<=160?w.name:'MachineNote';
  result[id]={id,name,mediaPrefix:`accounts/${owner}/workspaces/${id}`,active:w.active===true,readOnly:w.readOnly===true};
 }
 return result;
}
class GDGAccountState{
 #key;
 constructor({url,key,db='redx_accounts',fetchImpl=fetch}){
  const u=new URL(url);
  if(!['https:','http:'].includes(u.protocol)||u.protocol==='http:'&&u.hostname!=='127.0.0.1'||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error('Invalid GenDragoon database endpoint');
  if(!key||!/^[a-z][a-z0-9_]{1,50}$/.test(db))throw new Error('Existing user database and scoped GDG key required');
  this.url=u.origin;this.db=db;this.#key=key;this.fetch=fetchImpl;
 }
 async call(method,route,body){
  const r=await this.fetch(`${this.url}/v1/db/${this.db}/${route}`,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+this.#key,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  if(r.status===404)throw new CloudError('not_found',404);
  if(r.status===409)throw new CloudError('concurrent_update',409);
  if(!r.ok)throw new CloudError('gdg_account_store_unavailable',503);
  const chunks=[];let size=0;for await(const chunk of r.body){size+=chunk.length;if(size>MAX_STATE*2)throw new CloudError('gdg_account_record_limit',503);chunks.push(chunk);}
  return size?JSON.parse(Buffer.concat(chunks)):{};
 }
 address(owner){return Number.parseInt(owner.slice(0,13),16);}
 async get(identity){
  const a=actor(identity);
  try{
   const r=await this.call('GET','path/'+encodeURIComponent(`${FILE}:Account[ID=${this.address(a.owner)}].State`));
   const value=decode(r.value);
   if(!value||value.schema!==1||value.owner!==a.owner||value.subject!==a.subject||value.issuer!==a.issuer||!Number.isSafeInteger(value.revision)||!value.GDGSigned||!value.GDGWS)throw new CloudError('gdg_account_record_invalid',503);
   return value;
  }catch(e){if(e.status===404)return null;throw e;}
 }
 async ensure(identity){
  let value=await this.get(identity);if(value)return value;
  value=initial(identity);
  try{await this.call('POST','bx',{q:`{Add[]} = "${FILE}":Account[ID=$id] = [ {Owner[]} = $owner, {Subject[]} = $subject, {Revision[]} = 0, {GDGSigned[]} = $signed, {GDGWS[]} = $workspaces, {State[]} = $state ]`,params:{id:this.address(value.owner),owner:value.owner,subject:value.subject,signed:JSON.stringify(value.GDGSigned),workspaces:JSON.stringify(value.GDGWS),state:JSON.stringify(value)}});return value;}
  catch(e){if(e.status===409){const current=await this.get(identity);if(current)return current;}throw e;}
 }
 async change(identity,update){
  const a=actor(identity);await this.ensure(identity);
  for(let attempt=0;attempt<10;attempt++){
   const before=await this.get(identity);if(!before)throw new CloudError('gdg_account_record_missing',503);
   const next=structuredClone(before);update(next);next.revision=before.revision+1;
   if(next.owner!==a.owner||next.subject!==a.subject||next.issuer!==a.issuer||next.schema!==1)throw new CloudError('gdg_account_identity_changed',503);
   const encoded=JSON.stringify(next);if(Buffer.byteLength(encoded)>MAX_STATE)throw new CloudError('gdg_account_record_limit',507);
   try{await this.call('POST','bx',{q:`{Tx[]} = [ {Require[]} = "${FILE}":Account[ID=$id, Owner=$owner, Subject=$subject, Revision=$previous], {Set[]} = "${FILE}":Account[ID=$id] = [ {Owner[]} = $owner, {Subject[]} = $subject, {Revision[]} = $next, {GDGSigned[]} = $signed, {GDGWS[]} = $workspaces, {State[]} = $state ] ]`,params:{id:this.address(a.owner),owner:a.owner,subject:a.subject,previous:before.revision,next:next.revision,signed:JSON.stringify(next.GDGSigned),workspaces:JSON.stringify(next.GDGWS),state:encoded}});return next;}
   catch(e){if(e.status!==409)throw e;}
  }
  throw new CloudError('busy_retry',409);
 }
 receiptKey(owner,id){if(!OWNER.test(owner||'')||!WORKSPACE.test(id||''))throw new CloudError('device_id_invalid',400);return digest(JSON.stringify(['GDGSigned/receipt/v1',owner,id]));}
 async readReceipt(identity,id){
  const a=actor(identity),key=this.receiptKey(a.owner,id);
  try{
   const r=await this.call('GET','path/'+encodeURIComponent(`${FILE}:GDGSigned[ID=${this.address(key)}].State`));
   const value=decode(r.value);
   if(!value||value.schema!==1||value.owner!==a.owner||value.subject!==a.subject||value.issuer!==a.issuer||value.id!==id||value.key!==key||!WORKSPACE.test(value.workspaceId||'')||!value.qr)throw new CloudError('device_receipt_invalid',503);
   return value;
  }catch(e){if(e.status===404)return null;throw e;}
 }
 async writeReceipt(identity,workspace,id,qr){
  const a=actor(identity),key=this.receiptKey(a.owner,id);
  if(!WORKSPACE.test(workspace||''))throw new CloudError('workspace_invalid',400);
  const value={schema:1,...a,id,key,workspaceId:workspace,qr};
  const encoded=JSON.stringify(value);if(Buffer.byteLength(encoded)>192*1024)throw new CloudError('device_receipt_invalid',413);
  const prior=await this.readReceipt(identity,id);
  if(prior){if(JSON.stringify(prior)!==encoded)throw new CloudError('device_registration_conflict',409);return;}
  try{await this.call('POST','bx',{q:`{Add[]} = "${FILE}":GDGSigned[ID=$row] = [ {Owner[]} = $owner, {Subject[]} = $subject, {DeviceID[]} = $device, {WorkspaceID[]} = $workspace, {State[]} = $state ]`,params:{row:this.address(key),owner:a.owner,subject:a.subject,device:id,workspace,state:encoded}});}
  catch(error){if(error.status!==409)throw error;const found=await this.readReceipt(identity,id);if(JSON.stringify(found)!==encoded)throw new CloudError('device_registration_conflict',409);}
 }
 async removeReceipt(identity,id){
  const a=actor(identity),value=await this.readReceipt(identity,id);if(!value)return;
  await this.call('POST','bx',{q:`{Tx[]} = [ {Require[]} = "${FILE}":GDGSigned[ID=$row, Owner=$owner, Subject=$subject, DeviceID=$device, State=$expected], {Delete[]} = "${FILE}":GDGSigned[ID=$row] ]`,params:{row:this.address(value.key),owner:a.owner,subject:a.subject,device:id,expected:JSON.stringify(value)}});
 }
 async purgeReceipts(identity){
  const a=actor(identity);
  for(let page=0;page<50;page++){
   const r=await this.call('POST','bx',{q:`{Get[]} = "${FILE}":GDGSigned[Owner=$owner, Subject=$subject] -> [ID, DeviceID], Sort = ID, Limit = 50`,params:{owner:a.owner,subject:a.subject}});
   if(Array.isArray(r.rows)&&r.rows.length===0)return;
   if(JSON.stringify(r.columns)!=='["ID","DeviceID"]'||!Array.isArray(r.rows)||r.rows.length>50)throw new CloudError('device_receipt_invalid',503);
   for(const row of r.rows){if(!Array.isArray(row)||!WORKSPACE.test(row[1]||'')||row[0]!==this.address(this.receiptKey(a.owner,row[1])))throw new CloudError('device_receipt_invalid',503);await this.removeReceipt(identity,row[1]);}
  }
  throw new CloudError('device_receipt_cleanup_pending',409);
 }
 async remove(identity){
  const a=actor(identity);await this.purgeReceipts(identity);const current=await this.get(identity);if(!current)return;
  await this.call('POST','bx',{q:`{Tx[]} = [ {Require[]} = "${FILE}":Account[ID=$id, Owner=$owner, Subject=$subject, Revision=$previous], {Delete[]} = "${FILE}":Account[ID=$id] ]`,params:{id:this.address(a.owner),owner:a.owner,subject:a.subject,previous:current.revision}});
 }
 async syncWorkspaces(identity,receiverState){
  const a=actor(identity),map=workspaceRecords(receiverState,a.owner),revision=receiverState.revision;
  if(!Number.isSafeInteger(revision))throw new CloudError('workspace_state_invalid',503);
  const current=await this.ensure(identity);
  if(current.workspaceRevision>revision)return current;
  if(current.workspaceRevision===revision&&JSON.stringify(current.GDGWS)===JSON.stringify(map))return current;
  for(const [id,device] of Object.entries(current.GDGSigned))if(!map[device.workspaceId])await this.removeReceipt(identity,id);
  return this.change(identity,next=>{
   if(next.workspaceRevision>revision)return;
   next.GDGWS=map;next.workspaceRevision=revision;
   // Deleted workspaces cannot leave signed-device QR or credential records.
   for(const [id,device] of Object.entries(next.GDGSigned))if(!map[device.workspaceId])delete next.GDGSigned[id];
  });
 }
}
module.exports={GDGAccountState,actor,initial,workspaceRecords,FILE,MAX_STATE};
