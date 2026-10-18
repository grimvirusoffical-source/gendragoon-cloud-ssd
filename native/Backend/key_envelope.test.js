"use strict";
// Wrapped workspace key envelope. No network, credentials, or live Firebase.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const express=require("express");
const {memoryFirestore}=require("./test_firestore");
const {registerKeyEnvelope,MAX_ENVELOPE_BYTES}=require("./key_envelope");
const {createAccountDeletion}=require("./account_delete");
const uid="owner-user",otherUid="other-user";
const owner=crypto.createHash("sha256").update(uid).digest("hex");
const other=crypto.createHash("sha256").update(otherUid).digest("hex");
const workspace="12345678-1234-4000-8000-000000000001";
const foreignWorkspace="12345678-1234-4000-8000-000000000099";
function hash(value){return crypto.createHash("sha256").update(value).digest("hex");}
function wrapped(byte=7,length=48){return Buffer.alloc(length,byte).toString("base64");}
function b64url(length,byte=2){return Buffer.alloc(length,byte).toString("base64url");}
const salt=b64url(16,2),iv=b64url(12,3);
const ARGON={alg:"argon2id",memoryKiB:19456,iterations:2,parallelism:1};
function body(version,key=wrapped(),kdf=ARGON){
 return {version,kdf,salt,iv,wrappedKey:key};
}
function listen(app){
 const server=app.listen(0,"127.0.0.1");
 return new Promise(resolve=>server.once("listening",()=>resolve({
  server,base:"http://127.0.0.1:"+server.address().port,
 })));
}
function appFor(db,users={owner:uid,other:otherUid}){
 const app=express();
 app.use(express.json({limit:"16kb"}));
 const byUid=Object.fromEntries(Object.entries(users).map(([name,id])=>[name,id]));
 registerKeyEnvelope({app,db,hash,firebaseAuth:(req,res,next)=>{
  const token=(req.headers.authorization||"").replace(/^Bearer /,"");
  const id=byUid[token];
  if(!id)return res.status(401).json({error:"invalid_token"});
  req.user={uid:id};
  next();
 }});
 return app;
}
function seed(){
 return memoryFirestore([
  ["gd_accounts/"+owner+"/workspaces/"+workspace,{kind:"paid",accountHash:owner,name:"Mine"}],
  ["gd_accounts/"+other+"/workspaces/"+workspace,{kind:"paid",accountHash:other,name:"Theirs"}],
  ["gd_accounts/"+other+"/workspaces/"+foreignWorkspace,{kind:"paid",accountHash:other,name:"Hidden"}],
  ["tenants/"+owner+"/workspaces/free",{kind:"free",accountKey:owner}],
 ]);
}
async function assertError(response,status,error){
 assert.equal(response.status,status);
 const payload=await response.json();
 assert.deepEqual(payload,{error});
 assert.equal(Object.hasOwn(payload,"code"),false);
 return payload;
}

test("key envelope: create, reject a second create, then replace only with the next version",async()=>{
 const db=seed();
 const app=appFor(db);
 const {server,base}=await listen(app);
 const url=base+"/v2/workspaces/"+workspace+"/key-envelope";
 const headers={authorization:"Bearer owner","content-type":"application/json"};
 try{
  const missing=await fetch(url,{headers});
  await assertError(missing,404,"not_found");
  const bare=await fetch(url,{method:"PUT",headers,body:JSON.stringify(body(1))});
  await assertError(bare,428,"precondition_required");
  const created=await fetch(url,{method:"PUT",headers:{...headers,"if-none-match":"*"},body:JSON.stringify(body(1))});
  assert.equal(created.status,201);
  assert.equal(created.headers.get("etag"),'"1"');
  assert.deepEqual(await created.json(),body(1));
  const again=await fetch(url,{method:"PUT",headers:{...headers,"if-none-match":"*"},body:JSON.stringify(body(1,wrapped(9)))});
  await assertError(again,409,"envelope_exists");
  const stored=await db.collection("gd_accounts").doc(owner).collection("key_envelopes").doc(workspace).get();
  assert.equal(stored.data().wrappedKey,wrapped());
  const wrong=await fetch(url,{method:"PUT",headers:{...headers,"if-match":'"9"'},body:JSON.stringify(body(10,wrapped(3)))});
  await assertError(wrong,412,"version_mismatch");
  assert.equal((await db.collection("gd_accounts").doc(owner).collection("key_envelopes").doc(workspace).get()).data().wrappedKey,wrapped());
  const next=await fetch(url,{method:"PUT",headers:{...headers,"if-match":'"1"'},body:JSON.stringify(body(2,wrapped(3)))});
  assert.equal(next.status,200);
  assert.deepEqual(await next.json(),body(2,wrapped(3)));
  const got=await fetch(url,{headers});
  assert.equal(got.status,200);
  assert.deepEqual(await got.json(),body(2,wrapped(3)));
  const foreign=await fetch(url,{headers:{authorization:"Bearer other"}});
  await assertError(foreign,404,"not_found");
  const hidden=await fetch(base+"/v2/workspaces/"+foreignWorkspace+"/key-envelope",{headers});
  await assertError(hidden,404,"not_found");
  const theirs=await db.collection("gd_accounts").doc(other).collection("key_envelopes").doc(workspace).get();
  assert.equal(theirs.exists,false);
 }finally{server.close();}
});

