"use strict";
// Polling must keep working after the job deletes the Terms record and the
// Firebase user. This mounts createLoginGate, the same production chain
// free_server uses, and not a middleware stub that skips Terms.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),fs=require("node:fs");
const express=require("express");
const {memoryFirestore}=require("./test_firestore");
const {createAccountDeletion,registerAccountDeletion,STATUS_TOKEN_TTL_MS}=require("./account_delete");
const {createLoginGate,TERMS_VERSION}=require("./login_gate");
const NOW=1_800_000_000_000;
const uidA="user-a",uidB="user-b";
function hash(value){return crypto.createHash("sha256").update(value).digest("hex");}
function userFor(uid){
 return {uid,auth_time:Math.floor(NOW/1000)-30,firebase:{sign_in_provider:"google.com"}};
}
function termsDoc(){return {termsVersion:TERMS_VERSION,readConfirmed:true,agreed:true};}
function listen(app){
 const server=app.listen(0,"127.0.0.1");
 return new Promise(resolve=>server.once("listening",()=>resolve({server,base:"http://127.0.0.1:"+server.address().port})));
}
function captureLogs(){
 const lines=[];
 const write=(...args)=>lines.push(args.map(item=>typeof item==="string"?item:JSON.stringify(item)).join(" "));
 const originals={log:console.log,info:console.info,warn:console.warn,error:console.error,debug:console.debug};
 for(const key of Object.keys(originals))console[key]=(...args)=>write(...args);
 return {lines,restore(){Object.assign(console,originals);}};
}
function assertUnlogged(lines,...secrets){
 const text=lines.join("\n");
 for(const secret of secrets)assert.equal(text.includes(secret),false);
}

