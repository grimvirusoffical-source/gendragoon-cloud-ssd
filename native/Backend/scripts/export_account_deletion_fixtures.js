"use strict";
// Generates fixtures/account-deletion/*.json from the real deletion handlers.
const crypto=require("node:crypto");
let seq=1;
crypto.randomBytes=size=>{
 const buf=Buffer.alloc(size);
 for(let i=0;i<size;i++)buf[i]=(seq+i)&255;
 seq+=1;
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
const {registerAccountDeletion,STATUS_TOKEN_TTL_MS}=require("../account_delete");
const {installV2Errors}=require("../v2_errors");

const NOW=1_700_000_000_000;
const outDir=path.resolve(process.argv[2]||path.join(__dirname,"../../../fixtures"));
const hash=uid=>crypto.createHash("sha256").update("fixture:"+uid).digest("hex");

function sortValue(value){
 if(Array.isArray(value))return value.map(sortValue);
 if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sortValue(value[key])]));
 return value;
}
function writeCase(area,name,record){
 const dir=path.join(outDir,area);
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,name+".json"),JSON.stringify(sortValue(record),null,2)+"\n");
}
function redactValue(value){
 if(Array.isArray(value))return value.map(redactValue);
 if(!value||typeof value!=="object")return value;
 const copy={};
 for(const [key,item] of Object.entries(value)){
  if(key==="statusToken"&&typeof item==="string")copy[key]="<redacted>";
  else if(key==="authorization")copy[key]="<redacted>";
  else copy[key]=redactValue(item);
 }
 return copy;
}
function publish(name,record,secrets){
 const redacted=redactValue(record);
 const text=JSON.stringify(redacted);
 for(const secret of secrets||[]){
  if(secret&&text.includes(secret))throw Error(name+" leaked a token");
 }
 writeCase("account-deletion",name,redacted);
}
async function capture(base,method,requestPath,{token="owner",body}={}){
 const headers={};
 if(token!==null)headers.authorization="Bearer "+token;
 if(body!==undefined)headers["content-type"]="application/json";
 const response=await fetch(base+requestPath,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 const text=await response.text();
 let parsed=null;
 if(text){try{parsed=JSON.parse(text);}catch(_){parsed=text;}}
 return {request:{method,path:requestPath,headers,body:body===undefined?null:body},response:{status:response.status,body:parsed}};
}
function authFor(now){
 return (req,res,next)=>{
  const token=(req.headers.authorization||"").replace(/^Bearer /,"");
  const fresh=Math.floor(now()/1000);
  if(token==="owner"||token==="other"){req.user={uid:token,auth_time:fresh};return next();}
  if(token==="stale"){req.user={uid:"stale",auth_time:fresh-(5*60)-1};return next();}
  res.status(401).json({error:"Sign in required"});
 };
}
function stripeDouble({cancel}={}){
 return {subscriptions:{
  list:async()=>({has_more:false,data:cancel?[{id:"sub_fixture",status:"active",customer:"cus_fixture"}]:[]}),
  cancel:cancel||(async()=>({})),
 }};
}
async function listen({now=()=>NOW,stripe,rows=[],holdRunner=false}={}){
 const db=memoryFirestore(rows);
 let releaseRunner=()=>{};
 if(holdRunner){
  let started=0;
  let open=()=>{};
  const gate=new Promise(resolve=>{open=resolve;});
  const original=db.runTransaction.bind(db);
  db.runTransaction=async fn=>{
   started+=1;
   if(started>1)await gate;
   return original(fn);
  };
  releaseRunner=open;
 }
 const app=express();
 app.use(express.json({limit:"16kb"}));
 const bucket={deleteFiles:async()=>{}};
 const auth={revokeRefreshTokens:async()=>{},deleteUser:async()=>{}};
 registerAccountDeletion({app,db,stripe:stripe||stripeDouble(),bucket,auth,hash,now,firebaseAuth:authFor(now)});
 installV2Errors(app);
 const server=app.listen(0,"127.0.0.1");
 await new Promise(resolve=>server.once("listening",resolve));
 return {base:"http://127.0.0.1:"+server.address().port,releaseRunner,close:()=>new Promise(resolve=>server.close(resolve))};
}
async function pollUntil(base,jobId,token,want){
 const deadline=Date.now()+5000;
 let last;
 while(Date.now()<deadline){
  last=await capture(base,"GET","/v2/account/deletions/"+jobId,{token});
  if(last.response.status===200&&last.response.body?.status===want)return last;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 throw Error("wanted "+want+" but got "+JSON.stringify(last&&last.response));
}
async function main(){
 const errors=await listen();
 try{
  const missing=await capture(errors.base,"DELETE","/v2/account",{token:"not-a-token",body:{confirm:"DELETE"}});
  if(missing.response.status!==401||missing.response.body?.error!=="invalid_token")throw Error("invalid token "+JSON.stringify(missing.response));
  publish("invalid-token",missing);
  const stale=await capture(errors.base,"DELETE","/v2/account",{token:"stale",body:{confirm:"DELETE"}});
  if(stale.response.status!==401||stale.response.body?.error!=="reauth_required")throw Error("reauth "+JSON.stringify(stale.response));
  publish("reauth-required",stale);
  const absent=await capture(errors.base,"DELETE","/v2/account",{body:{}});
  if(absent.response.status!==400||absent.response.body?.error!=="confirm_required")throw Error("missing confirm "+JSON.stringify(absent.response));
  publish("confirm-missing",absent);
  const wrong=await capture(errors.base,"DELETE","/v2/account",{body:{confirm:"NO"}});
  if(wrong.response.status!==400||wrong.response.body?.error!=="confirm_required")throw Error("wrong confirm "+JSON.stringify(wrong.response));
  publish("confirm-wrong",wrong);
  const singular=await capture(errors.base,"GET","/v2/account/deletion/00000000-0000-4000-8000-000000000099",{token:null});
  if(singular.response.status!==404||singular.response.body?.error!=="not_found")throw Error("singular "+JSON.stringify(singular.response));
  publish("singular-path",singular);
  const oversized=await capture(errors.base,"POST","/v2/account",{body:{pad:"x".repeat(20*1024)}});
  if(oversized.response.status!==413||oversized.response.body?.error!=="payload_too_large")throw Error("413 "+JSON.stringify(oversized.response));
  writeCase("errors","payload-too-large",redactValue(oversized));
 }finally{await errors.close();}

 const accepted=await listen();
 try{
  const created=await capture(accepted.base,"DELETE","/v2/account",{body:{confirm:"DELETE"}});
  if(created.response.status!==202||created.response.body?.status!=="deleting"||typeof created.response.body?.jobId!=="string"||typeof created.response.body?.statusToken!=="string")
   throw Error("202 "+JSON.stringify(created.response));
  publish("accepted",created,[created.response.body.statusToken]);
  await pollUntil(accepted.base,created.response.body.jobId,created.response.body.statusToken,"done");
 }finally{await accepted.close();}

 const queued=await listen({holdRunner:true});
 try{
  const created=await capture(queued.base,"DELETE","/v2/account",{body:{confirm:"DELETE"}});
  if(created.response.status!==202)throw Error("queued create "+JSON.stringify(created.response));
  const status=await capture(queued.base,"GET","/v2/account/deletions/"+created.response.body.jobId,{token:created.response.body.statusToken});
  if(status.response.status!==200||status.response.body?.status!=="queued"||status.response.body?.retryable!==true)
   throw Error("queued "+JSON.stringify(status.response));
  publish("status-queued",status,[created.response.body.statusToken]);
  queued.releaseRunner();
  await pollUntil(queued.base,created.response.body.jobId,created.response.body.statusToken,"done");
 }finally{queued.releaseRunner();await queued.close();}

 let releaseCancel=()=>{};
 const runningHold=new Promise(resolve=>{releaseCancel=()=>resolve({});});
 const running=await listen({
  rows:[["gd_accounts/"+hash("owner"),{stripeCustomerId:"cus_fixture"}]],
  stripe:stripeDouble({cancel:()=>runningHold}),
 });
 try{
  const created=await capture(running.base,"DELETE","/v2/account",{body:{confirm:"DELETE"}});
  if(created.response.status!==202)throw Error("running create "+JSON.stringify(created.response));
  const status=await pollUntil(running.base,created.response.body.jobId,created.response.body.statusToken,"running");
  publish("status-running",status,[created.response.body.statusToken]);
  releaseCancel();
  await pollUntil(running.base,created.response.body.jobId,created.response.body.statusToken,"done");
 }finally{releaseCancel();await running.close();}

 const failed=await listen({
  rows:[["gd_accounts/"+hash("owner"),{stripeCustomerId:"cus_fixture"}]],
  stripe:stripeDouble({cancel:async()=>{throw Object.assign(Error("stripe down"),{type:"api_error"});}}),
 });
 try{
  const created=await capture(failed.base,"DELETE","/v2/account",{body:{confirm:"DELETE"}});
  if(created.response.status!==202)throw Error("failed create "+JSON.stringify(created.response));
  const status=await pollUntil(failed.base,created.response.body.jobId,created.response.body.statusToken,"failed");
  if(status.response.body?.retryable!==true)throw Error("failed retryable "+JSON.stringify(status.response));
  publish("status-failed",status,[created.response.body.statusToken]);
  const again=await capture(failed.base,"DELETE","/v2/account",{body:{confirm:"DELETE"}});
  if(again.response.status!==202||again.response.body?.status!=="queued"||again.response.body?.jobId!==created.response.body.jobId)
   throw Error("retry failed "+JSON.stringify(again.response));
  if(!again.response.body.statusToken||again.response.body.statusToken===created.response.body.statusToken)
   throw Error("retry token "+JSON.stringify(again.response.body));
  publish("retry-after-failed",again,[created.response.body.statusToken,again.response.body.statusToken]);
 }finally{await failed.close();}

 let clock=NOW;
 const finished=await listen({now:()=>clock});
 try{
  const created=await capture(finished.base,"DELETE","/v2/account",{body:{confirm:"DELETE"}});
  if(created.response.status!==202)throw Error("done create "+JSON.stringify(created.response));
  const done=await pollUntil(finished.base,created.response.body.jobId,created.response.body.statusToken,"done");
  if(done.response.body?.retryable!==false)throw Error("done "+JSON.stringify(done.response));
  publish("status-done",done,[created.response.body.statusToken]);
  const gone=await capture(finished.base,"DELETE","/v2/account",{body:{confirm:"DELETE"}});
  if(gone.response.status!==410||gone.response.body?.error!=="account_deleted"||gone.response.body?.jobId!==created.response.body.jobId)
   throw Error("410 "+JSON.stringify(gone.response));
  publish("account-deleted",gone,[created.response.body.statusToken,gone.response.body.statusToken]);
  clock=NOW+STATUS_TOKEN_TTL_MS+1;
  const expired=await capture(finished.base,"GET","/v2/account/deletions/"+created.response.body.jobId,{token:created.response.body.statusToken});
  if(expired.response.status!==404||expired.response.body?.error!=="not_found")throw Error("expired "+JSON.stringify(expired.response));
  publish("expired-token",expired,[created.response.body.statusToken,gone.response.body.statusToken]);
 }finally{await finished.close();}

 const crossed=await listen();
 try{
  const first=await capture(crossed.base,"DELETE","/v2/account",{token:"owner",body:{confirm:"DELETE"}});
  const second=await capture(crossed.base,"DELETE","/v2/account",{token:"other",body:{confirm:"DELETE"}});
  if(first.response.status!==202||second.response.status!==202)throw Error("cross create");
  const foreign=await capture(crossed.base,"GET","/v2/account/deletions/"+first.response.body.jobId,{token:second.response.body.statusToken});
  if(foreign.response.status!==404||foreign.response.body?.error!=="not_found")throw Error("other token "+JSON.stringify(foreign.response));
  publish("other-job-token",foreign,[first.response.body.statusToken,second.response.body.statusToken]);
  await pollUntil(crossed.base,first.response.body.jobId,first.response.body.statusToken,"done");
  await pollUntil(crossed.base,second.response.body.jobId,second.response.body.statusToken,"done");
 }finally{await crossed.close();}

 const polled=await listen();
 try{
  const created=await capture(polled.base,"DELETE","/v2/account",{body:{confirm:"DELETE"}});
  if(created.response.status!==202)throw Error("status auth create "+JSON.stringify(created.response));
  const rejected=await capture(polled.base,"GET","/v2/account/deletions/"+created.response.body.jobId,{token:"revoked.firebase.token"});
  if(rejected.response.status!==401||rejected.response.body?.error!=="invalid_token")throw Error("status 401 "+JSON.stringify(rejected.response));
  publish("status-invalid-token",rejected,[created.response.body.statusToken]);
  const missingHeader=await capture(polled.base,"GET","/v2/account/deletions/"+created.response.body.jobId,{token:null});
  if(missingHeader.response.status!==401||missingHeader.response.body?.error!=="unauthorized"||Object.hasOwn(missingHeader.response.body,"code"))throw Error("status no header "+JSON.stringify(missingHeader.response));
  publish("status-unauthorized",missingHeader,[created.response.body.statusToken]);
  await pollUntil(polled.base,created.response.body.jobId,created.response.body.statusToken,"done");
 }finally{await polled.close();}

 const permanent=await listen({
  rows:[["gd_accounts/"+hash("owner"),{stripeCustomerId:"cus_fixture"}]],
  stripe:stripeDouble({cancel:async()=>{throw Object.assign(Error("stripe key rejected"),{type:"authentication_error",statusCode:401});}}),
 });
 try{
  const created=await capture(permanent.base,"DELETE","/v2/account",{body:{confirm:"DELETE"}});
  if(created.response.status!==202)throw Error("permanent create "+JSON.stringify(created.response));
  const status=await pollUntil(permanent.base,created.response.body.jobId,created.response.body.statusToken,"failed");
  const body=status.response.body||{};
  if(status.response.status!==200||body.status!=="failed"||body.retryable!==false||body.jobId!==created.response.body.jobId)
   throw Error("permanent status "+JSON.stringify(status.response));
  if(body.failureReason||body.attempts||body.statusToken)throw Error("status leaked "+JSON.stringify(body));
  publish("status-failed-not-retryable",status,[created.response.body.statusToken]);
  const denied=await capture(permanent.base,"DELETE","/v2/account",{body:{confirm:"DELETE"}});
  if(denied.response.status!==409||denied.response.body?.error!=="deletion_not_retryable"||denied.response.body?.jobId!==created.response.body.jobId||denied.response.body?.statusToken)
   throw Error("not retryable "+JSON.stringify(denied.response));
  publish("retry-not-retryable",denied,[created.response.body.statusToken]);
 }finally{await permanent.close();}
}
main().catch(error=>{console.error(error);process.exit(1);});
