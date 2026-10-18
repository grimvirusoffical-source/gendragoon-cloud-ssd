"use strict";
// QA deletion contract (Morgan) against the production wiring:
// free_server's createLoginGate -> billing_gateway.installedBilling -> account_delete.
// Firebase is modelled like production Admin Auth: the login gate's
// verifyIdToken checks the JWT only (free_server does not pass checkRevoked),
// while adminAuth.getUser/deleteUser reflect the real user record.
// Stub Firestore, Stripe and bucket only: no network, keys, or user data.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const express=require("express");
const {memoryFirestore}=require("./test_firestore");
const {installedBilling}=require("./billing_gateway");
const {createLoginGate,TERMS_VERSION}=require("./login_gate");
const {STATUS_TOKEN_TTL_MS,REAUTH_SECONDS,supportDiscordStartup,whenSupportSettled}=require("./account_delete");
const {installV2Errors}=require("./v2_errors");
const NOW=1_800_000_000_000;
const TOKEN_RE=/^[A-Za-z0-9_-]{43}$/;
const hash=uid=>crypto.createHash("sha256").update("gd-v1:"+uid).digest("hex");
const termsDoc=()=>({termsVersion:TERMS_VERSION,readConfirmed:true,agreed:true});

function harness({uids,terms=uids,authAge=30,holdStripe=false,bucket={deleteFiles:async()=>{}},stripe:stripeOverride,v2Errors=false}){
 let now=NOW;
 const db=memoryFirestore([
  ...uids.map(u=>["gd_accounts/"+hash(u),{uid:u}]),
  ...terms.map(u=>["accepted_terms/"+u,termsDoc()]),
 ]);
 const users=new Set(uids);
 const ages=new Map(uids.map(u=>[u,authAge]));
 let termsReads=0;
 // JWT-only verification, as free_server does: a deleted user's unexpired ID
 // token still verifies; garbage does not.
 const gate=createLoginGate({
  verifyIdToken:async token=>{
   const m=/^idtoken\.(.+)$/.exec(token);
   if(!m||!ages.has(m[1]))throw Object.assign(Error("bad jwt"),{code:"auth/argument-error"});
   return {uid:m[1],auth_time:Math.floor(now/1000)-ages.get(m[1]),firebase:{sign_in_provider:"google.com"}};
  },
  fetchTerms:async uid=>{
   termsReads+=1;
   const snap=await db.collection("accepted_terms").doc(uid).get();
   if(!snap.exists)return {ok:false,json:async()=>({})};
   const r=snap.data();
   return {ok:true,json:async()=>({fields:{termsVersion:{stringValue:r.termsVersion},
    readConfirmed:{booleanValue:r.readConfirmed===true},agreed:{booleanValue:r.agreed===true}}})};
  },
 });
 const gone=()=>Object.assign(Error("gone"),{code:"auth/user-not-found"});
 const adminAuth={
  revokeRefreshTokens:async u=>{if(!users.has(u))throw gone();},
  deleteUser:async u=>{if(!users.has(u))throw gone();users.delete(u);},
  getUser:async u=>{if(!users.has(u))throw gone();return {uid:u,disabled:false};},
 };
 let release=()=>{};
 const hold=new Promise(r=>{release=r;});
 const stripe={subscriptions:{list:async()=>({has_more:false,data:[]}),cancel:async()=>({})}};
 if(holdStripe){
  db.rows.set("gd_accounts/"+hash(uids[0]),{uid:uids[0],stripeCustomerId:"cus_test"});
  stripe.subscriptions.list=async q=>({has_more:false,data:[{id:"sub_"+q.customer,status:"active",customer:q.customer}]});
  stripe.subscriptions.cancel=async()=>{await hold;return {};};
 }
 // Each build is one server instance: its own express app and its own
 // account_delete service (in-memory job cache), sharing db, Firebase and clock.
 const build=(stripeImpl,bucketImpl=bucket)=>{
  const app=express();
  app.use("/v2",express.json({limit:"16kb"}));
  installedBilling({app,db,bucket:bucketImpl,admin:{firestore:{FieldValue:{serverTimestamp:()=>0}}},
   firebaseAuth:gate.firebaseAuth,firebaseAuthWithoutTerms:gate.firebaseAuthWithoutTerms,accountKey:hash,
   env:{},stripeOverride:stripeImpl,adminAuth,now:()=>now});
  // Production free_server installs JSON /v2 misses after billing (free_server.js:315).
  if(v2Errors)installV2Errors(app);
  return app;
 };
 const app=build(stripeOverride||stripe);
 const errors=[];
 const extra=[];
 return {db,users,ages,app,release,errors,
  // A second server instance on the same Firestore (multi-instance Cloud Run).
  async instance(stripeImpl=stripe,bucketImpl){
   const server=build(stripeImpl,bucketImpl).listen(0,"127.0.0.1");
   await new Promise(r=>server.once("listening",r));
   extra.push(server);
   return "http://127.0.0.1:"+server.address().port;
  },
  get termsReads(){return termsReads;},
  setNow(v){now=v;},
  async listen(){
   const server=app.listen(0,"127.0.0.1");
   await new Promise(r=>server.once("listening",r));
   this.server=server;this.base="http://127.0.0.1:"+server.address().port;
  },
  close(){this.server?.close();for(const s of extra)s.close();},
  async call(method,path,{token,body,base=this.base}={}){
   const headers={};
   if(token!==undefined)headers.authorization="Bearer "+token;
   if(body!==undefined)headers["content-type"]="application/json";
   const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
   const text=await res.text();
   let json=null;try{json=JSON.parse(text);}catch(_){}
   if(res.status>=400)errors.push({status:res.status,path,json,text});
   return {status:res.status,json,text,headers:res.headers};
  },
  del(uid,opts={}){return this.call("DELETE","/v2/account",{token:"idtoken."+uid,body:{confirm:"DELETE"},...opts});},
  poll(jobId,token,base){return this.call("GET","/v2/account/deletions/"+jobId,{token,base});},
  async pollUntil(jobId,token,want="done",onEach){
   const seen=[];const deadline=Date.now()+5000;let last;
   do{
    last=await this.poll(jobId,token);
    if(last.status!==200)return {seen,last};
    seen.push(last.json.status);
    if(onEach)await onEach(last.json.status);
    if(last.json.status===want)break;
    await new Promise(r=>setTimeout(r,5));
   }while(Date.now()<deadline);
   return {seen,last};
  },
 };
}
function assertErrorShape(errors){
 assert.ok(errors.length>0);
 for(const e of errors){
  assert.ok(e.json&&typeof e.json==="object",`${e.status} ${e.path}: body is not JSON: ${e.text}`);
  assert.equal(typeof e.json.error,"string",`${e.status} ${e.path}: missing error`);
  assert.equal("code" in e.json,false,`${e.status} ${e.path}: must not send a code field`);
  const allowed=e.status===410?["error","jobId","statusToken"]:e.status===409?["error","jobId"]:["error"];
  for(const key of Object.keys(e.json))assert.ok(allowed.includes(key),`${e.status} ${e.path}: unexpected key ${key}`);
 }
}

test("contract 1: production wiring skips Terms only for DELETE /v2/account and GET deletions/:jobId (the support request is covered by contract 21)",async()=>{
 const h=harness({uids:["u-terms"],terms:[]}); // user has NO Terms record
 await h.listen();
 try{
  const other=await h.call("GET","/v2/workspaces",{token:"idtoken.u-terms"});
  assert.equal(other.status,403,"other /v2 routes still require Terms");
  assert.deepEqual(other.json,{error:"Current Terms acceptance required"});
  const reads=h.termsReads;
  assert.equal(reads,1);
  const created=await h.del("u-terms");
  assert.equal(created.status,202,created.text);
  const ownerPoll=await h.poll(created.json.jobId,"idtoken.u-terms");
  assert.equal(ownerPoll.status,200,"owner Firebase poll skips Terms");
  const {last}=await h.pollUntil(created.json.jobId,created.json.statusToken);
  assert.equal(last.json.status,"done");
  assert.equal(h.termsReads,reads,"deletion routes never read Terms");
  const after=await h.call("GET","/v2/projects",{token:"idtoken.u-terms"});
  assert.notEqual(after.status,200,"other /v2 routes stay closed");
 }finally{h.close();}
});

test("contract 2: 202 body is exactly {status:'deleting', jobId, statusToken}",async()=>{
 const h=harness({uids:["u-202"]});
 await h.listen();
 try{
  const r=await h.del("u-202");
  assert.equal(r.status,202);
  assert.deepEqual(Object.keys(r.json).sort(),["jobId","status","statusToken"]);
  assert.equal(r.json.status,"deleting");
  assert.match(r.json.jobId,/^[0-9a-f-]{36}$/);
  assert.match(r.json.statusToken,TOKEN_RE);
  const stored=JSON.stringify([...h.db.rows.values()]);
  assert.equal(stored.includes(r.json.statusToken),false,"only the hash is stored");
  await h.pollUntil(r.json.jobId,r.json.statusToken);
 }finally{h.close();}
});

