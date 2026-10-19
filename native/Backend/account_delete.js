"use strict";
// In-app account deletion (Apple App Store guideline 5.1.1(v)).
// One resumable job per accountHash. A 60s lease in the job document keeps
// two instances from running the same job. Stripe subscriptions are cancelled
// immediately with no proration invoice. Managed objects are removed.
// Customer-owned (BYO) buckets are never called; only our record of them is
// dropped. Firebase refresh tokens are revoked and the user is deleted last.
const crypto=require("node:crypto");
const {deleteAccountKeyEnvelopes}=require("./key_envelope");
const REAUTH_SECONDS=5*60;
const STATUS_TOKEN_TTL_MS=7*24*60*60*1000;
const LEASE_MS=60*1000;
const MAX_STATUS_TOKENS=5;
const MAX_FAILED_ATTEMPTS=5;
const SUPPORT_WINDOW_MS=24*60*60*1000;
const SUPPORT_MAX_CALLS=5;
const NOTIFY_BACKOFF_MS=[60*1000,5*60*1000,30*60*1000,2*60*60*1000,6*60*60*1000];
const NOTIFY_MAX_ATTEMPTS=5;
const SUPPORT_STALE_MS=60*60*1000;
const NAMES_TTL_MS=30*24*60*60*1000;
const SUPPORT_DOC_TTL_MS=NAMES_TTL_MS;
const SUPPORT_SWEEP_INTERVAL_MS=60*1000;
const SWEEP_LIMIT=50;
const CONTENT_LIMIT=1800;
const JOB_STATUS=new Set(["queued","running","done","failed"]);
const SUBSCRIPTION_KEY=/SubscriptionId$/;
const SUB_STATUS=new Set(["incomplete","incomplete_expired","trialing","active","past_due","canceled","unpaid","paused","unknown"]);
const FIREBASE_STATUS=new Set(["active","disabled","missing","deleted","unknown"]);
const DISCORD_CONFIG_MESSAGE="support_notify_unconfigured: SUPPORT_DISCORD_WEBHOOK_URL must be an https://discord.com/api/webhooks/ URL";
let registeredSweep=null;
const supportInflight=new Set();
function trackSupport(work){
 const done=Promise.resolve().then(work);
 supportInflight.add(done);
 done.finally(()=>supportInflight.delete(done));
 return done;
}
function whenSupportSettled(){
 const step=()=>supportInflight.size?Promise.allSettled([...supportInflight]).then(step):Promise.resolve();
 return step();
}
function supportGateRequired(env){
 if(typeof env?.K_SERVICE==="string"&&env.K_SERVICE.length>0)return true;
 return env?.NODE_ENV==="production";
}

