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
const {STATUS_TOKEN_TTL_MS,REAUTH_SECONDS}=require("./account_delete");
const NOW=1_800_000_000_000;
const TOKEN_RE=/^[A-Za-z0-9_-]{43}$/;
const hash=uid=>crypto.createHash("sha256").update("gd-v1:"+uid).digest("hex");
const termsDoc=()=>({termsVersion:TERMS_VERSION,readConfirmed:true,agreed:true});

function harness({uids,terms=uids,authAge=30,holdStripe=false}){
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
 const build=stripeImpl=>{
  const app=express();
  app.use("/v2",express.json({limit:"16kb"}));
  installedBilling({app,db,bucket:{deleteFiles:async()=>{}},admin:{firestore:{FieldValue:{serverTimestamp:()=>0}}},
   firebaseAuth:gate.firebaseAuth,firebaseAuthWithoutTerms:gate.firebaseAuthWithoutTerms,accountKey:hash,
   env:{},stripeOverride:stripeImpl,adminAuth,now:()=>now});
  return app;
 };
 const app=build(stripe);
 const errors=[];
 const extra=[];
 return {db,users,ages,app,release,errors,
  // A second server instance on the same Firestore (multi-instance Cloud Run).
  async instance(stripeImpl=stripe){
   const server=build(stripeImpl).listen(0,"127.0.0.1");
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
   return {status:res.status,json,text};
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
  const allowed=e.status===410?["error","jobId","statusToken"]:["error"];
  for(const key of Object.keys(e.json))assert.ok(allowed.includes(key),`${e.status} ${e.path}: unexpected key ${key}`);
 }
}

test("contract 1: production wiring skips Terms only for DELETE /v2/account and GET deletions/:jobId",async()=>{
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
   ["no header",a.jobId,undefined],
   ["unknown job",crypto.randomUUID(),a.statusToken],
  ];
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
 {todo:"SERVER BUG account_delete.js:252: firebaseUserGone() runs before the done-tombstone check (:257). After a real deletion the Firebase user is gone, so a repeat DELETE returns 401 invalid_token and the 410 is unreachable. Existing 410 tests keep getUser succeeding after deleteUser. Ruled (Avery, F1 blocks PR #6): 410 is the answer. The fix must also flip account_delete.test.js:91 and account_delete_retry.test.js:135, which pin 401 for this case."},
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
const F2_TODO="F2 SERVER GAP account_delete.js:53-57: issueStatusToken overwrites the single job.statusTokenHash/statusTokenExpiresAt, so every repeat 202 (:271) or 410 (:258) makes all earlier tokens 404. Ruling: set of up to 5 hashes, each with its own 7-day expiry, oldest dropped.";
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

test("contract 9 (F2): a repeat 202 while running does not invalidate earlier tokens",{todo:F2_TODO},async()=>{
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

test("contract 10 (F2): cap of 5 - the 6th token drops only the oldest (oldest 404, other 5 stay 200)",{todo:F2_TODO},async()=>{
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

test("contract 11 (F2): each token has its own 7-day expiry; a newer token outlives an older one",{todo:F2_TODO},async()=>{
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

test("contract 12 (F2): two devices polling with different tokens both reach done",{todo:F2_TODO},async()=>{
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
 {todo:"Needs F1 (account_delete.js:252 returns 401 invalid_token before the done tombstone at :257, so no 410 is reachable after a real deletion) and F2 (:258 overwrites the single hash). Fails first at F1."},
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
 {todo:"F3 SERVER GAP account_delete.js:46-52: save() blind-writes the runner's in-memory job (plainJob :29-30) to deletion_jobs and account_deletions, so instance A's later step saves overwrite the hash instance B issued on a repeat DELETE; B's token 404s on every instance that reads Firestore. Fix: issue/save tokens in a transaction on the job doc that merges the hash set."},
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
 {todo:"SERVER GAP account_delete.js:269-273: a repeat DELETE on a running job calls issueStatusToken then schedule(), which returns early because the job is inflight, so the new hash is never saved. It reaches Firestore only at the runner's next step save; any other instance (or a restart) 404s the token until then, and forever if this instance dies. Fix: save the hash (same job-doc transaction as F3) before returning 202."},
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