test("contract 3: Bearer statusToken polls running -> done after the Firebase user is deleted",async()=>{
 const h=harness({uids:["u-run"],holdStripe:true});
 await h.listen();
 try{
  const r=await h.del("u-run");
  assert.equal(r.status,202);
  const first=await h.poll(r.json.jobId,r.json.statusToken);
  assert.equal(first.status,200);
  assert.deepEqual(Object.keys(first.json).sort(),["jobId","retryable","status"]);
  assert.ok(["queued","running"].includes(first.json.status));
  h.release();
  const {seen,last}=await h.pollUntil(r.json.jobId,r.json.statusToken);
  assert.ok([first.json.status,...seen].includes("running"));
  assert.deepEqual(last.json,{jobId:r.json.jobId,status:"done",retryable:false});
  assert.equal(h.users.has("u-run"),false,"Firebase user deleted");
  const again=await h.poll(r.json.jobId,r.json.statusToken);
  assert.equal(again.status,200,"statusToken keeps working after user deletion");
  // free_server verifies ID tokens without checkRevoked, so a deleted user's
  // unexpired token may still read its OWN job; it must never 401/403 or wipe.
  const firebase=await h.poll(r.json.jobId,"idtoken.u-run");
  assert.ok(firebase.status===200||firebase.status===404,firebase.text);
  if(firebase.status===200)assert.deepEqual(firebase.json,{jobId:r.json.jobId,status:"done",retryable:false});
 }finally{h.close();}
});

test("contract 4: another job's token, an expired token and garbage tokens all get 404 not_found",async()=>{
 const h=harness({uids:["u-a","u-b"]});
 await h.listen();
 try{
  const a=(await h.del("u-a")).json,b=(await h.del("u-b")).json;
  await h.pollUntil(a.jobId,a.statusToken);await h.pollUntil(b.jobId,b.statusToken);
  const cases=[
   ["other job's token",a.jobId,b.statusToken],
   ["other job's token (reverse)",b.jobId,a.statusToken],
   ["garbage",a.jobId,"garbage"],
   ["43-char random",a.jobId,crypto.randomBytes(32).toString("base64url")],
   ["hash instead of token",a.jobId,crypto.createHash("sha256").update(a.statusToken).digest("hex")],
   ["unknown job",crypto.randomUUID(),a.statusToken],
  ];
  const missing=await h.poll(a.jobId,undefined);
  assert.equal(missing.status,401,"no header");
  assert.deepEqual(missing.json,{error:"unauthorized"});
  for(const [name,jobId,token] of cases){
   const r=await h.poll(jobId,token);
   assert.equal(r.status,404,name);
   assert.deepEqual(r.json,{error:"not_found"},name);
  }
  h.setNow(NOW+STATUS_TOKEN_TTL_MS+1);
  const expired=await h.poll(a.jobId,a.statusToken);
  assert.equal(expired.status,404,"expired");
  assert.deepEqual(expired.json,{error:"not_found"});
  h.setNow(NOW+STATUS_TOKEN_TTL_MS-1);
  assert.equal((await h.poll(a.jobId,a.statusToken)).status,200,"valid until the 7-day mark");
 }finally{h.close();}
});

test("contract 5: repeat DELETE after done -> 410 {error:'account_deleted', jobId, statusToken} with a fresh token",
 
 async()=>{
 const h=harness({uids:["u-410"]});
 await h.listen();
 try{
  const first=(await h.del("u-410")).json;
  await h.pollUntil(first.jobId,first.statusToken);
  assert.equal(h.users.has("u-410"),false);
  const again=await h.del("u-410");
  assert.equal(again.status,410,again.text);
  assert.deepEqual(Object.keys(again.json).sort(),["error","jobId","statusToken"]);
  assert.equal(again.json.error,"account_deleted");
  assert.equal(again.json.jobId,first.jobId);
  assert.match(again.json.statusToken,TOKEN_RE);
  assert.notEqual(again.json.statusToken,first.statusToken);
  const fresh=await h.poll(first.jobId,again.json.statusToken);
  assert.deepEqual(fresh.json,{jobId:first.jobId,status:"done",retryable:false});
 }finally{h.close();}
});

test("contract 6: every deletion error body carries its code in `error` only",async()=>{
 const h=harness({uids:["u-err","u-stale"]});
 h.ages.set("u-stale",REAUTH_SECONDS+60);
 await h.listen();
 try{
  await h.call("DELETE","/v2/account",{body:{confirm:"DELETE"}});
  await h.call("DELETE","/v2/account",{token:"garbage",body:{confirm:"DELETE"}});
  await h.del("u-stale");
  await h.del("u-err",{body:{confirm:"nope"}});
  await h.poll(crypto.randomUUID(),"garbage");
  const r=(await h.del("u-err")).json;
  await h.pollUntil(r.jobId,r.statusToken);
  await h.del("u-err");
  assertErrorShape(h.errors);
  const codes=h.errors.map(e=>e.json.error);
  assert.ok(codes.includes("confirm_required"));
  assert.ok(codes.includes("not_found"));
 }finally{h.close();}
});

test("contract 7: 401 reauth_required vs invalid_token; a repeat DELETE never returns reauth_required",async()=>{
 const h=harness({uids:["u-fresh","u-old"]});
 h.ages.set("u-old",REAUTH_SECONDS+1);
 await h.listen();
 try{
  const stale=await h.del("u-old");
  assert.equal(stale.status,401);assert.deepEqual(stale.json,{error:"reauth_required"});
  for(const [name,token] of [["no token",undefined],["garbage","garbage"],["unknown user","idtoken.nobody"]]){
   const r=await h.call("DELETE","/v2/account",{token,body:{confirm:"DELETE"}});
   assert.equal(r.status,401,name);assert.deepEqual(r.json,{error:"invalid_token"},name);
  }
  const first=(await h.del("u-fresh")).json;
  await h.pollUntil(first.jobId,first.statusToken);
  // Same user retries with a stale auth_time after the job finished.
  h.ages.set("u-fresh",REAUTH_SECONDS+3600);
  const repeat=await h.del("u-fresh");
  assert.notEqual(repeat.json?.error,"reauth_required",repeat.text);
  assert.ok(repeat.status===410||(repeat.status===401&&repeat.json.error==="invalid_token"),repeat.text);
  h.ages.set("u-fresh",30);
  const repeatFresh=await h.del("u-fresh");
  assert.notEqual(repeatFresh.json?.error,"reauth_required");
  assertErrorShape(h.errors);
 }finally{h.close();}
});

// ---- F2 (Avery's ruling): each job keeps a SET of valid statusToken hashes,
// capped at 5, each with its own 7-day expiry; a 6th drops the oldest. Tokens
// from a repeat 202 or 410 never invalidate earlier ones. Only hashes stored.
const tokenHash=t=>crypto.createHash("sha256").update(t).digest("hex");
const DAY=24*60*60*1000;
async function runningJobWithTokens(h,uid,count){
 const first=await h.del(uid);
 assert.equal(first.status,202,first.text);
 const tokens=[first.json.statusToken];
 for(let i=1;i<count;i++){
  const again=await h.del(uid);
  assert.equal(again.status,202,"repeat DELETE while running is 202: "+again.text);
  assert.equal(again.json.jobId,first.json.jobId,"repeat 202 resumes the same job");
  assert.match(again.json.statusToken,TOKEN_RE);
  tokens.push(again.json.statusToken);
 }
 assert.equal(new Set(tokens).size,count,"every issued token is fresh");
 return {jobId:first.json.jobId,tokens};
}
async function pollStatuses(h,jobId,tokens,base){
 return Promise.all(tokens.map(async t=>(await h.poll(jobId,t,base)).status));
}

test("contract 8 (F2): only hashes are stored, never a raw statusToken, across repeat 202s",async()=>{
 const h=harness({uids:["u-hash"],holdStripe:true});
 await h.listen();
 try{
  const {jobId,tokens}=await runningJobWithTokens(h,"u-hash",6);
  const stored=JSON.stringify([...h.db.rows.entries()]);
  for(const [i,t] of tokens.entries())assert.equal(stored.includes(t),false,`raw token #${i+1} stored`);
  h.release();
  await h.pollUntil(jobId,tokens.at(-1));
  const after=JSON.stringify([...h.db.rows.entries()]);
  for(const [i,t] of tokens.entries())assert.equal(after.includes(t),false,`raw token #${i+1} stored after done`);
  assert.ok(after.includes(tokenHash(tokens.at(-1))),"the newest token's sha256 is stored");
  for(const v of [...h.db.rows.values()])for(const [k,x] of Object.entries(v||{}))
   if(/statusToken/i.test(k)&&typeof x==="string")assert.match(x,/^[0-9a-f]{64}$/,`${k} holds only a sha256 hex`);
 }finally{h.close();}
});

test("contract 9 (F2): a repeat 202 while running does not invalidate earlier tokens",
 async()=>{
 const h=harness({uids:["u-keep"],holdStripe:true});
 await h.listen();
 try{
  const {jobId,tokens}=await runningJobWithTokens(h,"u-keep",3);
  assert.deepEqual(await pollStatuses(h,jobId,tokens),[200,200,200],"F2: all 3 tokens poll 200 while running");
  h.release();
  for(const t of tokens){
   const {last}=await h.pollUntil(jobId,t);
   assert.equal(last.status,200,"F2: token still valid at done");
   assert.deepEqual(last.json,{jobId,status:"done",retryable:false});
  }
 }finally{h.close();}
});

