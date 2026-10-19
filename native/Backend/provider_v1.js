"use strict";
// /provider/v1: Gendragoon as a storage provider for RedX (joint design /workspace/integration/GENDRAGOON-REDX.md 1.4).
// Shapes RedX's engine/pack ChunkStore and ManifestStore onto HTTP:
//   blobs     = immutable chunks named by the SHA-256 of their bytes (content mode) or an opaque 64-hex id (sealed mode)
//   manifests = one atomic blob per 64-hex folder key, with optional compare-and-swap on the storage generation
// Credentials: gdpk_ binding keys (hash at rest), obtained from a one-time grant (pair 1) or code + PKCE (pair 2).
// Nothing here is mounted unless PROVIDER_V1_ENABLED=true (see free_server.js). Not deployed anywhere.
const crypto=require("node:crypto");
const express=require("express");

const MAX_BLOB_BYTES=16*1024*1024;          // Cloud Run caps request bodies at 32 MiB (gap G11)
const MAX_MANIFEST_BYTES=4*1024*1024;
const GRANT_TTL_MS=5*60*1000;
const CODE_TTL_MS=5*60*1000;
const KEY_TTL_MS=90*24*3600*1000;
const ROTATE_GRACE_MS=10*60*1000;
const BATCH_HAS_MAX=1000;
const LIST_MAX=1000;
const SCOPES=["blobs:rw","blobs:r"];
const HEX64=/^[0-9a-f]{64}$/;
const KEY_RE=/^gdpk_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
const B64URL43=/^[A-Za-z0-9_-]{43}$/;
const COLL={grants:"gd_provider_grants",bindings:"gd_provider_bindings",keys:"gd_provider_keys",audit:"gd_provider_audit"};

const sha256hex=b=>crypto.createHash("sha256").update(b).digest("hex");
const b64url=n=>crypto.randomBytes(n).toString("base64url");
function fail(res,status,error,extra={}){if(!res.headersSent)res.status(status).json({error,...extra});}
function safeEqualHex(a,b){
 if(typeof a!=="string"||typeof b!=="string"||a.length!==b.length)return false;
 return crypto.timingSafeEqual(Buffer.from(a,"hex"),Buffer.from(b,"hex"));
}
function cleanText(v,max){
 if(v===undefined||v===null)return "";
 if(typeof v!=="string")throw Object.assign(Error("bad_text"),{code:"bad_request"});
 const t=v.normalize("NFC").replace(/[\x00-\x1f\x7f]/g,"").trim();
 if(t.length>max)throw Object.assign(Error("too_long"),{code:"bad_request"});
 return t;
}
function parseScopes(v){
 const s=v===undefined?["blobs:rw"]:v;
 if(!Array.isArray(s)||!s.length||s.length>2||!s.every(x=>SCOPES.includes(x)))throw Object.assign(Error("bad_scope"),{code:"invalid_scope"});
 return [...new Set(s)];
}
function etagValue(h){
 if(typeof h!=="string")return null;
 const m=/^(?:W\/)?"?([0-9]{1,30})"?$/.exec(h.trim());
 return m?m[1]:null;
}

// Token buckets kept per instance. Cloud Run may run several instances, so the effective limit is per instance (documented).
function rateLimiter({rate,burst,now}){
 const buckets=new Map();
 return function take(key,cost=1){
  const t=now();let b=buckets.get(key);
  if(!b){b={tokens:burst,at:t};buckets.set(key,b);}
  b.tokens=Math.min(burst,b.tokens+(t-b.at)/1000*rate);b.at=t;
  if(b.tokens>=cost){b.tokens-=cost;return 0;}
  if(buckets.size>50000)buckets.clear();
  return Math.max(1,Math.ceil((cost-b.tokens)/rate));
 };
}

