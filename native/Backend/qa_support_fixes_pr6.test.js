"use strict";
// QA re-verify tests for PR #6 at 580e672 (F1-F7 fixes). In-memory Firestore and stubs only.
// no network beyond 127.0.0.1, no real Discord webhook, no Stripe, no credentials.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const http=require("node:http"),{spawn,execFileSync}=require("node:child_process"),path=require("node:path");
const express=require("express");
const {memoryFirestore}=require("./test_firestore");
const {registerAccountDeletion,createDiscordNotifier,supportDiscordStartup,whenSupportSettled,NAMES_TTL_MS,NOTIFY_BACKOFF_MS,STATUS_TOKEN_TTL_MS}=require("./account_delete");
const NOW=1_800_000_000_000;
const hash=uid=>crypto.createHash("sha256").update("gd-v1:"+uid).digest("hex");
const MARK="QaMarkerWebhookTok_9f8e7d";
const WEBHOOK=["https:","","discord.com","api","webhooks","987654321098765432",MARK].join("/");
const authFailure=()=>async()=>{throw Object.assign(Error("auth"),{type:"authentication_error",statusCode:401});};

// Local Discord stub: every notifier fetch to discord.com is redirected here, so nothing leaves the box.
async function discordStub(handler){
 const hits=[];
 const server=http.createServer((req,res)=>{
  const chunks=[];req.on("data",c=>chunks.push(c));req.on("end",()=>{
   const body=Buffer.concat(chunks).toString("utf8");hits.push({url:req.url,type:req.headers["content-type"],body});
   const r=handler?handler(hits.length):{status:204};res.statusCode=r.status;res.end(r.body||"");
  });
 });
 await new Promise(r=>server.listen(0,"127.0.0.1",r));
 const base="http://127.0.0.1:"+server.address().port;
 const fetchImpl=async(url,init)=>{
  const u=new URL(url);assert.equal(u.hostname.endsWith("discord.com"),true);
  return fetch(base+u.pathname,{method:init.method,headers:init.headers,body:init.body});
 };
 return {hits,fetchImpl,close:()=>server.close()};
}
function parseMultipart(body,type){
 const b=/boundary=([^;\s]+)/.exec(type)[1];const out={};
 for(const part of String(body).split("--"+b).slice(1,-1)){
  const name=/name="([^"]+)"/.exec(part)[1];const filename=/filename="([^"]+)"/.exec(part)?.[1]||null;
  out[name]={filename,value:part.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/,"")};
 }
 return out;
}
function capture(){
 const lines=[];const orig={log:console.log,warn:console.warn,error:console.error};
 for(const k of Object.keys(orig))console[k]=(...a)=>lines.push(k+": "+a.map(x=>x instanceof Error?x.stack+" "+x.message:typeof x==="string"?x:JSON.stringify(x)).join(" "));
 return {lines,restore(){Object.assign(console,orig);}};
}
function world({uid="u-qa",rows=[],env={},fetchImpl,notifier,cancel=authFailure(),bucket}={}){
 let now=NOW;const calls=[];let authed=0;
 const db=memoryFirestore([["gd_accounts/"+hash(uid),{uid,stripeCustomerId:"cus_qa"}],...rows]);
 const stripe={subscriptions:{list:async()=>({has_more:false,data:[{id:"sub_qa",status:"active",customer:"cus_qa"}]}),cancel}};
 const app=express();app.use(express.json({limit:"16kb"}));
 const options={app,db,stripe,bucket:bucket||{deleteFiles:async()=>{}},auth:{deleteUser:async()=>{},revokeRefreshTokens:async()=>{}},
  hash,now:()=>now,env,firebaseAuth:(req,_res,next)=>{authed+=1;req.user={uid,auth_time:Math.floor(now/1000)-30};next();}};
 if(fetchImpl)options.notifier=createDiscordNotifier({env,fetchImpl,warn(){}});
 else if(notifier!==false)options.notifier=notifier||(async e=>{calls.push(e);});
 const svc=registerAccountDeletion(options);
 return {db,app,calls,svc,get authed(){return authed;},setNow(v){now=v;},
  async listen(){this.server=app.listen(0,"127.0.0.1");await new Promise(r=>this.server.once("listening",r));this.base="http://127.0.0.1:"+this.server.address().port;},
  close(){this.server?.close();},
  async call(method,p,{token,body,headers:extra,settle=true}={}){
   const headers={...(extra||{})};if(token!==undefined)headers.authorization="Bearer "+token;if(body!==undefined)headers["content-type"]="application/json";
   const res=await fetch(this.base+p,{method,headers,body:body===undefined?undefined:(typeof body==="string"?body:JSON.stringify(body))});
   const text=await res.text();let json=null;try{json=JSON.parse(text);}catch{}
   if(settle)await whenSupportSettled();
   return {status:res.status,json,text,headers:Object.fromEntries(res.headers)};
  }};
}
async function failedJob(w){
 await w.listen();
 const c=await w.call("DELETE","/v2/account",{token:"x",body:{confirm:"DELETE"}});
 assert.equal(c.status,202,c.text);
 const deadline=Date.now()+5000;
 for(;;){const s=await w.call("GET","/v2/account/deletions/"+c.json.jobId,{token:c.json.statusToken});
  if(s.json?.status==="failed")return c.json;if(Date.now()>deadline)assert.fail(s.text);await new Promise(r=>setTimeout(r,5));}
}
const sup=(w,jobId,token,opts={})=>w.call("POST","/v2/account/deletions/"+jobId+"/support-request",{token,...opts});
const {createAccountDeletion}=require("./account_delete");
const HOUR=60*60*1000;
function countReads(db,prefixes){
 const stat={n:0};const orig=db.rows.has.bind(db.rows);
 db.rows.has=k=>{if(prefixes.some(p=>k.startsWith(p)))stat.n++;return orig(k);};
 return stat;
}

