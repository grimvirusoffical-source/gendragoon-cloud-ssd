"use strict";
// Starts the workspace HTTP handlers with Firestore and Stripe test doubles,
// sends real requests, and writes fixtures/<area>/<case>.json.
const crypto=require("node:crypto");
const NOW=1_700_000_000_000;
Date.now=()=>NOW;
let byte=1;
crypto.randomBytes=size=>{
 const buf=Buffer.alloc(size);
 for(let i=0;i<size;i++)buf[i]=(byte+i)&255;
 byte+=1;
 return buf;
};
let uuid=0;
crypto.randomUUID=()=>{
 uuid+=1;
 return "00000000-0000-4000-8000-"+uuid.toString(16).padStart(12,"0");
};

const fs=require("node:fs");
const path=require("node:path");
const express=require("express");
const {memoryFirestore}=require("../test_firestore");
const {registerBillingV2}=require("../billing_v2");
const {registerPaidStorage}=require("../paid_storage");
const {LAPSE_GRACE_MS}=require("../workspace_policy");

const hash=uid=>crypto.createHash("sha256").update("fixture:"+uid).digest("hex");
const owner=hash("owner");
const other=hash("other");
const wid=n=>"11111111-1111-4111-8111-"+String(n).padStart(12,"0");
const outDir=path.resolve(process.argv[2]||path.join(__dirname,"../../../fixtures"));
const env={STRIPE_CHECKOUT_ENABLED:"false",STRIPE_ENVIRONMENT:"test",PUBLIC_URL:"https://billing.example"};
const stripe={customers:{create:async()=>({id:"cus_fixture"})},checkout:{sessions:{}},prices:{retrieve:async()=>{throw Error("stripe double");}}};
const SECRET_HEADERS=new Set(["authorization","cookie","set-cookie","x-api-key","stripe-signature"]);

