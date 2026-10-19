"use strict";
// Short-lived V4 signed URLs for one workspace prefix in the managed bucket.
// Clients never receive a service-account key or a downscoped access token.
// Objects are named by opaque ids. Filenames and AES-256 keys stay on device.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OBJECT_ID=/^(?:[a-f0-9]{32}|[a-f0-9]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const PLAINTEXT_KEY=/^(name|filename|fileName|originalName|plaintext|plaintextName|key|encryptionKey|dek|kek|password|secret|secretAccessKey|accessKey|accessKeyId|privateKey|content|data)$/i;
const KMS_KEY=/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+$/;
const URL_TTL_MS=15*60*1000;
const MAX_OBJECTS=32;

function refusal(status,code){
 const error=new Error(code);
 error.status=status;
 error.code=code;
 return error;
}
function rejectPlaintext(value,depth=0){
 if(depth>6||!value||typeof value!=="object")return;
 for(const [key,child] of Object.entries(value)){
  if(PLAINTEXT_KEY.test(key))throw refusal(400,"plaintext_rejected");
  if(child&&typeof child==="object")rejectPlaintext(child,depth+1);
 }
}
function scopedPath(prefix,objectId){
 if(objectId==="manifest")return prefix+"manifest";
 if(typeof objectId!=="string"||!OBJECT_ID.test(objectId))throw refusal(400,"invalid_object_id");
 const path=prefix+objectId;
 if(!path.startsWith(prefix)||path.slice(prefix.length)!==objectId||path.includes("..")||path.includes("//"))
  throw refusal(400,"invalid_object_id");
 return path;
}
function bucketName(bucket,env){
 const name=bucket?.name||env.CUSTOMER_BUCKET;
 if(typeof name!=="string"||!name||name==="gen-dragoon-ssd")throw refusal(503,"bucket_not_configured");
 return name;
}
function managedBucketPosture(env=process.env){
 const kmsKey=typeof env.GDSSD_KMS_KEY==="string"&&env.GDSSD_KMS_KEY.trim()?env.GDSSD_KMS_KEY.trim():null;
 if(kmsKey&&!KMS_KEY.test(kmsKey))throw refusal(500,"invalid_kms_key");
 return {encryption:"CMEK",kmsKey,uniformBucketLevelAccess:true,publicAccessPrevention:"enforced",
  transport:"TLS",clientEncryption:"AES-256-GCM",objectNames:"opaque-ids"};
}
const OPS={get:{mode:"read",method:"GET",action:"read"},put:{mode:"write",method:"PUT",action:"write"},
 delete:{mode:"delete",method:"DELETE",action:"delete"}};