test("N1 stale alert across 48 h of 10-minute sweeps fires exactly once (one-time staleAlertedAt)",async()=>{
 const cap=capture();
 const w=world({env:{SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK},fetchImpl:async()=>({ok:false,status:503})});
 let j;
 try{
  j=await failedJob(w);await sup(w,j.jobId,j.statusToken);await whenSupportSettled();
  for(let t=10*60*1000;t<=48*HOUR;t+=10*60*1000){w.setNow(NOW+t);await w.svc.sweepSupportNotifications();}
 }finally{cap.restore();w.close();}
 const stale=cap.lines.filter(l=>l.includes("support_notify_stale "+j.jobId)).length;
 const failed=cap.lines.filter(l=>l.includes("support_notify_failed "+j.jobId)).length;
 assert.equal(stale,1,"stale "+stale);assert.equal(failed,1,"failed "+failed);
});

test("N2 expireAt cleanup never removes a pending/unsent request; a sent or terminal one keeps a 30-day expireAt",async()=>{
 const w=world({env:{SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK},fetchImpl:async()=>({ok:false,status:503})});
 try{
  const j=await failedJob(w);await sup(w,j.jobId,j.statusToken);await whenSupportSettled();
  const key="supportRequests/"+j.jobId;
  assert.equal(w.db.rows.get(key).expireAt,undefined,"pending has no expireAt");
  for(let t=1;t<=40;t++){w.setNow(NOW+t*HOUR);await w.svc.sweepSupportNotifications();}
  assert.ok(w.db.rows.has(key),"pending request survives sweeps");
  // injected hardening case: a pending doc that carries a past expireAt (e.g. legacy/manual edit)
  w.db.rows.set("supportRequests/inj",{jobId:"inj",createdAt:new Date(NOW).toISOString(),count:1,
   notify:{state:"pending",attempts:0,nextAttemptAt:new Date(NOW+999*HOUR).toISOString()},expireAt:new Date(NOW)});
  await w.svc.sweepSupportNotifications();
  assert.ok(w.db.rows.has("supportRequests/inj"),"cleanup deleted a PENDING request because it had expireAt");
 }finally{w.close();}
});