test("contract 10 (F2): cap of 5 - the 6th token drops only the oldest (oldest 404, other 5 stay 200)",
 async()=>{
 const h=harness({uids:["u-cap"],holdStripe:true});
 await h.listen();
 try{
  const {jobId,tokens}=await runningJobWithTokens(h,"u-cap",6);
  assert.deepEqual(await pollStatuses(h,jobId,tokens),[404,200,200,200,200,200],"F2: oldest evicted, newest 5 valid");
  const stored=JSON.stringify([...h.db.rows.entries()]);
  for(const t of tokens.slice(1))assert.ok(stored.includes(tokenHash(t)),"F2: every valid token's hash is stored");
  assert.equal(stored.includes(tokenHash(tokens[0])),false,"F2: evicted hash is dropped");
  const oldest=await h.poll(jobId,tokens[0]);
  assert.deepEqual(oldest.json,{error:"not_found"});
  // a 7th drops the next oldest
  const seventh=(await h.del("u-cap")).json.statusToken;
  assert.deepEqual(await pollStatuses(h,jobId,[...tokens,seventh]),[404,404,200,200,200,200,200],"F2: 7th evicts token #2");
  h.release();
  const {last}=await h.pollUntil(jobId,seventh);
  assert.equal(last.json.status,"done");
  assert.deepEqual(await pollStatuses(h,jobId,[...tokens,seventh]),[404,404,200,200,200,200,200],"F2: same set after done");
 }finally{h.close();}
});

test("contract 11 (F2): each token has its own 7-day expiry; a newer token outlives an older one",
 async()=>{
 const h=harness({uids:["u-ttl"],holdStripe:true});
 await h.listen();
 try{
  const first=(await h.del("u-ttl")).json;
  h.setNow(NOW+3*DAY);
  const second=await h.del("u-ttl");
  assert.equal(second.status,202,second.text);
  const t1=first.statusToken,t2=second.json.statusToken,jobId=first.jobId;
  assert.deepEqual(await pollStatuses(h,jobId,[t1,t2]),[200,200],"F2: both valid at day 3");
  h.setNow(NOW+STATUS_TOKEN_TTL_MS-1);
  assert.deepEqual(await pollStatuses(h,jobId,[t1,t2]),[200,200],"F2: t1 valid until its own 7-day mark");
  h.setNow(NOW+STATUS_TOKEN_TTL_MS+1);
  assert.deepEqual(await pollStatuses(h,jobId,[t1,t2]),[404,200],"F2: t1 expired at its 7 days, t2 still valid");
  h.setNow(NOW+3*DAY+STATUS_TOKEN_TTL_MS-1);
  assert.deepEqual(await pollStatuses(h,jobId,[t1,t2]),[404,200],"F2: t2 valid until its own 7-day mark");
  h.setNow(NOW+3*DAY+STATUS_TOKEN_TTL_MS+1);
  assert.deepEqual(await pollStatuses(h,jobId,[t1,t2]),[404,404],"F2: t2 expired at its 7 days");
  h.release();
 }finally{h.close();}
});

test("contract 12 (F2): two devices polling with different tokens both reach done",
 async()=>{
 const h=harness({uids:["u-two"],holdStripe:true});
 await h.listen();
 try{
  const phone=(await h.del("u-two")).json;
  const laptop=(await h.del("u-two")).json;
  assert.equal(laptop.jobId,phone.jobId);
  setTimeout(()=>h.release(),20);
  const [a,b]=await Promise.all([h.pollUntil(phone.jobId,phone.statusToken),h.pollUntil(laptop.jobId,laptop.statusToken)]);
  assert.equal(a.last.status,200,"F2: first device's token was invalidated by the second device's DELETE: "+a.last.text);
  assert.deepEqual(a.last.json,{jobId:phone.jobId,status:"done",retryable:false});
  assert.deepEqual(b.last.json,{jobId:phone.jobId,status:"done",retryable:false});
  assert.equal(h.users.has("u-two"),false);
 }finally{h.close();}
});

test("contract 13 (F1+F2): after done with a REALLY deleted user, 410 tokens do not invalidate the 202 token or each other",
 
 async()=>{
 const h=harness({uids:["u-410set"]});
 await h.listen();
 try{
  const first=(await h.del("u-410set")).json;
  await h.pollUntil(first.jobId,first.statusToken);
  assert.equal(h.users.has("u-410set"),false,"Firebase user really deleted");
  const r1=await h.del("u-410set");
  assert.equal(r1.status,410,"F1: repeat DELETE after done must be 410: "+r1.text);
  const r2=await h.del("u-410set");
  assert.equal(r2.status,410,"F1: second repeat DELETE must be 410: "+r2.text);
  const tokens=[first.statusToken,r1.json.statusToken,r2.json.statusToken];
  assert.equal(new Set(tokens).size,3);
  assert.deepEqual(await pollStatuses(h,first.jobId,tokens),[200,200,200],"F2: 202 token and both 410 tokens all valid");
  const stored=JSON.stringify([...h.db.rows.entries()]);
  for(const t of tokens)assert.equal(stored.includes(t),false,"raw token stored");
 }finally{h.close();}
});

// ---- F3: with more than one server instance, the instance running the job
// must not overwrite a token another instance issued meanwhile.
test("contract 14 (F3): a token issued by another instance while the job runs survives the runner's later saves",
 
 async()=>{
 const h=harness({uids:["u-multi"],holdStripe:true});
 await h.listen();
 try{
  const a=(await h.del("u-multi")).json; // instance A runs the job, held in Stripe
  assert.ok(["queued","running"].includes((await h.poll(a.jobId,a.statusToken)).json.status));
  // Instance B: separate process, same Firestore. Its own Stripe call never
  // returns, so only A advances the job.
  const b=await h.instance({subscriptions:{list:async q=>({has_more:false,data:[{id:"sub_"+q.customer,status:"active",customer:q.customer}]}),cancel:()=>new Promise(()=>{})}});
  const fromB=await h.del("u-multi",{base:b});
  assert.equal(fromB.status,202,fromB.text);
  assert.equal(fromB.json.jobId,a.jobId,"B resumes the same job");
  const bToken=fromB.json.statusToken;
  h.release(); // A finishes: stripe, objects, metadata, firebase, done
  const {last}=await h.pollUntil(a.jobId,a.statusToken);
  assert.deepEqual(last.json,{jobId:a.jobId,status:"done",retryable:false});
  // Instance C has no memory: it answers from Firestore only.
  const c=await h.instance();
  const viaC=await h.poll(a.jobId,bToken,c);
  assert.equal(viaC.status,200,"F3: B's token lost from Firestore after A's saves: "+viaC.text);
  assert.deepEqual(viaC.json,{jobId:a.jobId,status:"done",retryable:false});
  assert.equal((await h.poll(a.jobId,a.statusToken,c)).status,200,"A's token also valid from Firestore");
  assert.equal((await h.poll(a.jobId,bToken)).status,200,"F3: B's token valid on A");
 }finally{h.close();}
});

test("contract 15 (F3/F4): a repeat-202 token is persisted before the 202 is returned",
 
 async()=>{
 const h=harness({uids:["u-persist"],holdStripe:true});
 await h.listen();
 try{
  const first=(await h.del("u-persist")).json;
  const again=await h.del("u-persist");
  assert.equal(again.status,202,again.text);
  const stored=JSON.stringify([...h.db.rows.entries()]);
  assert.ok(stored.includes(tokenHash(again.json.statusToken)),"F4: repeat-202 token hash not in Firestore while the job runs");
  const c=await h.instance();
  const viaC=await h.poll(first.jobId,again.json.statusToken,c);
  assert.equal(viaC.status,200,"F4: another instance 404s the repeat-202 token: "+viaC.text);
  assert.equal(viaC.json.status,"running");
  h.release();
  await h.pollUntil(first.jobId,again.json.statusToken);
 }finally{h.close();}
});

// ---- Job lease (Riley, PR #6): the job-doc transaction grants a 60 s lease;
// only the holder runs the job, renews it every batch and stops if it loses it;
// after expiry another instance resumes from the last completed batch.
const LEASE_MS=60_000;
// Per-instance Stripe and bucket stubs that log every side effect into one
// shared array, so cross-instance duplicates are countable.
function sideEffects(log,name,{hangCancel=false,hangPrefix=null}={}){
 let release=()=>{};
 const gate=new Promise(r=>{release=r;});
 const stripe={subscriptions:{
  list:async q=>({has_more:false,data:[{id:"sub_lease",status:"active",customer:q.customer}]}),
  cancel:async id=>{log.push({by:name,kind:"cancel",id});if(hangCancel)await gate;return {};},
 }};
 const bucket={deleteFiles:async({prefix})=>{
  log.push({by:name,kind:"bucket",prefix});
  if(hangPrefix&&prefix.startsWith(hangPrefix))await gate;
 }};
 return {stripe,bucket,release};
}
const count=(log,pred)=>log.filter(pred).length;
const settle=(ms=60)=>new Promise(r=>setTimeout(r,ms));
async function pollAt(h,jobId,token,base,want="done"){
 const deadline=Date.now()+5000;let last;
 do{last=await h.poll(jobId,token,base);if(last.status!==200||last.json.status===want)return last;await settle(5);}
 while(Date.now()<deadline);
 return last;
}
function seedCustomer(h,uid){h.db.rows.set("gd_accounts/"+hash(uid),{uid,stripeCustomerId:"cus_lease"});}

