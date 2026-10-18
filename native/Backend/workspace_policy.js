"use strict";
// Shared workspace policy. Prices are never created here and no live price ids
// or secrets are embedded. Callers look up the recurring fee with
// STRIPE_WORKSPACE_MONTHLY_PRICE_ID or the catalog lookup key below.
const crypto=require("node:crypto");
const {STORAGE,PERFORMANCE}=require("./catalog");

const FREE_WORKSPACES=1;
const WORKSPACE_FEE_USD_MONTHLY=5;
const WORKSPACE_FEE_CENTS=WORKSPACE_FEE_USD_MONTHLY*100;
const BASE_CAP=10;
const RAISED_CAP=20;
const LAPSE_GRACE_MS=3*24*60*60*1000;
const BYO_CHALLENGE_TTL_MS=10*60*1000;
const MONTHLY_LOOKUP_KEY="gdssd_workspace_monthly_v3";
const QUALIFYING_STORAGE_GB=2000;
const QUALIFYING_WORKERS=8;
const S3_ALIASES=new Set(["s3","aws","r2","cloudflare","backblaze","b2","wasabi","minio","gcs","google"]);
const SECRET_KEY=/^(accessKey|accessKeyId|secretAccessKey|secret|password|privateKey|private_key|sessionToken|credentials|awsSecretAccessKey|awsAccessKeyId|secretKey|apiKey|clientSecret|token|serviceAccount|service_account|keyFile|pem)$/i;
const PRIVATE_KEY_BLOCK=/-----BEGIN (?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/;
const SERVICE_ACCOUNT_JSON=/"type"\s*:\s*"service_account"|"private_key"\s*:/;
const GRANDFATHER_CUTOFF_MS=Number(process.env.GRANDFATHER_CUTOFF_MS)||Date.parse("2026-10-17T00:00:00Z");
const LIST_UNAVAILABLE={scopeUnavailable:true};
const LIST_UNAVAILABLE_LOCK={error:"workspace_lock",reason:"scope_unavailable",overBy:0,unpaidWorkspaceIds:[]};

function monthlyPriceId(env={},prices={}){
 const fromEnv=env.STRIPE_WORKSPACE_MONTHLY_PRICE_ID;
 if(typeof fromEnv==="string"&&/^price_[A-Za-z0-9]+$/.test(fromEnv))return fromEnv;
 const fromCatalog=prices[MONTHLY_LOOKUP_KEY];
 if(typeof fromCatalog==="string"&&/^price_[A-Za-z0-9]+$/.test(fromCatalog))return fromCatalog;
 return null;
}
function createdAtMs(w){
 const raw=w?.createdAtMs??w?.createdAt;
 if(typeof raw==="number"&&Number.isFinite(raw))return raw<1e12?Math.round(raw*1000):raw;
 if(raw&&typeof raw.toMillis==="function")return raw.toMillis();
 // An unresolved server timestamp is this write, not a legacy row.
 if(raw&&typeof raw==="object")return Date.now();
 return null;
}
function isGrandfathered(w){
 if(!w||typeof w!=="object")return false;
 // Monthly records opt out explicitly. Existing one-time and free rows do not
 // carry workspaceFeeModel and must not be rewritten to add one.
 if(w.workspaceFeeModel==="monthly")return false;
 // Rows created on or after the cutoff are not grandfathered. A missing
 // createdAt is a legacy row written before the field existed.
 const created=createdAtMs(w);
 if(created!=null&&created>=GRANDFATHER_CUTOFF_MS)return false;
 if(w.kind==="free"||w.feeIsOneTime===true)return true;
 return w.projectBillingVersion===2&&["paid","free","owner"].includes(w.projectFeeStatus);
}
function periodEndMs(w){
 // Grace is anchored to the last paid invoice period, never to a subscription
 // current_period_end (Stripe advances that on a failed renewal).
 const raw=w&&(w.paidThroughMs??w.workspaceFeePeriodEndMs);
 if(typeof raw!=="number"||!Number.isFinite(raw))return null;
 return raw<1e12?Math.round(raw*1000):raw;
}
function monthlyUnpaid(w){
 if(!w||w.workspaceFeeModel!=="monthly"||isGrandfathered(w))return false;
 const status=w.workspaceFeeStatus||"";
 if(w.workspaceFeePaid===true&&["active","paid","trialing"].includes(status))return false;
 if(["active","paid","trialing"].includes(status)&&w.workspaceFeePaid!==false)return false;
 return ["past_due","unpaid","lapsed","payment_failed","incomplete","canceled","cancelled"].includes(status)||w.workspaceFeePaid===false;
}
function evaluateLapse(w,now=Date.now()){
 const grandfathered=isGrandfathered(w);
 if(!w||grandfathered||w.workspaceFeeModel!=="monthly")return {lapsed:false,grandfathered,withinGrace:false,graceEndsAt:null};
 const end=periodEndMs(w);
 if(end==null)return {lapsed:false,grandfathered:false,withinGrace:false,graceEndsAt:null};
 const graceEndsAt=end+LAPSE_GRACE_MS;
 const unpaid=monthlyUnpaid(w);
 return {lapsed:unpaid&&now>=graceEndsAt,grandfathered:false,withinGrace:unpaid&&now<graceEndsAt,graceEndsAt};
}
function projectStatus(w){
 if(!w)return "pending_activation";
 if(w.projectStatus)return w.projectStatus;
 if(w.kind==="free"&&w.provisioned!==false)return "active";
 // byoActive + manualProviderConfigured alone must not activate a BYO workspace.
 if(w.kind==="byo"){
  if(w.byoChallengeVerified===true&&w.provisioned!==false&&!evaluateLapse(w).lapsed)return "active";
  return "pending_activation";
 }
 if(w.storageActive&&w.provisioned)return "active";
 return "pending_activation";
}
function activatedBasicProject(w){
 return !!w&&w.projectBillingVersion===2&&w.projectStatus==="active"&&
  ["free","paid","owner"].includes(w.projectFeeStatus)&&w.provisioned===true;
}
function qualifiesForRaisedCap(w){
 if(projectStatus(w)!=="active"||w.storageActive!==true||w.provisioned!==true||
    !Object.hasOwn(STORAGE,w.storageTier||"")||STORAGE[w.storageTier].gb<QUALIFYING_STORAGE_GB)return false;
 if(w.projectBillingVersion===2&&!activatedBasicProject(w))return false;
 const extra=w.performanceActive===true&&Object.hasOwn(PERFORMANCE,w.performanceTier||"")?PERFORMANCE[w.performanceTier].workers:0;
 const bundled=w.storageMode==="bundle"?Math.min(24,Math.max(2,Math.floor(STORAGE[w.storageTier].gb/250))):0;
 return Math.max(extra,bundled)>=QUALIFYING_WORKERS;
}
function isByoWorkspace(w){
 if(!w||typeof w!=="object")return false;
 if(w.kind==="byo"||w.byoRegistered===true)return true;
 return typeof w.providerType==="string"&&w.providerType.length>0;
}
function subscriptionActive(w){
 const status=w?.workspaceFeeStatus||"";
 if(w?.workspaceFeePaid===true&&["active","paid","trialing"].includes(status))return true;
 return ["active","paid","trialing"].includes(status)&&w?.workspaceFeePaid!==false;
}
function byoLapsed(w){return isByoWorkspace(w)&&!isGrandfathered(w)&&!subscriptionActive(w);}
function feeLapsed(w){return !!w&&(evaluateLapse(w).lapsed||byoLapsed(w));}
function slotHolder(w){return !!w&&!isByoWorkspace(w)&&!isGrandfathered(w);}
function hostedEligible(w){
 if(!slotHolder(w))return false;
 const status=projectStatus(w);
 return status!=="archived"&&status!=="merged";
}
function byCreated(a,b){
 const ca=createdAtMs(a),cb=createdAtMs(b);
 const da=ca==null?Number.MAX_SAFE_INTEGER:ca,db=cb==null?Number.MAX_SAFE_INTEGER:cb;
 if(da!==db)return da-db;
 const ia=String(a.id),ib=String(b.id);
 if(ia<ib)return -1;
 if(ia>ib)return 1;
 return 0;
}
function chooseFreeWorkspaceId(projects,{avoidId=null}={}){
 const eligible=(Array.isArray(projects)?projects:[]).filter(hostedEligible).sort(byCreated);
 const pick=eligible.find(workspace=>workspace.id!==avoidId);
 return pick?pick.id:null;
}
// Oldest non-grandfathered hosted workspace, by createdAtMs then id. A stored id
// keeps the slot through archive. Grandfathered and BYO workspaces never hold it.
function freeWorkspaceId(account,projects){
 const stored=typeof account?.freeWorkspaceId==="string"&&account.freeWorkspaceId?account.freeWorkspaceId:null;
 if(!Array.isArray(projects))return stored;
 if(stored){
  const holder=projects.find(workspace=>workspace&&workspace.id===stored);
  if(slotHolder(holder))return stored;
 }
 return chooseFreeWorkspaceId(projects);
}
function workspacePrice(workspace,freeId){
 const grandfathered=isGrandfathered(workspace);
 const isFree=!!workspace&&workspace.id===freeId&&!isByoWorkspace(workspace)&&!grandfathered;
 const monthlyPriceCents=isFree||grandfathered?0:WORKSPACE_FEE_CENTS;
 return {isFree,monthlyPriceCents};
}
function countsTowardCap(w){return !["archived","merged"].includes(projectStatus(w));}
function summarizeProjects(projects){
 const list=Array.isArray(projects)?projects:[];
 const current=list.filter(countsTowardCap);
 const qualified=current.some(qualifiesForRaisedCap);
 const projectLimit=qualified?RAISED_CAP:BASE_CAP;
 const overBy=Math.max(0,current.length-projectLimit);
 const unpaidWorkspaceIds=list.filter(w=>w&&w.id&&feeLapsed(w)).map(w=>w.id);
 const locked=overBy>0||unpaidWorkspaceIds.length>0;
 const reason=overBy>0&&unpaidWorkspaceIds.length?"over_cap_and_lapsed":unpaidWorkspaceIds.length?"lapsed":overBy>0?"over_cap":null;
 return {qualified,projectLimit,used:current.length,overBy,unpaidWorkspaceIds,locked,uploadsBlocked:locked,reason,
  active:current.filter(w=>projectStatus(w)==="active").length,
  pending:current.filter(w=>projectStatus(w)!=="active").length,
  archived:list.filter(w=>projectStatus(w)==="archived").length,
  grandfatheredProjects:list.filter(isGrandfathered).length};
}
function lockBody(summary){
 return {error:"workspace_lock",reason:summary.reason,overBy:summary.overBy||0,unpaidWorkspaceIds:summary.unpaidWorkspaceIds||[]};
}
function findSecretFields(body,prefix=""){
 if(typeof body==="string"){
  if(PRIVATE_KEY_BLOCK.test(body)||SERVICE_ACCOUNT_JSON.test(body))return [prefix||"value"];
  return [];
 }
 if(!body||typeof body!=="object")return [];
 const found=[];
 for(const [key,value] of Object.entries(body)){
  if(SECRET_KEY.test(key)&&value!=null&&value!=="")found.push(prefix+key);
  else if(typeof value==="string"&&(PRIVATE_KEY_BLOCK.test(value)||SERVICE_ACCOUNT_JSON.test(value)))found.push(prefix+key);
  else if(value&&typeof value==="object")found.push(...findSecretFields(value,prefix+key+"."));
 }
 return found;
}
function rejectProviderSecrets(body){
 const secrets=findSecretFields(body);
 if(!secrets.length)return;
 const error=new Error("Provider credentials must stay on the device");
 error.status=400;error.code="BYO_SECRET_REJECTED";
 throw error;
}
function normalizeProvider(raw){
 const value=String(raw||"").trim().toLowerCase();
 if(S3_ALIASES.has(value))return "s3";
 if(value==="sftp")return "sftp";
 return null;
}
function unsupportedProvider(provider){
 const error=new Error("byo_provider_unsupported");
 error.status=422;error.code="byo_provider_unsupported";error.provider=provider;
 throw error;
}
function publicByoRegistration(body){
 rejectProviderSecrets(body);
 if(!body||Array.isArray(body)||typeof body!=="object"){
  const error=new Error("Provider registration is incomplete");error.status=400;error.code="BYO_REGISTRATION_INVALID";throw error;
 }
 const rawProvider=String(body.provider||body.providerType||"").trim().toLowerCase();
 // SFTP, Azure, and WebDAV are not launch providers. S3-compatible only.
 if(rawProvider==="sftp"||rawProvider==="azure"||rawProvider==="webdav")unsupportedProvider(rawProvider);
 const providerType=normalizeProvider(rawProvider);
 const endpoint=typeof body.endpoint==="string"?body.endpoint.trim():"";
 const fingerprint=typeof body.bucketFingerprint==="string"?body.bucketFingerprint.trim():
  typeof body.hostFingerprint==="string"?body.hostFingerprint.trim():"";
 if(!providerType||endpoint.length<3||endpoint.length>300||/[\s\x00-\x1f]/.test(endpoint)||
    !/^[a-f0-9]{8,128}$/i.test(fingerprint)){
  const error=new Error("Endpoint and a bucket or host fingerprint are required");
  error.status=400;error.code="BYO_REGISTRATION_INVALID";throw error;
 }
 return {providerType,endpoint,bucketFingerprint:fingerprint.toLowerCase()};
}
function issueChallenge(now=Date.now()){
 return {nonce:crypto.randomBytes(32).toString("hex"),expiresAtMs:now+BYO_CHALLENGE_TTL_MS,used:false};
}
function verifyChallenge(stored,readBack,now=Date.now()){
 if(!stored||stored.used===true)return {ok:false,code:"BYO_CHALLENGE_USED"};
 if(typeof stored.expiresAtMs!=="number"||now>=stored.expiresAtMs)return {ok:false,code:"BYO_CHALLENGE_EXPIRED"};
 const provided=typeof readBack==="string"?readBack.trim():"";
 if(!provided||provided.length>256||provided!==stored.nonce)return {ok:false,code:"BYO_CHALLENGE_MISMATCH"};
 return {ok:true};
}
function collisionName(original,sourceName,taken){
 if(!taken.has(original))return original;
 const base=original+" (from "+sourceName+")";
 if(!taken.has(base))return base;
 let n=2;
 while(taken.has(base+" "+n))n+=1;
 return base+" "+n;
}
function fileDigest(data){
 if(typeof data?.sha256==="string"&&/^[a-f0-9]{64}$/i.test(data.sha256))return data.sha256.toLowerCase();
 if(typeof data?.hash==="string"&&/^[a-f0-9]{64}$/i.test(data.hash))return data.hash.toLowerCase();
 return null;
}
function storedChecksums(meta){
 if(!meta||typeof meta!=="object")return {};
 const out={};
 if(typeof meta.crc32c==="string"&&meta.crc32c)out.crc32c=meta.crc32c;
 const md5=meta.md5Hash||meta.md5;
 if(typeof md5==="string"&&md5)out.md5=md5;
 if(typeof meta.sha256==="string"&&/^[a-f0-9]{64}$/i.test(meta.sha256))out.sha256=meta.sha256.toLowerCase();
 if(typeof meta.etag==="string"&&meta.etag&&!String(meta.etag).includes("-"))out.etag=meta.etag.replace(/"/g,"");
 return out;
}
function checksumsAgree(source,dest){
 const keys=["crc32c","md5","sha256","etag"].filter(key=>source[key]&&dest[key]);
 if(!keys.length)return null;
 return keys.every(key=>source[key]===dest[key]);
}
function invoicePaidThroughMs(invoice){
 if(!invoice||typeof invoice!=="object")return null;
 let end=null;
 for(const line of invoice.lines?.data||[]){
  const raw=line?.period?.end;
  if(typeof raw==="number"&&Number.isFinite(raw))end=end==null?raw:Math.max(end,raw);
 }
 if(end==null&&typeof invoice.period_end==="number"&&Number.isFinite(invoice.period_end))end=invoice.period_end;
 if(end==null)return null;
 return end<1e12?Math.round(end*1000):end;
}
function isPrivateAddress(address){
 const value=String(address||"").toLowerCase().replace(/^\[|\]$/g,"");
 if(value==="::1"||value==="::"||value.startsWith("fe80:")||value.startsWith("fc")||value.startsWith("fd"))return true;
 const mapped=value.startsWith("::ffff:")?value.slice(7):value;
 const parts=mapped.split(".").map(Number);
 if(parts.length!==4||parts.some(part=>!Number.isInteger(part)||part<0||part>255))return value.includes(":")?false:true;
 const [a,b]=parts;
 if(a===0||a===10||a===127)return true;
 if(a===169&&b===254)return true;
 if(a===172&&b>=16&&b<=31)return true;
 if(a===192&&b===168)return true;
 if(a===100&&b>=64&&b<=127)return true;
 return false;
}
function canListWorkspaces(db){
 try{
  const sample=db.collection("gd_accounts").doc("capability-probe").collection("workspaces");
  return typeof sample.limit==="function"&&typeof sample.get==="function";
 }catch(_){return false;}
}
async function listAccountProjects(db,ownerHash){
 if(!canListWorkspaces(db))return LIST_UNAVAILABLE;
 const legacy=db.collection("tenants").doc(ownerHash).collection("workspaces").doc("free");
 const docs=await db.collection("gd_accounts").doc(ownerHash).collection("workspaces").limit(201).get();
 const projects=[];
 for(const doc of docs.docs||[]){
  const data=doc.data();
  if(data&&data.accountHash===ownerHash)projects.push({...data,id:doc.id});
 }
 const free=await legacy.get();
 if(free.exists&&free.data()?.accountKey===ownerHash)projects.push({...free.data(),id:"free"});
 return projects;
}
function writeNeedsLock(method){return method!=="GET"&&method!=="HEAD"&&method!=="DELETE";}

module.exports={FREE_WORKSPACES,WORKSPACE_FEE_USD_MONTHLY,WORKSPACE_FEE_CENTS,BASE_CAP,RAISED_CAP,
 LAPSE_GRACE_MS,BYO_CHALLENGE_TTL_MS,MONTHLY_LOOKUP_KEY,QUALIFYING_STORAGE_GB,QUALIFYING_WORKERS,
 GRANDFATHER_CUTOFF_MS,LIST_UNAVAILABLE,LIST_UNAVAILABLE_LOCK,
 monthlyPriceId,isGrandfathered,evaluateLapse,projectStatus,activatedBasicProject,
 qualifiesForRaisedCap,summarizeProjects,lockBody,findSecretFields,rejectProviderSecrets,
 isByoWorkspace,subscriptionActive,byoLapsed,feeLapsed,chooseFreeWorkspaceId,freeWorkspaceId,workspacePrice,
 publicByoRegistration,issueChallenge,verifyChallenge,collisionName,fileDigest,storedChecksums,checksumsAgree,
 invoicePaidThroughMs,isPrivateAddress,listAccountProjects,writeNeedsLock};
