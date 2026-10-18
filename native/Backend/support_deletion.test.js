"use strict";
// Signed-out support request for a failed deletion. No network, secrets, or live Stripe.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {spawn}=require("node:child_process");
const express=require("express");
const {memoryFirestore}=require("./test_firestore");
const {registerAccountDeletion,createDiscordNotifier,supportDiscordStartup,SUPPORT_WINDOW_MS,NAMES_TTL_MS,NOTIFY_BACKOFF_MS}=require("./account_delete");
const NOW=1_800_000_000_000;
const hash=uid=>crypto.createHash("sha256").update("gd-v1:"+uid).digest("hex");
const DOC_KEYS=["accountHash","count","createdAt","failureReason","jobId","notify","uid"];
const WEBHOOK="https://discord.com/api/webhooks/123456789012345678/WebhookSecretMarker123";
const EMAIL="person@example.com";
const WRAPPED="super-secret-wrapped-key";
const OBJECT_ID="11111111-1111-4111-8111-111111111111";

function parseMultipart(body,contentType){
 const boundary=/boundary=([^;\s]+)/.exec(contentType||"")?.[1];
 assert.ok(boundary,"multipart boundary");
 const parts=String(body).split("--"+boundary).slice(1,-1);
 const out={};
 for(const part of parts){
  const name=/name="([^"]+)"/.exec(part)?.[1];
  const filename=/filename="([^"]+)"/.exec(part)?.[1]||null;
  const value=part.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/,"");
  out[name]={filename,value};
 }
 return out;
}
function world({uid="u-support",cancel,bucket,notifier,env,fetchImpl,rows=[],auth}={}){
 let now=NOW;
 const calls=[];
 const db=memoryFirestore([
  ["gd_accounts/"+hash(uid),{uid,stripeCustomerId:"cus_support"}],
  ...rows,
 ]);
 const stripe={subscriptions:{
  list:async()=>({has_more:false,data:[{id:"sub_support",status:"active",customer:"cus_support"}]}),
  cancel:cancel||(async()=>({})),
 }};
 let authed=0;
 const app=express();
 app.use(express.json({limit:"16kb"}));
 const runtimeEnv=env||{};
 const options={app,db,stripe,bucket:bucket||{deleteFiles:async()=>{}},
  auth:auth||{deleteUser:async()=>{},revokeRefreshTokens:async()=>{}},hash,now:()=>now,env:runtimeEnv,
  firebaseAuth:(req,_res,next)=>{authed+=1;req.user={uid,auth_time:Math.floor(now/1000)-30};next();}};
 if(fetchImpl)options.notifier=createDiscordNotifier({env:runtimeEnv,fetchImpl,warn(){}});
 else if(notifier)options.notifier=notifier;
 else if(notifier!==false)options.notifier=async event=>{calls.push(event);};
 const svc=registerAccountDeletion(options);
 return {db,app,calls,svc,get authed(){return authed;},setNow(v){now=v;},now:()=>now,
  async listen(){
   const server=app.listen(0,"127.0.0.1");
   await new Promise(resolve=>server.once("listening",resolve));
   this.server=server;this.base="http://127.0.0.1:"+server.address().port;
  },
  close(){this.server?.close();},
  async call(method,requestPath,{token,body}={}){
   const headers={};
   if(token!==undefined)headers.authorization="Bearer "+token;
   if(body!==undefined)headers["content-type"]="application/json";
   const res=await fetch(this.base+requestPath,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
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
function support(w,jobId,token,body){
 return w.call("POST","/v2/account/deletions/"+jobId+"/support-request",body===undefined?{token}:{token,body});
}
function authFailure(){
 return async()=>{throw Object.assign(Error("auth"),{type:"authentication_error",statusCode:401});};
}

test("a failed job accepts a status token and repeats the same requestId",async()=>{
 const w=world({cancel:authFailure()});
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
  assert.equal(doc.notify.state,"sent");
  assert.equal(JSON.stringify(doc).includes(created.statusToken),false);
  assert.equal(JSON.stringify(doc).includes("workspaceNames"),false);
  const again=await support(w,created.jobId,created.statusToken);
  assert.equal(again.status,202,again.text);
  assert.equal(again.json.requestId,first.json.requestId);
  assert.equal(w.db.rows.get("supportRequests/"+created.jobId).count,2);
  assert.equal(w.calls.length,1,"the repeat does not notify again");
  const old=await w.call("POST","/v2/support/deletion-request",{token:created.statusToken,body:{jobId:created.jobId}});
  assert.equal(old.status,404);
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
 const w=world({cancel:authFailure()});
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

test("a job that is not failed, a bad token, and another job's token are refused",async()=>{
 const done=world();
 const failed=world({uid:"u-failed",cancel:authFailure()});
 try{
  const finished=await start(done);
  await pollUntil(done,finished.jobId,finished.statusToken,"done");
  const early=await support(done,finished.jobId,finished.statusToken);
  assert.equal(early.status,409,early.text);
  assert.deepEqual(early.json,{error:"support_not_needed"});
  assert.equal(done.db.rows.has("supportRequests/"+finished.jobId),false);
  const created=await start(failed);
  await pollUntil(failed,created.jobId,created.statusToken,"failed");
  const missing=await failed.call("POST","/v2/account/deletions/"+created.jobId+"/support-request");
  assert.equal(missing.status,401);
  assert.deepEqual(missing.json,{error:"unauthorized"});
  const bad=await support(failed,created.jobId,"not-a-token");
  assert.equal(bad.status,404,bad.text);
  assert.deepEqual(bad.json,{error:"not_found"});
  const foreign=await support(failed,created.jobId,finished.statusToken);
  assert.equal(foreign.status,404,foreign.text);
  assert.deepEqual(foreign.json,{error:"not_found"});
  const extra=await support(failed,created.jobId,created.statusToken,{email:EMAIL,uid:"other",jobId:"nope"});
  assert.equal(extra.status,202,extra.text);
  assert.equal(JSON.stringify([...failed.db.rows.values()]).includes(EMAIL),false);
 }finally{done.close();failed.close();}
});

test("discord multipart lists ids and names and omits secrets, file bytes, and emails",async()=>{
 const owner=hash("u-discord");
 const objectId=OBJECT_ID;
 const objects=new Set([
  "customer/"+owner+"/managed/w1/"+objectId,
  "customer/"+owner+"/managed/w1/notes.txt",
 ]);
 const seen=[];
 const bucket={
  objects,
  deleteFiles:async({prefix})=>{for(const key of [...objects])if(key.startsWith(prefix))objects.delete(key);},
  getFiles:async({prefix})=>[[...objects].filter(key=>key.startsWith(prefix)).map(name=>({name}))],
 };
 const w=world({uid:"u-discord",cancel:authFailure(),bucket,env:{SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK},
  fetchImpl:async(url,init)=>{seen.push({url,body:Buffer.from(init.body).toString("utf8"),type:init.headers["content-type"]});return {ok:true,status:204};},
  auth:{getUser:async()=>({disabled:false,email:EMAIL}),deleteUser:async()=>{},revokeRefreshTokens:async()=>{}},
  rows:[
   ["gd_accounts/"+owner+"/workspaces/w1",{name:"Alpha",email:EMAIL,wrappedKey:WRAPPED}],
   ["gd_accounts/"+owner+"/workspaces/secret",{name:{ciphertext:"encrypted-name",iv:"iv"}}],
  ]});
 try{
  const created=await start(w);
  await pollUntil(w,created.jobId,created.statusToken,"failed");
  const got=await support(w,created.jobId,created.statusToken);
  assert.equal(got.status,202,got.text);
  assert.equal(seen.length,1);
  assert.equal(seen[0].url,WEBHOOK);
  const parts=parseMultipart(seen[0].body,seen[0].type);
  const payload=JSON.parse(parts.payload_json.value);
  assert.deepEqual(payload.allowed_mentions,{parse:[]});
  assert.ok(payload.content.includes("u-discord"));
  assert.ok(payload.content.includes(created.jobId));
  assert.ok(payload.content.includes("stripe_authentication_error"));
  assert.ok(payload.content.includes("attempts: 1"));
  assert.ok(payload.content.includes("w1 Alpha"));
  assert.ok(payload.content.includes("secret"));
  assert.equal(payload.content.includes("encrypted-name"),false);
  assert.ok(payload.content.length<=1800);
  assert.equal(parts["files[0]"].filename,"deletion-"+created.jobId+".json");
  const file=JSON.parse(parts["files[0]"].value);
  const alpha=file.workspaces.find(row=>row.id==="w1");
  assert.equal(alpha.name,"Alpha");
  assert.equal(alpha.prefixes[0].remaining>=1,true);
  assert.ok(alpha.prefixes[0].remainingIds.includes(objectId));
  assert.deepEqual(file.subscriptions,[{id:"sub_support",status:"active"}]);
  assert.deepEqual(file.firebase,{status:"active"});
  const secretWorkspace=file.workspaces.find(row=>row.id==="secret");
  assert.equal(Object.hasOwn(secretWorkspace,"name"),false);
  const packed=seen[0].body;
  for(const secret of [WEBHOOK,"WebhookSecretMarker123",EMAIL,WRAPPED,created.statusToken,"notes.txt","encrypted-name"])
   assert.equal(packed.includes(secret),false,secret);
  const supportDoc=w.db.rows.get("supportRequests/"+created.jobId);
  assert.equal(JSON.stringify(supportDoc).includes("Alpha"),false);
  assert.equal(JSON.stringify(supportDoc).includes(EMAIL),false);
  const job=w.db.rows.get("deletion_jobs/"+created.jobId);
  assert.ok(job.workspaceIds.includes("w1"));
  assert.equal(job.workspaceNames,undefined);
 }finally{w.close();}
});

test("content is truncated at 1800 characters",async()=>{
 const owner=hash("u-long");
 const rows=[];
 for(let n=0;n<12;n++)rows.push(["gd_accounts/"+owner+"/workspaces/ws"+n,{name:"N".repeat(150)}]);
 const seen=[];
 const w=world({uid:"u-long",cancel:authFailure(),rows,env:{SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK},
  fetchImpl:async(_url,init)=>{seen.push({body:Buffer.from(init.body).toString("utf8"),type:init.headers["content-type"]});return {ok:true,status:204};}});
 try{
  const created=await start(w);
  await pollUntil(w,created.jobId,created.statusToken,"failed");
  assert.equal((await support(w,created.jobId,created.statusToken)).status,202);
  const payload=JSON.parse(parseMultipart(seen[0].body,seen[0].type).payload_json.value);
  assert.equal(payload.content.length,1800);
 }finally{w.close();}
});

test("a missing webhook and a 4xx, 5xx, or timeout still save the request",async()=>{
 const warnings=[];
 const original=console.warn;
 console.warn=(...args)=>warnings.push(args.join(" "));
 try{
  const quiet=world({uid:"u-quiet",cancel:authFailure(),notifier:false});
  const created=await start(quiet);
  await pollUntil(quiet,created.jobId,created.statusToken,"failed");
  const got=await support(quiet,created.jobId,created.statusToken);
  assert.equal(got.status,202,got.text);
  const doc=quiet.db.rows.get("supportRequests/"+created.jobId);
  assert.equal(doc.count,1);
  assert.equal(doc.notify.state,"pending");
  assert.equal(doc.notify.attempts,0);
  quiet.close();
  for(const [name,fetchImpl] of [
   ["status",async()=>({ok:false,status:503})],
   ["client",async()=>({ok:false,status:400})],
   ["timeout",async()=>{throw Error("timeout "+WEBHOOK+" plugin down");}],
  ]){
   const w=world({uid:"u-"+name,cancel:authFailure(),env:{SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK},fetchImpl});
   try{
    const job=await start(w);
    await pollUntil(w,job.jobId,job.statusToken,"failed");
    const response=await support(w,job.jobId,job.statusToken);
    assert.equal(response.status,202,name+" "+response.text);
    const saved=w.db.rows.get("supportRequests/"+job.jobId);
    assert.equal(saved.notify.state,"pending",name);
    assert.equal(saved.notify.attempts,1,name);
   }finally{w.close();}
  }
 }finally{console.warn=original;}
 assert.equal(warnings.some(line=>line.includes("support_notify_unconfigured")),true);
 assert.equal(warnings.some(line=>line.includes("support deletion notify failed")),true);
 assert.equal(warnings.join("\n").includes(WEBHOOK),false);
 assert.equal(warnings.join("\n").includes("plugin down"),false);
});

test("a down webhook recovers on the sweep and is sent once",async()=>{
 let failures=2,ok=0;
 const w=world({cancel:authFailure(),env:{SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK,SUPPORT_SWEEP_TOKEN:"sweep-token-value"},fetchImpl:async()=>{
  if(failures>0){failures-=1;return {ok:false,status:503};}
  ok+=1;return {ok:true,status:204};
 }});
 try{
  const created=await start(w);
  await pollUntil(w,created.jobId,created.statusToken,"failed");
  assert.equal((await support(w,created.jobId,created.statusToken)).status,202);
  assert.equal(w.db.rows.get("supportRequests/"+created.jobId).notify.attempts,1);
  const denied=await w.call("POST","/internal/support-notifications/sweep",{token:"nope-nope-nope-no"});
  assert.equal(denied.status,401);
  w.setNow(NOW+NOTIFY_BACKOFF_MS[0]);
  const swept=await w.call("POST","/internal/support-notifications/sweep",{token:"sweep-token-value"});
  assert.equal(swept.status,200,swept.text);
  assert.equal(w.db.rows.get("supportRequests/"+created.jobId).notify.attempts,2);
  w.setNow(NOW+NOTIFY_BACKOFF_MS[0]+NOTIFY_BACKOFF_MS[1]);
  await w.svc.sweepSupportNotifications();
  const doc=w.db.rows.get("supportRequests/"+created.jobId);
  assert.equal(doc.notify.state,"sent");
  assert.equal(ok,1);
  await w.svc.sweepSupportNotifications();
  assert.equal(ok,1,"a later sweep does not send again");
 }finally{w.close();}
});

test("five failed deliveries stop and log only the job id",async()=>{
 const errors=[];
 const original=console.error;
 console.error=(...args)=>errors.push(args.join(" "));
 const w=world({cancel:authFailure(),env:{SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK},fetchImpl:async()=>({ok:false,status:502})});
 try{
  const created=await start(w);
  await pollUntil(w,created.jobId,created.statusToken,"failed");
  assert.equal((await support(w,created.jobId,created.statusToken)).status,202);
  let at=NOW;
  for(let n=0;n<4;n++){
   at+=NOTIFY_BACKOFF_MS[n];
   w.setNow(at);
   await w.svc.sweepSupportNotifications();
  }
  const doc=w.db.rows.get("supportRequests/"+created.jobId);
  assert.equal(doc.notify.state,"failed");
  assert.equal(doc.notify.attempts,5);
  assert.equal(errors.filter(line=>line==="support_notify_failed "+created.jobId).length,1);
  assert.equal(errors.join("\n").includes(WEBHOOK),false);
  await w.svc.sweepSupportNotifications();
  assert.equal(w.db.rows.get("supportRequests/"+created.jobId).notify.attempts,5);
  assert.equal(errors.filter(line=>line==="support_notify_failed "+created.jobId).length,1);
 }finally{console.error=original;w.close();}
});

test("a pending request older than one hour logs support_notify_stale",async()=>{
 const errors=[];
 const original=console.error;
 console.error=(...args)=>errors.push(args.join(" "));
 const w=world({cancel:authFailure(),env:{SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK},fetchImpl:async()=>({ok:false,status:503})});
 try{
  const created=await start(w);
  await pollUntil(w,created.jobId,created.statusToken,"failed");
  await support(w,created.jobId,created.statusToken);
  w.setNow(NOW+60*60*1000);
  await w.svc.sweepSupportNotifications();
  assert.equal(errors.some(line=>line.startsWith("support_notify_stale")),false);
  w.setNow(NOW+60*60*1000+1);
  await w.svc.sweepSupportNotifications();
  assert.equal(errors.some(line=>line==="support_notify_stale "+created.jobId),true);
  assert.equal(errors.join("\n").includes(WEBHOOK),false);
 }finally{console.error=original;w.close();}
});

test("workspace names clear on done, when the post is sent, and after 30 days",async()=>{
 const owner=hash("u-names");
 const rows=[["gd_accounts/"+owner+"/workspaces/w1",{name:"Alpha",email:EMAIL}]];
 let release=()=>{};
 const gate=new Promise(resolve=>{release=resolve;});
 const done=world({uid:"u-names",rows,cancel:async()=>{await gate;}});
 try{
  const created=await start(done);
  const running=done.db.rows.get("deletion_jobs/"+created.jobId);
  assert.equal(running.workspaceNames.w1,"Alpha");
  assert.ok(running.namesExpireAt);
  release();
  await pollUntil(done,created.jobId,created.statusToken,"done");
  const finished=done.db.rows.get("deletion_jobs/"+created.jobId);
  assert.equal(finished.workspaceNames,undefined);
  assert.deepEqual(finished.workspaceIds,["w1"]);
 }finally{release();done.close();}
 const kept=world({uid:"u-kept",cancel:authFailure(),rows:[["gd_accounts/"+hash("u-kept")+"/workspaces/w9",{name:"Kept"}]],
  env:{SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK},fetchImpl:async()=>({ok:false,status:503})});
 try{
  const created=await start(kept);
  await pollUntil(kept,created.jobId,created.statusToken,"failed");
  await support(kept,created.jobId,created.statusToken);
  assert.equal(kept.db.rows.get("deletion_jobs/"+created.jobId).workspaceNames.w9,"Kept");
  const expire=new Date(kept.db.rows.get("deletion_jobs/"+created.jobId).namesExpireAt).getTime();
  assert.equal(expire,NOW+NAMES_TTL_MS);
  kept.setNow(expire);
  await kept.svc.sweepSupportNotifications();
  const job=kept.db.rows.get("deletion_jobs/"+created.jobId);
  assert.equal(job.workspaceNames,undefined);
  assert.deepEqual(job.workspaceIds,["w9"]);
  assert.equal(JSON.stringify(kept.db.rows.get("supportRequests/"+created.jobId)).includes("Kept"),false);
 }finally{kept.close();}
});

test("production refuses to start without logging the webhook value",async()=>{
 const secret="https://evil.example/WebhookSecretMarker123";
 const dev=supportDiscordStartup({NODE_ENV:"test",SUPPORT_DISCORD_WEBHOOK_URL:secret});
 assert.equal(dev.exit,false);
 assert.equal(dev.warn,true);
 assert.equal(dev.message.includes("SUPPORT_DISCORD_WEBHOOK_URL"),true);
 assert.equal(dev.message.includes(secret),false);
 assert.equal(dev.message.includes("WebhookSecretMarker123"),false);
 const missing=supportDiscordStartup({NODE_ENV:"production"});
 assert.equal(missing.exit,true);
 assert.equal(missing.message.includes("WebhookSecretMarker123"),false);
 const child=spawn(process.execPath,["-e","require('./free_server.js').start()"],{
  cwd:__dirname,
  env:{PATH:process.env.PATH,NODE_ENV:"production",CUSTOMER_BUCKET:"gendragoon-test-placeholder",STORAGE_PROJECT_ID:"gendragood-ssd",SUPPORT_DISCORD_WEBHOOK_URL:secret},
 });
 let output="";
 child.stdout.on("data",chunk=>{output+=chunk;});
 child.stderr.on("data",chunk=>{output+=chunk;});
 const result=await new Promise(resolve=>{
  const timer=setTimeout(()=>{child.kill("SIGTERM");resolve({code:null,output});},4000);
  child.on("exit",code=>{clearTimeout(timer);resolve({code,output});});
 });
 assert.equal(result.code,1);
 assert.match(result.output,/SUPPORT_DISCORD_WEBHOOK_URL/);
 assert.equal(result.output.includes("WebhookSecretMarker123"),false);
 assert.equal(result.output.includes("evil.example"),false);
 assert.equal(result.output.includes("API ready"),false);
 const source=fs.readFileSync(require.resolve("./free_server.js"),"utf8");
 const startFn=source.slice(source.indexOf("function start"));
 assert.ok(startFn.indexOf("supportDiscordStartup")<startFn.indexOf("app.listen"));
});

test("predeploy check fails closed and does not print the secret",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gd-gcloud-"));
 const fake=path.join(dir,"gcloud");
 fs.writeFileSync(fake,`#!/usr/bin/env node
if(process.env.FAKE_MISSING==="1"){process.stderr.write("SECRETVALUE missing\\n");process.exit(1);}
process.stdout.write("enabled SECRETVALUE\\n");
process.exit(0);
`);
 fs.chmodSync(fake,0o755);
 function run(extra){
  return new Promise(resolve=>{
   const child=spawn(process.execPath,[path.join(__dirname,"scripts/predeploy_check.js")],{env:{...extra,PATH:dir+path.delimiter+(process.env.PATH||"")}});
   let output="";
   child.stdout.on("data",chunk=>{output+=chunk;});
   child.stderr.on("data",chunk=>{output+=chunk;});
   child.on("exit",code=>resolve({code,output}));
  });
 }
 const ok=await run({});
 assert.equal(ok.code,0);
 assert.match(ok.output,/SUPPORT_DISCORD_WEBHOOK_URL/);
 assert.equal(ok.output.includes("SECRETVALUE"),false);
 const missing=await run({FAKE_MISSING:"1"});
 assert.equal(missing.code,1);
 assert.match(missing.output,/SUPPORT_DISCORD_WEBHOOK_URL/);
 assert.equal(missing.output.includes("SECRETVALUE"),false);
});
