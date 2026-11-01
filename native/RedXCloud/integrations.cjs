'use strict';
// GenDragoon-only integration credentials and external workspace metadata.
// No external endpoint is fetched here. BYO secrets stay on the client.
const crypto = require('node:crypto');
const {CloudError, digest} = require('./redx-state.cjs');
const OWNER = /^[a-f0-9]{64}$/, WORKSPACE = /^[a-f0-9]{32}$/, KEY = /^gdpk_([a-f0-9]{16})_([A-Za-z0-9_-]{43})$/;
const SERVICES = Object.freeze([
  {id:'redxai-db',name:'Red-XAI-DB',status:'available',contract:'redx-pack-v1',connectProvider:'gendragoon',capabilities:['byo-pack','redx-pkce','scoped-receiver-files'],limits:['RedX external-provider redemption is not implemented in the external program.']},
  {id:'rottenapple-store',name:'RottenApple Store and Shop',status:'available',contract:'gendragoon-provider-v1',connectProvider:'rottenapple',capabilities:['provider-grant','provider-pkce','scoped-receiver-files'],limits:['External RottenApple L3 storage binding is not implemented; legacy provider blob and manifest APIs are unavailable.']},
  {id:'quick-launcher',name:'Quick Launcher',status:'available',contract:'gendragoon-provider-v1',connectProvider:'quicklaunch',capabilities:['provider-grant','provider-pkce','scoped-receiver-files'],limits:['Connect and health contract supported; legacy provider blob and manifest APIs are unavailable.']},
  {id:'redxai-host',name:'Red-XAI Host',status:'contract-required'},
  {id:'rottencore',name:'RottenCore',status:'installer-contract-only'},
  {id:'poisonapple',name:'PoisonApple',status:'contract-required'},
]);
const AVAILABLE = new Set(SERVICES.filter(x=>x.status==='available').map(x=>x.id));
const MAX_KEYS=20, MAX_BYO=20, TTL=90*86400_000;
const fail=(code,status=400)=>{throw new CloudError(code,status);};
function text(value,max=80){if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f\x7f]/.test(value))fail('integration_name_invalid');return value.trim();}
function identityRecord(identity){
 if(!identity||identity.apiKey||!OWNER.test(identity.owner||'')||typeof identity.issuer!=='string'||!identity.issuer||typeof identity.subject!=='string'||!identity.subject)fail('account_session_required',401);
 if(digest(JSON.stringify(['red-xai-receiver/v1',identity.issuer,identity.subject]))!==identity.owner)fail('identity_binding_invalid',403);
 return {owner:identity.owner,issuer:identity.issuer,subject:identity.subject};
}
function scopes(value){if(!Array.isArray(value)||!value.length||value.length>2||new Set(value).size!==value.length||value.some(x=>!['files:read','files:write'].includes(x)))fail('integration_scope_invalid');return [...value];}
function safeOrigin(value){
 let u;try{u=new URL(value);}catch{fail('byo_origin_invalid');}
 if((u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(u.hostname)))||u.username||u.password||u.search||u.hash||u.pathname!=='/')fail('byo_origin_invalid');
 return u.origin;
}
function dbName(value){if(typeof value!=='string'||!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(value)||['default','admin','redxai_accounts'].includes(value))fail('byo_database_invalid');return value;}
function packName(value){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(value))fail('byo_pack_invalid');return value;}
function summary(key,now){const {id,name,service,workspaceId,scopes,createdAtMs,expiresAtMs,revokedAtMs}=key;return {id,name,service,workspaceId,scopes,createdAt:new Date(createdAtMs).toISOString(),expiresAt:new Date(expiresAtMs).toISOString(),active:revokedAtMs===null&&expiresAtMs>now};}
const fresh=()=>({keys:{},byo:{}});