function sortValue(value){
 if(Array.isArray(value))return value.map(sortValue);
 if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sortValue(value[key])]));
 return value;
}
function clearJson(dir){
 if(!fs.existsSync(dir))return;
 for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const child=path.join(dir,entry.name);
  if(entry.isDirectory())clearJson(child);
  else if(entry.name.endsWith(".json"))fs.unlinkSync(child);
 }
}
function writeCase(area,name,record){
 const dir=path.join(outDir,area);
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,name+".json"),JSON.stringify(sortValue(record),null,2)+"\n");
}
function requestHeaders(method,token,extra){
 const headers={authorization:"Bearer "+token,...extra};
 if(method!=="GET"&&method!=="HEAD")headers["content-type"]="application/json";
 return headers;
}
function redact(headers){
 return Object.fromEntries(Object.entries(headers).map(([key,value])=>{
  const lower=key.toLowerCase();
  return [lower,SECRET_HEADERS.has(lower)?"<redacted>":value];
 }));
}
async function capture(base,method,requestPath,{token="owner",body,headers}={}){
 const sent=requestHeaders(method,token,headers);
 const response=await fetch(base+requestPath,{method,headers:sent,body:body===undefined?undefined:JSON.stringify(body)});
 const text=await response.text();
 let parsed=null;
 if(text){try{parsed=JSON.parse(text);}catch(_){parsed=text;}}
 return {request:{method,path:requestPath,headers:redact(sent),body:body===undefined?null:body},response:{status:response.status,body:parsed}};
}
function paid(name,extra={}){
 return {kind:"paid",accountHash:owner,name,projectBillingVersion:2,projectStatus:"active",projectFeeStatus:"paid",
  provisioned:true,storageActive:false,performanceActive:false,usedBytes:0,reservedBytes:0,createdAt:NOW,...extra};
}
function put(db,id,data,account=owner){db.rows.set("gd_accounts/"+account+"/workspaces/"+id,data);}
async function start(db,{byoFetch=null}={}){
 const app=express();
 app.use(express.json({limit:"16kb"}));
 const auth=(req,res,next)=>{
  const token=(req.headers.authorization||"").replace(/^Bearer /,"");
  if(token==="owner"||token==="other"){req.user={uid:token};return next();}
  res.status(401).json({error:"Sign in required"});
 };
 registerBillingV2({app,db,stripe,admin:{firestore:{FieldValue:{serverTimestamp:()=>NOW}}},
  auth,agreed:(_req,_res,next)=>next(),hash,prices:{},env,byoFetch});
 registerPaidStorage({app,db,bucket:{file:()=>({})},accountKey:hash,
  FieldValue:{increment:n=>({increment:n}),serverTimestamp:()=>NOW},
  apiKeys:{verify:async()=>null},getAuth:()=>({}),firebaseAuth:auth});
 const server=app.listen(0,"127.0.0.1");
 await new Promise(resolve=>server.once("listening",resolve));
 return {base:"http://127.0.0.1:"+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}
function unlistable(db){
 const col=c=>({...c,limit:undefined,doc:id=>doc(c.doc(id))});
 const doc=d=>({...d,collection:name=>col(d.collection(name))});
 return {...db,collection:name=>col(db.collection(name)),doc:p=>doc(db.doc(p))};
}
function assertLock(record,reason){
 if(record.response.status!==423||record.response.body?.error!=="workspace_lock"||record.response.body.reason!==reason||
    typeof record.response.body.overBy!=="number"||!Array.isArray(record.response.body.unpaidWorkspaceIds))
  throw Error("expected 423 workspace_lock "+reason+" but got "+record.response.status+" "+JSON.stringify(record.response.body));
}

async function workspaceCases(){
 const db=memoryFirestore();
 const app=await start(db);
 try{
  const created=await capture(app.base,"POST","/v2/projects",{body:{name:"Fixture Project",intentId:wid(1)}});
  if(created.response.status!==201)throw Error("create failed "+JSON.stringify(created.response));
  writeCase("workspaces","create",created);
  const listed=await capture(app.base,"GET","/v2/workspaces");
  if(listed.response.status!==200||!Array.isArray(listed.response.body?.workspaces))throw Error("list failed "+JSON.stringify(listed.response));
  writeCase("workspaces","list",listed);
  for(let n=2;n<=10;n++)put(db,wid(n),paid("Workspace "+n));
  const capped=await capture(app.base,"POST","/v2/projects",{body:{name:"Eleventh Workspace",intentId:wid(11)}});
  if(capped.response.status!==409||capped.response.body?.error!=="PROJECT_LIMIT_REACHED")throw Error("cap failed "+JSON.stringify(capped.response));
  writeCase("workspaces","cap-reached",capped);
  put(db,wid(40),{...paid("Foreign workspace"),accountHash:other});
  const foreign=await capture(app.base,"GET","/v2/projects/"+wid(40));
  if(foreign.response.status!==404||foreign.response.body?.error!=="PROJECT_NOT_FOUND")throw Error("foreign get failed "+JSON.stringify(foreign.response));
  writeCase("ownership","foreign-workspace",foreign);
 }finally{await app.close();}
}
async function lockCase(name,reason,seed){
 const db=memoryFirestore();
 seed(db);
 const app=await start(name==="scope-unavailable"?unlistable(db):db);
 try{
  const record=await capture(app.base,"POST","/v2/workspaces/"+wid(1)+"/cloud/uploads",{body:{name:"blocked.txt",sizeBytes:4}});
  assertLock(record,reason);
  writeCase("workspace-lock",name,record);
 }finally{await app.close();}
}
async function mergeCases(){
 const db=memoryFirestore();
 const source=wid(1),target=wid(2);
 put(db,source,paid("Alpha"));
 put(db,target,paid("Beta"));
 const digest="ab".repeat(32);
 db.rows.set("gd_accounts/"+owner+"/workspaces/"+source+"/files/a",{name:"notes.txt",sizeBytes:11,sha256:digest,createdAt:NOW});
 db.rows.set("gd_accounts/"+owner+"/workspaces/"+target+"/files/b",{name:"notes.txt",sizeBytes:11,sha256:digest,createdAt:NOW});
 const app=await start(db);
 try{
  const rejected=await capture(app.base,"POST","/v2/workspaces/"+source+"/merge",{body:{targetId:target,confirmName:"Nope"}});
  if(rejected.response.status!==400||rejected.response.body?.error!=="CONFIRM_NAME_REQUIRED")throw Error("confirmName failed "+JSON.stringify(rejected.response));
  writeCase("merge","confirm-name",rejected);
  const preview=await capture(app.base,"POST","/v2/workspaces/"+source+"/merge/preview",{body:{targetId:target,confirmName:"Alpha"}});
  if(preview.response.status!==200||preview.response.body?.files?.[0]?.renamedTo!=="notes.txt (from Alpha)")
   throw Error("preview failed "+JSON.stringify(preview.response));
  writeCase("merge","preview",preview);
  const merged=await capture(app.base,"POST","/v2/workspaces/"+source+"/merge",{body:{targetId:target,confirmName:"Alpha"}});
  if(merged.response.status!==200||merged.response.body?.sourceDeleted!==true)throw Error("merge failed "+JSON.stringify(merged.response));
  writeCase("merge","completed",merged);
  const files=await capture(app.base,"GET","/v2/workspaces/"+target+"/cloud/files");
  if(files.response.status!==200||!files.response.body?.files?.some(file=>file.name==="notes.txt (from Alpha)"))
   throw Error("renamed file missing "+JSON.stringify(files.response));
  writeCase("merge","renamed-file",files);
 }finally{await app.close();}
}
async function byoCases(){
 const fetched=[];
 const byoFetch=async url=>{
  fetched.push(url);
  const nonce=new URL(url).pathname.split("/").pop();
  return {status:200,body:Buffer.from(nonce),headers:{etag:'"'+"cd".repeat(16)+'"'}};
 };
 const db=memoryFirestore();
 const id=wid(1),expired=wid(2),endpoint="https://bucket.s3.us-east-1.amazonaws.com";
 put(db,id,{kind:"byo",accountHash:owner,name:"BYO workspace",provisioned:true,projectBillingVersion:2});
 put(db,expired,{kind:"byo",accountHash:owner,name:"Expired BYO",provisioned:true,projectBillingVersion:2,providerType:"s3",
  endpoint,bucketFingerprint:"ab".repeat(8),byoChallenge:{nonce:"expirednonce",expiresAtMs:NOW-1,used:false}});
 const app=await start(db,{byoFetch});
 try{
  const unsupported=await capture(app.base,"POST","/v2/workspaces/"+id+"/byo/register",{body:{provider:"sftp",endpoint:"sftp.example.com:22",bucketFingerprint:"ab".repeat(16)}});
  if(unsupported.response.status!==422||unsupported.response.body?.error!=="byo_provider_unsupported")throw Error("sftp "+JSON.stringify(unsupported.response));
  writeCase("byo","provider-unsupported",unsupported);
  const registered=await capture(app.base,"POST","/v2/workspaces/"+id+"/byo/register",{body:{provider:"s3",endpoint,bucketFingerprint:"ab".repeat(8)}});
  if(registered.response.status!==200)throw Error("register "+JSON.stringify(registered.response));
  writeCase("byo","register",registered);
  const challenge=await capture(app.base,"POST","/v2/workspaces/"+id+"/byo/challenge");
  const nonce=challenge.response.body?.nonce;
  if(challenge.response.status!==200||typeof nonce!=="string"||typeof challenge.response.body.expiresAtMs!=="number"||typeof challenge.response.body.ttlMs!=="number")
   throw Error("challenge "+JSON.stringify(challenge.response));
  writeCase("byo","challenge",challenge);
  const missing=await capture(app.base,"POST","/v2/workspaces/"+id+"/byo/verify",{body:{}});
  if(missing.response.status!==400||JSON.stringify(missing.response.body)!==JSON.stringify({error:"presigned_url_required"}))
   throw Error("missing url "+JSON.stringify(missing.response));
  writeCase("byo","verify-missing-url",missing);
  const host=await capture(app.base,"POST","/v2/workspaces/"+id+"/byo/verify",{body:{presignedUrl:"https://attacker.example/.gendragoon-challenge/"+nonce}});
  if(host.response.body?.error!=="BYO_ENDPOINT_HOST_MISMATCH")throw Error("host "+JSON.stringify(host.response));
  writeCase("byo","verify-host-mismatch",host);
  const mismatch=await capture(app.base,"POST","/v2/workspaces/"+id+"/byo/verify",{body:{presignedUrl:endpoint+"/.gendragoon-challenge/not-the-nonce"}});
  if(mismatch.response.body?.error!=="BYO_CHALLENGE_MISMATCH")throw Error("mismatch "+JSON.stringify(mismatch.response));
  writeCase("byo","verify-mismatch",mismatch);
  const expiredVerify=await capture(app.base,"POST","/v2/workspaces/"+expired+"/byo/verify",{body:{presignedUrl:endpoint+"/.gendragoon-challenge/expirednonce"}});
  if(expiredVerify.response.body?.error!=="BYO_CHALLENGE_EXPIRED")throw Error("expired "+JSON.stringify(expiredVerify.response));
  writeCase("byo","verify-expired",expiredVerify);
  const ok=await capture(app.base,"POST","/v2/workspaces/"+id+"/byo/verify",{body:{presignedUrl:endpoint+"/.gendragoon-challenge/"+nonce+"?X-Amz-Signature=fixture"}});
  if(ok.response.status!==200||ok.response.body?.verified!==true)throw Error("verify "+JSON.stringify(ok.response));
  writeCase("byo","verify-success",ok);
  const used=await capture(app.base,"POST","/v2/workspaces/"+id+"/byo/verify",{body:{presignedUrl:endpoint+"/.gendragoon-challenge/"+nonce}});
  if(used.response.body?.error!=="BYO_CHALLENGE_USED")throw Error("used "+JSON.stringify(used.response));
  writeCase("byo","verify-used",used);
  if(fetched.some(url=>url.includes("attacker.example")))throw Error("host mismatch was fetched");
 }finally{await app.close();}
}

async function main(){
 fs.mkdirSync(outDir,{recursive:true});
 clearJson(outDir);
 await workspaceCases();
 await lockCase("over-cap","over_cap",db=>{for(let n=1;n<=11;n++)put(db,wid(n),paid("Workspace "+n));});
 await lockCase("lapsed","lapsed",db=>put(db,wid(1),paid("Lapsed",{workspaceFeeModel:"monthly",workspaceFeeStatus:"past_due",workspaceFeePaid:false,paidThroughMs:NOW-LAPSE_GRACE_MS})));
 await lockCase("over-cap-and-lapsed","over_cap_and_lapsed",db=>{
  for(let n=1;n<=10;n++)put(db,wid(n),paid("Workspace "+n));
  put(db,wid(11),paid("Lapsed",{workspaceFeeModel:"monthly",workspaceFeeStatus:"past_due",workspaceFeePaid:false,paidThroughMs:NOW-LAPSE_GRACE_MS}));
 });
 await lockCase("scope-unavailable","scope_unavailable",db=>put(db,wid(1),paid("Unlisted")));
 await lockCase("merge-in-progress","merge_in_progress",db=>put(db,wid(1),paid("Merging",{mergeLock:{token:"fixture-lock",sourceId:wid(1),targetId:wid(2),expiresAtMs:NOW+120000}})));
 await mergeCases();
 await byoCases();
}
main().catch(error=>{console.error(error);process.exit(1);});