async function defaultSign({bucket,objectPath,op,expiresAt,extensionHeaders}){
 const file=bucket.file(objectPath);
 const [url]=await file.getSignedUrl({version:"v4",action:OPS[op].action,expires:expiresAt,virtualHostedStyle:false,
  ...(op==="put"?{contentType:"application/octet-stream"}:{}),
  ...(extensionHeaders?{extensionHeaders}:{})});
 return url;
}
// GCS generations are int64 and can pass 2^53. A decimal string is kept
// exactly. A safe integer is accepted and stringified.
function generationToken(value){
 if(typeof value==="number"&&Number.isSafeInteger(value)&&value>=0)return String(value);
 if(typeof value==="string"&&/^[0-9]+$/.test(value)&&value.length<=20)return value;
 return null;
}
// Real workspace_policy lock. isWriteLocked remains a test seam and, when it
// returns true, still produces PR #5's lock body.
async function writeLocked(deps,ctx){
 const policy=require("./workspace_policy");
 if(typeof deps.isWriteLocked==="function"){
  const injected=await deps.isWriteLocked(ctx);
  if(!injected)return null;
  if(injected&&typeof injected==="object"&&injected.error==="workspace_lock")return injected;
  return {error:"workspace_lock",reason:"over_cap",overBy:0,unpaidWorkspaceIds:[]};
 }
 const projects=await policy.listAccountProjects(deps.db,ctx.accountHash);
 if(!Array.isArray(projects))return policy.LIST_UNAVAILABLE_LOCK;
 const summary=policy.summarizeProjects(projects);
 if(!(summary&&(summary.locked||summary.uploadsBlocked)))return null;
 return policy.lockBody(summary);
}
async function loadWorkspace(db,accountHash,id,op){
 if(id==="free"){
  const snap=await db.collection("tenants").doc(accountHash).collection("workspaces").doc("free").get();
  if(!snap.exists||snap.data()?.accountKey!==accountHash||snap.data()?.kind!=="free")return null;
  return {id,data:snap.data(),prefix:"customer/"+accountHash+"/free/objects/"};
 }
 if(typeof id!=="string"||!UUID.test(id))return {invalid:true};
 const snap=await db.collection("gd_accounts").doc(accountHash).collection("workspaces").doc(id).get();
 if(!snap.exists){
  // Same route for team workspaces. resolveTeamWorkspace enforces membership and role.
  let t;
  try{t=await require("./team_storage").resolveTeamWorkspace(db,accountHash,id,{method:OPS[op]?.method||"GET"});}
  catch(error){throw refusal(error.status||503,error.code||"team_storage_unavailable");}
  if(!t)return null;
  return {id,data:t.view,prefix:t.scope.prefix+"/objects/",team:t};
 }
 if(snap.data()?.accountHash!==accountHash)return null;
 return {id,data:snap.data(),prefix:"customer/"+accountHash+"/managed/"+id+"/objects/"};
}
async function issueStorageUrls(deps,req){
 const env=deps.env||process.env;
 rejectPlaintext(req.body);
 const body=req.body;
 if(!body||typeof body!=="object"||Array.isArray(body))throw refusal(400,"invalid_request");
 const spec=OPS[body.op];
 if(!spec)throw refusal(400,"invalid_op");
 if(!Array.isArray(body.objects)||body.objects.length<1||body.objects.length>MAX_OBJECTS)throw refusal(400,"invalid_objects");
 const wantsManifest=body.objects.includes("manifest");
 let generationMatch=null;
 if(body.op==="put"&&wantsManifest){
  generationMatch=generationToken(body.ifGeneration);
  if(generationMatch===null)throw refusal(400,"manifest_generation_required");
 }
 const accountHash=deps.hash(req.user.uid);
 if(typeof accountHash!=="string"||!/^[a-f0-9]{64}$/.test(accountHash))throw refusal(400,"invalid_account");
 const workspace=await loadWorkspace(deps.db,accountHash,req.params.id,body.op);
 if(workspace?.invalid)throw refusal(400,"invalid_workspace");
 if(!workspace)throw refusal(404,"not_found");
 if(workspace.data.kind==="byo")throw refusal(409,"byo_external");
 const locked=workspace.team?(workspace.team.scope.uploadsBlocked?workspace.team.scope.lock:null):
  await writeLocked(deps,{db:deps.db,accountHash,workspace:workspace.data,workspaceId:workspace.id});
 if((body.op==="put"||body.op==="delete")&&locked){
  const error=refusal(423,"workspace_lock");
  error.body=locked;
  throw error;
 }
 const name=bucketName(deps.bucket,env);
 const expiresMs=(typeof deps.now==="function"?deps.now():Date.now())+URL_TTL_MS;
 if(expiresMs-(typeof deps.now==="function"?deps.now():Date.now())>URL_TTL_MS)throw refusal(500,"signing_failed");
 const sign=deps.sign||defaultSign;
 const urls=[];
 for(const objectId of body.objects){
  const objectPath=scopedPath(workspace.prefix,objectId);
  const extensionHeaders=objectId==="manifest"&&generationMatch!==null?{"x-goog-if-generation-match":generationMatch}:undefined;
  const url=await sign({bucket:deps.bucket,bucketName:name,objectPath,op:body.op,expiresAt:expiresMs,extensionHeaders});
  if(typeof url!=="string"||!url.startsWith("https://")||url.includes("..")||!url.includes(objectPath))
   throw refusal(500,"signing_failed");
  const entry={object:objectId,url,method:spec.method,expiresAt:new Date(expiresMs).toISOString()};
  if(objectId==="manifest"&&body.op==="get")entry.generation=await manifestGeneration(deps.bucket,objectPath);
  urls.push(entry);
 }
 return {bucket:name,prefix:workspace.prefix,mode:spec.mode,op:body.op,
  expiresAt:new Date(expiresMs).toISOString(),urls};
}
async function manifestGeneration(bucket,objectPath){
 const file=typeof bucket?.file==="function"?bucket.file(objectPath):null;
 if(!file||typeof file.getMetadata!=="function")return "0";
 try{
  const result=await file.getMetadata();
  const meta=Array.isArray(result)?result[0]:result;
  if(meta?.generation===undefined||meta?.generation===null||meta.generation==="")return "0";
  return String(meta.generation);
 }catch(error){
  if(error?.code===404||error?.code==="404"||error?.status===404)return "0";
  throw error;
 }
}
function registerStorageUrls(deps){
 const {app,firebaseAuth}=deps;
 if(!app||typeof firebaseAuth!=="function")throw Error("storage URLs require an app and firebaseAuth");
 app.post("/v2/workspaces/:id/storage-urls",firebaseAuth,async(req,res)=>{
  try{
   const body=await issueStorageUrls(deps,req);
   res.setHeader("Cache-Control","private, no-store");
   res.json(body);
  }catch(error){
   const status=Number.isInteger(error?.status)?error.status:500;
   if(status>=500)console.error("storage url request failed",error?.code||"storage_url_failed");
   res.status(status).json(error?.body||{error:error?.code||"storage_url_failed"});
  }
 });
}
module.exports={registerStorageUrls,issueStorageUrls,managedBucketPosture,writeLocked,URL_TTL_MS,scopedPath};