// Separate table, per-account ledger plus immutable lookup pointers. A pointer
// alone never authorizes: the key must also exist in its owner's CAS ledger.
class IntegrationMetadata {
 constructor(store){this.store=store;}
 address(kind,id){return Number.parseInt(digest(kind+':'+id).slice(0,13),16);}
 async get(kind,id){
  try{const out=await this.store.call('GET','path/'+encodeURIComponent(`integrations.red-xai.db:Integration[ID=${this.address(kind,id)}].State`));
   const value=JSON.parse(JSON.parse(out.value));if(value.kind!==kind||value.id!==id||!Number.isSafeInteger(value.revision))fail('integration_metadata_collision',503);return value;
  }catch(e){if(e.status===404)return null;throw e;}
 }
 async change(kind,id,operation){
  for(let n=0;n<12;n++){
   const old=await this.get(kind,id),next=old?structuredClone(old):{kind,id,revision:0,data:fresh()};operation(next.data);next.revision=(old?.revision||0)+1;
   const state=JSON.stringify(next);if(Buffer.byteLength(state)>256*1024)fail('integration_limit',507);
   try{
    if(!old)await this.store.call('POST','bx',{q:'{Add[]} = "integrations.red-xai.db":Integration[ID=$id] = [ {Revision[]} = $next, {State[]} = $state ]',params:{id:this.address(kind,id),next:next.revision,state}});
    else await this.store.call('POST','bx',{q:'{Tx[]} = [ {Require[]} = "integrations.red-xai.db":Integration[ID=$id, Revision=$previous], {Set[]} = "integrations.red-xai.db":Integration[ID=$id] = [ {Revision[]} = $next, {State[]} = $state ] ]',params:{id:this.address(kind,id),previous:old.revision,next:next.revision,state}});
    return next.data;
   }catch(e){if(e.status!==409)throw e;}
  }fail('integration_busy_retry',409);
 }
 async account(owner){return (await this.get('owner',owner))?.data||fresh();}
 async update(owner,operation){return this.change('owner',owner,operation);}
 async linkKey(id,owner){await this.change('key',id,data=>{if(data.owner&&data.owner!==owner)fail('integration_key_collision',409);data.owner=owner;});}
 async ownerForKey(id){return (await this.get('key',id))?.data.owner||null;}
 async createGrant(id,value){await this.change('grant',id,data=>{if(data.grant)fail('integration_grant_collision',409);data.grant=value;});}
 async grant(id){return (await this.get('grant',id))?.data.grant||null;}
 async consumeGrant(id,verify,at){let accepted;await this.change('grant',id,data=>{const g=data.grant;if(!g||g.usedAtMs!==null||g.expiresAtMs<=at||!verify(g))fail('invalid_grant',400);g.usedAtMs=at;accepted=structuredClone(g);});return accepted;}
}