test("N2b a repeat send after the post was sent must keep expireAt (retention)",async()=>{
 const w=world();
 try{
  const j=await failedJob(w);await sup(w,j.jobId,j.statusToken);await whenSupportSettled();
  const key="supportRequests/"+j.jobId;
  assert.equal(w.db.rows.get(key).notify.state,"sent");assert.ok(w.db.rows.get(key).expireAt,"sent has expireAt");
  await sup(w,j.jobId,j.statusToken);
  assert.ok(w.db.rows.get(key).expireAt,"repeat send dropped expireAt, so the sent record is never cleaned up");
 }finally{w.close();}
});

for(const nodeEnv of [undefined,"test","development"]){
 test("N3 K_SERVICE gate, NODE_ENV="+nodeEnv+": invalid -> exit 1 with no value; valid -> server starts",async()=>{
  const run=url=>new Promise(resolve=>{
   const env={PATH:process.env.PATH,K_SERVICE:"gendragoon-free",PORT:"0",CUSTOMER_BUCKET:"gendragoon-test-placeholder",STORAGE_PROJECT_ID:"gendragood-ssd",
    FIRESTORE_EMULATOR_HOST:"127.0.0.1:1",GOOGLE_APPLICATION_CREDENTIALS:"/nonexistent"};
   if(nodeEnv)env.NODE_ENV=nodeEnv;if(url!==undefined)env.SUPPORT_DISCORD_WEBHOOK_URL=url;
   const child=spawn(process.execPath,["-e","require('./free_server.js').start()"],{cwd:__dirname,env});
   let o="";child.stdout.on("data",c=>{o+=c;if(o.includes("API ready"))child.kill("SIGTERM");});child.stderr.on("data",c=>o+=c);
   const timer=setTimeout(()=>child.kill("SIGKILL"),6000);
   child.on("exit",code=>{clearTimeout(timer);resolve({code,o});});
  });
  for(const bad of [undefined,"","https://evil.example/"+MARK,["http:","","discord.com","api","webhooks","1",MARK].join("/")]){
   const r=await run(bad);
   assert.equal(r.code,1,String(bad)+" "+r.o);assert.match(r.o,/SUPPORT_DISCORD_WEBHOOK_URL/);
   assert.equal(r.o.includes(MARK),false);assert.equal(r.o.includes("API ready"),false);
  }
  const ok=await run(WEBHOOK);
  assert.match(ok.o,/API ready/,ok.o);assert.equal(ok.o.includes(MARK),false);
 });
}

test("N4 escaping covers [ ] ( ) * _ ~ ` > | and @everyone/@here/<@..> mentions",async()=>{
 const stub=await discordStub();const owner=hash("u-esc");
 const name="[a](b) *c* _d_ ~e~ `f` >g |h| @everyone @here <@1> <@&2> <@!3> x@y";
 const w=world({uid:"u-esc",env:{SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK},fetchImpl:stub.fetchImpl,rows:[["gd_accounts/"+owner+"/workspaces/w1",{name}]]});
 try{
  const j=await failedJob(w);await sup(w,j.jobId,j.statusToken);await whenSupportSettled();
  const c=JSON.parse(parseMultipart(stub.hits[0].body,stub.hits[0].type).payload_json.value).content;
  const line=c.split("\n").find(l=>l.startsWith("workspaces:"));
  const nameOut=line.slice(line.indexOf("w1 ")+3);
  for(const ch of "[]()*_~`>|")for(let i=0;i<nameOut.length;i++)if(nameOut[i]===ch)assert.equal(nameOut[i-1],"\\","unescaped "+ch+" in "+nameOut);
  assert.equal(/@everyone|@here|<@[!&]?\d/.test(c),false,c);
  assert.deepEqual(JSON.parse(parseMultipart(stub.hits[0].body,stub.hits[0].type).payload_json.value).allowed_mentions,{parse:[]});
  // the JSON attachment keeps the raw name (not rendered by Discord)
  const file=JSON.parse(parseMultipart(stub.hits[0].body,stub.hits[0].type)["files[0]"].value);
  assert.equal(file.workspaces[0].name,name);
 }finally{w.close();stub.close();}
});

