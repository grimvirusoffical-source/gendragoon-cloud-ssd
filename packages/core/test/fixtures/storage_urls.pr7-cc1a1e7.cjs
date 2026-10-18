// Fixture: verbatim copy of native/Backend/storage_urls.js from
// grimvirusoffical-source/gendragoon-cloud-ssd PR #7 @ cc1a1e7 (only these header lines added).
// Used by test/real-server-probe.test.ts. Do not edit; refresh from the PR when it changes.
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
async function defaultSign({bucket,objectPath,op,expiresAt}){
 const file=bucket.file(objectPath);
 const [url]=await file.getSignedUrl({version:"v4",action:op==="upload"?"write":"read",expires:expiresAt,
  virtualHostedStyle:false,...(op==="upload"?{contentType:"application/octet-stream"}:{})});
 return url;
}
// Lock seam. fix/backend-workspace-policy (not merged) exports summarizeProjects.
// Until that module is on this branch, callers inject isWriteLocked or the
// workspace record's locked/uploadsBlocked flags are honored.
async function writeLocked(deps,ctx){
 if(typeof deps.isWriteLocked==="function")return !!await deps.isWriteLocked(ctx);
 let policy=null;
 try{policy=require("./workspace_policy");}
 catch(error){if(error.code!=="MODULE_NOT_FOUND")throw error;}
 if(policy&&typeof policy.listAccountProjects==="function"&&typeof policy.summarizeProjects==="function"){
  const projects=await policy.listAccountProjects(deps.db,ctx.accountHash);
  if(Array.isArray(projects)){
   const summary=policy.summarizeProjects(projects);
   return !!(summary&&(summary.locked||summary.uploadsBlocked));
  }
 }
 const workspace=ctx.workspace||{};
 return workspace.locked===true||workspace.uploadsBlocked===true;
}
async function loadWorkspace(db,accountHash,id){
 if(id==="free"){
  const snap=await db.collection("tenants").doc(accountHash).collection("workspaces").doc("free").get();
  if(!snap.exists||snap.data()?.accountKey!==accountHash||snap.data()?.kind!=="free")return null;
  return {id,data:snap.data(),prefix:"customer/"+accountHash+"/free/objects/"};
 }
 if(typeof id!=="string"||!UUID.test(id))return {invalid:true};
 const snap=await db.collection("gd_accounts").doc(accountHash).collection("workspaces").doc(id).get();
 if(!snap.exists||snap.data()?.accountHash!==accountHash)return null;
 return {id,data:snap.data(),prefix:"customer/"+accountHash+"/managed/"+id+"/objects/"};
}
async function issueStorageUrls(deps,req){
 const env=deps.env||process.env;
 rejectPlaintext(req.body);
 const body=req.body;
 if(!body||typeof body!=="object"||Array.isArray(body))throw refusal(400,"invalid_request");
 if(body.op!=="upload"&&body.op!=="download")throw refusal(400,"invalid_op");
 if(!Array.isArray(body.objects)||body.objects.length<1||body.objects.length>MAX_OBJECTS)throw refusal(400,"invalid_objects");
 const accountHash=deps.hash(req.user.uid);
 if(typeof accountHash!=="string"||!/^[a-f0-9]{64}$/.test(accountHash))throw refusal(400,"invalid_account");
 const workspace=await loadWorkspace(deps.db,accountHash,req.params.id);
 if(workspace?.invalid)throw refusal(400,"invalid_workspace");
 if(!workspace)throw refusal(404,"not_found");
 if(workspace.data.kind==="byo")throw refusal(409,"byo_external");
 const locked=await writeLocked(deps,{db:deps.db,accountHash,workspace:workspace.data,workspaceId:workspace.id});
 if(body.op==="upload"&&locked)throw refusal(423,"workspace_lock");
 const name=bucketName(deps.bucket,env);
 const expiresMs=(typeof deps.now==="function"?deps.now():Date.now())+URL_TTL_MS;
 if(expiresMs-(typeof deps.now==="function"?deps.now():Date.now())>URL_TTL_MS)throw refusal(500,"signing_failed");
 const sign=deps.sign||defaultSign;
 const urls=[];
 for(const objectId of body.objects){
  const objectPath=scopedPath(workspace.prefix,objectId);
  const url=await sign({bucket:deps.bucket,bucketName:name,objectPath,op:body.op,expiresAt:expiresMs});
  if(typeof url!=="string"||!url.startsWith("https://")||url.includes("..")||!url.includes(objectPath))
   throw refusal(500,"signing_failed");
  urls.push({object:objectId,url,method:body.op==="upload"?"PUT":"GET",expiresAt:new Date(expiresMs).toISOString()});
 }
 return {bucket:name,prefix:workspace.prefix,mode:body.op==="upload"?"write":"read",op:body.op,
  expiresAt:new Date(expiresMs).toISOString(),urls};
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
   res.status(status).json({error:error?.code||"storage_url_failed"});
  }
 });
}
module.exports={registerStorageUrls,issueStorageUrls,managedBucketPosture,writeLocked,URL_TTL_MS,scopedPath};