test("contract 16 (lease): two instances racing on one job - only one runs it; each Stripe cancel and bucket batch happens once",
 async()=>{
 const log=[];
 const A=sideEffects(log,"A",{hangCancel:true}),B=sideEffects(log,"B");
 const h=harness({uids:["u-race"],stripe:A.stripe,bucket:A.bucket});
 seedCustomer(h,"u-race");
 await h.listen();
 try{
  const first=await h.del("u-race");                 // A takes the lease, held inside Stripe cancel
  assert.equal(first.status,202,first.text);
  const b=await h.instance(B.stripe,B.bucket);
  const fromB=await h.del("u-race",{base:b});         // B races for the same job while A holds the lease
  assert.equal(fromB.status,202,fromB.text);
  assert.equal(fromB.json.jobId,first.json.jobId);
  await settle();
  assert.equal(count(log,e=>e.by==="B"),0,"lease: B ran side effects while A holds the lease: "+JSON.stringify(log));
  A.release();
  const c=await h.instance(B.stripe,B.bucket);
  const last=await pollAt(h,first.json.jobId,first.json.statusToken,c);
  assert.deepEqual(last.json,{jobId:first.json.jobId,status:"done",retryable:false});
  await settle();
  assert.equal(count(log,e=>e.kind==="cancel"&&e.id==="sub_lease"),1,"lease: Stripe cancel ran more than once: "+JSON.stringify(log));
  for(const prefix of ["customer/"+hash("u-race")+"/","tenants/"+hash("u-race")+"/"])
   assert.equal(count(log,e=>e.kind==="bucket"&&e.prefix===prefix),1,"lease: bucket batch "+prefix.split("/")[0]+" ran more than once: "+JSON.stringify(log));
  assert.equal(h.users.has("u-race"),false);
 }finally{h.close();}
});

test("contract 17 (lease): holder dies mid-job - after 60 s another instance takes over, never repeats a completed batch, reaches done",
 async()=>{
 const log=[];
 // A completes the Stripe batch, then stalls forever in the first bucket batch
 // (simulated death: never advances, never releases the lease).
 const A=sideEffects(log,"A",{hangPrefix:"customer/"}),B=sideEffects(log,"B");
 const h=harness({uids:["u-dead"],stripe:A.stripe,bucket:A.bucket});
 seedCustomer(h,"u-dead");
 await h.listen();
 try{
  const first=(await h.del("u-dead")).json;
  await settle();
  assert.equal(count(log,e=>e.by==="A"&&e.kind==="cancel"),1);
  assert.equal(count(log,e=>e.by==="A"&&e.kind==="bucket"),1,"A is stalled in the first bucket batch");
  const b=await h.instance(B.stripe,B.bucket);
  h.setNow(NOW+LEASE_MS-1);
  const early=await h.del("u-dead",{base:b});
  assert.equal(early.status,202,early.text);
  await settle();
  assert.equal(count(log,e=>e.by==="B"),0,"lease: B ran before A's 60 s lease expired: "+JSON.stringify(log));
  h.setNow(NOW+LEASE_MS+1);
  const takeover=await h.del("u-dead",{base:b});
  assert.equal(takeover.status,202,takeover.text);
  assert.equal(takeover.json.jobId,first.jobId);
  const c=await h.instance(B.stripe,B.bucket);
  const last=await pollAt(h,first.jobId,takeover.json.statusToken,c);
  assert.deepEqual(last.json,{jobId:first.jobId,status:"done",retryable:false},"lease: job did not reach done after takeover");
  assert.equal(count(log,e=>e.kind==="cancel"),1,"lease: completed Stripe batch repeated after takeover: "+JSON.stringify(log));
  assert.equal(count(log,e=>e.by==="B"&&e.kind==="bucket"&&e.prefix.startsWith("tenants/")),1,"B finishes the remaining bucket batch once");
  assert.equal(count(log,e=>e.kind==="bucket"&&e.prefix.startsWith("tenants/")),1,"tenants batch exactly once");
  assert.equal(h.users.has("u-dead"),false,"Firebase user deleted by the new holder");
 }finally{h.close();}
});

test("contract 18 (lease): an instance that lost its lease makes no further writes or side effects after its current step",
 async()=>{
 const log=[];
 const A=sideEffects(log,"A",{hangCancel:true}),B=sideEffects(log,"B");
 const h=harness({uids:["u-lost"],stripe:A.stripe,bucket:A.bucket});
 seedCustomer(h,"u-lost");
 await h.listen();
 try{
  const first=(await h.del("u-lost")).json;          // A holds the lease, stuck in Stripe cancel
  await settle();
  const b=await h.instance(B.stripe,B.bucket);
  h.setNow(NOW+LEASE_MS+1);                           // A's lease expires without renewal
  const takeover=await h.del("u-lost",{base:b});
  assert.equal(takeover.status,202,takeover.text);
  const c=await h.instance(B.stripe,B.bucket);
  // poll with the newest token so F2 (single hash) cannot mask the lease check
  const last=await pollAt(h,first.jobId,takeover.json.statusToken,c);
  assert.deepEqual(last.json,{jobId:first.jobId,status:"done",retryable:false},"B took over and finished: "+last.text);
  await settle();
  const before=JSON.stringify([...h.db.rows.entries()].sort());
  const aBefore=count(log,e=>e.by==="A");
  A.release();                                        // A's current step returns after it lost the lease
  await settle(150);
  assert.equal(count(log,e=>e.by==="A"),aBefore,"lease: A kept running side effects after losing its lease: "+JSON.stringify(log.filter(e=>e.by==="A")));
  assert.equal(JSON.stringify([...h.db.rows.entries()].sort()),before,"lease: A wrote to Firestore after losing its lease");
  assert.deepEqual((await pollAt(h,first.jobId,takeover.json.statusToken,c)).json,{jobId:first.jobId,status:"done",retryable:false});
 }finally{h.close();}
});

test("poll reclaims an expired lease and finishes from the last checkpoint without repeating a completed batch",async()=>{
 const log=[];
 const A=sideEffects(log,"A",{hangPrefix:"customer/"}),B=sideEffects(log,"B");
 const h=harness({uids:["u-poll"],stripe:A.stripe,bucket:A.bucket});
 seedCustomer(h,"u-poll");
 await h.listen();
 try{
  const first=(await h.del("u-poll")).json;
  await settle();
  assert.equal(count(log,e=>e.kind==="cancel"),1,"stripe batch committed before the stall");
  assert.equal(count(log,e=>e.by==="A"&&e.kind==="bucket"),1,"A is stalled in the customer prefix batch");
  const b=await h.instance(B.stripe,B.bucket);
  h.setNow(NOW+LEASE_MS-1);
  const early=await h.poll(first.jobId,first.statusToken,b);
  assert.equal(early.status,200,early.text);
  await settle();
  assert.equal(count(log,e=>e.by==="B"),0,"poll did not take a lease that was still held: "+JSON.stringify(log));
  h.setNow(NOW+LEASE_MS+1);
  const last=await pollAt(h,first.jobId,first.statusToken,b);
  assert.deepEqual(last.json,{jobId:first.jobId,status:"done",retryable:false},"status poll did not restart the stalled job: "+last.text);
  assert.equal(count(log,e=>e.kind==="cancel"),1,"completed Stripe batch was repeated after the poll takeover: "+JSON.stringify(log));
  assert.equal(count(log,e=>e.kind==="bucket"&&e.prefix.startsWith("tenants/")),1,"tenants batch exactly once");
  assert.equal(h.users.has("u-poll"),false);
 }finally{h.close();}
});