async function body(req){let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>8192)fail('body_too_large',413);chunks.push(chunk);}try{const v=JSON.parse(Buffer.concat(chunks));if(!v||typeof v!=='object'||Array.isArray(v))throw Error();return v;}catch{fail('bad_json');}}
function routeAccess(path,method,workspace){
 if(path==='/provider/v1/health'&&method==='GET')return 'files:read';
 if(path==='/v1/receivers/me'&&method==='GET')return 'files:read';
 const m=/^\/v1\/receivers\/me\/workspaces\/([a-f0-9]{32})\/((?:blobs|objects)\/[a-f0-9]{32}|library)$/.exec(path);
 if(!m&&/^\/v1\/receivers\/me\/library\/[a-f0-9]{18}$/.test(path)&&['PUT','DELETE'].includes(method))return 'files:write';
 if(!m&&path==='/v1/receivers/me/library/operations'&&method==='POST')return 'files:write';
 if(!m||m[1]!==workspace)fail('integration_route_forbidden',403);
 if(['GET','HEAD'].includes(method))return 'files:read';
 if(['PUT','POST','DELETE'].includes(method))return 'files:write';
 fail('integration_route_forbidden',403);
}
function assertWorkspace(identity,workspace){if(identity?.apiKey&&identity.workspaceId!==workspace)fail('integration_workspace_forbidden',403);}
function filterState(value,identity){
 if(!identity?.apiKey)return value;
 const id=identity.workspaceId,workspaces=(value.workspaces||[]).filter(x=>x.id===id);
 return {...value,workspaces,machineNotes:workspaces,objects:(value.objects||[]).filter(x=>x.workspace===id),libraryItems:undefined,
  quotaBytes:workspaces[0]?.quotaBytes||0,usedBytes:workspaces[0]?.usedBytes||0,ownerBenefits:false,projectLimit:1};
}
function createIntegrations({store,metadata,authorizeWorkspace,beforeUse=async()=>{},withAccount=async(_identity,operation)=>operation(),now=Date.now}={}){
 const records=metadata||new IntegrationMetadata(store);
 const matches=path=>/^\/v1\/integrations\/(services|keys(?:\/[a-f0-9]{16})?|byo(?:\/byo_[a-f0-9]{32})?)$/.test(path)||['/provider/v1/connect/grants','/provider/v1/connect/authorize','/provider/v1/health'].includes(path);
 const matchesPublic=path=>['/provider/v1/connect/redeem','/provider/v1/connect/token','/v1/connect/exchange','/v1/connect/revoke'].includes(path);
 async function checked(actor,workspaceId,allowed){await beforeUse(actor);if(!authorizeWorkspace)fail('integration_entitlements_unavailable',503);const entitlement=await authorizeWorkspace(actor,workspaceId);validateEntitlement(entitlement,workspaceId,allowed.includes('files:write'),now());return entitlement;}
 async function issueKey(actor,{service,workspaceId,scopes:allowed,name}){
  return withAccount(actor,async()=>{
   await checked(actor,workspaceId,allowed);
   const previous=await records.account(actor.owner);if(Object.values(previous.keys).filter(x=>x.revokedAtMs===null&&x.expiresAtMs>now()).length>=MAX_KEYS)fail('integration_key_limit',409);
   const id=crypto.randomBytes(8).toString('hex'),secret=crypto.randomBytes(32).toString('base64url'),apiKey='gdpk_'+id+'_'+secret;
   const key={id,name,service,workspaceId,scopes:allowed,identity:actor,digest:digest(apiKey),createdAtMs:now(),expiresAtMs:now()+TTL,revokedAtMs:null};
   await records.linkKey(id,actor.owner);
   await records.update(actor.owner,current=>{if(current.keys[id])fail('integration_key_collision',409);if(Object.values(current.keys).filter(x=>x.revokedAtMs===null&&x.expiresAtMs>now()).length>=MAX_KEYS)fail('integration_key_limit',409);for(const stale of Object.values(current.keys).filter(x=>x.revokedAtMs!==null||x.expiresAtMs<=now()).sort((a,b)=>a.createdAtMs-b.createdAtMs)){if(Object.keys(current.keys).length<200)break;delete current.keys[stale.id];}current.keys[id]=key;});
   return {status:201,body:{...summary(key,now()),apiKey,key:apiKey,keyId:id,warning:'Copy this secret now. It is shown only once.'}};
  });
 }
 async function handle(req,u,identity){
  if(u.pathname==='/provider/v1/health'&&req.method==='GET'){
   if(!identity?.apiKey)identityRecord(identity);
   return {status:200,body:{ok:true,api:'gendragoon-integrations/v1',capabilities:{receiverFiles:true,legacyBlobAPI:false,manifestCas:false},binding:identity?.apiKey?{id:identity.keyId,workspaceId:identity.workspaceId}:undefined}};
  }
  const actor=identityRecord(identity);if(u.search)fail('invalid_path');
  const path=u.pathname,method=req.method,state=await records.account(actor.owner);
  if(['/provider/v1/connect/grants','/provider/v1/connect/authorize'].includes(path)&&method==='POST'){
   const value=await body(req),service=value.service;if(!AVAILABLE.has(service))fail('integration_service_unavailable',409);
   const workspaceId=value.workspaceId;if(!WORKSPACE.test(workspaceId||''))fail('integration_workspace_invalid');
   const allowed=scopes(value.scopes),name=text(value.name||value.requester?.name||'Connected application');
   const code=path.endsWith('/authorize');if(code&&(value.codeChallengeMethod!=='S256'||!(/^[A-Za-z0-9_-]{43}$/).test(value.codeChallenge||'')))fail('invalid_pkce');
   if(value.state!==undefined&&(!code||typeof value.state!=='string'||!(/^[A-Za-z0-9_-]{22,128}$/).test(value.state)))fail('invalid_state');
   await checked(actor,workspaceId,allowed);
   await records.update(actor.owner,current=>{current.grantIssuedAtMs=(current.grantIssuedAtMs||[]).filter(t=>t>now()-600000);if(current.grantIssuedAtMs.length>=10)fail('rate_limited',429);current.grantIssuedAtMs.push(now());});
   const secret=(code?'gdpc_':'gdpg_')+crypto.randomBytes(32).toString('base64url'),expiresAtMs=now()+300000;
   await records.createGrant(digest(secret),{kind:code?'code':'grant',identity:actor,service,workspaceId,scopes:allowed,name,challenge:code?value.codeChallenge:null,stateDigest:value.state?digest(value.state):null,createdAtMs:now(),expiresAtMs,usedAtMs:null});
   return {status:201,body:{[code?'code':'grant']:secret,expiresAt:new Date(expiresAtMs).toISOString(),ttlSeconds:300}};
  }
  if(path==='/v1/integrations/services'&&method==='GET')return {status:200,body:{schema:1,services:SERVICES}};
  if(path==='/v1/integrations/keys'&&method==='GET')return {status:200,body:{keys:Object.values(state.keys).map(x=>summary(x,now())),maxActive:MAX_KEYS}};
  if(path==='/v1/integrations/keys'&&method==='POST'){
   const value=await body(req),service=value.service;if(!AVAILABLE.has(service))fail('integration_service_unavailable',409);
   const workspaceId=value.workspaceId;if(!WORKSPACE.test(workspaceId||''))fail('integration_workspace_invalid');
   return issueKey(actor,{service,workspaceId,scopes:scopes(value.scopes),name:text(value.name)});
  }
  const keyID=/^\/v1\/integrations\/keys\/([a-f0-9]{16})$/.exec(path)?.[1];
  if(keyID&&method==='DELETE'){await records.update(actor.owner,current=>{if(!current.keys[keyID])fail('not_found',404);current.keys[keyID].revokedAtMs=now();});return {status:200,body:{ok:true,revoked:true}};}
  if(path==='/v1/integrations/byo'&&method==='GET')return {status:200,body:{schema:1,workspaces:Object.values(state.byo)}};
  if(path==='/v1/integrations/byo'&&method==='POST'){
   const value=await body(req);if(Object.keys(value).some(k=>!['name','origin','database','pack'].includes(k)))fail('byo_metadata_only');
   const item={id:'byo_'+crypto.randomBytes(16).toString('hex'),kind:'redx-db-byo',name:text(value.name),origin:safeOrigin(value.origin),database:dbName(value.database),pack:packName(value.pack||'gendragoon'),hostingFeeCents:0,billingRequired:false,storageLocation:'external-redx-pack',createdAtMs:now()};
   await records.update(actor.owner,current=>{if(Object.keys(current.byo).length>=MAX_BYO)fail('byo_workspace_limit',409);current.byo[item.id]=item;});
   return {status:201,body:{ok:true,workspace:item}};
  }
  const byoID=/^\/v1\/integrations\/byo\/(byo_[a-f0-9]{32})$/.exec(path)?.[1];
  if(byoID&&method==='DELETE'){await records.update(actor.owner,current=>{if(!current.byo[byoID])fail('not_found',404);delete current.byo[byoID];});return {status:200,body:{ok:true,disconnected:true,externalDataDeleted:false}};}
  fail('not_found',404);
 }
 async function handlePublic(req,u){
  if(req.method!=='POST'||u.search||!matchesPublic(u.pathname))fail('not_found',404);
  if(u.pathname==='/v1/connect/revoke'){
   const key=await keyForRequest(req);return withAccount(key.identity,async()=>{await records.update(key.identity.owner,current=>{if(!current.keys[key.id]||current.keys[key.id].digest!==key.digest)fail('integration_key_invalid',401);current.keys[key.id].revokedAtMs=now();});
   return {status:200,body:{revoked:true,connection_id:'cn_'+key.id,key_id:key.id}};});
  }
  const value=await body(req),redxStyle=u.pathname==='/v1/connect/exchange',code=redxStyle||u.pathname.endsWith('/token'),secret=code?value.code:value.grant;
  if(typeof secret!=='string'||!(code?/^gdpc_[A-Za-z0-9_-]{43}$/:/^gdpg_[A-Za-z0-9_-]{43}$/).test(secret))fail('invalid_grant');
  let challenge;
  if(code){const verifier=redxStyle?value.pkce_verifier:value.codeVerifier;if(typeof verifier!=='string'||!(/^[A-Za-z0-9._~-]{43,128}$/).test(verifier))fail('invalid_grant');challenge=crypto.createHash('sha256').update(verifier).digest('base64url');}
  const id=digest(secret),grant=await records.grant(id);
  const verify=g=>g.kind===(code?'code':'grant')&&(!code||g.challenge===challenge)&&(!redxStyle||Boolean(g.stateDigest))&&(!g.stateDigest||typeof value.state==='string'&&g.stateDigest===digest(value.state));
  if(!grant||grant.usedAtMs!==null||grant.expiresAtMs<=now()||!verify(grant))fail('invalid_grant');
  return withAccount(grant.identity,async()=>{
  await checked(grant.identity,grant.workspaceId,grant.scopes);
  const accepted=await records.consumeGrant(id,verify,now());
  const issued=await issueKey(accepted.identity,accepted);
  return {status:201,body:{...issued.body,bindingId:issued.body.id,binding:{id:issued.body.id,workspaceId:accepted.workspaceId,workspaceName:accepted.name},workspaceId:accepted.workspaceId,keyExpiresAt:issued.body.expiresAt,capabilities:{receiverFiles:true,legacyBlobAPI:false,manifestCas:false},...(redxStyle?{api:'v1',connection_id:'cn_'+issued.body.id,workspace:{db:accepted.workspaceId,name:accepted.name},key_id:issued.body.id,scope:accepted.scopes.includes('files:write')?'write':'read',prefix:'',endpoints:{revoke:'/v1/connect/revoke',files:'/v1/receivers/me/workspaces/'+accepted.workspaceId+'/blobs/'},storage:{mode:'gendragoon',provider:'gendragoon',status:'scoped-storage-key'}}:{})}};
  });
 }
 const isAPIKey=req=>/^Bearer gdpk_/.test(req.headers.authorization||'');
 async function keyForRequest(req){
  const token=(req.headers.authorization||'').replace(/^Bearer /,''),match=KEY.exec(token);if(!match)fail('integration_key_invalid',401);
  const owner=await records.ownerForKey(match[1]);if(!owner||!OWNER.test(owner))fail('integration_key_invalid',401);
  const key=(await records.account(owner)).keys[match[1]],expected=Buffer.from(key?.digest||'','hex'),actual=Buffer.from(digest(token),'hex');
  if(!key||expected.length!==32||!crypto.timingSafeEqual(expected,actual)||key.revokedAtMs!==null||key.expiresAtMs<=now()||!AVAILABLE.has(key.service))fail('integration_key_invalid',401);
  return key;
 }
 async function authenticateAPIKey(req,path,method=req.method){
  const key=await keyForRequest(req);
  await beforeUse(key.identity);
  const scope=routeAccess(path,method,key.workspaceId);if(!key.scopes.includes(scope))fail('integration_scope_required',403);
  if(!authorizeWorkspace)fail('integration_entitlements_unavailable',503);
  const entitlement=await authorizeWorkspace(key.identity,key.workspaceId);validateEntitlement(entitlement,key.workspaceId,scope==='files:write',now());
  return {...key.identity,ownerAdmin:false,apiKey:true,workspaceId:key.workspaceId,keyId:key.id,scopes:[...key.scopes],service:key.service,entitlement,bearer:null};
 }
 return {matches,handle,matchesPublic,handlePublic,isAPIKey,authenticateAPIKey,filterState,assertWorkspace};
}
function validateEntitlement(value,id,write,now){
 if(!value||value.id!==id||typeof value.active!=='boolean'||typeof value.readOnly!=='boolean'||!Number.isSafeInteger(value.quotaBytes)||value.quotaBytes<0||!Number.isInteger(value.workers)||value.workers<0||value.workers>24||!Number.isFinite(value.checkedAtMs)||value.checkedAtMs>now+5000||now-value.checkedAtMs>60_000)fail('integration_entitlements_unavailable',503);
 if(write&&(!value.active||value.readOnly||value.quotaBytes<=0||value.workers<1))fail('workspace_read_only',403);
}
module.exports={createIntegrations,IntegrationMetadata,SERVICES,routeAccess,filterState,validateEntitlement,assertWorkspace};
