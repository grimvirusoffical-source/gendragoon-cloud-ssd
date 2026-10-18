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
 const app=express();
 app.use("/v2",express.json({limit:"16kb"}));
 installedBilling({app,db,bucket:{deleteFiles:async()=>{}},admin:{firestore:{FieldValue:{serverTimestamp:()=>0}}},
  firebaseAuth:gate.firebaseAuth,firebaseAuthWithoutTerms:gate.firebaseAuthWithoutTerms,accountKey:hash,
  env:{},stripeOverride:stripe,adminAuth,now:()=>now});
 const errors=[];
 return {db,users,ages,app,release,errors,
  get termsReads(){return termsReads;},
  setNow(v){now=v;},
  async listen(){
   const server=app.listen(0,"127.0.0.1");
   await new Promise(r=>server.once("listening",r));
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
   if(res.status>=400)errors.push({status:res.status,path,json,text});
   return {status:res.status,json,text};
  },
  del(uid,extra={}){return this.call("DELETE","/v2/account",{token:"idtoken."+uid,body:{confirm:"DELETE"},...extra});},
  poll(jobId,token){return this.call("GET","/v2/account/deletions/"+jobId,{token});},
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
 {todo:"SERVER BUG account_delete.js:252: firebaseUserGone() runs before the done-tombstone check (:257). After a real deletion the Firebase user is gone, so a repeat DELETE returns 401 invalid_token and the 410 is unreachable. Existing 410 tests keep getUser succeeding after deleteUser. Moving the check after the tombstone makes this pass but breaks account_delete.test.js:91 and account_delete_retry.test.js:135, which pin 401 for the same case: the contract needs one answer."},
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