test("retry after failed: same job, queued 202, token set grows, finished steps are not repeated",async()=>{
 const log=[];
 let failCustomer=true;
 const stripe={subscriptions:{
  list:async q=>({has_more:false,data:[{id:"sub_retry",status:"active",customer:q.customer}]}),
  cancel:async id=>{log.push({kind:"cancel",id});return {};},
 }};
 const bucket={deleteFiles:async({prefix})=>{
  log.push({kind:"bucket",prefix});
  if(failCustomer&&prefix.startsWith("customer/"))throw Object.assign(Error("bucket down"),{code:"bucket_down"});
 }};
 const h=harness({uids:["u-retry"],stripe,bucket});
 seedCustomer(h,"u-retry");
 await h.listen();
 try{
  const first=(await h.del("u-retry")).json;
  const failed=await h.pollUntil(first.jobId,first.statusToken,"failed");
  assert.equal(failed.last.json.status,"failed");
  assert.equal(failed.last.json.retryable,true);
  assert.equal(count(log,e=>e.kind==="cancel"),1);
  const again=await h.del("u-retry");
  assert.equal(again.status,202,again.text);
  assert.deepEqual(Object.keys(again.json).sort(),["jobId","status","statusToken"]);
  assert.equal(again.json.status,"queued");
  assert.equal(again.json.jobId,first.jobId);
  assert.notEqual(again.json.statusToken,first.statusToken);
  await settle(80);
  const stored=h.db.rows.get("deletion_jobs/"+first.jobId);
  assert.equal(stored.steps.stripe,true,"stripe completion marker stays on the job");
  assert.equal(stored.statusTokens.length,2);
  assert.ok(stored.statusTokens.some(item=>item.hash===tokenHash(again.json.statusToken)));
  assert.equal(count(log,e=>e.kind==="cancel"),1,"completed Stripe cancel was not repeated");
  assert.ok(count(log,e=>e.kind==="bucket"&&e.prefix.startsWith("customer/"))>=2,"the failed prefix is tried again");
  failCustomer=false;
  const third=await h.del("u-retry");
  assert.equal(third.json.jobId,first.jobId);
  const done=await h.pollUntil(first.jobId,third.json.statusToken);
  assert.equal(done.last.json.status,"done");
  assert.equal(count(log,e=>e.kind==="cancel"),1);
 }finally{h.close();}
});

function stripeCancel(cancel){
 return {subscriptions:{
  list:async q=>({has_more:false,data:[{id:"sub_try",status:"active",customer:q.customer}]}),
  cancel,
 }};
}
function assertStatusBody(body){
 assert.deepEqual(Object.keys(body).sort(),["jobId","retryable","status"]);
 assert.equal("failureReason" in body,false);
 assert.equal("attempts" in body,false);
}

test("transient deletion errors stay retryable and record a failureReason",async()=>{
 const cases=[
  [{statusCode:503,type:"api_error"},"upstream_unavailable"],
  [{code:"ECONNRESET"},"network"],
  [{code:"ETIMEDOUT"},"timeout"],
  [{type:"rate_limit_error",statusCode:429},"rate_limited"],
 ];
 for(const [fields,reason] of cases){
  const uid="u-transient-"+reason;
  const h=harness({uids:[uid],stripe:stripeCancel(async()=>{throw Object.assign(Error(reason),fields);}),bucket:{deleteFiles:async()=>{}}});
  seedCustomer(h,uid);
  await h.listen();
  try{
   const first=(await h.del(uid)).json;
   const failed=await h.pollUntil(first.jobId,first.statusToken,"failed");
   assert.equal(failed.last.json.status,"failed");
   assert.equal(failed.last.json.retryable,true,reason);
   assertStatusBody(failed.last.json);
   const stored=h.db.rows.get("deletion_jobs/"+first.jobId);
   assert.equal(stored.failureReason,reason);
   assert.equal(stored.attempts,1);
   const again=await h.del(uid);
   assert.equal(again.status,202,again.text);
   assert.equal(again.json.status,"queued");
   assert.equal(again.json.jobId,first.jobId);
  }finally{h.close();}
 }
});

test("the fifth transient failure is not retryable and the next DELETE is 409",async()=>{
 const h=harness({uids:["u-cap"],stripe:stripeCancel(async()=>{throw Object.assign(Error("reset"),{code:"ECONNRESET"});}),bucket:{deleteFiles:async()=>{}}});
 seedCustomer(h,"u-cap");
 await h.listen();
 try{
  const first=(await h.del("u-cap")).json;
  let token=first.statusToken;
  for(let attempt=1;attempt<=5;attempt++){
   const failed=await h.pollUntil(first.jobId,token,"failed");
   assert.equal(failed.last.json.status,"failed");
   assertStatusBody(failed.last.json);
   const stored=h.db.rows.get("deletion_jobs/"+first.jobId);
   assert.equal(stored.attempts,attempt);
   assert.equal(stored.failureReason,"network");
   assert.equal(stored.retryable,attempt<5,String(attempt));
   assert.equal(failed.last.json.retryable,attempt<5);
   if(attempt===5)break;
   const next=await h.del("u-cap");
   assert.equal(next.status,202,next.text);
   assert.equal(next.json.status,"queued");
   assert.equal(next.json.jobId,first.jobId);
   token=next.json.statusToken;
  }
  const before=h.db.rows.get("deletion_jobs/"+first.jobId).statusTokens.map(item=>item.hash);
  assert.equal(before.length,5);
  const denied=await h.del("u-cap");
  assert.equal(denied.status,409,denied.text);
  assert.deepEqual(denied.json,{error:"deletion_not_retryable",jobId:first.jobId});
  const stored=h.db.rows.get("deletion_jobs/"+first.jobId);
  assert.deepEqual(stored.statusTokens.map(item=>item.hash),before);
  assert.equal(stored.attempts,5);
  assert.equal(stored.retryable,false);
 }finally{h.close();}
});

test("permanent deletion errors flip retryable immediately and the next DELETE is 409",async()=>{
 const cases=[
  ["gcs-403","gcs_permission_denied",{bucket:async({prefix})=>{if(prefix.startsWith("customer/"))throw Object.assign(Error("denied"),{code:403});}}],
  ["gcs-permission","gcs_permission_denied",{bucket:async()=>{throw Object.assign(Error("denied"),{code:"permission-denied"});}}],
  ["stripe-auth","stripe_authentication_error",{cancel:async()=>{throw Object.assign(Error("auth"),{type:"authentication_error",statusCode:401});}}],
  ["stripe-permission","stripe_permission_error",{cancel:async()=>{throw Object.assign(Error("perm"),{type:"permission_error",statusCode:403});}}],
  ["stripe-invalid","stripe_invalid_request",{cancel:async()=>{throw Object.assign(Error("bad"),{type:"invalid_request_error",code:"parameter_unknown",statusCode:400});}}],
 ];
 for(const [name,reason,fault] of cases){
  const uid="u-perm-"+name;
  const stripe=stripeCancel(fault.cancel||(async()=>({})));
  const bucket={deleteFiles:fault.bucket||(async()=>{})};
  const h=harness({uids:[uid],stripe,bucket});
  seedCustomer(h,uid);
  await h.listen();
  try{
   const first=(await h.del(uid)).json;
   const failed=await h.pollUntil(first.jobId,first.statusToken,"failed");
   assert.equal(failed.last.json.status,"failed",name);
   assert.equal(failed.last.json.retryable,false,name);
   assertStatusBody(failed.last.json);
   const stored=h.db.rows.get("deletion_jobs/"+first.jobId);
   assert.equal(stored.failureReason,reason,name);
   assert.equal(stored.attempts,1,name);
   assert.equal(stored.retryable,false,name);
   const hashes=stored.statusTokens.map(item=>item.hash);
   const denied=await h.del(uid);
   assert.equal(denied.status,409,denied.text);
   assert.deepEqual(denied.json,{error:"deletion_not_retryable",jobId:first.jobId});
   assert.equal("statusToken" in denied.json,false);
   const after=h.db.rows.get("deletion_jobs/"+first.jobId);
   assert.deepEqual(after.statusTokens.map(item=>item.hash),hashes,name);
   assert.equal(after.status,"failed");
  }finally{h.close();}
 }
});

test("a Stripe resource_missing cancel is success and does not count as a failed attempt",async()=>{
 const h=harness({uids:["u-missing"],stripe:stripeCancel(async()=>{throw Object.assign(Error("gone"),{type:"invalid_request_error",code:"resource_missing",statusCode:404});}),bucket:{deleteFiles:async()=>{}}});
 seedCustomer(h,"u-missing");
 await h.listen();
 try{
  const first=(await h.del("u-missing")).json;
  const done=await h.pollUntil(first.jobId,first.statusToken,"done");
  assert.equal(done.last.json.status,"done");
  assert.equal(done.last.json.retryable,false);
  const stored=h.db.rows.get("deletion_jobs/"+first.jobId);
  assert.equal(stored.attempts||0,0);
  assert.equal(stored.failureReason,null);
 }finally{h.close();}
});