test("key envelope: a passphrase field is refused and an oversized body is refused",async()=>{
 const db=seed();
 const {server,base}=await listen(appFor(db));
 const url=base+"/v2/workspaces/"+workspace+"/key-envelope";
 const headers={authorization:"Bearer owner","content-type":"application/json","if-none-match":"*"};
 const logs=[];
 const original=console.error;
 console.error=(...args)=>logs.push(args.join(" "));
 try{
  const leaked=await fetch(url,{method:"PUT",headers,body:JSON.stringify({...body(1),passphrase:"hunter2"})});
  await assertError(leaked,400,"plaintext_rejected");
  assert.equal((await db.collection("gd_accounts").doc(owner).collection("key_envelopes").doc(workspace).get()).exists,false);
  assert.equal(logs.join("\n").includes("hunter2"),false);
  const huge=wrapped(1,MAX_ENVELOPE_BYTES);
  const oversized=await fetch(url,{method:"PUT",headers,body:JSON.stringify(body(1,huge))});
  await assertError(oversized,413,"payload_too_large");
  assert.equal((await db.collection("gd_accounts").doc(owner).collection("key_envelopes").doc(workspace).get()).exists,false);
 }finally{console.error=original;server.close();}
});

test("key envelope: account deletion removes only that account's envelopes",async()=>{
 const db=seed();
 const keep=wrapped(4),drop=wrapped(5);
 await db.collection("gd_accounts").doc(owner).collection("key_envelopes").doc(workspace).set(body(3,drop));
 await db.collection("gd_accounts").doc(other).collection("key_envelopes").doc(workspace).set(body(1,keep));
 await db.collection("gd_accounts").doc(owner).set({stripeCustomerId:"cus_env",uid});
 const users=new Set([uid]);
 const auth={deleteUser:async user=>{users.delete(user);},revokeRefreshTokens:async()=>{},getUser:async user=>{
  if(!users.has(user))throw Object.assign(Error("gone"),{code:"auth/user-not-found"});
  return {uid:user};
 },verifyIdToken:async user=>({uid:user})};
 const stripe={subscriptions:{list:async()=>({has_more:false,data:[]}),cancel:async()=>({})}};
 const svc=createAccountDeletion({db,stripe,bucket:{deleteFiles:async()=>{}},auth,byoProviders:{},hash,now:()=>1_800_000_000_000});
 const started=await svc.deleteAccount({user:{uid,auth_time:Math.floor(1_800_000_000_000/1000)-30}});
 const deadline=Date.now()+5000;
 let job;
 do{
  job=await svc.jobStatus(started.jobId);
  if(job?.status==="done"||job?.status==="failed")break;
  await new Promise(resolve=>setTimeout(resolve,10));
 }while(Date.now()<deadline);
 assert.equal(job.status,"done");
 assert.equal((await db.collection("gd_accounts").doc(owner).collection("key_envelopes").doc(workspace).get()).exists,false);
 const kept=await db.collection("gd_accounts").doc(other).collection("key_envelopes").doc(workspace).get();
 assert.equal(kept.data().wrappedKey,keep);
 const receipts=await db.collection("billing_receipts").get();
 assert.equal(JSON.stringify(receipts.docs.map(doc=>doc.data())).includes(drop),false);
});

