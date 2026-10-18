"use strict";
// QA risk tests for PR #6 support request (d33970c). In-memory Firestore and stubs only:
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
  async call(method,p,{token,body,headers:extra}={}){
   const headers={...(extra||{})};if(token!==undefined)headers.authorization="Bearer "+token;if(body!==undefined)headers["content-type"]="application/json";
   const res=await fetch(this.base+p,{method,headers,body:body===undefined?undefined:(typeof body==="string"?body:JSON.stringify(body))});
   const text=await res.text();let json=null;try{json=JSON.parse(text);}catch{}
   await whenSupportSettled();
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

test("R1 concurrent repeat sends: 10 at once -> 5x202 same requestId, 5x429, exactly one alert",async()=>{
 const w=world();
 try{
  const j=await failedJob(w);
  const res=await Promise.all(Array.from({length:10},()=>sup(w,j.jobId,j.statusToken)));
  const ok=res.filter(r=>r.status===202),lim=res.filter(r=>r.status===429);
  assert.equal(ok.length,5,res.map(r=>r.status).join(","));assert.equal(lim.length,5);
  assert.equal(new Set(ok.map(r=>r.json.requestId)).size,1);
  assert.equal(w.calls.length,1,"one Discord alert");
  assert.equal(w.db.rows.get("supportRequests/"+j.jobId).count,5);
 }finally{w.close();}
});

test("R2 concurrent sends through the real notifier and local stub -> one POST",async()=>{
 const stub=await discordStub();
 const w=world({env:{SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK},fetchImpl:stub.fetchImpl});
 try{
  const j=await failedJob(w);
  await Promise.all(Array.from({length:3},()=>sup(w,j.jobId,j.statusToken)));
  await w.svc.sweepSupportNotifications();
  assert.equal(stub.hits.length,1);
 }finally{w.close();stub.close();}
});

test("R3 workspace names with @everyone, @here, role/user mentions and markdown cannot ping and are neutralised",async()=>{
 const stub=await discordStub();const owner=hash("u-ment");
 const evil="@everyone @here <@123456789012345678> <@&222> <@!333> [click](https://evil.example) **bold** `x` ||spoiler|| # Heading";
 const w=world({uid:"u-ment",env:{SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK},fetchImpl:stub.fetchImpl,
  rows:[["gd_accounts/"+owner+"/workspaces/w1",{name:evil}]]});
 try{
  const j=await failedJob(w);
  assert.equal((await sup(w,j.jobId,j.statusToken)).status,202);
  const parts=parseMultipart(stub.hits[0].body,stub.hits[0].type);
  const payload=JSON.parse(parts.payload_json.value);
  assert.deepEqual(payload.allowed_mentions,{parse:[]},"mentions disabled");
  assert.equal(Object.keys(payload).sort().join(),"allowed_mentions,content");
  assert.equal(/@everyone|@here|<@[!&]?\d/.test(payload.content),false,payload.content);
  // markdown masked link: the post renders a clickable link to an attacker URL in grim's channel
  assert.equal(payload.content.includes("](https://evil.example)"),false,"markdown not escaped: "+payload.content);
 }finally{w.close();stub.close();}
});

test("R4 webhook URL never appears in logs, errors, responses, stored docs or the post body",async()=>{
 const cap=capture();
 const stub=await discordStub(n=>({status:n<3?500:204,body:"echo "+WEBHOOK}));
 const thrower=async url=>{throw new Error("connect ECONNREFUSED "+url);};
 const w1=world({uid:"u-l1",env:{SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK},fetchImpl:stub.fetchImpl});
 const w2=world({uid:"u-l2",env:{SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK},fetchImpl:thrower});
 const out=[];
 try{
  for(const w of [w1,w2]){
   const j=await failedJob(w);
   for(const t of [j.statusToken,"bad",undefined])out.push((await sup(w,j.jobId,t)).text);
   let at=NOW;for(let i=0;i<5;i++){at+=NOTIFY_BACKOFF_MS[i]+2*60*60*1000;w.setNow(at);await w.svc.sweepSupportNotifications();}
   out.push(JSON.stringify([...w.db.rows.entries()]));
   out.push((await w.call("POST","/internal/support-notifications/sweep",{token:"x"})).text);
  }
 }finally{cap.restore();w1.close();w2.close();stub.close();}
 const all=cap.lines.join("\n")+"\n"+out.join("\n")+"\n"+stub.hits.map(h=>h.body).join("\n");
 assert.equal(all.includes(MARK),false);assert.equal(all.includes("987654321098765432"),false);
 assert.ok(cap.lines.some(l=>l.includes("support_notify_failed")));
});

test("R5 production gate rejects lookalike/insecure URLs and never echoes the value; dev is optional",()=>{
 for(const bad of [undefined,"","http://discord.com/api/webhooks/1/"+MARK,"https://discordapp.com/api/webhooks/1/"+MARK,
  "https://discord.com.evil.example/api/webhooks/1/"+MARK,"https://evil.example/discord.com/api/webhooks/1/"+MARK,
  "https://discord.com/api/webhooks/1/"+MARK+"?wait=true","https://user:"+MARK+"@discord.com/api/webhooks/1/abcdefgh","not a url "+MARK]){
  const r=supportDiscordStartup({NODE_ENV:"production",SUPPORT_DISCORD_WEBHOOK_URL:bad});
  assert.equal(r.exit,true,String(bad));assert.match(r.message,/SUPPORT_DISCORD_WEBHOOK_URL/);assert.equal(r.message.includes(MARK),false);
 }
 assert.equal(supportDiscordStartup({NODE_ENV:"production",SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK}).exit,false);
 assert.equal(supportDiscordStartup({NODE_ENV:"development"}).exit,false);
 assert.equal(supportDiscordStartup({}).exit,false);
});

test("R6 production with a VALID-looking URL starts (gate passes) and logs nothing of the value",async()=>{
 const child=spawn(process.execPath,["-e","const s=require('./free_server.js').start(0);setTimeout(()=>process.exit(0),1500)"],{cwd:__dirname,
  env:{PATH:process.env.PATH,NODE_ENV:"production",CUSTOMER_BUCKET:"gendragoon-test-placeholder",STORAGE_PROJECT_ID:"demo-qa",SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK,
   FIRESTORE_EMULATOR_HOST:"127.0.0.1:1",GOOGLE_APPLICATION_CREDENTIALS:"/nonexistent"}});
 let o="";child.stdout.on("data",c=>o+=c);child.stderr.on("data",c=>o+=c);
 await new Promise(r=>child.on("exit",r));
 assert.equal(o.includes(MARK),false,o);assert.equal(/support_notify_unconfigured/.test(o),false,o);
});

test("R7 queued and running jobs -> 409 support_not_needed; nothing stored, no alert",async()=>{
 let release;const gate=new Promise(r=>release=r);
 const w=world({cancel:async()=>{await gate;return {};}});
 try{
  await w.listen();
  const c=await w.call("DELETE","/v2/account",{token:"x",body:{confirm:"DELETE"}});
  const r=await sup(w,c.json.jobId,c.json.statusToken);
  assert.equal(r.status,409,r.text);assert.deepEqual(r.json,{error:"support_not_needed"});
  assert.equal(w.db.rows.has("supportRequests/"+c.json.jobId),false);assert.equal(w.calls.length,0);
 }finally{release();w.close();}
});

test("R8 expired status token and token of another job -> 404 not_found",async()=>{
 const a=world({uid:"u-a"}),b=world({uid:"u-b"});
 try{
  const ja=await failedJob(a),jb=await failedJob(b);
  // copy job B's doc into A's db so the other token belongs to a real, failed job on the same server
  a.db.rows.set("deletion_jobs/"+jb.jobId,b.db.rows.get("deletion_jobs/"+jb.jobId));
  assert.equal((await sup(a,ja.jobId,jb.statusToken)).status,404);
  assert.equal((await sup(a,jb.jobId,ja.statusToken)).status,404);
  assert.equal((await sup(a,jb.jobId,jb.statusToken)).status,202,"sanity: own token works");
  a.setNow(NOW+STATUS_TOKEN_TTL_MS+1);
  const exp=await sup(a,ja.jobId,ja.statusToken);
  assert.equal(exp.status,404,exp.text);assert.deepEqual(exp.json,{error:"not_found"});
  assert.equal(a.db.rows.has("supportRequests/"+ja.jobId),false);
 }finally{a.close();b.close();}
});

test("R9 missing Authorization header -> spec says bad token is 404; server returns 401 (recorded)",async()=>{
 const w=world();
 try{const j=await failedJob(w);const r=await w.call("POST","/v2/account/deletions/"+j.jobId+"/support-request");
  assert.equal(r.status,401);assert.deepEqual(r.json,{error:"unauthorized"});
  const unknown=await sup(w,"00000000-0000-4000-8000-0000000000ff",j.statusToken);assert.equal(unknown.status,404);
 }finally{w.close();}
});

test("R10 job deleted after it failed: request -> 404, and a pending request for it does not loop/stale forever",async()=>{
 const cap=capture();
 const w=world({env:{SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK},fetchImpl:async()=>({ok:false,status:503})});
 let j;
 try{
  j=await failedJob(w);
  assert.equal((await sup(w,j.jobId,j.statusToken)).status,202);
  w.db.rows.delete("deletion_jobs/"+j.jobId);
  for(const k of [...w.db.rows.keys()])if(k.startsWith("account_deletions/"))w.db.rows.delete(k);
  const r=await sup(w,j.jobId,j.statusToken);
  assert.equal(r.status,404,r.text);
  let at=NOW;for(let i=0;i<8;i++){at+=7*60*60*1000;w.setNow(at);await w.svc.sweepSupportNotifications();}
 }finally{cap.restore();w.close();}
 const doc=w.db.rows.get("supportRequests/"+j.jobId);
 const stale=cap.lines.filter(l=>l.includes("support_notify_stale "+j.jobId)).length;
 assert.ok(doc.notify.state!=="pending"||stale<=1,"orphan support request stays "+doc.notify.state+" attempts="+doc.notify.attempts+" and logged stale "+stale+"x");
});

test("R11 unsent request: support_notify_stale at most once per 24h, then again only while still unsent",async()=>{
 const cap=capture();
 const w=world({env:{SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK},fetchImpl:async()=>({ok:false,status:503})});
 let j;
 try{
  j=await failedJob(w);await sup(w,j.jobId,j.statusToken);
  const stale=()=>cap.lines.filter(l=>l.includes("support_notify_stale "+j.jobId)).length;
  w.setNow(NOW+60*60*1000);await w.svc.sweepSupportNotifications();
  assert.equal(stale(),0,"not yet more than one hour after createdAt");
  w.setNow(NOW+60*60*1000+1);await w.svc.sweepSupportNotifications();
  assert.equal(stale(),1);
  const alerted=Date.parse(w.db.rows.get("supportRequests/"+j.jobId).notify.staleAlertedAt);
  assert.ok(Number.isFinite(alerted));
  w.setNow(alerted+24*60*60*1000-1);await w.svc.sweepSupportNotifications();
  assert.equal(stale(),1,"no second log inside 24h");
  w.setNow(alerted+24*60*60*1000);await w.svc.sweepSupportNotifications();
  assert.equal(stale(),2,"re-alert after 24h while the request is still unsent");
  assert.notEqual(w.db.rows.get("supportRequests/"+j.jobId).notify.state,"sent");
 }finally{cap.restore();w.close();}
});

test("R12 names TTL: cleared at 30 days even with no webhook configured and job still failed",async()=>{
 const owner=hash("u-ttl");
 const w=world({uid:"u-ttl",notifier:false,rows:[["gd_accounts/"+owner+"/workspaces/w1",{name:"TTLName"}]]});
 try{
  const j=await failedJob(w);await sup(w,j.jobId,j.statusToken);
  const job=w.db.rows.get("deletion_jobs/"+j.jobId);
  assert.equal(job.workspaceNames.w1,"TTLName");
  assert.equal(new Date(job.namesExpireAt).getTime(),NOW+NAMES_TTL_MS);
  w.setNow(NOW+NAMES_TTL_MS-1);await w.svc.sweepSupportNotifications();
  assert.equal(w.db.rows.get("deletion_jobs/"+j.jobId).workspaceNames.w1,"TTLName");
  w.setNow(NOW+NAMES_TTL_MS);await w.svc.sweepSupportNotifications();
  const after=w.db.rows.get("deletion_jobs/"+j.jobId);
  assert.equal(after.workspaceNames,undefined);
  for(const [k,v] of w.db.rows)if(!k.includes("/workspaces/"))assert.equal(JSON.stringify(v).includes("TTLName"),false,k);
 }finally{w.close();}
});

test("R13 support record never stores names; post never contains statusToken, Firebase token, sealed names, file bytes",async()=>{
 const stub=await discordStub();const owner=hash("u-sec");
 const objs=new Set(["customer/"+owner+"/managed/w1/aaaaaaaa-1111-4111-8111-111111111111"]);
 const bucket={deleteFiles:async()=>{},getFiles:async({prefix})=>[[...objs].filter(k=>k.startsWith(prefix)).map(name=>({name}))],
  file:()=>({download:async()=>[Buffer.from("FILEBYTES_SECRET")]})};
 const w=world({uid:"u-sec",bucket,env:{SUPPORT_DISCORD_WEBHOOK_URL:WEBHOOK},fetchImpl:stub.fetchImpl,
  rows:[["gd_accounts/"+owner+"/workspaces/w1",{name:"Visible",sealedName:"SEALED_NAME_X",wrappedKey:"WRAPPED_KEY_X"}],
        ["gd_accounts/"+owner+"/workspaces/w2",{name:{ciphertext:"CIPHER_NAME_X",iv:"i"}}]]});
 try{
  const j=await failedJob(w);
  const r=await sup(w,j.jobId,j.statusToken,{headers:{"x-firebase-token":"FBTOKEN_X"},body:{idToken:"FBTOKEN_X",names:["BODYNAME_X"]}});
  assert.equal(r.status,202,r.text);
  const body=stub.hits[0].body;
  for(const s of [j.statusToken,"FBTOKEN_X","SEALED_NAME_X","CIPHER_NAME_X","WRAPPED_KEY_X","FILEBYTES_SECRET","BODYNAME_X",MARK])assert.equal(body.includes(s),false,s);
  const file=JSON.parse(parseMultipart(body,stub.hits[0].type)["files[0]"].value);
  assert.equal(parseMultipart(body,stub.hits[0].type)["files[0]"].filename,"deletion-"+j.jobId+".json");
  for(const k of ["workspaces","subscriptions","firebase"])assert.ok(k in file,k);
  const row=file.workspaces.find(x=>x.id==="w1");
  assert.ok(row.prefixes.every(p=>"deleted" in p&&"remaining" in p&&Array.isArray(p.remainingIds)));
  const doc=w.db.rows.get("supportRequests/"+j.jobId);
  assert.equal(/Visible|CIPHER|SEALED|BODYNAME|FBTOKEN/.test(JSON.stringify(doc)),false);
 }finally{w.close();stub.close();}
});

test("R14 old /v2/support/deletion-request route is 404 (with and without token/body)",async()=>{
 const w=world();
 try{const j=await failedJob(w);
  for(const opts of [{},{token:j.statusToken},{token:j.statusToken,body:{jobId:j.jobId}}]){
   const r=await w.call("POST","/v2/support/deletion-request",opts);assert.equal(r.status,404,JSON.stringify(opts)+" "+r.text);}
 }finally{w.close();}
});

test("R15 signed-out: Firebase middleware is never called on the support route",async()=>{
 const w=world();
 try{const j=await failedJob(w);const before=w.authed;await sup(w,j.jobId,j.statusToken);assert.equal(w.authed,before);}finally{w.close();}
});

test("R16 account deletion clears freeWorkspaceId and never promotes a sibling (gd_accounts + tenants)",async()=>{
 const owner=hash("u-free");
 const w=world({uid:"u-free",cancel:async()=>({}),rows:[
  ["gd_accounts/"+owner,{uid:"u-free",stripeCustomerId:"cus_qa",freeWorkspaceId:"free1"}],
  ["gd_accounts/"+owner+"/workspaces/free1",{name:"F",projectFeeStatus:"free",createdAtMs:1}],
  ["gd_accounts/"+owner+"/workspaces/paid2",{name:"P",projectFeeStatus:"monthly",createdAtMs:2}],
  ["tenants/"+owner+"/workspaces/t3",{name:"T"}]]});
 const writes=[];const origSet=w.db.doc?null:null;void origSet;
 try{
  await w.listen();
  const c=await w.call("DELETE","/v2/account",{token:"x",body:{confirm:"DELETE"}});
  const deadline=Date.now()+5000;
  for(;;){const s=await w.call("GET","/v2/account/deletions/"+c.json.jobId,{token:c.json.statusToken});if(s.json?.status==="done"||Date.now()>deadline)break;await new Promise(r=>setTimeout(r,5));}
  const acct=w.db.rows.get("gd_accounts/"+owner);
  assert.ok(!acct||acct.freeWorkspaceId==null,JSON.stringify(acct));
  for(const k of w.db.rows.keys())assert.equal(k.includes("/workspaces/"),false,k);
  void writes;
 }finally{w.close();}
});

test("R17 repo-wide grep: no real discord.com/api/webhooks URL committed (tree and history)",()=>{
 const root=path.resolve(__dirname,"../..");
 let tree="";
 try{tree=execFileSync("git",["grep","-nE","discord(app)?\\.com/api/webhooks/[0-9]{5,}/"],{cwd:root,encoding:"utf8"});}
 catch(error){if(error.status!==1)throw error;}
 for(const line of tree.trim().split("\n").filter(Boolean))
  assert.match(line,/(test\.js|qa_.*\.js):.*(WebhookSecretMarker123|QaMarkerWebhookTok)/,line);
});
