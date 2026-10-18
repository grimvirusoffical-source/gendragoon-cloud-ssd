"use strict";
// Signed-out support request for a failed deletion. No network, secrets, or live Stripe.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const express=require("express");
const {memoryFirestore}=require("./test_firestore");
const {registerAccountDeletion,createWebhookNotifier,SUPPORT_WINDOW_MS}=require("./account_delete");
const NOW=1_800_000_000_000;
const hash=uid=>crypto.createHash("sha256").update("gd-v1:"+uid).digest("hex");
const DOC_KEYS=["accountHash","count","createdAt","failureReason","jobId","uid"];

function world({uid="u-support",cancel,bucket,notifier,warn}={}){
 let now=NOW;
 const calls=[];
 const db=memoryFirestore([["gd_accounts/"+hash(uid),{uid,stripeCustomerId:"cus_support"}]]);
 const stripe={subscriptions:{
  list:async()=>({has_more:false,data:[{id:"sub_support",status:"active",customer:"cus_support"}]}),
  cancel:cancel||(async()=>({})),
 }};
 let authed=0;
 const app=express();
 app.use(express.json({limit:"16kb"}));
 registerAccountDeletion({app,db,stripe,bucket:bucket||{deleteFiles:async()=>{}},
  auth:{deleteUser:async()=>{},revokeRefreshTokens:async()=>{}},hash,now:()=>now,
  notifier:notifier||(async event=>{calls.push(event);}),
  firebaseAuth:(req,_res,next)=>{authed+=1;req.user={uid,auth_time:Math.floor(now/1000)-30};next();}});
 return {db,app,calls,warn,get authed(){return authed;},setNow(v){now=v;},
  async listen(){
   const server=app.listen(0,"127.0.0.1");
   await new Promise(resolve=>server.once("listening",resolve));
   this.server=server;this.base="http://127.0.0.1:"+server.address().port;
  },
  close(){this.server?.close();},
  async call(method,path,{token,body}={}){
   const headers={};
   if(token!==undefined)headers.authorization="Bearer "+token;
   if(body!==undefined)headers["content-type"]="application/json";
   const res=await fetch(this.base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
   const text=await res.text();
   let json=null;try{json=JSON.parse(text);}catch(_){}
   return {status:res.status,json,text,retryAfter:res.headers.get("retry-after")};
  },
 };
}
async function pollUntil(w,jobId,token,want){
 const deadline=Date.now()+5000;
 let last;
 do{
  last=await w.call("GET","/v2/account/deletions/"+jobId,{token});
  if(last.status===200&&last.json?.status===want)return last;
  await new Promise(resolve=>setTimeout(resolve,5));
 }while(Date.now()<deadline);
 assert.fail("wanted "+want+" but got "+last.text);
}
async function start(w){
 await w.listen();
 const created=await w.call("DELETE","/v2/account",{token:"ignored",body:{confirm:"DELETE"}});
 assert.equal(created.status,202,created.text);
 return created.json;
}
function support(w,jobId,token,extra){
 return w.call("POST","/v2/support/deletion-request",{token,body:{jobId,...extra}});
}

test("a failed job accepts a status token and repeats the same requestId",async()=>{
 const w=world({cancel:async()=>{throw Object.assign(Error("auth"),{type:"authentication_error",statusCode:401});}});
 try{
  const created=await start(w);
  const failed=await pollUntil(w,created.jobId,created.statusToken,"failed");
  assert.equal(failed.json.retryable,false);
  const authed=w.authed;
  const first=await support(w,created.jobId,created.statusToken);
  assert.equal(first.status,202,first.text);
  assert.deepEqual(Object.keys(first.json).sort(),["requestId","status"]);
  assert.equal(first.json.status,"received");
  assert.equal(typeof first.json.requestId,"string");
  assert.ok(first.json.requestId.length>0);
  assert.equal(w.authed,authed,"support does not use the Firebase Terms gate");
  const doc=w.db.rows.get("supportRequests/"+created.jobId);
  assert.deepEqual(Object.keys(doc).sort(),DOC_KEYS);
  assert.equal(doc.accountHash,hash("u-support"));
  assert.equal(doc.uid,"u-support");
  assert.equal(doc.jobId,created.jobId);
  assert.equal(doc.failureReason,"stripe_authentication_error");
  assert.equal(doc.count,1);
  assert.equal(JSON.stringify(doc).includes(created.statusToken),false);
  const again=await support(w,created.jobId,created.statusToken);
  assert.equal(again.status,202,again.text);
  assert.equal(again.json.requestId,first.json.requestId);
  assert.equal(w.db.rows.get("supportRequests/"+created.jobId).count,2);
  assert.equal(w.calls.length,1,"the repeat does not notify again");
  assert.deepEqual(w.calls[0],{jobId:created.jobId,accountId:hash("u-support"),failureReason:"stripe_authentication_error",createdAt:doc.createdAt});
 }finally{w.close();}
});

test("a retryable failure also accepts a support request",async()=>{
 const w=world({cancel:async()=>{throw Object.assign(Error("reset"),{code:"ECONNRESET"});}});
 try{
  const created=await start(w);
  const failed=await pollUntil(w,created.jobId,created.statusToken,"failed");
  assert.equal(failed.json.retryable,true);
  const got=await support(w,created.jobId,created.statusToken);
  assert.equal(got.status,202,got.text);
  assert.equal(w.db.rows.get("supportRequests/"+created.jobId).failureReason,"network");
 }finally{w.close();}
});

test("the sixth support call in 24 hours is 429 and the next window notifies once",async()=>{
 const w=world({cancel:async()=>{throw Object.assign(Error("auth"),{type:"authentication_error",statusCode:401});}});
 try{
  const created=await start(w);
  await pollUntil(w,created.jobId,created.statusToken,"failed");
  let requestId;
  for(let n=1;n<=5;n++){
   const got=await support(w,created.jobId,created.statusToken);
   assert.equal(got.status,202,n+" "+got.text);
   requestId=requestId||got.json.requestId;
   assert.equal(got.json.requestId,requestId);
  }
  assert.equal(w.calls.length,1);
  const limited=await support(w,created.jobId,created.statusToken);
  assert.equal(limited.status,429,limited.text);
  assert.deepEqual(limited.json,{error:"rate_limited",retryAfterSec:86400});
  assert.equal(limited.retryAfter,"86400");
  assert.equal(w.db.rows.get("supportRequests/"+created.jobId).count,5);
  assert.equal(w.calls.length,1);
  w.setNow(NOW+SUPPORT_WINDOW_MS);
  const renewed=await support(w,created.jobId,created.statusToken);
  assert.equal(renewed.status,202,renewed.text);
  assert.equal(renewed.json.requestId,requestId);
  assert.equal(w.db.rows.get("supportRequests/"+created.jobId).count,1);
  assert.equal(w.calls.length,2);
 }finally{w.close();}
});

test("a job that is not failed, a bad token, another job, and an unknown field are refused",async()=>{
 const done=world();
 const failed=world({uid:"u-failed",cancel:async()=>{throw Object.assign(Error("auth"),{type:"authentication_error",statusCode:401});}});
 try{
  const finished=await start(done);
  await pollUntil(done,finished.jobId,finished.statusToken,"done");
  const early=await support(done,finished.jobId,finished.statusToken);
  assert.equal(early.status,409,early.text);
  assert.deepEqual(early.json,{error:"support_not_needed"});
  assert.equal(done.db.rows.has("supportRequests/"+finished.jobId),false);
  const created=await start(failed);
  await pollUntil(failed,created.jobId,created.statusToken,"failed");
  const missing=await failed.call("POST","/v2/support/deletion-request",{body:{jobId:created.jobId}});
  assert.equal(missing.status,401);
  assert.deepEqual(missing.json,{error:"unauthorized"});
  const bad=await support(failed,created.jobId,"not-a-token");
  assert.equal(bad.status,404,bad.text);
  assert.deepEqual(bad.json,{error:"not_found"});
  const foreign=await support(failed,created.jobId,finished.statusToken);
  assert.equal(foreign.status,404,foreign.text);
  assert.deepEqual(foreign.json,{error:"not_found"});
  const extra=await support(failed,created.jobId,created.statusToken,{email:"person@example.com"});
  assert.equal(extra.status,400,extra.text);
  assert.deepEqual(extra.json,{error:"unknown_field"});
  const empty=await failed.call("POST","/v2/support/deletion-request",{token:created.statusToken,body:{}});
  assert.equal(empty.status,400);
  assert.deepEqual(empty.json,{error:"invalid_body"});
  assert.equal(failed.db.rows.has("supportRequests/"+created.jobId),false);
  assert.equal(JSON.stringify([...failed.db.rows.values()]).includes("person@example.com"),false);
 }finally{done.close();failed.close();}
});

test("a missing or failing webhook still saves the request and returns 202",async()=>{
 const warnings=[];
 const warn=message=>warnings.push(message);
 const quiet=createWebhookNotifier({env:{},warn});
 const down=createWebhookNotifier({env:{SUPPORT_NOTIFY_WEBHOOK_URL:"https://support.example/hook"},warn,fetchImpl:async()=>{throw Error("down");}});
 const rejected=createWebhookNotifier({env:{SUPPORT_NOTIFY_WEBHOOK_URL:"https://support.example/hook"},warn,fetchImpl:async()=>({ok:false,status:503})});
 for(const [name,notifier] of [["unset",quiet],["throw",down],["status",rejected]]){
  const w=world({uid:"u-"+name,cancel:async()=>{throw Object.assign(Error("auth"),{type:"authentication_error",statusCode:401});},notifier});
  try{
   const created=await start(w);
   await pollUntil(w,created.jobId,created.statusToken,"failed");
   const got=await support(w,created.jobId,created.statusToken);
   assert.equal(got.status,202,name+" "+got.text);
   assert.equal(w.db.rows.get("supportRequests/"+created.jobId).count,1,name);
  }finally{w.close();}
 }
 assert.deepEqual(warnings,["support deletion notify skipped","support deletion notify failed","support deletion notify failed"]);
 const thrown=world({uid:"u-throw",cancel:async()=>{throw Object.assign(Error("auth"),{type:"authentication_error",statusCode:401});},
  notifier:async()=>{throw Error("plugin down");}});
 const logged=[];
 const original=console.warn;
 console.warn=(...args)=>logged.push(args.join(" "));
 try{
  const created=await start(thrown);
  await pollUntil(thrown,created.jobId,created.statusToken,"failed");
  const got=await support(thrown,created.jobId,created.statusToken);
  assert.equal(got.status,202,got.text);
  assert.equal(thrown.db.rows.get("supportRequests/"+created.jobId).count,1);
  assert.equal(logged.some(line=>line.includes("support deletion notify failed")),true);
  assert.equal(logged.join("\n").includes("plugin down"),false);
 }finally{console.warn=original;thrown.close();}
});