test("two concurrent retries of a failed job keep one job and one runner",async()=>{
 const log=[];
 let mode="fail";
 let release=()=>{};
 const gate=new Promise(resolve=>{release=resolve;});
 const stripeFor=name=>({subscriptions:{
  list:async q=>({has_more:false,data:[{id:"sub_both",status:"active",customer:q.customer}]}),
  cancel:async()=>{
   log.push({by:name,kind:"cancel"});
   if(mode==="fail")throw Object.assign(Error("down"),{code:"stripe_cancel_failed"});
   if(mode==="hang")await gate;
  },
 },});
 const bucket={deleteFiles:async({prefix})=>{log.push({kind:"bucket",prefix});}};
 const h=harness({uids:["u-both"],stripe:stripeFor("A"),bucket});
 seedCustomer(h,"u-both");
 await h.listen();
 try{
  const first=(await h.del("u-both")).json;
  assert.equal((await h.pollUntil(first.jobId,first.statusToken,"failed")).last.json.status,"failed");
  assert.equal(count(log,e=>e.kind==="cancel"),1);
  h.setNow(NOW+LEASE_MS+1);
  mode="hang";
  const other=await h.instance(stripeFor("B"),bucket);
  const [left,right]=await Promise.all([h.del("u-both"),h.del("u-both",{base:other})]);
  assert.equal(left.status,202,left.text);
  assert.equal(right.status,202,right.text);
  assert.equal(left.json.jobId,first.jobId);
  assert.equal(right.json.jobId,first.jobId);
  const statuses=[left.json.status,right.json.status];
  assert.ok(statuses.includes("queued"),"the retry that observed failed returns queued: "+statuses.join(","));
  assert.ok(statuses.every(status=>status==="queued"||status==="deleting"),statuses.join(","));
  assert.notEqual(left.json.statusToken,right.json.statusToken);
  await settle(80);
  assert.equal(count(log,e=>e.kind==="cancel"),2,"one retry runner, not two");
  const jobs=[...h.db.rows.keys()].filter(key=>key.startsWith("deletion_jobs/"));
  assert.deepEqual(jobs,["deletion_jobs/"+first.jobId]);
  mode="ok";
  release();
  const token=left.json.statusToken;
  const done=await h.pollUntil(first.jobId,token);
  assert.equal(done.last.json.status,"done",done.last.text);
  assert.equal(count(log,e=>e.kind==="cancel"),2);
 }finally{h.close();}
});

// ---------------------------------------------------------------------------
// Deletion support request (PR #6 56b7f6b, head d33970c). Final spec: Avery,
// Riley, Casey. POST /v2/account/deletions/:jobId/support-request, no body,
// Bearer statusToken only, works signed out; the server reads uid from the job.
// Casey's branch test/pr6-support-request (cc4ee9c) covers emulator concurrency,
// the deep redaction sweep, 30-day cleanup and stale/notify retry timing; these
// contracts cover one response per fixture and status code, signed-out auth,
// the old route, one stub-webhook payload, the prod start gate and a repo guard.
const fs=require("node:fs"),path=require("node:path"),http=require("node:http"),os=require("node:os");
const {spawnSync}=require("node:child_process");
const REPO=path.resolve(__dirname,"../..");
const SUPPORT_FIXTURES=["support-received","support-repeat","support-not-needed","support-bad-token","support-rate-limited"];
const fixture=name=>JSON.parse(fs.readFileSync(path.join(REPO,"fixtures/account-deletion",name+".json"),"utf8"));
// Built from parts so this file never contains a webhook-shaped literal (contract 27).
const FAKE_HOOK_ID="1".repeat(18),FAKE_HOOK_SECRET="ContractHookSecret_"+"x".repeat(12);
const FAKE_WEBHOOK=["https:","","discord.com","api","webhooks",FAKE_HOOK_ID,FAKE_HOOK_SECRET].join("/");
const supportPath=jobId=>"/v2/account/deletions/"+jobId+"/support-request";
function stripeAuthFailure(){
 return {subscriptions:{
  list:async q=>({has_more:false,data:[{id:"sub_"+q.customer,status:"active",customer:q.customer}]}),
  cancel:async()=>{throw Object.assign(Error("stripe auth"),{type:"authentication_error",statusCode:401});},
 }};
}
// A failed (retryable:false) job through the production wiring.
async function failedJob(opts={}){
 const uid=opts.uid||"u-support";
 const h=harness({uids:[uid],stripe:stripeAuthFailure(),v2Errors:true,...opts.harness});
 h.db.rows.set("gd_accounts/"+hash(uid),{uid,stripeCustomerId:"cus_support",...(opts.account||{})});
 for(const [id,data] of Object.entries(opts.workspaces||{}))h.db.rows.set("gd_accounts/"+hash(uid)+"/workspaces/"+id,data);
 await h.listen();
 const created=await h.del(uid);
 assert.equal(created.status,202,created.text);
 const {last}=await h.pollUntil(created.json.jobId,created.json.statusToken,"failed");
 assert.equal(last.json.status,"failed",last.text);
 assert.equal(last.json.retryable,false);
 return {h,uid,jobId:created.json.jobId,statusToken:created.json.statusToken};
}
async function support(h,jobId,token,body){
 const result=await h.call("POST",supportPath(jobId),body===undefined?{token}:{token,body});
 await whenSupportSettled();
 return result;
}
function captureLogs(){
 const lines=[];const saved={};
 for(const k of ["log","warn","error","info"]){saved[k]=console[k];console[k]=(...a)=>lines.push(a.map(String).join(" "));}
 return {lines,restore(){Object.assign(console,saved);}};
}
// Local HTTP stub standing in for Discord. The notifier only accepts an https
// discord.com webhook (account_delete.js:231-241), so fetch to FAKE_WEBHOOK is
// forwarded to the stub; every other fetch (the harness's own calls) passes through.
async function stubWebhook(reply=204){
 const posts=[];
 const server=http.createServer((req,res)=>{
  const chunks=[];
  req.on("data",c=>chunks.push(c));
  req.on("end",()=>{posts.push({method:req.method,url:req.url,headers:req.headers,body:Buffer.concat(chunks).toString("utf8")});
   res.statusCode=reply;res.end();});
 });
 await new Promise(r=>server.listen(0,"127.0.0.1",r));
 const base="http://127.0.0.1:"+server.address().port;
 const realFetch=globalThis.fetch;
 const hadEnv=Object.hasOwn(process.env,"SUPPORT_DISCORD_WEBHOOK_URL"),oldEnv=process.env.SUPPORT_DISCORD_WEBHOOK_URL;
 process.env.SUPPORT_DISCORD_WEBHOOK_URL=FAKE_WEBHOOK;
 globalThis.fetch=(url,init)=>{
  const target=String(url);
  if(target.startsWith(FAKE_WEBHOOK))return realFetch(base+"/hook",{...init,signal:undefined});
  return realFetch(url,init);
 };
 return {posts,close(){globalThis.fetch=realFetch;
  if(hadEnv)process.env.SUPPORT_DISCORD_WEBHOOK_URL=oldEnv;else delete process.env.SUPPORT_DISCORD_WEBHOOK_URL;
  server.close();}};
}
function parseMultipart(body,contentType){
 const boundary=/boundary=([^;\s]+)/.exec(contentType||"")?.[1];
 assert.ok(boundary,"multipart boundary");
 const out={};
 for(const part of String(body).split("--"+boundary).slice(1,-1)){
  const name=/name="([^"]+)"/.exec(part)?.[1];
  const filename=/filename="([^"]+)"/.exec(part)?.[1]||null;
  out[name]={filename,value:part.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/,"")};
 }
 return out;
}

test("contract 19: the 5 support fixtures match the spec and regenerate byte-for-byte from d33970c's exporter",()=>{
 const want={
  "support-received":[202,["requestId","status"]],
  "support-repeat":[202,["requestId","status"]],
  "support-not-needed":[409,["error"]],
  "support-bad-token":[404,["error"]],
  "support-rate-limited":[429,["error","retryAfterSec"]],
 };
 for(const name of SUPPORT_FIXTURES){
  const f=fixture(name);
  assert.equal(f.request.method,"POST",name);
  assert.match(f.request.path,/^\/v2\/account\/deletions\/[0-9a-f-]{36}\/support-request$/,name);
  assert.equal(f.request.body,null,name+": the client sends no body");
  assert.deepEqual(Object.keys(f.request.headers),["authorization"],name+": only the Bearer statusToken is sent");
  assert.equal(f.request.headers.authorization,"<redacted>",name);
  assert.equal(f.response.status,want[name][0],name);
  assert.deepEqual(Object.keys(f.response.body).sort(),want[name][1],name);
 }
 const received=fixture("support-received").response.body,repeat=fixture("support-repeat").response.body;
 assert.equal(received.status,"received");
 assert.ok(typeof received.requestId==="string"&&received.requestId.length>0);
 assert.deepEqual(repeat,received,"a repeat returns the same requestId");
 assert.equal(fixture("support-not-needed").response.body.error,"support_not_needed");
 assert.equal(fixture("support-bad-token").response.body.error,"not_found");
 const limited=fixture("support-rate-limited").response.body;
 assert.equal(limited.error,"rate_limited");
 assert.ok(Number.isInteger(limited.retryAfterSec)&&limited.retryAfterSec>0);
 const out=fs.mkdtempSync(path.join(os.tmpdir(),"gd-support-fx-"));
 try{
  const run=spawnSync(process.execPath,[path.join(__dirname,"scripts/export_account_deletion_fixtures.js"),out],{encoding:"utf8"});
  assert.equal(run.status,0,run.stderr);
  for(const name of SUPPORT_FIXTURES){
   const fresh=fs.readFileSync(path.join(out,"account-deletion",name+".json"));
   const committed=fs.readFileSync(path.join(REPO,"fixtures/account-deletion",name+".json"));
   assert.ok(fresh.equals(committed),name+".json does not regenerate byte-for-byte");
  }
 }finally{fs.rmSync(out,{recursive:true,force:true});}
});