function registerProviderV1({app,db,blobs,firebaseAuth,accountKey,resolveWorkspace,isUserActive=null,now=Date.now,
  limits={},prefix="/provider/v1"}={}){
 for(const [k,v] of Object.entries({app,db,blobs,firebaseAuth,accountKey,resolveWorkspace}))
  if(!v)throw Error("registerProviderV1 needs "+k);
 const L={rps:50,burst:200,grantsPer10Min:10,redeemPerMinPerIp:30,...limits};
 const bindingLimit=rateLimiter({rate:L.rps,burst:L.burst,now});
 const grantLimit=rateLimiter({rate:L.grantsPer10Min/600,burst:L.grantsPer10Min,now});
 const redeemLimit=rateLimiter({rate:L.redeemPerMinPerIp/60,burst:L.redeemPerMinPerIp,now});
 const lastTouch=new Map(),userActiveCache=new Map();
 const router=express.Router();
 const json=express.json({limit:"8kb"});
 const objectPrefix=b=>"customer/"+b.ownerHash+"/provider/"+b.id+"/";
 const blobName=(b,id)=>objectPrefix(b)+"b/"+id;
 const manifestName=(b,key)=>objectPrefix(b)+"m/"+key;

 function audit(event,fields={}){
  // Never a key, grant, code, verifier, body or signed URL.
  const row={atMs:now(),event,bindingId:fields.bindingId||null,ownerHash:fields.ownerHash||null,reason:fields.reason||null};
  Promise.resolve().then(()=>db.collection(COLL.audit).doc(crypto.randomUUID()).set(row)).catch(()=>{});
 }

 async function issueBinding(tx,{ownerHash,uid,workspaceId,scopes,client,quotaBytes}){
  const id=crypto.randomUUID(),keyId=crypto.randomBytes(8).toString("hex"),secret=b64url(32),t=now();
  const binding={id,ownerHash,uid,workspaceId,scopes,client,quotaBytes,usedBytes:0,objectCount:0,
   createdAtMs:t,revokedAtMs:null,lastUsedAtMs:null,lastError:null};
  tx.create(db.collection(COLL.bindings).doc(id),binding);
  tx.create(db.collection(COLL.keys).doc(keyId),{bindingId:id,digest:sha256hex(secret),scopes,createdAtMs:t,
   expiresAtMs:t+KEY_TTL_MS,revokedAtMs:null,graceUntilMs:null});
  return {binding,apiKey:"gdpk_"+keyId+"_"+secret,keyExpiresAt:new Date(t+KEY_TTL_MS).toISOString()};
 }
 function bindingResponse(out){
  return {bindingId:out.binding.id,apiKey:out.apiKey,keyExpiresAt:out.keyExpiresAt,scopes:out.binding.scopes,
   workspaceId:out.binding.workspaceId,quotaBytes:out.binding.quotaBytes,capabilities:capabilities()};
 }
 function capabilities(){
  return {version:1,maxBlobBytes:MAX_BLOB_BYTES,maxManifestBytes:MAX_MANIFEST_BYTES,idModes:["content","sealed"],
   manifestCas:true,batchHasMax:BATCH_HAS_MAX,listMax:LIST_MAX,rateLimit:{rps:L.rps,burst:L.burst}};
 }

 // ---- connect ------------------------------------------------------------------------------------------
 async function prepareGrant(req){
  const workspaceId=cleanText(req.body?.workspaceId,64);
  if(!workspaceId)throw Object.assign(Error(),{code:"bad_request"});
  const scopes=parseScopes(req.body?.scopes);
  const requester={name:cleanText(req.body?.requester?.name,80),host:cleanText(req.body?.requester?.host,253)};
  const ws=await resolveWorkspace(req.user.uid,workspaceId);
  if(!ws||!Number.isSafeInteger(ws.quotaBytes)||ws.quotaBytes<=0)throw Object.assign(Error(),{code:"workspace_not_found",status:404});
  return {workspaceId,scopes,requester,quotaBytes:ws.quotaBytes,ownerHash:accountKey(req.user.uid),uid:req.user.uid};
 }
 function connectError(res,e){
  if(e?.code==="bad_request"||e?.code==="invalid_scope")return fail(res,400,e.code);
  if(e?.code==="workspace_not_found")return fail(res,404,"workspace_not_found");
  return fail(res,503,"provider_unavailable");
 }
 router.post("/connect/grants",firebaseAuth,json,async(req,res)=>{
  const wait=grantLimit("g:"+req.user.uid);if(wait){res.set("Retry-After",String(wait));return fail(res,429,"rate_limited");}
  try{
   const g=await prepareGrant(req);const grant="gdpg_"+b64url(32),t=now();
   await db.collection(COLL.grants).doc(sha256hex(grant)).create({kind:"grant",...g,createdAtMs:t,expiresAtMs:t+GRANT_TTL_MS,usedAtMs:null});
   audit("connect.grant",{ownerHash:g.ownerHash});
   res.status(201).json({grant,expiresAt:new Date(t+GRANT_TTL_MS).toISOString(),ttlSeconds:GRANT_TTL_MS/1000});
  }catch(e){connectError(res,e);}
 });
 router.post("/connect/authorize",firebaseAuth,json,async(req,res)=>{
  const wait=grantLimit("g:"+req.user.uid);if(wait){res.set("Retry-After",String(wait));return fail(res,429,"rate_limited");}
  try{
   if(req.body?.codeChallengeMethod!=="S256"||typeof req.body?.codeChallenge!=="string"||!B64URL43.test(req.body.codeChallenge))
    return fail(res,400,"invalid_pkce");
   const g=await prepareGrant(req);const code="gdpc_"+b64url(32),t=now();
   await db.collection(COLL.grants).doc(sha256hex(code)).create({kind:"code",...g,codeChallenge:req.body.codeChallenge,
    createdAtMs:t,expiresAtMs:t+CODE_TTL_MS,usedAtMs:null});
   audit("connect.authorize",{ownerHash:g.ownerHash});
   res.status(201).json({code,expiresAt:new Date(t+CODE_TTL_MS).toISOString()});
  }catch(e){connectError(res,e);}
 });
 async function consume(req,res,{secret,kind,verify}){
  const wait=redeemLimit("r:"+(req.ip||"?"));if(wait){res.set("Retry-After",String(wait));return fail(res,429,"rate_limited");}
  const prefixRe=kind==="grant"?/^gdpg_[A-Za-z0-9_-]{43}$/:/^gdpc_[A-Za-z0-9_-]{43}$/;
  if(typeof secret!=="string"||!prefixRe.test(secret)){audit("connect.fail",{reason:"malformed"});return fail(res,400,"invalid_grant");}
  let client;try{client={name:cleanText(req.body?.client?.name,80),host:cleanText(req.body?.client?.host,253)};}catch(_){return fail(res,400,"bad_request");}
  try{
   const ref=db.collection(COLL.grants).doc(sha256hex(secret));
   const out=await db.runTransaction(async tx=>{
    const s=await tx.get(ref);
    if(!s.exists)return {reason:"unknown"};
    const g=s.data();
    if(g.kind!==kind)return {reason:"kind"};
    if(g.usedAtMs)return {reason:"replay"};
    if(g.expiresAtMs<=now())return {reason:"expired"};
    if(verify&&!verify(g))return {reason:"pkce"};
    tx.update(ref,{usedAtMs:now()});
    return {issued:await issueBinding(tx,{ownerHash:g.ownerHash,uid:g.uid,workspaceId:g.workspaceId,scopes:g.scopes,
     client:{name:client.name||g.requester?.name||"",host:client.host||g.requester?.host||""},quotaBytes:g.quotaBytes})};
   });
   if(!out.issued){audit("connect.fail",{reason:out.reason});return fail(res,400,"invalid_grant");}
   audit("connect.exchange",{bindingId:out.issued.binding.id,ownerHash:out.issued.binding.ownerHash});
   res.status(201).json(bindingResponse(out.issued));
  }catch(_){fail(res,503,"provider_unavailable");}
 }
 router.post("/connect/redeem",json,(req,res)=>consume(req,res,{secret:req.body?.grant,kind:"grant"}));
 router.post("/connect/token",json,(req,res)=>{
  const v=req.body?.codeVerifier;
  if(typeof v!=="string"||!/^[A-Za-z0-9._~-]{43,128}$/.test(v))return fail(res,400,"invalid_grant");
  const challenge=crypto.createHash("sha256").update(v).digest("base64url");
  return consume(req,res,{secret:req.body?.code,kind:"code",verify:g=>{
   const a=Buffer.from(g.codeChallenge||""),b=Buffer.from(challenge);return a.length===b.length&&crypto.timingSafeEqual(a,b);}});
 });

 // ---- binding key auth -------------------------------------------------------------------------------------
 async function keyAuth(req,res,next){
  const m=KEY_RE.exec((req.headers.authorization||"").replace(/^Bearer /,""));
  if(!m)return fail(res,401,"invalid_key");
  try{
   const ks=await db.collection(COLL.keys).doc(m[1]).get();
   if(!ks.exists)return fail(res,401,"invalid_key");
   const k=ks.data(),t=now();
   if(!safeEqualHex(k.digest,sha256hex(m[2]))||k.revokedAtMs||k.expiresAtMs<=t||(k.graceUntilMs&&k.graceUntilMs<=t))
    return fail(res,401,"invalid_key");
   const bs=await db.collection(COLL.bindings).doc(k.bindingId).get();
   if(!bs.exists||bs.data().revokedAtMs)return fail(res,401,"binding_revoked");
   const binding=bs.data();
   if(isUserActive){
    let c=userActiveCache.get(binding.uid);
    if(!c||c.at+60000<t){c={at:t,ok:await isUserActive(binding.uid)};userActiveCache.set(binding.uid,c);}
    if(!c.ok)return fail(res,401,"binding_revoked");
   }
   const wait=bindingLimit("b:"+binding.id);
   if(wait){res.set("Retry-After",String(wait));return fail(res,429,"rate_limited");}
   req.binding=binding;req.keyId=m[1];req.keyScopes=k.scopes;
   if((lastTouch.get(binding.id)||0)+60000<t){
    lastTouch.set(binding.id,t);
    db.collection(COLL.bindings).doc(binding.id).update({lastUsedAtMs:t}).catch(()=>{});
   }
   next();
  }catch(_){fail(res,503,"provider_unavailable");}
 }
 const canWrite=(req,res,next)=>req.keyScopes?.includes("blobs:rw")?next():fail(res,403,"insufficient_scope");
 const canRead=(req,res,next)=>(req.keyScopes?.includes("blobs:rw")||req.keyScopes?.includes("blobs:r"))?next():fail(res,403,"insufficient_scope");

 router.post("/connect/rotate",keyAuth,async(req,res)=>{
  try{
   const keyId=crypto.randomBytes(8).toString("hex"),secret=b64url(32),t=now();
   await db.runTransaction(async tx=>{
    const oldRef=db.collection(COLL.keys).doc(req.keyId);const o=await tx.get(oldRef);
    if(!o.exists||o.data().revokedAtMs||o.data().graceUntilMs)throw Object.assign(Error(),{code:"rotated"});
    tx.update(oldRef,{graceUntilMs:t+ROTATE_GRACE_MS});
    tx.create(db.collection(COLL.keys).doc(keyId),{bindingId:req.binding.id,digest:sha256hex(secret),scopes:o.data().scopes,
     createdAtMs:t,expiresAtMs:t+KEY_TTL_MS,revokedAtMs:null,graceUntilMs:null});
   });
   audit("key.rotate",{bindingId:req.binding.id,ownerHash:req.binding.ownerHash});
   res.status(201).json({apiKey:"gdpk_"+keyId+"_"+secret,keyExpiresAt:new Date(t+KEY_TTL_MS).toISOString(),
    previousKeyValidUntil:new Date(t+ROTATE_GRACE_MS).toISOString()});
  }catch(e){if(e?.code==="rotated")return fail(res,409,"already_rotated");fail(res,503,"provider_unavailable");}
 });

 // ---- quota accounting --------------------------------------------------------------------------------------
 // usedBytes moves inside a Firestore transaction BEFORE the object write (reservation) and is refunded if the write
 // fails. A crash between the two over-counts, never under-counts; reconcileBinding() repairs it from the bucket.
 async function adjust(binding,deltaBytes,deltaCount,{enforce}){
  const ref=db.collection(COLL.bindings).doc(binding.id);
  return db.runTransaction(async tx=>{
   const s=await tx.get(ref);
   if(!s.exists||s.data().revokedAtMs)throw Object.assign(Error(),{code:"binding_revoked"});
   const b=s.data(),used=(b.usedBytes||0)+deltaBytes;
   if(enforce&&deltaBytes>0&&used>b.quotaBytes)throw Object.assign(Error(),{code:"quota_exceeded",usedBytes:b.usedBytes,quotaBytes:b.quotaBytes});
   tx.update(ref,{usedBytes:Math.max(0,used),objectCount:Math.max(0,(b.objectCount||0)+deltaCount)});
  });
 }
 function noteError(binding,code){db.collection(COLL.bindings).doc(binding.id).update({lastError:{code,atMs:now()}}).catch(()=>{});}

 // Writes one object with optional caller precondition, keeping usedBytes exact. Returns {generation, created}.
 async function writeObject(binding,name,data,digest,{callerPrecondition,sameContentIsNoop}){
  for(let attempt=0;attempt<4;attempt++){
   const head=await blobs.head(name);
   if(callerPrecondition!==undefined){
    if(callerPrecondition==="0"&&head)throw Object.assign(Error(),{code:"precondition_failed"});
    if(callerPrecondition!=="0"&&(!head||head.generation!==callerPrecondition))throw Object.assign(Error(),{code:"precondition_failed"});
   }
   if(head&&sameContentIsNoop&&head.sha256===digest&&head.size===data.length)return {generation:head.generation,created:false};
   const delta=data.length-(head?head.size:0),countDelta=head?0:1;
   if(delta>0||countDelta)await adjust(binding,Math.max(0,delta),countDelta,{enforce:true});
   let put;
   try{put=await blobs.put(name,data,{ifGenerationMatch:head?head.generation:"0",sha256:digest});}
   catch(e){
    await adjust(binding,-Math.max(0,delta),-countDelta,{enforce:false}).catch(()=>{});
    if(e?.code==="precondition_failed"){if(callerPrecondition!==undefined)throw e;continue;}
    throw e;
   }
   if(delta<0)await adjust(binding,delta,0,{enforce:false}).catch(()=>{});
   return {generation:put.generation,created:!head};
  }
  throw Object.assign(Error(),{code:"conflict"});
 }
 async function removeObject(binding,name,callerPrecondition){
  for(let attempt=0;attempt<4;attempt++){
   const head=await blobs.head(name);
   if(!head){if(callerPrecondition&&callerPrecondition!=="0")throw Object.assign(Error(),{code:"precondition_failed"});return false;}
   if(callerPrecondition&&head.generation!==callerPrecondition)throw Object.assign(Error(),{code:"precondition_failed"});
   if(await blobs.delete(name,{ifGenerationMatch:head.generation})){
    await adjust(binding,-head.size,-1,{enforce:false}).catch(()=>{});return true;
   }
  }
  throw Object.assign(Error(),{code:"conflict"});
 }
 function storageError(req,res,e){
  const map={quota_exceeded:[507,"quota_exceeded"],precondition_failed:[412,"precondition_failed"],binding_revoked:[401,"binding_revoked"],conflict:[409,"conflict"]};
  const [status,code]=map[e?.code]||[503,"storage_unavailable"];
  if(status>=500||status===409)noteError(req.binding,code);
  if(code==="quota_exceeded"){audit("quota.hit",{bindingId:req.binding.id,ownerHash:req.binding.ownerHash});
   return fail(res,507,code,{usedBytes:e.usedBytes,quotaBytes:e.quotaBytes});}
  fail(res,status,code);
 }
 function rawBody(max){
  const parse=express.raw({type:()=>true,limit:max});
  return (req,res,next)=>{
   const len=Number(req.headers["content-length"]);
   if(Number.isFinite(len)&&len>max)return fail(res,413,max===MAX_BLOB_BYTES?"blob_too_large":"manifest_too_large",{maxBytes:max});
   parse(req,res,e=>{
    if(e?.type==="entity.too.large")return fail(res,413,max===MAX_BLOB_BYTES?"blob_too_large":"manifest_too_large",{maxBytes:max});
    if(e)return fail(res,400,"bad_body");
    if(!Buffer.isBuffer(req.body))req.body=Buffer.alloc(0);
    next();
   });
  };
 }
 const validId=(req,res,next)=>HEX64.test(req.params.id)?next():fail(res,400,"bad_id");
 const validKey=(req,res,next)=>HEX64.test(req.params.key)?next():fail(res,400,"bad_key");

 // ---- blobs (ChunkStore) -------------------------------------------------------------------------------------
 router.put("/blobs/:id",keyAuth,canWrite,validId,rawBody(MAX_BLOB_BYTES),async(req,res)=>{
  const mode=req.headers["x-id-mode"]||"content";
  if(mode!=="content"&&mode!=="sealed")return fail(res,400,"bad_id_mode");
  const digest=sha256hex(req.body),claimed=req.headers["x-content-sha256"];
  if(claimed!==undefined&&!(typeof claimed==="string"&&HEX64.test(claimed)))return fail(res,400,"bad_checksum_header");
  if(mode==="sealed"&&claimed===undefined)return fail(res,400,"checksum_required");
  if((claimed!==undefined&&claimed!==digest)||(mode==="content"&&digest!==req.params.id)){
   audit("blob.checksum_mismatch",{bindingId:req.binding.id,ownerHash:req.binding.ownerHash});
   return fail(res,422,"checksum_mismatch");
  }
  try{
   const out=await writeObject(req.binding,blobName(req.binding,req.params.id),req.body,digest,{sameContentIsNoop:true});
   res.set("ETag",'"'+out.generation+'"').set("X-Content-SHA256",digest).status(out.created?201:200).json({id:req.params.id,created:out.created,size:req.body.length});
  }catch(e){storageError(req,res,e);}
 });
 router.head("/blobs/:id",keyAuth,canRead,validId,async(req,res)=>{
  try{const h=await blobs.head(blobName(req.binding,req.params.id));
   if(!h)return res.status(404).end();
   res.set({"Content-Length":String(h.size),"ETag":'"'+h.generation+'"',...(h.sha256?{"X-Content-SHA256":h.sha256}:{})}).status(200).end();
  }catch(e){res.status(503).end();}
 });
 router.get("/blobs/:id",keyAuth,canRead,validId,async(req,res)=>{
  try{const o=await blobs.get(blobName(req.binding,req.params.id));
   if(!o)return fail(res,404,"not_found");
   res.set({"Content-Type":"application/octet-stream","ETag":'"'+o.generation+'"',"X-Content-SHA256":o.sha256||sha256hex(o.data)}).status(200).send(o.data);
  }catch(e){storageError(req,res,e);}
 });
 router.delete("/blobs/:id",keyAuth,canWrite,validId,async(req,res)=>{
  try{await removeObject(req.binding,blobName(req.binding,req.params.id));res.status(204).end();}catch(e){storageError(req,res,e);}
 });
 async function listIds(req,res,kind){
  const limit=Math.min(LIST_MAX,Math.max(1,Number.parseInt(req.query.limit,10)||LIST_MAX));
  const cursor=typeof req.query.cursor==="string"&&HEX64.test(req.query.cursor)?req.query.cursor:"";
  const base=objectPrefix(req.binding)+kind+"/";
  try{const page=await blobs.list(base,{cursor:cursor?base+cursor:"",limit});
   const ids=page.items.map(i=>i.name.slice(base.length)).filter(id=>HEX64.test(id));
   res.json({ids,next:page.next?page.next.slice(base.length):null});
  }catch(e){storageError(req,res,e);}
 }
 router.get("/blobs",keyAuth,canRead,(req,res)=>listIds(req,res,"b"));
 router.post("/blobs/batch-has",keyAuth,canRead,express.json({limit:"80kb"}),async(req,res)=>{
  const ids=req.body?.ids;
  if(!Array.isArray(ids)||ids.length>BATCH_HAS_MAX||!ids.every(i=>typeof i==="string"&&HEX64.test(i)))return fail(res,400,"bad_ids");
  try{
   const present=[];let i=0;
   await Promise.all(Array.from({length:Math.min(16,ids.length)},async()=>{
    while(i<ids.length){const id=ids[i++];if(await blobs.head(blobName(req.binding,id)))present.push(id);}
   }));
   res.json({present:ids.filter(id=>present.includes(id))});
  }catch(e){storageError(req,res,e);}
 });

 // ---- manifests (ManifestStore) -------------------------------------------------------------------------------
 function precondition(req){
  const inm=req.headers["if-none-match"],im=req.headers["if-match"];
  if(inm!==undefined&&im!==undefined)return {error:"bad_precondition"};
  if(inm!==undefined)return inm.trim()==="*"?{value:"0"}:{error:"bad_precondition"};
  if(im!==undefined){const g=etagValue(im);return g?{value:g}:{error:"bad_precondition"};}
  return {value:undefined};
 }
 router.get("/manifests/:key",keyAuth,canRead,validKey,async(req,res)=>{
  try{const o=await blobs.get(manifestName(req.binding,req.params.key));
   if(!o)return fail(res,404,"not_found");
   res.set({"Content-Type":"application/octet-stream","ETag":'"'+o.generation+'"',"X-Content-SHA256":o.sha256||sha256hex(o.data)}).status(200).send(o.data);
  }catch(e){storageError(req,res,e);}
 });
 router.put("/manifests/:key",keyAuth,canWrite,validKey,rawBody(MAX_MANIFEST_BYTES),async(req,res)=>{
  const p=precondition(req);if(p.error)return fail(res,400,p.error);
  const digest=sha256hex(req.body),claimed=req.headers["x-content-sha256"];
  if(claimed!==undefined&&claimed!==digest)return fail(res,422,"checksum_mismatch");
  try{
   const out=await writeObject(req.binding,manifestName(req.binding,req.params.key),req.body,digest,{callerPrecondition:p.value,sameContentIsNoop:false});
   res.set("ETag",'"'+out.generation+'"').status(out.created?201:200).json({key:req.params.key,created:out.created,size:req.body.length});
  }catch(e){storageError(req,res,e);}
 });
 router.delete("/manifests/:key",keyAuth,canWrite,validKey,async(req,res)=>{
  const p=precondition(req);if(p.error)return fail(res,400,p.error);
  try{await removeObject(req.binding,manifestName(req.binding,req.params.key),p.value);res.status(204).end();}catch(e){storageError(req,res,e);}
 });
 router.get("/manifests",keyAuth,canRead,(req,res)=>listIds(req,res,"m"));

 // ---- usage, health, capabilities -----------------------------------------------------------------------------
 router.get("/usage",keyAuth,canRead,async(req,res)=>{
  try{const s=await db.collection(COLL.bindings).doc(req.binding.id).get();const b=s.data();
   res.json({usedBytes:b.usedBytes||0,quotaBytes:b.quotaBytes,objectCount:b.objectCount||0,workspaceId:b.workspaceId});
  }catch(_){fail(res,503,"provider_unavailable");}
 });
 router.get("/health",keyAuth,(req,res)=>res.json({ok:true,time:new Date(now()).toISOString()}));
 router.get("/capabilities",(req,res)=>res.json(capabilities()));

 // ---- bindings, for the signed-in Gendragoon user ----------------------------------------------------------------
 router.get("/bindings",firebaseAuth,async(req,res)=>{
  try{const docs=await db.collection(COLL.bindings).where("ownerHash","==",accountKey(req.user.uid)).limit(100).get();
   res.json({bindings:docs.docs.map(d=>{const b=d.data();return {id:b.id,workspaceId:b.workspaceId,client:b.client,scopes:b.scopes,
    usedBytes:b.usedBytes||0,quotaBytes:b.quotaBytes,objectCount:b.objectCount||0,createdAt:new Date(b.createdAtMs).toISOString(),
    lastUsedAt:b.lastUsedAtMs?new Date(b.lastUsedAtMs).toISOString():null,lastError:b.lastError||null,active:!b.revokedAtMs};})});
  }catch(_){fail(res,503,"provider_unavailable");}
 });
 router.delete("/bindings/:id",firebaseAuth,async(req,res)=>{
  if(!/^[0-9a-f-]{36}$/.test(req.params.id))return fail(res,404,"not_found");
  try{
   const ref=db.collection(COLL.bindings).doc(req.params.id),s=await ref.get();
   if(!s.exists||s.data().ownerHash!==accountKey(req.user.uid))return fail(res,404,"not_found");
   await revokeBinding(req.params.id);
   let purged=null;
   if(req.query.deleteData==="true")purged=await purgeBinding(req.params.id);
   audit(purged?"binding.revoke_and_purge":"binding.revoke",{bindingId:req.params.id,ownerHash:s.data().ownerHash});
   res.json({revoked:true,purgedObjects:purged});
  }catch(_){fail(res,503,"provider_unavailable");}
 });

 async function revokeBinding(id){
  const t=now();
  await db.collection(COLL.bindings).doc(id).update({revokedAtMs:t});
  const keys=await db.collection(COLL.keys).where("bindingId","==",id).limit(50).get();
  for(const k of keys.docs)if(!k.data().revokedAtMs)await k.ref.update({revokedAtMs:t});
 }
 async function bindingDoc(id){const s=await db.collection(COLL.bindings).doc(id).get();if(!s.exists)throw Error("no binding");return s.data();}
 // Deletes every object of a binding (disconnect + delete data, account deletion G7).
 async function purgeBinding(id){
  const b=await bindingDoc(id),base=objectPrefix(b);let n=0,cursor="";
  for(;;){const page=await blobs.list(base,{cursor,limit:LIST_MAX});
   for(const it of page.items){if(await blobs.delete(it.name))n++;}
   if(!page.next)break;cursor=page.next;}
  await db.collection(COLL.bindings).doc(id).update({usedBytes:0,objectCount:0});
  return n;
 }
 // Recomputes usedBytes/objectCount from the bucket (repairs a crash between reservation and write).
 async function reconcileBinding(id){
  const b=await bindingDoc(id),base=objectPrefix(b);let bytes=0,count=0,cursor="";
  for(;;){const page=await blobs.list(base,{cursor,limit:LIST_MAX});
   for(const it of page.items){bytes+=it.size;count++;}
   if(!page.next)break;cursor=page.next;}
  await db.collection(COLL.bindings).doc(id).update({usedBytes:bytes,objectCount:count});
  return {usedBytes:bytes,objectCount:count,previousUsedBytes:b.usedBytes||0};
 }

 app.use(prefix,router);
 return {router,revokeBinding,purgeBinding,reconcileBinding,capabilities,COLL};
}
module.exports={registerProviderV1,MAX_BLOB_BYTES,MAX_MANIFEST_BYTES,COLL};