test("N5 202 returns in < 1 s while Discord hangs (stub never answers)",async()=>{
 const sockets=[];
 const hang=http.createServer(()=>{});hang.on("connection",s=>sockets.push(s));
 await new Promise(r=>hang.listen(0,"127.0.0.1",r));
 const base="http://127.0.0.1:"+hang.address().port;
 const w=world({env:{SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK},fetchImpl:(url,init)=>fetch(base+new URL(url).pathname,init)});
 try{
  const j=await failedJob(w);
  const t0=Date.now();const r=await sup(w,j.jobId,j.statusToken,{settle:false});const ms=Date.now()-t0;console.log("QA_N5_MS "+ms+" sockets="+sockets.length);
  assert.equal(r.status,202);assert.ok(ms<1000,"202 took "+ms+" ms");
  const t1=Date.now();const r2=await sup(w,j.jobId,j.statusToken,{settle:false});assert.equal(r2.status,202);assert.ok(Date.now()-t1<1000);
  assert.equal(sockets.length>=1,true,"Discord POST was attempted");
 }finally{w.close();for(const s of sockets)s.destroy();hang.close();await whenSupportSettled();}
});

test("N6b crash after the record is saved but before any post was claimed -> next sweep sends once",async()=>{
 const w=world({notifier:false});
 try{
  const j=await failedJob(w);await sup(w,j.jobId,j.statusToken);await whenSupportSettled(); // unconfigured: saved, not claimed
  const sent=[];
  const b=createAccountDeletion({db:w.db,stripe:{},bucket:{},auth:{},hash,now:()=>NOW+1000,notifier:async e=>{sent.push(e.jobId);},env:{}});
  await b.sweepSupportNotifications();await b.sweepSupportNotifications();
  assert.deepEqual(sent,[j.jobId]);
 }finally{w.close();}
});

test("N7 scoped sweep reads only due records (snapshot reads counted)",async()=>{
 const rows=[];
 for(let i=0;i<300;i++){
  rows.push(["supportRequests/s"+i,{jobId:"s"+i,createdAt:new Date(NOW-HOUR*0.5).toISOString(),count:1,
   notify:{state:"sent",attempts:0,nextAttemptAt:null},expireAt:new Date(NOW+20*24*HOUR)}]);
  rows.push(["supportRequests/f"+i,{jobId:"f"+i,createdAt:new Date(NOW-HOUR*0.5).toISOString(),count:1,
   notify:{state:"pending",attempts:1,nextAttemptAt:new Date(NOW+HOUR).toISOString(),staleDueAt:new Date(NOW+HOUR).toISOString()}}]);
  rows.push(["deletion_jobs/j"+i,{jobId:"j"+i,status:"failed",workspaceNames:{w:"N"},namesExpireAt:new Date(NOW+10*24*HOUR)}]);
 }
 for(let i=0;i<3;i++)rows.push(["supportRequests/d"+i,{jobId:"d"+i,createdAt:new Date(NOW-HOUR*0.5).toISOString(),count:1,
  notify:{state:"pending",attempts:0,nextAttemptAt:new Date(NOW-1000).toISOString(),staleDueAt:new Date(NOW+HOUR).toISOString()}}],
  ["deletion_jobs/d"+i,{jobId:"d"+i,status:"failed",uid:"u",accountHash:"h",workspaceIds:[]}]);
 const sent=[];
 const db=memoryFirestore(rows);
 const svc=createAccountDeletion({db,stripe:{},bucket:{},auth:{},hash,now:()=>NOW,notifier:async e=>{sent.push(e.jobId);},env:{}});
 const reads=countReads(db,["supportRequests/","deletion_jobs/"]);
 await svc.sweepSupportNotifications();
 assert.equal(sent.length,3);
 assert.ok(reads.n<=3*12,"reads "+reads.n+" for 3 due among 903 records");
 const r2=countReads(db,["supportRequests/","deletion_jobs/"]);void r2;
 reads.n=0;await svc.sweepSupportNotifications();
 assert.ok(reads.n<=2,"idle sweep read "+reads.n+" docs");
});