test("contract 19b: support-unauthorized.json - no Authorization header at all, 401 {error:'unauthorized'}, nothing token-shaped, regenerates byte-for-byte",()=>{
 const name="support-unauthorized";
 const file=path.join(REPO,"fixtures/account-deletion",name+".json");
 const raw=fs.readFileSync(file,"utf8");
 const f=JSON.parse(raw);
 assert.equal(f.request.method,"POST");
 assert.match(f.request.path,/^\/v2\/account\/deletions\/[0-9a-f-]{36}\/support-request$/);
 assert.equal(f.request.body,null,"the client sends no body");
 assert.deepEqual(Object.keys(f.request.headers),[],"no authorization header, not even <redacted>");
 assert.equal(f.response.status,401);
 assert.deepEqual(f.response.body,{error:"unauthorized"});
 assert.equal(/[A-Za-z0-9_-]{43}/.test(raw),false,"no statusToken-shaped string anywhere in the fixture");
 assert.equal(/idtoken/i.test(raw),false,"no Firebase ID token");
 assert.equal(/bearer/i.test(raw),false,"no Bearer credential");
 assert.equal(/authorization/i.test(raw),false,"no authorization key anywhere");
 const out=fs.mkdtempSync(path.join(os.tmpdir(),"gd-support-unauth-fx-"));
 try{
  const run=spawnSync(process.execPath,[path.join(__dirname,"scripts/export_account_deletion_fixtures.js"),out],{encoding:"utf8"});
  assert.equal(run.status,0,run.stderr);
  const fresh=fs.readFileSync(path.join(out,"account-deletion",name+".json"));
  assert.ok(fresh.equals(fs.readFileSync(file)),name+".json does not regenerate byte-for-byte");
 }finally{fs.rmSync(out,{recursive:true,force:true});}
});

test("contract 20: 202 {status:'received', requestId} for a failed job; a repeat is 202 with the same requestId",async()=>{
 const {h,jobId,statusToken}=await failedJob();
 try{
  const first=await support(h,jobId,statusToken);
  assert.equal(first.status,202,first.text);
  assert.deepEqual(Object.keys(first.json).sort(),["requestId","status"]);
  assert.equal(first.json.status,"received");
  assert.ok(typeof first.json.requestId==="string"&&first.json.requestId.length>0);
  assert.match(first.headers.get("cache-control")||"",/no-store/);
  const again=await support(h,jobId,statusToken);
  assert.equal(again.status,202,again.text);
  assert.deepEqual(again.json,first.json,"support-repeat: same requestId");
  const doc=h.db.rows.get("supportRequests/"+jobId);
  assert.equal(doc.count,2);
  assert.equal(JSON.stringify(doc).includes(statusToken),false,"the support record never stores the statusToken");
 }finally{h.close();}
});

test("contract 21: signed out - statusToken only, no Firebase or Terms, no body read, uid comes from the job",async()=>{
 const {h,uid,jobId,statusToken}=await failedJob({uid:"u-signed-out"});
 try{
  // The owner has no Firebase session: the ID token no longer verifies and the user record is gone.
  h.ages.delete(uid);h.users.delete(uid);
  const reads=h.termsReads;
  const firebaseOnly=await support(h,jobId,"idtoken."+uid);
  assert.equal(firebaseOnly.status,404,"a Firebase ID token is not a support credential: "+firebaseOnly.text);
  assert.deepEqual(firebaseOnly.json,{error:"not_found"});
  const got=await support(h,jobId,statusToken,{uid:"u-attacker",email:"x@example.com",jobId:"nope"});
  assert.equal(got.status,202,got.text);
  assert.equal(h.termsReads,reads,"support never reads Terms");
  const doc=h.db.rows.get("supportRequests/"+jobId);
  assert.equal(doc.uid,uid,"uid is looked up from the job, never taken from the client");
  assert.equal(doc.jobId,jobId);
  assert.equal(JSON.stringify(doc).includes("u-attacker"),false);
  assert.equal(JSON.stringify(doc).includes("x@example.com"),false);
 }finally{h.close();}
});

test("contract 22: 409 support_not_needed for a queued/running job and for a done job",async()=>{
 const live=harness({uids:["u-live"],holdStripe:true,v2Errors:true});
 await live.listen();
 try{
  const created=await live.del("u-live");
  assert.equal(created.status,202,created.text);
  const early=await support(live,created.json.jobId,created.json.statusToken);
  assert.equal(early.status,409,early.text);
  assert.deepEqual(early.json,{error:"support_not_needed"});
  assert.equal(live.db.rows.has("supportRequests/"+created.json.jobId),false);
  live.release();
  const {last}=await live.pollUntil(created.json.jobId,created.json.statusToken,"done");
  assert.equal(last.json.status,"done");
  const done=await support(live,created.json.jobId,created.json.statusToken);
  assert.equal(done.status,409,done.text);
  assert.deepEqual(done.json,{error:"support_not_needed"},"support-not-needed fixture shape");
  assert.equal(live.db.rows.has("supportRequests/"+created.json.jobId),false);
 }finally{live.release();live.close();}
});

test("contract 23: 404 not_found for a bad, expired or other-job token; 401 unauthorized with no Authorization header",async()=>{
 const {h,jobId,statusToken}=await failedJob({uid:"u-tokens"});
 const other=harness({uids:["u-other"],v2Errors:true});
 await other.listen();
 try{
  const otherJob=await other.del("u-other");
  assert.equal(otherJob.status,202,otherJob.text);
  const missing=await h.call("POST",supportPath(jobId));
  assert.equal(missing.status,401,"account_delete.js:1001: "+missing.text);
  assert.deepEqual(missing.json,{error:"unauthorized"});
  for(const [label,token] of [["garbage","not-a-token"],["well-formed unknown","A".repeat(43)],
   ["other job",otherJob.json.statusToken],["Firebase JWT","idtoken.u-tokens"]]){
   const got=await support(h,jobId,token);
   assert.equal(got.status,404,label+": "+got.text);
   assert.deepEqual(got.json,{error:"not_found"},label);
  }
  h.setNow(NOW+STATUS_TOKEN_TTL_MS+1);
  const expired=await support(h,jobId,statusToken);
  assert.equal(expired.status,404,"expired: "+expired.text);
  assert.deepEqual(expired.json,{error:"not_found"});
  assert.equal(h.db.rows.has("supportRequests/"+jobId),false,"no refused call writes a support record");
 }finally{h.close();other.close();}
});

test("contract 24: the 6th call in a day is 429 rate_limited with retryAfterSec; requestId never changes",async()=>{
 const {h,jobId,statusToken}=await failedJob({uid:"u-limit"});
 try{
  let requestId;
  for(let n=1;n<=5;n++){
   const got=await support(h,jobId,statusToken);
   assert.equal(got.status,202,n+": "+got.text);
   requestId=requestId||got.json.requestId;
   assert.equal(got.json.requestId,requestId);
  }
  const limited=await support(h,jobId,statusToken);
  assert.equal(limited.status,429,limited.text);
  assert.deepEqual(Object.keys(limited.json).sort(),["error","retryAfterSec"]);
  assert.equal(limited.json.error,"rate_limited");
  assert.equal(limited.json.retryAfterSec,86400);
  assert.equal(limited.headers.get("retry-after"),"86400");
  h.setNow(NOW+24*60*60*1000);
  const renewed=await support(h,jobId,statusToken);
  assert.equal(renewed.status,202,renewed.text);
  assert.equal(renewed.json.requestId,requestId);
 }finally{h.close();}
});

test("contract 25: the old /v2/support/deletion-request route is gone (JSON 404)",async()=>{
 const {h,jobId,statusToken}=await failedJob({uid:"u-old"});
 try{
  for(const [method,opts] of [["POST",{token:statusToken,body:{jobId}}],["POST",{token:"idtoken.u-old",body:{jobId}}],["GET",{token:statusToken}]]){
   const got=await h.call(method,"/v2/support/deletion-request",opts);
   assert.equal(got.status,404,method+": "+got.text);
   assert.deepEqual(got.json,{error:"not_found"},method+": JSON body");
  }
  assert.equal(h.db.rows.has("supportRequests/"+jobId),false);
 }finally{h.close();}
});