function refusal(status,code,extra){
 const error=new Error(code);
 error.status=status;
 error.code=code;
 if(extra&&typeof extra==="object")Object.assign(error,extra);
 return error;
}
function authCodeMeansGone(error){
 const code=error?.code;
 return code==="auth/user-not-found"||code==="auth/user-disabled"||code==="auth/id-token-revoked";
}
function isMissing(error){
 const code=error?.code;
 return code==="auth/user-not-found"||code==="resource_missing"||code===5||code===404||code==="404"||code==="ENOENT"||code==="storage/object-not-found"||error?.status===404||error?.statusCode===404;
}
async function ignoreMissing(work){
 try{return await work();}
 catch(error){if(!isMissing(error))throw error;}
}
const STRIPE_TYPE={
 StripeAuthenticationError:"authentication_error",
 StripePermissionError:"permission_error",
 StripeInvalidRequestError:"invalid_request_error",
 StripeRateLimitError:"rate_limit_error",
 StripeAPIError:"api_error",
 StripeConnectionError:"api_connection_error",
 StripeIdempotencyError:"idempotency_error",
};
function errorChain(error){
 const list=[];
 let current=error;
 for(let depth=0;depth<4&&current;depth++){
  list.push(current);
  current=current.cause;
 }
 return list;
}
function stripeType(error){
 const raw=error?.rawType||error?.raw?.type;
 if(typeof raw==="string"&&raw)return raw;
 const type=error?.type;
 if(typeof type!=="string"||!type)return "";
 return STRIPE_TYPE[type]||type;
}
function httpStatus(error){
 const value=error?.statusCode??(typeof error?.status==="number"||typeof error?.status==="string"?error.status:undefined);
 if(typeof value==="number"&&Number.isInteger(value))return value;
 if(typeof value==="string"&&/^\d+$/.test(value))return Number(value);
 return null;
}
function isTimeoutError(error){
 const code=String(error?.code||error?.errno||"");
 if(/^(ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|ETIME)$/.test(code))return true;
 return /timeout/i.test(code);
}
function isNetworkError(error){
 const code=String(error?.code||error?.errno||"");
 if(/^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EPIPE)$/.test(code))return true;
 return code==="api_connection_error"||stripeType(error)==="api_connection_error";
}
function isGcsPermission(error){
 const code=error?.code??error?.statusCode??error?.status;
 if(code===403||code==="403")return true;
 const reason=[error?.code,error?.reason,error?.errors?.[0]?.reason].filter(item=>typeof item==="string").join(" ");
 return /permission[-_ ]?denied|^forbidden$|storage\/unauthorized/i.test(reason);
}
// Permanent classes cannot succeed on another try. Everything else stays
// retryable until the attempt cap: 5xx, network, timeouts, and 429.
function classifyDeletionError(error){
 const items=errorChain(error);
 for(const item of items){
  // resource_missing is success at the call site. If it still arrives here, it is
  // not an invalid_request failure and must not become permanent.
  if(item?.code==="resource_missing"||item?.raw?.code==="resource_missing")continue;
  const type=stripeType(item);
  if(type==="authentication_error")return {permanent:true,failureReason:"stripe_authentication_error"};
  if(type==="permission_error")return {permanent:true,failureReason:"stripe_permission_error"};
  if(type==="invalid_request_error")return {permanent:true,failureReason:"stripe_invalid_request"};
 }
 if(items.some(item=>item?.ownPrefix===true)&&items.some(isGcsPermission))
  return {permanent:true,failureReason:"gcs_permission_denied"};
 for(const item of items){
  const status=httpStatus(item);
  if(stripeType(item)==="rate_limit_error"||status===429||item?.code==="rate_limit_error")
   return {permanent:false,failureReason:"rate_limited"};
 }
 if(items.some(isTimeoutError))return {permanent:false,failureReason:"timeout"};
 if(items.some(isNetworkError))return {permanent:false,failureReason:"network"};
 for(const item of items){
  const status=httpStatus(item);
  if(stripeType(item)==="api_error"||(status>=500&&status<=599))
   return {permanent:false,failureReason:"upstream_unavailable"};
 }
 return {permanent:false,failureReason:"deletion_step_failed"};
}
function plainJob(job){
 const steps={...(job.steps||{})};
 if(steps.prefixes)steps.prefixes={...steps.prefixes};
 const data={jobId:job.jobId,accountHash:job.accountHash,status:job.status,steps,
  canceledIds:[...(job.canceledIds||[])],subscriptionIds:[...(job.subscriptionIds||[])],
  customerId:job.customerId||null,retryable:job.retryable===true,failure:job.failure||null,
  failureReason:typeof job.failureReason==="string"?job.failureReason:null,
  attempts:Number.isInteger(job.attempts)&&job.attempts>0?job.attempts:0,
  statusTokens:(job.statusTokens||[]).map(item=>({hash:item.hash,expiresAtMs:item.expiresAtMs}))};
 if(job.lease&&typeof job.lease.owner==="string"&&typeof job.lease.expiresAtMs==="number")
  data.lease={owner:job.lease.owner,expiresAtMs:job.lease.expiresAtMs};
 if(job.status!=="done"&&job.uid)data.uid=job.uid;
 if(Array.isArray(job.workspaceIds))data.workspaceIds=[...job.workspaceIds];
 if(!job.namesCleared&&job.workspaceNames&&typeof job.workspaceNames==="object"){
  const names={};
  for(const [id,value] of Object.entries(job.workspaceNames)){
   const plain=plaintextWorkspaceName(value);
   if(plain)names[id]=plain;
  }
  if(Object.keys(names).length)data.workspaceNames=names;
 }
 if(job.namesExpireAt){
  const stamp=new Date(job.namesExpireAt);
  if(!Number.isNaN(stamp.getTime()))data.namesExpireAt=stamp;
 }
 if(Number.isInteger(job.startedAtMs))data.startedAtMs=job.startedAtMs;
 if(job.prefixProgress&&typeof job.prefixProgress==="object")data.prefixProgress=structuredClone(job.prefixProgress);
 if(Array.isArray(job.subscriptionStatuses))
  data.subscriptionStatuses=job.subscriptionStatuses.filter(row=>row&&typeof row.id==="string").map(row=>({id:row.id,status:safeSubscriptionStatus(row.status)}));
 if(typeof job.firebaseStatus==="string"&&FIREBASE_STATUS.has(job.firebaseStatus))data.firebaseStatus=job.firebaseStatus;
 return data;
}
function pruneStatusTokens(list,now){
 const live=[];
 for(const item of list||[]){
  if(!item||typeof item.hash!=="string"||!/^[a-f0-9]{64}$/.test(item.hash))continue;
  if(typeof item.expiresAtMs!=="number"||now>item.expiresAtMs)continue;
  live.push({hash:item.hash,expiresAtMs:item.expiresAtMs});
 }
 // Oldest first. A sixth unexpired hash drops the oldest.
 return live.slice(-MAX_STATUS_TOKENS);
}
function mergeStatusTokens(stored,memory,now){
 const merged=[];
 const seen=new Set();
 for(const item of [...(stored||[]),...(memory||[])]){
  if(!item||typeof item.hash!=="string"||seen.has(item.hash))continue;
  seen.add(item.hash);
  merged.push(item);
 }
 return pruneStatusTokens(merged,now);
}
function supportRequestId(jobId){
 return crypto.createHash("sha256").update("gd-support-v1:"+jobId).digest("hex");
}
function plaintextWorkspaceName(value){
 if(typeof value!=="string")return "";
 const name=value.trim().normalize("NFC");
 if(!name||name.length>150||/[\u0000-\u001f]/.test(name))return "";
 return name;
}
function safeSubscriptionStatus(status){
 return SUB_STATUS.has(status)?status:"unknown";
}
function workspacePlace(accountHash,objectName){
 if(typeof objectName!=="string"||typeof accountHash!=="string")return null;
 for(const root of ["customer/"+accountHash+"/","tenants/"+accountHash+"/"]){
  if(!objectName.startsWith(root))continue;
  const parts=objectName.slice(root.length).split("/").filter(Boolean);
  if(parts[0]==="managed"&&parts[1])return {id:parts[1],prefix:root+"managed/"+parts[1]+"/"};
  if(parts[0])return {id:parts[0],prefix:root+parts[0]+"/"};
 }
 return null;
}
function opaqueObjectId(objectName){
 const leaf=String(objectName||"").split("/").filter(Boolean).pop()||"";
 return /^[A-Za-z0-9_-]{16,}$/.test(leaf)?leaf:"";
}
function ingestObjects(job,names,replaceUnder){
 if(!job.prefixProgress||typeof job.prefixProgress!=="object")job.prefixProgress={};
 if(replaceUnder){
  for(const rows of Object.values(job.prefixProgress)){
   for(const [prefix,row] of Object.entries(rows)){
    if(prefix.startsWith(replaceUnder)){row.remaining=0;row.remainingIds=[];}
   }
  }
 }
 for(const name of names||[]){
  const place=workspacePlace(job.accountHash,name);
  if(!place)continue;
  const rows=job.prefixProgress[place.id]||(job.prefixProgress[place.id]={});
  const row=rows[place.prefix]||(rows[place.prefix]={deleted:0,remaining:0,remainingIds:[]});
  row.remaining+=1;
  const opaque=opaqueObjectId(name);
  if(opaque&&row.remainingIds.length<200&&!row.remainingIds.includes(opaque))row.remainingIds.push(opaque);
 }
}
function markPrefixDeleted(job,accountPrefix){
 for(const rows of Object.values(job.prefixProgress||{})){
  for(const [prefix,row] of Object.entries(rows)){
   if(!prefix.startsWith(accountPrefix))continue;
   row.deleted=(row.deleted||0)+(row.remaining||0);
   row.remaining=0;
   row.remainingIds=[];
  }
 }
}
function discordWebhookUrl(env){
 const raw=env&&typeof env.SUPPORT_DISCORD_WEBHOOK_URL==="string"?env.SUPPORT_DISCORD_WEBHOOK_URL.trim():"";
 if(!raw)return {valid:false,url:""};
 let parsed;
 try{parsed=new URL(raw);}catch{return {valid:false,url:""};}
 if(parsed.protocol!=="https:"||parsed.username||parsed.password||parsed.search||parsed.hash)return {valid:false,url:""};
 const host=parsed.hostname.toLowerCase();
 if(host!=="discord.com"&&!host.endsWith(".discord.com"))return {valid:false,url:""};
 if(!/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{8,}\/?$/.test(parsed.pathname))return {valid:false,url:""};
 return {valid:true,url:"https://"+host+parsed.pathname.replace(/\/$/,"")};
}
function supportDiscordStartup(env=process.env){
 const valid=discordWebhookUrl(env).valid;
 if(supportGateRequired(env))return valid?{exit:false}:{exit:true,code:1,message:DISCORD_CONFIG_MESSAGE};
 if(!valid)return {exit:false,warn:true,message:DISCORD_CONFIG_MESSAGE};
 return {exit:false};
}
function escapeDiscord(value){
 return String(value).replace(/[\\*_~`|>\[\]()#-]/g,"\\$&");
}
function mentionStrip(value){
 return String(value??"").replaceAll("@everyone","everyone").replaceAll("@here","here").replaceAll("<@","<");
}
function discordText(value){
 return escapeDiscord(mentionStrip(value));
}
function discordContent(job){
 const names=job?.workspaceNames&&typeof job.workspaceNames==="object"?job.workspaceNames:{};
 const ids=Array.isArray(job?.workspaceIds)?job.workspaceIds:Object.keys(job?.prefixProgress||{});
 const listed=ids.map(id=>{
  const name=plaintextWorkspaceName(names[id]);
  const safe=name?discordText(name):"";
  return safe?id+" "+safe:id;
 }).join(", ");
 const uid=typeof job?.uid==="string"?mentionStrip(job.uid):"";
 const content=["uid: "+uid,"jobId: "+(job?.jobId||""),
  "failureReason: "+(typeof job?.failureReason==="string"?job.failureReason:""),
  "attempts: "+(Number.isInteger(job?.attempts)?job.attempts:0),"workspaces: "+listed].join("\n");
 return content.length>CONTENT_LIMIT?content.slice(0,CONTENT_LIMIT):content;
}
function discordFile(job){
 const names=job?.workspaceNames&&typeof job.workspaceNames==="object"?job.workspaceNames:{};
 const ids=[...new Set([...(job?.workspaceIds||[]),...Object.keys(job?.prefixProgress||{})])];
 return {workspaces:ids.map(id=>{
  const row={id};
  const name=plaintextWorkspaceName(names[id]);
  if(name)row.name=name;
  const prefixes=job?.prefixProgress?.[id]||{};
  row.prefixes=Object.keys(prefixes).sort().map(prefix=>({prefix,deleted:prefixes[prefix].deleted||0,
   remaining:prefixes[prefix].remaining||0,remainingIds:[...(prefixes[prefix].remainingIds||[])]}));
  return row;
 }),subscriptions:(job?.subscriptionStatuses||[]).filter(row=>row&&typeof row.id==="string"&&!row.id.includes("@"))
  .map(row=>({id:row.id,status:safeSubscriptionStatus(row.status)})),
 firebase:{status:FIREBASE_STATUS.has(job?.firebaseStatus)?job.firebaseStatus:"unknown"}};
}
function multipartBody(boundary,payloadJson,filename,fileJson){
 const chunks=[];
 const add=value=>chunks.push(Buffer.from(value));
 add("--"+boundary+"\r\nContent-Disposition: form-data; name=\"payload_json\"\r\n\r\n"+payloadJson+"\r\n");
 add("--"+boundary+"\r\nContent-Disposition: form-data; name=\"files[0]\"; filename=\""+filename+"\"\r\nContent-Type: application/json\r\n\r\n"+fileJson+"\r\n");
 add("--"+boundary+"--\r\n");
 return Buffer.concat(chunks);
}
function safeNotifyError(){
 const failure=new Error("support deletion notify failed");
 failure.code="support_notify_failed";
 failure.stack="Error: support deletion notify failed";
 return failure;
}
function createDiscordNotifier({env=process.env,fetchImpl=globalThis.fetch,warn=console.warn}={}){
 return async function notify(event){
  const target=discordWebhookUrl(env);
  if(!target.valid){
   warn("support_notify_unconfigured");
   throw Object.assign(new Error("support_notify_unconfigured"),{code:"support_notify_unconfigured"});
  }
  const boundary="gdsupport"+crypto.randomBytes(12).toString("hex");
  const payload=JSON.stringify({content:typeof event?.content==="string"?event.content:"",allowed_mentions:{parse:[]}});
  const filename=typeof event?.filename==="string"&&event.filename?event.filename:"deletion.json";
  const body=multipartBody(boundary,payload,filename,JSON.stringify(event?.file||{}));
  let response;
  try{
   response=await fetchImpl(target.url,{method:"POST",headers:{"content-type":"multipart/form-data; boundary="+boundary},body,
    signal:typeof AbortSignal!=="undefined"&&typeof AbortSignal.timeout==="function"?AbortSignal.timeout(10000):undefined});
  }catch(_){
   throw safeNotifyError();
  }
  if(!response||response.ok!==true)throw safeNotifyError();
 };
}
function freshNotify(at){
 return {state:"pending",attempts:0,nextAttemptAt:new Date(at).toISOString(),
  staleDueAt:new Date(at+SUPPORT_STALE_MS+1).toISOString()};
}
function supportTerminal(notify){
 if(notify?.state==="sent")return true;
 return notify?.state==="failed"&&(notify.jobMissing===true||(Number.isInteger(notify.attempts)&&notify.attempts>=NOTIFY_MAX_ATTEMPTS));
}
function keepStale(current){
 const kept={};
 if(typeof current?.staleAlertedAt==="string")kept.staleAlertedAt=current.staleAlertedAt;
 if(typeof current?.staleDueAt==="string")kept.staleDueAt=current.staleDueAt;
 return kept;
}
function rememberSubscription(job,id,status){
 if(typeof id!=="string"||!id||id.includes("@"))return;
 if(!Array.isArray(job.subscriptionStatuses))job.subscriptionStatuses=[];
 const safe=safeSubscriptionStatus(status);
 const row=job.subscriptionStatuses.find(item=>item.id===id);
 if(row)row.status=safe;
 else job.subscriptionStatuses.push({id,status:safe});
}
function bearerToken(req){
 const match=/^Bearer ([A-Za-z0-9._~-]+)$/.exec(req?.headers?.authorization||"");
 return match?match[1]:"";
}
function createAccountDeletion({db,stripe,bucket,auth,byoProviders,hash,now,notifier,env}){
 // byoProviders is accepted so callers can pass the registry. Deletion must
 // never invoke it: customer-owned storage stays untouched.
 void byoProviders;
 const runtimeEnv=env||process.env;
 const notify=typeof notifier==="function"?notifier:createDiscordNotifier({env:runtimeEnv});
 function webhookReady(){return typeof notifier==="function"||discordWebhookUrl(runtimeEnv).valid;}
 const instanceId=crypto.randomBytes(16).toString("hex");
 const jobs=new Map();
 const clock=()=>typeof now==="function"?now():Date.now();
 function accountRef(owner){return db.collection("account_deletions").doc(owner)}
 function jobRef(jobId){return db.collection("deletion_jobs").doc(jobId)}
 function heldByOther(lease,at){
  return !!(lease&&lease.owner!==instanceId&&typeof lease.expiresAtMs==="number"&&at<=lease.expiresAtMs);
 }
 function absorb(job,stored){
  if(!stored)return;
  const steps={...(stored.steps||{}),...(job.steps||{})};
  steps.prefixes={...(stored.steps?.prefixes||{}),...(job.steps?.prefixes||{})};
  for(const key of ["stripe","stripeListed","objects","metadata","firebase"])
   if(stored.steps?.[key]||job.steps?.[key])steps[key]=true;
  job.steps=steps;
  job.canceledIds=[...new Set([...(stored.canceledIds||[]),...(job.canceledIds||[])])];
  job.subscriptionIds=[...new Set([...(stored.subscriptionIds||[]),...(job.subscriptionIds||[])])];
  if(!job.customerId&&stored.customerId)job.customerId=stored.customerId;
  const storedAttempts=Number.isInteger(stored.attempts)?stored.attempts:0;
  const liveAttempts=Number.isInteger(job.attempts)?job.attempts:0;
  job.attempts=Math.max(storedAttempts,liveAttempts);
  if(!job.uid&&stored.uid)job.uid=stored.uid;
  if(stored.accountHash)job.accountHash=stored.accountHash;
  if(stored.jobId)job.jobId=stored.jobId;
  if(!Array.isArray(job.workspaceIds)&&Array.isArray(stored.workspaceIds))job.workspaceIds=[...stored.workspaceIds];
  if(!job.namesCleared&&job.workspaceNames==null&&stored.workspaceNames&&typeof stored.workspaceNames==="object")
   job.workspaceNames={...stored.workspaceNames};
  if(!job.namesExpireAt&&stored.namesExpireAt)job.namesExpireAt=stored.namesExpireAt;
  if(Number.isInteger(stored.startedAtMs)&&(!Number.isInteger(job.startedAtMs)||stored.startedAtMs<job.startedAtMs))
   job.startedAtMs=stored.startedAtMs;
  const progress=structuredClone(stored.prefixProgress||{});
  for(const [id,rows] of Object.entries(job.prefixProgress||{}))progress[id]={...(progress[id]||{}),...structuredClone(rows)};
  job.prefixProgress=progress;
  const statuses=new Map();
  for(const row of [...(stored.subscriptionStatuses||[]),...(job.subscriptionStatuses||[])]){
   if(row&&typeof row.id==="string")statuses.set(row.id,{id:row.id,status:safeSubscriptionStatus(row.status)});
  }
  job.subscriptionStatuses=[...statuses.values()];
  if(!job.firebaseStatus&&typeof stored.firebaseStatus==="string")job.firebaseStatus=stored.firebaseStatus;
 }
 function writeBoth(tx,job){
  const data=plainJob(job);
  tx.set(jobRef(job.jobId),data);
  tx.set(accountRef(job.accountHash),data);
  return data;
 }
 function statusTokenMatches(job,token){
  if(!job||typeof token!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(token))return false;
  const actual=Buffer.from(crypto.createHash("sha256").update(token).digest("hex"),"hex");
  if(actual.length!==32)return false;
  const at=clock();
  for(const item of job.statusTokens||[]){
   if(typeof item?.expiresAtMs!=="number"||at>item.expiresAtMs)continue;
   const expected=Buffer.from(String(item.hash||""),"hex");
   if(expected.length===actual.length&&crypto.timingSafeEqual(actual,expected))return true;
  }
  return false;
 }
 function remembered(owner){
  for(const job of jobs.values())if(job.accountHash===owner)return job;
  return null;
 }
 function hydrate(data){
  return {jobId:data.jobId,accountHash:data.accountHash,uid:data.uid,status:data.status,
   steps:{...(data.steps||{}),prefixes:{...(data.steps?.prefixes||{})}},
   canceledIds:[...(data.canceledIds||[])],subscriptionIds:[...(data.subscriptionIds||[])],
   customerId:data.customerId||null,retryable:data.retryable===true,failure:data.failure||null,
   failureReason:typeof data.failureReason==="string"?data.failureReason:null,
   attempts:Number.isInteger(data.attempts)&&data.attempts>0?data.attempts:0,
   statusTokens:(data.statusTokens||[]).map(item=>({hash:item.hash,expiresAtMs:item.expiresAtMs})),
   workspaceIds:Array.isArray(data.workspaceIds)?[...data.workspaceIds]:null,
   workspaceNames:data.workspaceNames&&typeof data.workspaceNames==="object"?{...data.workspaceNames}:null,
   namesExpireAt:data.namesExpireAt?new Date(data.namesExpireAt):null,
   startedAtMs:Number.isInteger(data.startedAtMs)?data.startedAtMs:null,
   prefixProgress:data.prefixProgress?structuredClone(data.prefixProgress):null,
   subscriptionStatuses:Array.isArray(data.subscriptionStatuses)?data.subscriptionStatuses.map(row=>({id:row.id,status:safeSubscriptionStatus(row.status)})):[],
   firebaseStatus:typeof data.firebaseStatus==="string"?data.firebaseStatus:null,
   lease:data.lease?{owner:data.lease.owner,expiresAtMs:data.lease.expiresAtMs}:null,inflight:false};
 }
 async function load(owner){
  const live=remembered(owner);
  if(live)return live;
  const snap=await accountRef(owner).get();
  if(!snap.exists)return null;
  const data=snap.data();
  if(!data?.jobId||!JOB_STATUS.has(data.status))return null;
  const job=hydrate(data);
  jobs.set(job.jobId,job);
  return job;
 }
 async function readJob(jobId){
  const snap=await jobRef(jobId).get();
  return snap.exists?snap.data():null;
 }
 // Extend our lease, or take an absent/expired one. A live lease owned by
 // another instance is left untouched and this instance does not become the runner.
 async function renewLease(job){
  let ok=false;
  await db.runTransaction(async tx=>{
   const snap=await tx.get(jobRef(job.jobId));
   const stored=snap.exists?snap.data():null;
   const at=clock();
   if(stored?.status==="done"){absorb(job,stored);job.status="done";job.statusTokens=mergeStatusTokens(stored.statusTokens,job.statusTokens,at);ok=false;return;}
   if(heldByOther(stored?.lease,at)){absorb(job,stored);job.lease=stored.lease;job.statusTokens=mergeStatusTokens(stored.statusTokens,job.statusTokens,at);ok=false;return;}
   if(stored)absorb(job,stored);
   job.lease={owner:instanceId,expiresAtMs:at+LEASE_MS};
   if(job.status!=="done")job.status="running";
   job.failure=null;
   job.statusTokens=mergeStatusTokens(stored?.statusTokens,job.statusTokens,at);
   writeBoth(tx,job);
   ok=true;
  });
  return ok;
 }
 // Checkpoint write. A holder whose lease expired, or was taken, stops here
 // without writing the in-memory batch.
 async function commitCheckpoint(job){
  let ok=false;
  await db.runTransaction(async tx=>{
   const snap=await tx.get(jobRef(job.jobId));
   const stored=snap.exists?snap.data():null;
   const at=clock();
   const own=stored?.lease?.owner===instanceId&&typeof stored?.lease?.expiresAtMs==="number"&&at<=stored.lease.expiresAtMs;
   if(!own||(stored?.status==="done"&&job.status!=="done")){
    if(stored){absorb(job,stored);job.lease=stored.lease||null;if(stored.status==="done")job.status="done";
     job.statusTokens=mergeStatusTokens(stored.statusTokens,job.statusTokens,at);}
    ok=false;return;
   }
   job.lease={owner:instanceId,expiresAtMs:stored.lease.expiresAtMs};
   job.statusTokens=mergeStatusTokens(stored.statusTokens,job.statusTokens,at);
   writeBoth(tx,job);
   ok=true;
  });
  return ok;
 }
 async function issueStatusToken(job,{claim}){
  const statusToken=crypto.randomBytes(32).toString("base64url");
  const extra={hash:crypto.createHash("sha256").update(statusToken).digest("hex"),expiresAtMs:clock()+STATUS_TOKEN_TTL_MS};
  let claimed=false;
  await db.runTransaction(async tx=>{
   const snap=await tx.get(jobRef(job.jobId));
   const stored=snap.exists?snap.data():null;
   const at=clock();
   const tokens=mergeStatusTokens(stored?.statusTokens,[...(job.statusTokens||[]),extra],at);
   const finished=stored?.status==="done"||job.status==="done";
   if(claim&&!finished&&!heldByOther(stored?.lease,at)){
    if(stored)absorb(job,stored);
    job.lease={owner:instanceId,expiresAtMs:at+LEASE_MS};
    job.statusTokens=tokens;
    // Stay queued until the runner renews the lease. That renewal is what
    // clients observe as running, including a failed job that DELETE just requeued.
    if(job.status!=="done"&&job.status!=="queued")job.status="running";
    writeBoth(tx,job);
    claimed=true;
    return;
   }
   const base=stored?{...stored,statusTokens:tokens}:{...plainJob(job),statusTokens:tokens};
   if(stored?.lease)base.lease={owner:stored.lease.owner,expiresAtMs:stored.lease.expiresAtMs};
   tx.set(jobRef(job.jobId),base);
   tx.set(accountRef(job.accountHash),base);
   job.statusTokens=tokens;
   if(stored?.lease)job.lease={owner:stored.lease.owner,expiresAtMs:stored.lease.expiresAtMs};
  });
  jobs.set(job.jobId,job);
  return {statusToken,claimed};
 }
 async function ensureSubscriptions(job){
  if(job.steps?.stripeListed)return;
  const owner=job.accountHash;
  const account=await db.collection("gd_accounts").doc(owner).get();
  const customer=account.exists?account.data()?.stripeCustomerId:job.customerId;
  if(typeof customer==="string"&&customer)job.customerId=customer;
  const ids=new Set(job.subscriptionIds||[]);
  const workspaces=await db.collection("gd_accounts").doc(owner).collection("workspaces").get();
  for(const doc of workspaces.docs||[]){
   const data=doc.data()||{};
   for(const [key,value] of Object.entries(data)){
    if(SUBSCRIPTION_KEY.test(key)&&typeof value==="string"&&value&&!value.includes("@")){
     ids.add(value);
     rememberSubscription(job,value,"unknown");
    }
   }
  }
  if(job.customerId&&typeof stripe?.subscriptions?.list==="function"){
   let startingAfter;
   do{
    let page;
    try{
     page=await stripe.subscriptions.list({customer:job.customerId,status:"all",limit:100,
      ...(startingAfter?{starting_after:startingAfter}:{})});
    }catch(error){
     // A missing customer has nothing to cancel. Other invalid requests fail the job.
     if(isMissing(error))break;
     throw error;
    }
    const rows=page?.data||[];
    for(const sub of rows){
     const subCustomer=typeof sub?.customer==="string"?sub.customer:sub?.customer?.id;
     if(subCustomer&&subCustomer!==job.customerId)continue;
     if(!sub?.id||typeof sub.id!=="string"||sub.id.includes("@"))continue;
     rememberSubscription(job,sub.id,sub.status);
     if(sub.status==="canceled"||sub.status==="incomplete_expired")continue;
     ids.add(sub.id);
    }
    startingAfter=page?.has_more&&rows.length?rows[rows.length-1].id:undefined;
   }while(startingAfter);
  }
  job.subscriptionIds=[...ids];
  job.steps={...job.steps,stripeListed:true};
 }
 async function cancelOne(id){
  try{
   // Immediate cancellation. prorate and invoice_now stay false so unused
   // time is not refunded; the billing portal's at-period-end setting does
   // not apply once the account itself is being deleted.
   await stripe.subscriptions.cancel(id,{invoice_now:false,prorate:false});
  }catch(error){
   if(isMissing(error))return;
   const wrapped=refusal(503,"stripe_cancel_failed");
   wrapped.cause=error;
   throw wrapped;
  }
 }
 async function listObjectNames(prefix){
  if(typeof bucket?.getFiles!=="function")return null;
  try{
   const listed=await bucket.getFiles({prefix});
   const files=listed?.[0]||[];
   return files.map(file=>typeof file==="string"?file:file?.name).filter(name=>typeof name==="string");
  }catch{return null;}
 }
 async function deletePrefix(job,prefix){
  const before=await listObjectNames(prefix);
  if(before)ingestObjects(job,before,prefix);
  try{
   await ignoreMissing(async()=>{
    if(typeof bucket?.deleteFiles==="function"){
     await bucket.deleteFiles({prefix,force:true});
     return;
    }
    if(typeof bucket?.getFiles!=="function")return;
    const listed=await bucket.getFiles({prefix});
    const files=listed?.[0]||[];
    for(const file of files){
     if(typeof file?.delete==="function")await ignoreMissing(()=>file.delete({ignoreNotFound:true}));
     else if(file?.name&&typeof bucket.file==="function")await ignoreMissing(()=>bucket.file(file.name).delete({ignoreNotFound:true}));
    }
   });
  }catch(error){
   // deletePrefix is only called for this account's customer/ and tenants/ folders.
   if(isGcsPermission(error)){
    try{error.ownPrefix=true;}catch(_){/* frozen */}
    if(error.ownPrefix===true)throw error;
    const wrapped=refusal(403,"gcs_permission_denied");
    wrapped.cause=error;
    wrapped.ownPrefix=true;
    throw wrapped;
   }
   const after=await listObjectNames(prefix);
   if(after)ingestObjects(job,after,prefix);
   throw error;
  }
  markPrefixDeleted(job,prefix);
 }
 async function releaseWorkspaces(owner){
  const groups=[
   db.collection("gd_accounts").doc(owner).collection("workspaces"),
   db.collection("tenants").doc(owner).collection("workspaces"),
  ];
  const docs=[];
  for(const collectionRef of groups){
   const snap=await collectionRef.get();
   for(const doc of snap.docs||[]){
    for(const name of ["files","uploads"]){
     const children=await doc.ref.collection(name).get();
     for(const child of children.docs||[])await ignoreMissing(()=>child.ref.delete());
    }
    docs.push(doc);
   }
  }
  // Account deletion removes every workspace. The single-workspace delete
  // transaction would move the free slot onto another row that this job is
  // about to delete, so this transaction only clears the slot and deletes.
  const account=db.collection("gd_accounts").doc(owner);
  const clearAndDelete=async tx=>{
   const accountSnap=await tx.get(account);
   for(const doc of docs)await tx.get(doc.ref);
   if(accountSnap.exists&&accountSnap.data()?.freeWorkspaceId)
    tx.set(account,{freeWorkspaceId:null},{merge:true});
   for(const doc of docs)tx.delete(doc.ref);
  };
  if(typeof db.runTransaction==="function")await db.runTransaction(clearAndDelete);
  else{
   const accountSnap=await account.get();
   if(accountSnap.exists&&accountSnap.data()?.freeWorkspaceId)
    await account.set({freeWorkspaceId:null},{merge:true});
   for(const doc of docs)await ignoreMissing(()=>doc.ref.delete());
  }
 }
 async function deleteMetadata(job){
  const owner=job.accountHash;
  await deleteAccountKeyEnvelopes(db,owner);
  const anonymizedId=crypto.createHash("sha256").update("gd-receipt-v1:"+owner).digest("hex");
  const receipt=db.collection("billing_receipts").doc(anonymizedId);
  await receipt.set({anonymizedId,stripeCustomerId:job.customerId||null,
   subscriptionIds:job.subscriptionIds||[],retainedFor:"tax_and_payment_records",deletedAtMs:clock()},{merge:true});
  try{
   const payments=await db.collection("project_payments").where("accountHash","==",owner).get();
   const paymentIds=[];
   for(const doc of payments.docs||[]){
    paymentIds.push(doc.id);
    await ignoreMissing(()=>doc.ref.delete());
   }
   if(paymentIds.length)await receipt.set({paymentIds},{merge:true});
  }catch(_){/* no payment ledger for this account */}
  await releaseWorkspaces(owner);
  if(db.rows instanceof Map){
   for(const key of [...db.rows.keys()]){
    if(key.includes(owner)&&key.includes("/workspaces/"))db.rows.delete(key);
   }
  }
  await ignoreMissing(()=>db.collection("gd_accounts").doc(owner).delete());
  await ignoreMissing(()=>db.collection("tenants").doc(owner).delete());
  if(job.uid)await ignoreMissing(()=>db.collection("ad_purchases").doc(job.uid).delete());
  try{
   const keys=await db.collection("gd_api_keys").where("ownerHash","==",owner).get();
   for(const doc of keys.docs||[])await ignoreMissing(()=>doc.ref.delete());
  }catch(_){/* key registry absent */}
  // /provider/v1 bindings, keys, envelopes, grants (objects are inside the customer/ prefix deleted earlier).
  await require("./provider_v1").deleteAccountProviderData(db,owner);
  await db.collection("accepted_terms").doc(job.uid).delete().catch?.(()=>{});
 }
 async function probeFirebase(uid){
  if(typeof uid!=="string"||!uid||typeof auth?.getUser!=="function")return "unknown";
  try{
   const record=await auth.getUser(uid);
   if(!record)return "missing";
   return record.disabled===true?"disabled":"active";
  }catch(error){
   return authCodeMeansGone(error)?"missing":"unknown";
  }
 }
 async function deleteFirebase(job){
  job.firebaseStatus=await probeFirebase(job.uid);
  if(typeof auth?.revokeRefreshTokens==="function")
   await ignoreMissing(()=>auth.revokeRefreshTokens(job.uid));
  await ignoreMissing(()=>auth.deleteUser(job.uid));
  job.firebaseStatus="deleted";
 }
 function nextBatch(job){
  if(!job.steps?.stripe)return "stripe";
  const owner=job.accountHash;
  const customer="customer/"+owner+"/";
  const tenants="tenants/"+owner+"/";
  if(!job.steps?.prefixes?.[customer])return "customer";
  if(!job.steps?.prefixes?.[tenants])return "tenants";
  if(!job.steps?.metadata)return "metadata";
  if(!job.steps?.firebase)return "firebase";
  return "done";
 }
 async function performBatch(job,kind){
  if(kind==="stripe"){
   await ensureSubscriptions(job);
   const pending=(job.subscriptionIds||[]).filter(id=>!(job.canceledIds||[]).includes(id));
   if(!pending.length){job.steps={...job.steps,stripe:true};return;}
   await cancelOne(pending[0]);
   rememberSubscription(job,pending[0],"canceled");
   job.canceledIds=[...(job.canceledIds||[]),pending[0]];
   if(pending.length===1)job.steps={...job.steps,stripe:true};
   return;
  }
  if(kind==="customer"||kind==="tenants"){
   const prefix=(kind==="customer"?"customer/":"tenants/")+job.accountHash+"/";
   await deletePrefix(job,prefix);
   job.steps={...job.steps,prefixes:{...(job.steps?.prefixes||{}),[prefix]:true}};
   const customer="customer/"+job.accountHash+"/";
   const tenants="tenants/"+job.accountHash+"/";
   if(job.steps.prefixes[customer]&&job.steps.prefixes[tenants])job.steps={...job.steps,objects:true};
   return;
  }
  if(kind==="metadata"){await deleteMetadata(job);job.steps={...job.steps,metadata:true};return;}
  if(kind==="firebase"){await deleteFirebase(job);job.steps={...job.steps,firebase:true};}
 }
 async function runJob(job){
  for(;;){
   if(!(await renewLease(job)))return;
   if(job.status==="done")return;
   const kind=nextBatch(job);
   if(kind==="done"){
    job.status="done";
    job.retryable=false;
    job.failure=null;
    job.failureReason=null;
    job.namesCleared=true;
    job.workspaceNames=null;
    job.namesExpireAt=null;
    await commitCheckpoint(job);
    return;
   }
   try{await performBatch(job,kind);}
   catch(error){
    await failJob(job,error);
    return;
   }
   if(!(await commitCheckpoint(job)))return;
  }
 }
 async function failJob(job,error){
  const stored=await readJob(job.jobId);
  const at=clock();
  const own=stored?.lease?.owner===instanceId&&typeof stored?.lease?.expiresAtMs==="number"&&at<=stored.lease.expiresAtMs;
  if(!own)return;
  const classified=classifyDeletionError(error);
  const prior=Math.max(Number.isInteger(job.attempts)?job.attempts:0,Number.isInteger(stored?.attempts)?stored.attempts:0);
  job.attempts=prior+1;
  job.status="failed";
  job.failureReason=classified.failureReason;
  job.failure=classified.failureReason;
  job.retryable=classified.permanent!==true&&job.attempts<MAX_FAILED_ATTEMPTS;
  try{await commitCheckpoint(job);}catch(_){/* status remains failed in memory */}
  console.error("account deletion job failed",job.jobId,job.failureReason);
 }
 function schedule(job){
  if(job.inflight||job.status==="done")return;
  job.inflight=true;
  job.promise=(async()=>{
   try{await runJob(job);}
   catch(error){await failJob(job,error);}
   finally{job.inflight=false;}
  })();
 }
 async function firebaseUserGone(uid){
  // Used only when no deletion record exists. A tombstone is decided first.
  if(!auth)return false;
  if(typeof auth.getUser==="function"){
   try{
    const record=await auth.getUser(uid);
    return record?.disabled===true;
   }catch(error){
    return authCodeMeansGone(error);
   }
  }
  // Test doubles look the user up with verifyIdToken(uid). Production Admin
  // Auth always exposes getUser, so a JWT verifier is not called with a uid.
  if(typeof auth.verifyIdToken==="function"){
   try{await auth.verifyIdToken(uid);return false;}
   catch(error){return authCodeMeansGone(error);}
  }
  return false;
 }
 async function deleteAccount(req){
  const user=req?.user||req;
  const uid=user?.uid;
  if(typeof uid!=="string"||!uid)throw refusal(401,"invalid_token");
  const owner=hash(uid);
  if(typeof owner!=="string"||!/^[a-f0-9]{64}$/.test(owner))throw refusal(400,"invalid_account");
  // The token's signature and claims already verified. A tombstone wins over
  // a missing Firebase user: repeat DELETE after done is 410, not 401.
  const existing=await load(owner);
  if(existing?.status==="done"){
   const {statusToken}=await issueStatusToken(existing,{claim:false});
   throw refusal(410,"account_deleted",{jobId:existing.jobId,statusToken});
  }
  if(!existing&&await firebaseUserGone(uid))throw refusal(401,"invalid_token");
  const authTime=user.auth_time;
  const age=Math.floor(clock()/1000)-(typeof authTime==="number"?authTime:Number.NaN);
  if(!Number.isFinite(authTime)||age>REAUTH_SECONDS)throw refusal(401,"reauth_required");
  if(req?.body!==undefined&&req?.body!==null){
   if(typeof req.body!=="object"||Array.isArray(req.body)||req.body.confirm!=="DELETE")
    throw refusal(400,"confirm_required");
  }
  if(existing?.status==="failed"&&existing.retryable!==true){
   throw refusal(409,"deletion_not_retryable",{jobId:existing.jobId});
  }
  if(existing?.status==="failed"){
   existing.uid=existing.uid||uid;
   const latest=await readJob(existing.jobId);
   if(latest&&!latest.workspaceNames){existing.namesCleared=true;existing.workspaceNames=null;}
   if(!Array.isArray(existing.workspaceIds))await captureDeletionContext(existing);
   existing.status="queued";
   existing.failure=null;
   existing.failureReason=null;
   const {statusToken,claimed}=await issueStatusToken(existing,{claim:true});
   if(claimed)schedule(existing);
   return {status:202,jobId:existing.jobId,statusToken,httpStatus:"queued"};
  }
  if(existing&&(existing.status==="queued"||existing.status==="running")){
   existing.uid=existing.uid||uid;
   if(!Array.isArray(existing.workspaceIds))await captureDeletionContext(existing);
   const {statusToken,claimed}=await issueStatusToken(existing,{claim:true});
   if(claimed)schedule(existing);
   return {status:202,jobId:existing.jobId,statusToken};
  }
  const job={jobId:crypto.randomUUID(),accountHash:owner,uid,status:"queued",steps:{},
   canceledIds:[],subscriptionIds:[],customerId:null,retryable:true,failure:null,failureReason:null,
   attempts:0,inflight:false,statusTokens:[],workspaceIds:null,workspaceNames:null,prefixProgress:null,
   subscriptionStatuses:[],firebaseStatus:null,startedAtMs:null,namesExpireAt:null};
  await captureDeletionContext(job);
  jobs.set(job.jobId,job);
  const {statusToken,claimed}=await issueStatusToken(job,{claim:true});
  if(claimed)schedule(job);
  return {status:202,jobId:job.jobId,statusToken};
 }
 async function jobStatus(jobId){
  if(typeof jobId!=="string"||!jobId)return null;
  const stored=await readJob(jobId);
  const live=jobs.get(jobId);
  // Firestore is the status clients observe. Memory can move ahead of the
  // checkpoint write; reporting it early would claim done before the commit.
  const source=stored&&JOB_STATUS.has(stored.status)?stored:live;
  if(!source||!JOB_STATUS.has(source.status))return null;
  const statusTokens=mergeStatusTokens(stored?.statusTokens,live?.statusTokens,clock());
  return {status:source.status,accountHash:source.accountHash||live?.accountHash,retryable:source.retryable===true,failure:source.failure||null,statusTokens};
 }
 // A poll restarts a queued or running job whose lease is missing or expired.
 // Failed jobs wait for DELETE. The holder that still has the job in flight is
 // left alone so a poll on that process does not start a second runner.
 async function resumeIfStalled(jobId){
  const stored=await readJob(jobId);
  if(!stored||stored.status==="done"||stored.status==="failed"||!JOB_STATUS.has(stored.status))return false;
  if(heldByOther(stored.lease,clock()))return false;
  const live=jobs.get(jobId);
  if(live?.inflight)return false;
  const job=live||hydrate(stored);
  absorb(job,stored);
  jobs.set(job.jobId,job);
  if(!(await renewLease(job)))return false;
  schedule(job);
  return true;
 }
 async function captureDeletionContext(job){
  if(!Number.isInteger(job.startedAtMs))job.startedAtMs=clock();
  if(!job.namesExpireAt)job.namesExpireAt=new Date(job.startedAtMs+NAMES_TTL_MS);
  if(!Array.isArray(job.workspaceIds)){
   const ids=[];
   const names={};
   for(const base of ["gd_accounts/"+job.accountHash+"/workspaces","tenants/"+job.accountHash+"/workspaces"]){
    let snap;
    try{snap=await db.collection(base).get();}catch{continue;}
    for(const doc of snap.docs||[]){
     if(!ids.includes(doc.id))ids.push(doc.id);
     const plain=plaintextWorkspaceName((doc.data()||{}).name);
     if(plain&&!names[doc.id])names[doc.id]=plain;
    }
   }
   job.workspaceIds=ids;
   job.workspaceNames=names;
  }
  if(!job.prefixProgress){
   job.prefixProgress={};
   for(const prefix of ["customer/"+job.accountHash+"/","tenants/"+job.accountHash+"/"]){
    const names=await listObjectNames(prefix);
    if(names)ingestObjects(job,names,prefix);
   }
  }
  if(!job.firebaseStatus)job.firebaseStatus=await probeFirebase(job.uid);
  if(!Array.isArray(job.subscriptionStatuses))job.subscriptionStatuses=[];
 }
 async function clearWorkspaceNames(jobId){
  const live=jobs.get(jobId);
  if(live){live.namesCleared=true;live.workspaceNames=null;live.namesExpireAt=null;}
  await db.runTransaction(async tx=>{
   const ref=jobRef(jobId);
   const snap=await tx.get(ref);
   if(!snap.exists)return;
   const data={...snap.data()};
   if(!data.workspaceNames&&!data.namesExpireAt)return;
   delete data.workspaceNames;
   delete data.namesExpireAt;
   const hasAccount=typeof data.accountHash==="string"&&data.accountHash!=="";
   const account=hasAccount?accountRef(data.accountHash):null;
   const accountSnap=account?await tx.get(account):null;
   tx.set(ref,data);
   if(accountSnap?.exists&&accountSnap.data()?.jobId===jobId)tx.set(account,data);
  });
 }
 async function claimNotify(jobId){
  let claimed=false;
  await db.runTransaction(async tx=>{
   const ref=db.collection("supportRequests").doc(jobId);
   const snap=await tx.get(ref);
   if(!snap.exists)return;
   const data=snap.data();
   const current=data.notify;
   if(!current||current.state!=="pending")return;
   const due=Date.parse(current.nextAttemptAt);
   const at=clock();
   if(Number.isFinite(due)&&due>at)return;
   tx.set(ref,{...data,notify:{...current,nextAttemptAt:new Date(at+60*1000).toISOString()}});
   claimed=true;
  });
  return claimed;
 }
 async function markNotify(jobId,outcome){
  let terminal=false;
  await db.runTransaction(async tx=>{
   const ref=db.collection("supportRequests").doc(jobId);
   const snap=await tx.get(ref);
   if(!snap.exists)return;
   const data=snap.data();
   const current=data.notify||freshNotify(clock());
   const at=clock();
   const kept=keepStale(current);
   const attempts=Number.isInteger(current.attempts)?current.attempts:0;
   if(outcome==="sent"){
    data.notify={state:"sent",attempts,nextAttemptAt:null,...kept};
    data.expireAt=new Date(at+SUPPORT_DOC_TTL_MS);
   }else{
    const nextAttempts=attempts+1;
    if(nextAttempts>=NOTIFY_MAX_ATTEMPTS){
     data.notify={state:"failed",attempts:nextAttempts,nextAttemptAt:new Date(at+NOTIFY_BACKOFF_MS[NOTIFY_BACKOFF_MS.length-1]).toISOString(),...kept};
     data.expireAt=new Date(at+SUPPORT_DOC_TTL_MS);
     terminal=true;
    }else data.notify={state:"pending",attempts:nextAttempts,nextAttemptAt:new Date(at+NOTIFY_BACKOFF_MS[nextAttempts-1]).toISOString(),...kept};
   }
   tx.set(ref,data);
  });
  if(terminal)console.error("support_notify_failed "+jobId);
 }
 async function failNotifyMissing(jobId){
  let log=false;
  await db.runTransaction(async tx=>{
   const ref=db.collection("supportRequests").doc(jobId);
   const snap=await tx.get(ref);
   if(!snap.exists)return;
   const data=snap.data();
   const current=data.notify||{};
   if(current.jobMissing)return;
   const at=clock();
   data.notify={...keepStale(current),state:"failed",attempts:Number.isInteger(current.attempts)?current.attempts:0,jobMissing:true};
   data.expireAt=new Date(at+SUPPORT_DOC_TTL_MS);
   tx.set(ref,data);
   log=true;
  });
  if(log)console.error("support_notify_failed "+jobId);
 }
 async function deliver(jobId,reason){
  if(!webhookReady()){
   if(reason==="request")console.warn("support_notify_unconfigured");
   return;
  }
  if(!(await claimNotify(jobId)))return;
  const stored=await readJob(jobId);
  if(!stored){
   await failNotifyMissing(jobId);
   return;
  }
  const filename="deletion-"+String(stored.jobId||jobId).replace(/[^A-Za-z0-9_-]/g,"")+".json";
  try{
   await notify({content:discordContent(stored),filename,file:discordFile(stored),jobId:stored.jobId||jobId});
  }catch(error){
   if(error?.code==="support_notify_unconfigured")return;
   await markNotify(jobId,"failed");
   console.warn("support deletion notify failed");
   return;
  }
  await markNotify(jobId,"sent");
  await clearWorkspaceNames(jobId);
 }
 function sweepQueryFailed(query,error){
  const code=error&&(typeof error.code==="string"||typeof error.code==="number")?String(error.code):"unknown";
  console.error("support_sweep_query_failed "+query+" "+code.replace(/[^A-Za-z0-9_.-]/g,"").slice(0,40));
 }
 async function dueSupportRequests(at){
  try{
   return await db.collection("supportRequests").where("notify.state","in",["pending","failed"])
    .where("notify.nextAttemptAt","<=",new Date(at).toISOString()).orderBy("notify.nextAttemptAt").limit(SWEEP_LIMIT).get();
  }catch(error){sweepQueryFailed("due",error);return {docs:[]};}
 }
 async function deferTerminal(jobId,at){
  await db.runTransaction(async tx=>{
   const ref=db.collection("supportRequests").doc(jobId);
   const snap=await tx.get(ref);
   if(!snap.exists)return;
   const data=snap.data();
   const notify=data.notify;
   if(!notify||notify.state!=="failed"||notify.jobMissing)return;
   const due=Date.parse(notify.nextAttemptAt);
   if(!Number.isFinite(due)||due>at)return;
   data.notify={...notify,nextAttemptAt:new Date(at+SUPPORT_WINDOW_MS).toISOString()};
   tx.set(ref,data);
  });
 }
 async function noteStale(at){
  let snap;
  try{
   snap=await db.collection("supportRequests").where("notify.state","in",["pending","failed"])
    .where("notify.staleDueAt","<=",new Date(at).toISOString()).orderBy("notify.staleDueAt").limit(SWEEP_LIMIT).get();
  }catch(error){sweepQueryFailed("stale",error);return;}
  for(const doc of snap.docs||[]){
   const jobId=doc.data()?.jobId;
   if(typeof jobId!=="string")continue;
   let alert=false;
   await db.runTransaction(async tx=>{
    const ref=db.collection("supportRequests").doc(jobId);
    const fresh=await tx.get(ref);
    if(!fresh.exists)return;
    const data=fresh.data();
    const notify=data.notify;
    const state=notify?.state;
    if(state!=="pending"&&state!=="failed")return;
    const created=Date.parse(data.createdAt);
    if(!Number.isFinite(created)||at-created<=SUPPORT_STALE_MS)return;
    if(typeof notify.staleAlertedAt==="string"&&notify.staleAlertedAt){
     if(notify.staleDueAt){
      const quiet={...notify};
      delete quiet.staleDueAt;
      data.notify=quiet;
      tx.set(ref,data);
     }
     return;
    }
    const due=Date.parse(notify.staleDueAt);
    if(!Number.isFinite(due)||due>at)return;
    const once={...notify,staleAlertedAt:new Date(at).toISOString()};
    delete once.staleDueAt;
    data.notify=once;
    tx.set(ref,data);
    alert=true;
   });
   if(alert)console.error("support_notify_stale "+jobId);
  }
 }
 async function expireWorkspaceNames(at){
  let snap;
  try{
   snap=await db.collection("deletion_jobs").where("namesExpireAt","<=",new Date(at)).orderBy("namesExpireAt").limit(SWEEP_LIMIT).get();
  }catch(error){sweepQueryFailed("names",error);return;}
  for(const doc of snap.docs||[]){
   const data=doc.data()||{};
   if(typeof data.jobId!=="string"||!data.workspaceNames)continue;
   try{await clearWorkspaceNames(data.jobId);}
   catch(_){console.error("support_names_clear_failed "+data.jobId);}
  }
 }
 async function expireSupportDocuments(at){
  let snap;
  try{
   snap=await db.collection("supportRequests").where("expireAt","<=",new Date(at)).orderBy("expireAt").limit(SWEEP_LIMIT).get();
  }catch(error){sweepQueryFailed("expire",error);return;}
  for(const doc of snap.docs||[]){
   const id=doc.id;
   try{
    await db.runTransaction(async tx=>{
     const fresh=await tx.get(doc.ref);
     if(!fresh.exists)return;
     const data=fresh.data()||{};
     const expires=data.expireAt instanceof Date?data.expireAt.getTime():
      typeof data.expireAt?.toMillis==="function"?data.expireAt.toMillis():Date.parse(data.expireAt);
     if(!Number.isFinite(expires)||expires>at||!supportTerminal(data.notify))return;
     tx.delete(doc.ref);
    });
   }catch(_){console.error("support_expire_failed "+id);}
  }
 }
 async function sweepSupportNotifications(){
  const at=clock();
  const snap=await dueSupportRequests(at);
  let delivered=0,failed=0;
  for(const doc of snap.docs||[]){
   const data=doc.data()||{};
   if(typeof data.jobId!=="string")continue;
   const state=data.notify?.state;
   if(state==="failed"){
    await deferTerminal(data.jobId,at);
    continue;
   }
   if(state!=="pending")continue;
   const before=Number.isInteger(data.notify?.attempts)?data.notify.attempts:0;
   await deliver(data.jobId,"sweep");
   const after=await db.collection("supportRequests").doc(data.jobId).get();
   const next=after.exists?after.data()?.notify:null;
   if(next?.state==="sent")delivered+=1;
   else if((next?.attempts||0)>before||next?.jobMissing)failed+=1;
  }
  await noteStale(at);
  await expireWorkspaceNames(at);
  await expireSupportDocuments(at);
  return {delivered,failed};
 }
 async function requestSupport(req){
  const jobId=req?.params?.jobId;
  if(typeof jobId!=="string"||jobId==="")throw refusal(404,"not_found");
  const authorization=req?.headers?.authorization;
  if(typeof authorization!=="string"||authorization.trim()==="")throw refusal(401,"unauthorized");
  const stored=await readJob(jobId);
  if(!stored||!statusTokenMatches({statusTokens:stored.statusTokens},bearerToken(req)))
   throw refusal(404,"not_found");
  if(stored.status!=="failed")throw refusal(409,"support_not_needed");
  const requestId=supportRequestId(jobId);
  const accountHash=stored.accountHash;
  const uid=typeof stored.uid==="string"?stored.uid:null;
  const failureReason=typeof stored.failureReason==="string"?stored.failureReason:null;
  let saved=null;
  await db.runTransaction(async tx=>{
   const ref=db.collection("supportRequests").doc(jobId);
   const snap=await tx.get(ref);
   const at=clock();
   const existing=snap.exists?snap.data():null;
   const start=existing?Date.parse(existing.createdAt):Number.NaN;
   const inWindow=Number.isFinite(start)&&at-start<SUPPORT_WINDOW_MS;
   const count=inWindow&&Number.isInteger(existing?.count)?existing.count:0;
   if(inWindow&&count>=SUPPORT_MAX_CALLS){
    saved={limited:true,retryAfterSec:Math.max(1,Math.ceil((start+SUPPORT_WINDOW_MS-at)/1000))};
    return;
   }
   const keepNotify=inWindow&&existing?.notify;
   const doc={accountHash,uid,jobId,failureReason,createdAt:inWindow?existing.createdAt:new Date(at).toISOString(),
    count:count+1,notify:keepNotify?existing.notify:freshNotify(at)};
   if(keepNotify&&existing.expireAt&&supportTerminal(existing.notify))doc.expireAt=existing.expireAt;
   tx.set(ref,doc);
   saved={limited:false,notify:doc.count===1};
  });
  if(saved?.limited)throw refusal(429,"rate_limited",{retryAfterSec:saved.retryAfterSec});
  if(saved?.notify)trackSupport(()=>deliver(jobId,"request"));
  return {status:202,requestId};
 }
 return {deleteAccount,jobStatus,statusTokenMatches,resumeIfStalled,requestSupport,sweepSupportNotifications};
}
function deletionAuth(firebaseAuth){
 return (req,res,next)=>{
  const send=res.json.bind(res);
  res.json=body=>{
   if(res.statusCode===401){
    const code=body?.error==="reauth_required"||body?.error==="invalid_token"?body.error:"invalid_token";
    return send({error:code});
   }
   return send(body);
  };
  return firebaseAuth(req,res,next);
 };
}
function registerAccountDeletion({app,firebaseAuth,...deps}){
 if(!app||typeof firebaseAuth!=="function")throw Error("account deletion requires an app and firebaseAuth");
 const svc=deps.service||createAccountDeletion(deps);
 const authn=deletionAuth(firebaseAuth);
 app.delete("/v2/account",authn,async(req,res)=>{
  try{
   const result=await svc.deleteAccount(req);
   res.setHeader("Cache-Control","private, no-store");
   const body={status:result.httpStatus==="queued"?"queued":"deleting",jobId:result.jobId};
   if(typeof result.statusToken==="string")body.statusToken=result.statusToken;
   res.status(202).json(body);
  }catch(error){
   const status=Number.isInteger(error?.status)?error.status:500;
   const code=error?.code||"account_deletion_failed";
   const body={error:status===401&&code!=="reauth_required"?"invalid_token":code};
   if((status===410||status===409)&&typeof error?.jobId==="string")body.jobId=error.jobId;
   if(status===410&&typeof error?.statusToken==="string")body.statusToken=error.statusToken;
   if(status>=500)console.error("account deletion request failed",code);
   res.setHeader("Cache-Control","private, no-store");
   res.status(status).json(body);
  }
 });
 app.post("/v2/account/deletions/:jobId/support-request",async(req,res)=>{
  try{
   const result=await svc.requestSupport(req);
   res.setHeader("Cache-Control","private, no-store");
   res.status(202).json({status:"received",requestId:result.requestId});
  }catch(error){
   const status=Number.isInteger(error?.status)?error.status:500;
   const code=error?.code||"support_request_failed";
   const body={error:code};
   if(status===429&&Number.isInteger(error?.retryAfterSec)){
    body.retryAfterSec=error.retryAfterSec;
    res.setHeader("Retry-After",String(error.retryAfterSec));
   }
   if(status>=500)console.error("support deletion request failed",code);
   res.setHeader("Cache-Control","private, no-store");
   res.status(status).json(body);
  }
 });
 app.post("/internal/support-notifications/sweep",async(req,res)=>{
  const expected=typeof (deps.env||process.env).SUPPORT_SWEEP_TOKEN==="string"?(deps.env||process.env).SUPPORT_SWEEP_TOKEN:"";
  const presented=bearerToken(req);
  const match=expected.length>=16&&presented.length===expected.length&&
   crypto.timingSafeEqual(crypto.createHash("sha256").update(expected).digest(),crypto.createHash("sha256").update(presented).digest());
  if(!match){
   res.setHeader("Cache-Control","private, no-store");
   return res.status(401).json({error:"unauthorized"});
  }
  try{
   const result=await svc.sweepSupportNotifications();
   res.setHeader("Cache-Control","private, no-store");
   res.json({ok:true,delivered:result.delivered,failed:result.failed});
  }catch(_){
   res.status(500).json({error:"internal"});
  }
 });
 registeredSweep=()=>svc.sweepSupportNotifications();
 app.get("/v2/account/deletions/:jobId",async(req,res)=>{
  try{
   const jobId=req.params.jobId;
   const authorization=req.headers?.authorization;
   if(typeof authorization!=="string"||authorization.trim()===""){
    res.setHeader("Cache-Control","private, no-store");
    return res.status(401).json({error:"unauthorized"});
   }
   const job=await svc.jobStatus(jobId);
   const presented=bearerToken(req);
   if(job&&typeof svc.statusTokenMatches==="function"&&svc.statusTokenMatches(job,presented)){
    if(typeof svc.resumeIfStalled==="function")await svc.resumeIfStalled(jobId);
    const fresh=await svc.jobStatus(jobId)||job;
    res.setHeader("Cache-Control","private, no-store");
    return res.json({jobId,status:fresh.status,retryable:fresh.retryable===true});
   }
   continueWithFirebase(firebaseAuth,req,res,()=>{
    Promise.resolve(finishStatus(req,res,job,jobId)).catch(()=>{
     if(!res.headersSent)res.status(503).json({error:"deletion_status_unavailable"});
    });
   });
  }catch(_){if(!res.headersSent)res.status(503).json({error:"deletion_status_unavailable"});}
 });
 return svc;
 async function finishStatus(req,res,job,jobId){
  if(res.headersSent)return;
  if(typeof req.user?.uid!=="string"||!req.user.uid||!job)return res.status(404).json({error:"not_found"});
  if(typeof job.accountHash==="string"){
   const owner=typeof deps.hash==="function"?deps.hash(req.user.uid):null;
   if(job.accountHash!==owner)return res.status(404).json({error:"not_found"});
  }
  if(typeof svc.resumeIfStalled==="function")await svc.resumeIfStalled(jobId);
  const fresh=await svc.jobStatus(jobId)||job;
  res.setHeader("Cache-Control","private, no-store");
  res.json({jobId,status:fresh.status,retryable:fresh.retryable===true});
 }
}
function jwtBearer(req){
 const bearer=(req?.headers?.authorization||"").replace(/^Bearer /,"");
 return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bearer);
}
function continueWithFirebase(firebaseAuth,req,res,onOk){
 let done=false;
 const firebaseToken=jwtBearer(req);
 const probe={
  statusCode:200,
  status(code){this.statusCode=code;return this;},
  setHeader(){return this;},
  getHeader(){return undefined;},
  json(){
   if(done||res.headersSent)return this;
   done=true;
   // 401 invalid_token is only a JWT-shaped bearer that fails verification.
   // A bad, expired, unknown, or other-job status token stays 404.
   if(firebaseToken&&this.statusCode===401)return res.status(401).json({error:"invalid_token"});
   res.status(404).json({error:"not_found"});
   return this;
  },
 };
 try{
  const maybe=firebaseAuth(req,probe,()=>{
   if(done||res.headersSent)return;
   done=true;
   onOk();
  });
  Promise.resolve(maybe).catch(()=>{
   if(!done&&!res.headersSent){
    done=true;
    res.status(404).json({error:"not_found"});
   }
  });
 }catch(_){
  if(!done&&!res.headersSent)res.status(404).json({error:"not_found"});
 }
}
function sweepRegisteredSupportNotifications(){
 return typeof registeredSweep==="function"?registeredSweep():Promise.resolve({delivered:0,failed:0});
}
module.exports={createAccountDeletion,registerAccountDeletion,createDiscordNotifier,supportDiscordStartup,sweepRegisteredSupportNotifications,whenSupportSettled,REAUTH_SECONDS,STATUS_TOKEN_TTL_MS,LEASE_MS,SUPPORT_WINDOW_MS,SUPPORT_SWEEP_INTERVAL_MS,NAMES_TTL_MS,NOTIFY_BACKOFF_MS};