test("N7b sweep honours SWEEP_LIMIT: 120 due requests drain over several sweeps, each sweep bounded",async()=>{
 const rows=[];
 for(let i=0;i<120;i++)rows.push(["supportRequests/d"+i,{jobId:"d"+i,createdAt:new Date(NOW).toISOString(),count:1,
  notify:{state:"pending",attempts:0,nextAttemptAt:new Date(NOW-1000).toISOString(),staleDueAt:new Date(NOW+HOUR).toISOString()}}],
  ["deletion_jobs/d"+i,{jobId:"d"+i,status:"failed",uid:"u",accountHash:"h",workspaceIds:[]}]);
 const sent=[];const db=memoryFirestore(rows);
 const svc=createAccountDeletion({db,stripe:{},bucket:{},auth:{},hash,now:()=>NOW,notifier:async e=>{sent.push(e.jobId);},env:{}});
 const r=await svc.sweepSupportNotifications();assert.ok(r.delivered<=50,"first sweep "+r.delivered);
 await svc.sweepSupportNotifications();await svc.sweepSupportNotifications();
 assert.equal(new Set(sent).size,120);assert.equal(sent.length,120);
});

test("N8 job deleted mid-sweep: that request goes failed (jobMissing) with one support_notify_failed; others still send",async()=>{
 const cap=capture();
 const rows=[];
 for(const id of ["a","b","c"])rows.push(["supportRequests/"+id,{jobId:id,createdAt:new Date(NOW).toISOString(),count:1,
  notify:{state:"pending",attempts:0,nextAttemptAt:new Date(NOW-3000+(id.charCodeAt(0))).toISOString(),staleDueAt:new Date(NOW+HOUR).toISOString()}}],
  ["deletion_jobs/"+id,{jobId:id,status:"failed",uid:"u",accountHash:"h",workspaceIds:[]}]);
 const db=memoryFirestore(rows);const sent=[];
 const svc=createAccountDeletion({db,stripe:{},bucket:{},auth:{},hash,now:()=>NOW,env:{},
  notifier:async e=>{sent.push(e.jobId);if(e.jobId==="a")db.rows.delete("deletion_jobs/b");}});
 let r;
 try{r=await svc.sweepSupportNotifications();await svc.sweepSupportNotifications();await svc.sweepSupportNotifications();}finally{cap.restore();}
 assert.deepEqual(sent.sort(),["a","c"]);
 const b=db.rows.get("supportRequests/b");
 assert.equal(b.notify.state,"failed");assert.equal(b.notify.jobMissing,true);assert.ok(b.expireAt);
 assert.equal(cap.lines.filter(l=>l.includes("support_notify_failed b")).length,1);
 assert.ok(r.failed>=1);
});

test("N6 outbox delivers after a crash (instance dies mid-post; a fresh instance on the same DB sends exactly once)",async()=>{
 const w=world({notifier:()=>new Promise(()=>{})}); // instance A: post never completes (process "crashed")
 try{
  const j=await failedJob(w); // NOTE: runs last; A's post never settles
assert.equal((await sup(w,j.jobId,j.statusToken,{settle:false})).status,202);
  await new Promise(r=>setTimeout(r,20));
  const key="supportRequests/"+j.jobId;assert.equal(w.db.rows.get(key).notify.state,"pending");
  const sent=[];
  const b=createAccountDeletion({db:w.db,stripe:{},bucket:{},auth:{},hash,now:()=>bNow,notifier:async e=>{sent.push(e.jobId);},env:{}});
  var bNow=NOW+30*1000;await b.sweepSupportNotifications();
  assert.equal(sent.length,0,"claimed by A, not retaken within 60 s");
  bNow=NOW+61*1000;await b.sweepSupportNotifications();await b.sweepSupportNotifications();
  assert.deepEqual(sent,[j.jobId]);assert.equal(w.db.rows.get(key).notify.state,"sent");
 }finally{w.close();}
});