test("key envelope: bad KDF params are 422 and 64 GiB is refused",async()=>{
 const db=seed();
 const {server,base}=await listen(appFor(db));
 const url=base+"/v2/workspaces/"+workspace+"/key-envelope";
 const headers={authorization:"Bearer owner","content-type":"application/json","if-none-match":"*"};
 const put=kdf=>fetch(url,{method:"PUT",headers,body:JSON.stringify({version:1,wrappedKey:wrapped(),salt,iv,...(kdf===undefined?{}:{kdf})})});
 try{
  await assertError(await put(),422,"kdf_params_invalid");
  await assertError(await put({alg:"pbkdf2",memoryKiB:19456,iterations:1,parallelism:1}),422,"kdf_params_invalid");
  await assertError(await put({alg:"argon2id",memoryKiB:64*1024*1024,iterations:1,parallelism:1}),422,"kdf_params_invalid");
  await assertError(await put({alg:"argon2id",memoryKiB:19455,iterations:1,parallelism:1}),422,"kdf_params_invalid");
  await assertError(await put({alg:"argon2id",memoryKiB:1048577,iterations:1,parallelism:1}),422,"kdf_params_invalid");
  await assertError(await put({alg:"argon2id",memoryKiB:19456,iterations:0,parallelism:1}),422,"kdf_params_invalid");
  await assertError(await put({alg:"argon2id",memoryKiB:19456,iterations:11,parallelism:1}),422,"kdf_params_invalid");
  await assertError(await put({alg:"argon2id",memoryKiB:19456,iterations:1,parallelism:5}),422,"kdf_params_invalid");
  await assertError(await put({alg:"scrypt",N:2**14,r:7,p:1}),422,"kdf_params_invalid");
  await assertError(await put({alg:"scrypt",N:2**13,r:8,p:1}),422,"kdf_params_invalid");
  await assertError(await put({alg:"scrypt",N:2**21,r:8,p:1}),422,"kdf_params_invalid");
  await assertError(await put({alg:"scrypt",N:2**14,r:8,p:5}),422,"kdf_params_invalid");
  assert.equal((await db.collection("gd_accounts").doc(owner).collection("key_envelopes").doc(workspace).get()).exists,false);
  const edge=await put({alg:"argon2id",memoryKiB:1048576,iterations:10,parallelism:4});
  assert.equal(edge.status,201);
  const replaceHeaders={authorization:headers.authorization,"content-type":headers["content-type"],"if-match":'"1"'};
  const scryptKdf={alg:"scrypt",N:2**20,r:8,p:1};
  const scrypt=await fetch(url,{method:"PUT",headers:replaceHeaders,body:JSON.stringify(body(2,wrapped(2),scryptKdf))});
  assert.equal(scrypt.status,200);
  assert.equal(scrypt.headers.get("etag"),'"2"');
  const stored=await db.collection("gd_accounts").doc(owner).collection("key_envelopes").doc(workspace).get();
  assert.equal(stored.data().version,2);
  assert.deepEqual(stored.data().kdf,scryptKdf);
  const stale=await fetch(url,{method:"PUT",headers:{...replaceHeaders,"if-match":'"1"'},body:JSON.stringify(body(2,wrapped(3),scryptKdf))});
  await assertError(stale,412,"version_mismatch");
  assert.equal((await db.collection("gd_accounts").doc(owner).collection("key_envelopes").doc(workspace).get()).data().wrappedKey,wrapped(2));
 }finally{server.close();}
});

test("key envelope: salt, iv, and leftover flat KDF fields are 422 envelope_invalid",async()=>{
 const db=seed();
 const {server,base}=await listen(appFor(db));
 const url=base+"/v2/workspaces/"+workspace+"/key-envelope";
 const headers={authorization:"Bearer owner","content-type":"application/json","if-none-match":"*"};
 const put=extra=>fetch(url,{method:"PUT",headers,body:JSON.stringify({...body(1),...extra})});
 try{
  await assertError(await put({salt:b64url(15)}),422,"envelope_invalid");
  await assertError(await put({salt:b64url(65)}),422,"envelope_invalid");
  await assertError(await put({salt:Buffer.alloc(16,0xff).toString("base64")}),422,"envelope_invalid");
  await assertError(await put({iv:b64url(11)}),422,"envelope_invalid");
  await assertError(await put({iv:b64url(33)}),422,"envelope_invalid");
  await assertError(await put({salt:undefined}),422,"envelope_invalid");
  await assertError(await put({opsLimit:3}),422,"envelope_invalid");
  await assertError(await put({memLimit:19456}),422,"envelope_invalid");
  await assertError(await put({kdfParams:ARGON}),422,"envelope_invalid");
  assert.equal((await db.collection("gd_accounts").doc(owner).collection("key_envelopes").doc(workspace).get()).exists,false);
  const edges=await put({salt:b64url(64),iv:b64url(32)});
  assert.equal(edges.status,201);
 }finally{server.close();}
});