test("contract 26: one Discord post per job per day via a stub webhook - mentions off, spec fields, safe attachment, no secrets anywhere",async()=>{
 const hook=await stubWebhook(204);
 const logs=captureLogs();
 const owner=hash("u-hook");
 const opaque="22222222-2222-4222-8222-222222222222";
 const objects=new Set(["customer/"+owner+"/managed/w1/"+opaque,"customer/"+owner+"/managed/w1/Tax return 2025.pdf"]);
 const bucket={deleteFiles:async()=>{},getFiles:async({prefix})=>[[...objects].filter(k=>k.startsWith(prefix)).map(name=>({name}))]};
 let ctx;
 try{
  ctx=await failedJob({uid:"u-hook",harness:{bucket},workspaces:{
   w1:{name:"Alpha Projects",wrappedKey:"WRAPPED-KEY-MATERIAL",storageSubscriptionId:"sub_ws1"},
   w2:{name:{ciphertext:"SEALED-NAME-CIPHERTEXT",iv:"iv"}},
  }});
  const {h,jobId,statusToken}=ctx;
  const first=await support(h,jobId,statusToken);
  assert.equal(first.status,202,first.text);
  const again=await support(h,jobId,statusToken);
  assert.equal(again.status,202,again.text);
  assert.equal(hook.posts.length,1,"a repeat does not post a second alert");
  const post=hook.posts[0];
  assert.equal(post.method,"POST");
  const parts=parseMultipart(post.body,post.headers["content-type"]);
  assert.deepEqual(Object.keys(parts).sort(),["files[0]","payload_json"]);
  const payload=JSON.parse(parts.payload_json.value);
  assert.deepEqual(payload.allowed_mentions,{parse:[]},"mentions disabled");
  for(const want of ["u-hook",jobId,"stripe_authentication_error","attempts: 1","w1 Alpha Projects","w2"])
   assert.ok(payload.content.includes(want),"content lists "+want);
  assert.equal(parts["files[0]"].filename,"deletion-"+jobId+".json");
  const file=JSON.parse(parts["files[0]"].value);
  assert.deepEqual(Object.keys(file).sort(),["firebase","subscriptions","workspaces"]);
  const w1=file.workspaces.find(w=>w.id==="w1");
  assert.ok(w1.prefixes.length>0);
  for(const p of w1.prefixes)assert.deepEqual(Object.keys(p).sort(),["deleted","prefix","remaining","remainingIds"]);
  assert.ok(w1.prefixes.some(p=>p.remainingIds.includes(opaque)),"remaining object ids are listed");
  assert.equal(Object.hasOwn(file.workspaces.find(w=>w.id==="w2"),"name"),false,"a sealed name is never sent");
  for(const s of file.subscriptions)assert.deepEqual(Object.keys(s).sort(),["id","status"]);
  assert.deepEqual(Object.keys(file.firebase),["status"]);
  const job=h.db.rows.get("deletion_jobs/"+jobId);
  assert.equal(job.workspaceNames,undefined,"copied names are cleared once the post is sent");
  assert.equal(JSON.stringify(h.db.rows.get("supportRequests/"+jobId)).includes("Alpha"),false,"the support record never stores names");
  const responses=[first.text,again.text].join("\n");
  const secrets=[statusToken,"idtoken.u-hook",FAKE_WEBHOOK,FAKE_HOOK_SECRET,"WRAPPED-KEY-MATERIAL","SEALED-NAME-CIPHERTEXT","Tax return 2025"];
  for(const s of secrets){
   assert.equal(post.body.includes(s),false,"Discord body leaks "+s);
   assert.equal(logs.lines.join("\n").includes(s),false,"logs leak "+s);
   assert.equal(responses.includes(s),false,"responses leak "+s);
  }
 }finally{logs.restore();hook.close();ctx?.h.close();}
});

test("contract 26b: a failed Discord forward still returns 202 and logs neither the webhook URL nor the token",async()=>{
 const hook=await stubWebhook(503);
 const logs=captureLogs();
 let ctx;
 try{
  ctx=await failedJob({uid:"u-hook-down"});
  const got=await support(ctx.h,ctx.jobId,ctx.statusToken);
  assert.equal(got.status,202,got.text);
  assert.equal(hook.posts.length,1);
  const doc=ctx.h.db.rows.get("supportRequests/"+ctx.jobId);
  assert.equal(doc.notify.state,"pending","the forward is retried by the sweep");
  assert.equal(doc.notify.attempts,1);
  for(const s of [FAKE_WEBHOOK,FAKE_HOOK_SECRET,ctx.statusToken])
   assert.equal(logs.lines.join("\n").includes(s),false,"logs leak "+s);
 }finally{logs.restore();hook.close();ctx?.h.close();}
});

test("contract 27: production refuses to start without a valid Discord webhook URL and never prints the value",()=>{
 const notDiscord="https://evil.example/api/webhooks/"+FAKE_HOOK_ID+"/"+FAKE_HOOK_SECRET;
 const plainHttp=FAKE_WEBHOOK.replace("https:","http:");
 for(const [label,value] of [["missing",undefined],["empty",""],["not discord",notDiscord],["http",plainHttp],["no token","https://discord.com/api/webhooks/"+FAKE_HOOK_ID]]){
  const env={NODE_ENV:"production"};
  if(value!==undefined)env.SUPPORT_DISCORD_WEBHOOK_URL=value;
  const gate=supportDiscordStartup(env);
  assert.equal(gate.exit,true,label);
  assert.match(gate.message,/SUPPORT_DISCORD_WEBHOOK_URL/,label+": names the variable");
  if(value)assert.equal(gate.message.includes(value),false,label+": never prints the value");
  assert.equal(gate.message.includes(FAKE_HOOK_SECRET),false,label);
 }
 assert.equal(supportDiscordStartup({NODE_ENV:"production",SUPPORT_DISCORD_WEBHOOK_URL:FAKE_WEBHOOK}).exit,false,"a valid webhook starts");
 const dev=supportDiscordStartup({NODE_ENV:"development"});
 assert.equal(dev.exit,false,"optional in dev");
 for(const value of [undefined,notDiscord]){
  const env={PATH:process.env.PATH,NODE_ENV:"production",CUSTOMER_BUCKET:"gendragoon-test-placeholder",STORAGE_PROJECT_ID:"gendragood-ssd"};
  if(value)env.SUPPORT_DISCORD_WEBHOOK_URL=value;
  const run=spawnSync(process.execPath,["-e","require('./free_server.js').start()"],{cwd:__dirname,env,encoding:"utf8",timeout:8000});
  const output=(run.stdout||"")+(run.stderr||"");
  assert.equal(run.status,1,(value?"bad":"missing")+" value exits 1 before listening");
  assert.match(output,/SUPPORT_DISCORD_WEBHOOK_URL/);
  assert.equal(output.includes("API ready"),false);
  assert.equal(output.includes(FAKE_HOOK_SECRET),false);
  assert.equal(output.includes("evil.example"),false);
 }
});

test("contract 27b: on Cloud Run (K_SERVICE) with NODE_ENV=test, an invalid webhook URL stops the real server without printing it",()=>{
 const marker="InvalidHookMarker_"+"q".repeat(10);
 const invalid=[
  ["non-https",["http:","","discord.com","api","webhooks",FAKE_HOOK_ID,marker].join("/")],
  ["wrong host",["https:","","evil.example","api","webhooks",FAKE_HOOK_ID,marker].join("/")],
  ["query",["https:","","discord.com","api","webhooks",FAKE_HOOK_ID,FAKE_HOOK_SECRET].join("/")+"?wait="+marker],
 ];
 for(const [label,value] of invalid){
  const env={PATH:process.env.PATH,K_SERVICE:"gendragoon-free",NODE_ENV:"test",PORT:"0",
   CUSTOMER_BUCKET:"gendragoon-test-placeholder",STORAGE_PROJECT_ID:"gendragood-ssd",SUPPORT_DISCORD_WEBHOOK_URL:value};
  const run=spawnSync(process.execPath,["-e","require('./free_server.js').start()"],{cwd:__dirname,env,encoding:"utf8",timeout:8000});
  const output=(run.stdout||"")+(run.stderr||"");
  assert.equal(run.status,1,label+": exits 1 before listening");
  assert.match(output,/SUPPORT_DISCORD_WEBHOOK_URL/,label+": names the variable");
  assert.equal(output.includes(value),false,label+": never prints the value");
  assert.equal(output.includes(marker),false,label);
  assert.equal(output.includes(FAKE_HOOK_SECRET),false,label);
  assert.equal(output.includes("evil.example"),false,label);
  assert.equal(output.includes("API ready"),false,label+": never listens");
 }
});

// Repo-wide guard. A leaked webhook has a numeric id and a token segment; the
// bare prefix in error text and docs (account_delete.js:26, README.md:92,
// docs/API-account.md:161) carries no credential and is allowed.
const WEBHOOK_URL_RE=/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/gi;
function webhookHits(){
 const files=spawnSync("git",["ls-files","-z"],{cwd:REPO,encoding:"utf8"}).stdout.split("\0").filter(Boolean);
 assert.ok(files.length>100,"git ls-files returned the repo");
 const hits=[];
 for(const rel of files){
  let text;
  try{
   const buf=fs.readFileSync(path.join(REPO,rel));
   if(buf.length>5_000_000||buf.subarray(0,8000).includes(0))continue;
   text=buf.toString("utf8");
  }catch{continue;}
  text.split("\n").forEach((line,i)=>{if(WEBHOOK_URL_RE.test(line))hits.push(rel+":"+(i+1));WEBHOOK_URL_RE.lastIndex=0;});
 }
 return hits;
}
// Webhook URLs in tests are assembled at runtime, so a tracked literal is a failure.
const KNOWN_FAKE_WEBHOOK_LITERALS=[];
test("contract 28: no Discord webhook URL appears in tracked files or fixtures (beyond the known fake test literal)",()=>{
 const hits=webhookHits().filter(hit=>!KNOWN_FAKE_WEBHOOK_LITERALS.includes(hit));
 assert.deepEqual(hits,[]);
 assert.deepEqual(webhookHits().filter(h=>h.startsWith("fixtures/")),[],"fixtures carry no webhook URL");
});
test("contract 28b: strict - no webhook-shaped URL at all in tracked files",()=>{
 assert.deepEqual(webhookHits(),[]);
});