test("production login chain: status token polls running then done after Terms and the Firebase user are gone",async()=>{
 const source=fs.readFileSync(require.resolve("./free_server.js"),"utf8");
 const billing=fs.readFileSync(require.resolve("./billing_gateway.js"),"utf8");
 assert.match(source,/createLoginGate\(/);
 assert.match(source,/firebaseAuthWithoutTerms/);
 assert.match(billing,/firebaseAuthWithoutTerms/);
 const ownerA=hash(uidA),ownerB=hash(uidB);
 const db=memoryFirestore([
  ["gd_accounts/"+ownerA,{stripeCustomerId:"cus_a",uid:uidA}],
  ["gd_accounts/"+ownerB,{stripeCustomerId:"cus_b",uid:uidB}],
  ["accepted_terms/"+uidA,termsDoc()],
  ["accepted_terms/"+uidB,termsDoc()],
 ]);
 const users=new Set([uidA,uidB]);
 const tokens=new Map([["good.token.userA",userFor(uidA)],["good.token.userB",userFor(uidB)]]);
 let termsReads=0;
 const gate=createLoginGate({
  verifyIdToken:async token=>{
   // JWT-only, as free_server does. A deleted user's unexpired ID token still verifies.
   const user=tokens.get(token);
   if(!user)throw Object.assign(Error("revoked"),{code:"auth/id-token-revoked"});
   return user;
  },
  fetchTerms:async uid=>{
   termsReads+=1;
   const snap=await db.collection("accepted_terms").doc(uid).get();
   if(!snap.exists)return {ok:false,json:async()=>({})};
   const row=snap.data();
   return {ok:true,json:async()=>({fields:{
    termsVersion:{stringValue:row.termsVersion},
    readConfirmed:{booleanValue:row.readConfirmed===true},
    agreed:{booleanValue:row.agreed===true},
   }})};
  },
 });
 let release=()=>{};
 const hold=new Promise(resolve=>{release=resolve;});
 let held=false;
 const stripe={subscriptions:{
  list:async query=>({has_more:false,data:[{id:"sub_"+query.customer,status:"active",customer:query.customer}]}),
  cancel:async()=>{if(!held){held=true;await hold;}},
 }};
 const auth={deletedUsers:[],
  revokeRefreshTokens:async()=>{},
  deleteUser:async user=>{
   if(!users.has(user))throw Object.assign(Error("gone"),{code:"auth/user-not-found"});
   users.delete(user);
   auth.deletedUsers.push(user);
  },
  getUser:async user=>{
   if(!users.has(user))throw Object.assign(Error("gone"),{code:"auth/user-not-found"});
   return {uid:user};
  },
  verifyIdToken:async user=>{
   if(!users.has(user))throw Object.assign(Error("revoked"),{code:"auth/id-token-revoked"});
   return {uid:user};
  }};
 const app=express();
 app.use(express.json());
 app.get("/v2/session",gate.firebaseAuth,(req,res)=>res.json({uid:req.user.uid}));
 const svc=registerAccountDeletion({app,firebaseAuth:gate.firebaseAuthWithoutTerms,db,stripe,bucket:{deleteFiles:async()=>{}},
  auth,byoProviders:{},hash,now:()=>NOW});
 const logs=captureLogs();
 const {server,base}=await listen(app);
 try{
  const session=await fetch(base+"/v2/session",{headers:{authorization:"Bearer good.token.userA"}});
  assert.equal(session.status,200);
  const before=termsReads;
  const created=await fetch(base+"/v2/account",{method:"DELETE",headers:{authorization:"Bearer good.token.userA","content-type":"application/json"},body:JSON.stringify({confirm:"DELETE"})});
  assert.equal(created.status,202);
  const started=await created.json();
  assert.equal(started.status,"deleting");
  assert.match(started.statusToken,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(termsReads,before,"DELETE must not run the Terms middleware");
  const seen=[];
  const deadline=Date.now()+5000;
  let status,termsBlocked=false,activeToken=started.statusToken;
  do{
   const polled=await fetch(base+"/v2/account/deletions/"+started.jobId,{headers:{authorization:"Bearer "+activeToken}});
   assert.equal(polled.status,200);
   status=await polled.json();
   assert.deepEqual(Object.keys(status).sort(),["jobId","retryable","status"]);
   seen.push(status.status);
   if(!termsBlocked&&(status.status==="running"||status.status==="queued")){
    termsBlocked=true;
    await db.collection("accepted_terms").doc(uidA).delete();
    const blocked=await fetch(base+"/v2/session",{headers:{authorization:"Bearer good.token.userA"}});
    assert.equal(blocked.status,403);
    assert.deepEqual(await blocked.json(),{error:"Current Terms acceptance required"});
    const resumed=await fetch(base+"/v2/account",{method:"DELETE",headers:{authorization:"Bearer good.token.userA","content-type":"application/json"},body:JSON.stringify({confirm:"DELETE"})});
    assert.equal(resumed.status,202);
    const resumedBody=await resumed.json();
    assert.equal(resumedBody.jobId,started.jobId);
    assert.notEqual(resumedBody.statusToken,activeToken);
    activeToken=resumedBody.statusToken;
    assert.equal(termsReads,before+1,"only the session route reads Terms");
    release();
   }
   if(status.status==="done")break;
   await new Promise(r=>setTimeout(r,5));
  }while(Date.now()<deadline);
  assert.equal(termsBlocked,true);
  assert.ok(seen.includes("running")||seen.includes("queued"));
  assert.equal(status.status,"done");
  assert.equal(status.jobId,started.jobId);
  assert.equal((await db.collection("accepted_terms").doc(uidA).get()).exists,false);
  assert.equal(users.has(uidA),false);
  const firebasePoll=await fetch(base+"/v2/account/deletions/"+started.jobId,{headers:{authorization:"Bearer good.token.userA"}});
  assert.equal(firebasePoll.status,200);
  assert.deepEqual(await firebasePoll.json(),{jobId:started.jobId,status:"done",retryable:false});
  const done=await fetch(base+"/v2/account/deletions/"+started.jobId,{headers:{authorization:"Bearer "+activeToken}});
  assert.equal(done.status,200);
  assert.deepEqual(await done.json(),{jobId:started.jobId,status:"done",retryable:false});
  const stored=await db.collection("deletion_jobs").doc(started.jobId).get();
  const activeHash=crypto.createHash("sha256").update(activeToken).digest("hex");
  assert.ok(stored.data().statusTokens.some(item=>item.hash===activeHash));
  assert.equal(stored.data().statusTokens.find(item=>item.hash===activeHash).expiresAtMs,NOW+STATUS_TOKEN_TTL_MS);
  assert.equal(JSON.stringify(stored.data()).includes(started.statusToken),false);
  assert.equal(JSON.stringify(stored.data()).includes(activeToken),false);
  const other=await fetch(base+"/v2/account",{method:"DELETE",headers:{authorization:"Bearer good.token.userB","content-type":"application/json"},body:JSON.stringify({confirm:"DELETE"})});
  assert.equal(other.status,202);
  const jobB=await other.json();
  const crossed=await fetch(base+"/v2/account/deletions/"+jobB.jobId,{headers:{authorization:"Bearer "+started.statusToken}});
  assert.equal(crossed.status,404);
  assert.deepEqual(await crossed.json(),{error:"not_found"});
  const own=await fetch(base+"/v2/account/deletions/"+started.jobId,{headers:{authorization:"Bearer "+jobB.statusToken}});
  assert.equal(own.status,404);
  assertUnlogged(logs.lines,started.statusToken,activeToken,jobB.statusToken);
 }finally{logs.restore();server.close();}
 void svc;
});

test("repeat DELETE after a tombstone returns 410 with the same jobId and a fresh status token",async()=>{
 const uid="user-keep",owner=hash(uid);
 const db=memoryFirestore([
  ["gd_accounts/"+owner,{stripeCustomerId:"cus_keep",uid}],
  ["accepted_terms/"+uid,termsDoc()],
 ]);
 const tokens=new Map([["good.token.keep",userFor(uid)]]);
 let termsReads=0;
 const gate=createLoginGate({
  verifyIdToken:async token=>{
   const user=tokens.get(token);
   if(!user)throw Object.assign(Error("revoked"),{code:"auth/id-token-revoked"});
   return user;
  },
  fetchTerms:async id=>{
   termsReads+=1;
   const snap=await db.collection("accepted_terms").doc(id).get();
   if(!snap.exists)return {ok:false,json:async()=>({})};
   const row=snap.data();
   return {ok:true,json:async()=>({fields:{
    termsVersion:{stringValue:row.termsVersion},
    readConfirmed:{booleanValue:row.readConfirmed===true},
    agreed:{booleanValue:row.agreed===true},
   }})};
  },
 });
 const users=new Set([uid]);
 const auth={deletedUsers:[],revokeRefreshTokens:async()=>{},
  deleteUser:async user=>{
   if(!users.has(user))throw Object.assign(Error("gone"),{code:"auth/user-not-found"});
   users.delete(user);auth.deletedUsers.push(user);
  },
  getUser:async user=>{
   if(!users.has(user))throw Object.assign(Error("gone"),{code:"auth/user-not-found"});
   return {uid:user};
  },
  verifyIdToken:async user=>{
   if(!users.has(user))throw Object.assign(Error("revoked"),{code:"auth/id-token-revoked"});
   return {uid:user};
  }};
 const app=express();
 app.use(express.json());
 app.get("/v2/session",gate.firebaseAuth,(req,res)=>res.json({ok:true,uid:req.user.uid}));
 registerAccountDeletion({app,firebaseAuth:gate.firebaseAuthWithoutTerms,db,
  stripe:{subscriptions:{list:async()=>({has_more:false,data:[]}),cancel:async()=>({})}},
  bucket:{deleteFiles:async()=>{}},auth,byoProviders:{},hash,now:()=>NOW});
 const logs=captureLogs();
 const {server,base}=await listen(app);
 try{
  const before=termsReads;
  const created=await fetch(base+"/v2/account",{method:"DELETE",headers:{authorization:"Bearer good.token.keep","content-type":"application/json"},body:JSON.stringify({confirm:"DELETE"})});
  assert.equal(created.status,202);
  assert.equal(termsReads,before);
  const started=await created.json();
  const deadline=Date.now()+5000;
  let done;
  do{
   const polled=await fetch(base+"/v2/account/deletions/"+started.jobId,{headers:{authorization:"Bearer "+started.statusToken}});
   done=await polled.json();
   if(polled.status===200&&done.status==="done")break;
   await new Promise(r=>setTimeout(r,5));
  }while(Date.now()<deadline);
  assert.equal(done.status,"done");
  const session=await fetch(base+"/v2/session",{headers:{authorization:"Bearer good.token.keep"}});
  assert.equal(session.status,403);
  assert.deepEqual(await session.json(),{error:"Current Terms acceptance required"});
  const again=await fetch(base+"/v2/account",{method:"DELETE",headers:{authorization:"Bearer good.token.keep","content-type":"application/json"},body:JSON.stringify({confirm:"DELETE"})});
  assert.equal(again.status,410);
  const body=await again.json();
  assert.equal(body.error,"account_deleted");
  assert.equal(body.jobId,started.jobId);
  assert.match(body.statusToken,/^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(body.statusToken,started.statusToken);
  const fresh=await fetch(base+"/v2/account/deletions/"+started.jobId,{headers:{authorization:"Bearer "+body.statusToken}});
  assert.equal(fresh.status,200);
  assert.deepEqual(await fresh.json(),{jobId:started.jobId,status:"done",retryable:false});
  const stale=await fetch(base+"/v2/account/deletions/"+started.jobId,{headers:{authorization:"Bearer "+started.statusToken}});
  assert.equal(stale.status,200);
  assert.deepEqual(await stale.json(),{jobId:started.jobId,status:"done",retryable:false});
  assertUnlogged(logs.lines,started.statusToken,body.statusToken);
 }finally{logs.restore();server.close();}
});

test("a status token expires after 7 days",async()=>{
 const uid="user-expire",owner=hash(uid);
 let now=NOW;
 const db=memoryFirestore([["gd_accounts/"+owner,{uid}]]);
 const gate=createLoginGate({
  verifyIdToken:async token=>{
   if(token!=="good.token.expire")throw Object.assign(Error("revoked"),{code:"auth/id-token-revoked"});
   return userFor(uid);
  },
  fetchTerms:async()=>{throw Error("terms must not run");},
 });
 const app=express();
 app.use(express.json());
 registerAccountDeletion({app,firebaseAuth:gate.firebaseAuthWithoutTerms,db,
  stripe:{subscriptions:{list:async()=>({has_more:false,data:[]}),cancel:async()=>({})}},
  bucket:{deleteFiles:async()=>{}},
  auth:{deleteUser:async()=>{},revokeRefreshTokens:async()=>{},getUser:async user=>({uid:user}),verifyIdToken:async user=>({uid:user})},
  byoProviders:{},hash,now:()=>now});
 const {server,base}=await listen(app);
 try{
  const created=await fetch(base+"/v2/account",{method:"DELETE",headers:{authorization:"Bearer good.token.expire","content-type":"application/json"},body:JSON.stringify({confirm:"DELETE"})});
  const started=await created.json();
  const deadline=Date.now()+5000;
  let status;
  do{
   const polled=await fetch(base+"/v2/account/deletions/"+started.jobId,{headers:{authorization:"Bearer "+started.statusToken}});
   status=await polled.json();
   if(polled.status===200&&status.status==="done")break;
   await new Promise(r=>setTimeout(r,5));
  }while(Date.now()<deadline);
  assert.equal(status.status,"done");
  now=NOW+STATUS_TOKEN_TTL_MS+1;
  const expired=await fetch(base+"/v2/account/deletions/"+started.jobId,{headers:{authorization:"Bearer "+started.statusToken}});
  assert.equal(expired.status,404);
  const firebase=await fetch(base+"/v2/account/deletions/"+started.jobId,{headers:{authorization:"Bearer good.token.expire"}});
  assert.equal(firebase.status,200);
  assert.equal((await firebase.json()).status,"done");
 }finally{server.close();}
});
