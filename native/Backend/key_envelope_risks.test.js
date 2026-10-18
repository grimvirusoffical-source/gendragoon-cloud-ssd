"use strict";
// QA risk tests for the workspace key envelope (PR #9). In-memory Firestore,
// stub Firebase/Stripe, 127.0.0.1 only. No credentials or network.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const fs=require("node:fs"),path=require("node:path");
const express=require("express");
const {memoryFirestore}=require("./test_firestore");
const {registerKeyEnvelope,MAX_ENVELOPE_BYTES}=require("./key_envelope");
const {createAccountDeletion}=require("./account_delete");
const hash=v=>crypto.createHash("sha256").update(v).digest("hex");
const A="risk-a",B="risk-b",ha=hash(A),hb=hash(B);
const WS="22222222-2222-4222-8222-000000000001",WS_B="22222222-2222-4222-8222-000000000002",WS_NONE="22222222-2222-4222-8222-0000000000ff";
const MIB=1024*1024,GIB=1024*MIB;
const wrapped=(b=7,n=48)=>Buffer.alloc(n,b).toString("base64");
const ARGON={memory:19*MIB,iterations:2,parallelism:1},SCRYPT={N:2**14,r:8,p:1};
const env=(version=1,o={})=>({version,wrappedKey:wrapped(),kdf:"argon2id",kdfParams:ARGON,...o});
function seed(){return memoryFirestore([
 ["gd_accounts/"+ha+"/workspaces/"+WS,{kind:"paid",accountHash:ha}],
 ["gd_accounts/"+hb+"/workspaces/"+WS_B,{kind:"paid",accountHash:hb}],
 ["gd_accounts/"+hb+"/workspaces/"+WS,{kind:"paid",accountHash:hb}],
]);}
async function server(db){
 const app=express();app.use("/v2",express.json({limit:"16kb"})); // same limit as free_server.js:77
 const tok={"tok-a":A,"tok-b":B};
 registerKeyEnvelope({app,db,hash,firebaseAuth:(req,res,next)=>{const u=tok[(req.headers.authorization||"").slice(7)];
  if(!u)return res.status(401).json({error:"invalid_token"});req.user={uid:u};next();}});
 const s=app.listen(0,"127.0.0.1");await new Promise(r=>s.once("listening",r));
 const base="http://127.0.0.1:"+s.address().port;
 async function call(method,ws,who,body,h={}){const r=await fetch(base+"/v2/workspaces/"+ws+"/key-envelope",{method,
  headers:{authorization:"Bearer "+who,"content-type":"application/json",...h},body:body===undefined?undefined:(typeof body==="string"?body:JSON.stringify(body))});
  const text=await r.text();let json=null;try{json=JSON.parse(text);}catch(_){}return {status:r.status,json,text,etag:r.headers.get("etag")};}
 return {s,call};
}
const stored=(db,h,ws)=>db.rows.get("gd_accounts/"+h+"/key_envelopes/"+ws);

test("cross-account: B gets 404 not_found identical to a missing workspace; no leak",async()=>{
 const db=seed();const {s,call}=await server(db);
 try{
  assert.equal((await call("PUT",WS,"tok-a",env(1),{"if-none-match":"*"})).status,201);
  const onlyA="22222222-2222-4222-8222-0000000000aa";db.rows.set("gd_accounts/"+ha+"/workspaces/"+onlyA,{kind:"paid",accountHash:ha});
  await call("PUT",onlyA,"tok-a",env(1),{"if-none-match":"*"});
  const r1=await call("GET",onlyA,"tok-b"),r2=await call("GET",WS_NONE,"tok-b");
  assert.equal(r1.status,404);assert.deepEqual(r1.json,{error:"not_found"});assert.equal(r1.text,r2.text);assert.equal(r1.etag,r2.etag,"etag must not distinguish");
  // same workspace id exists under B with no envelope: B must not see A's
  const r3=await call("GET",WS,"tok-b");assert.equal(r3.status,404);assert.equal(r3.text.includes(wrapped()),false);
  // B cannot write into A-only workspace (create or update)
  assert.equal((await call("PUT",onlyA,"tok-b",env(1),{"if-none-match":"*"})).status,404);
  assert.equal((await call("PUT",onlyA,"tok-b",env(2),{"if-match":'"1"'})).status,404);
  assert.equal(stored(db,ha,onlyA).version,1);
  assert.equal(stored(db,hb,onlyA),undefined);
 }finally{s.close();}
});

test("preconditions: stale If-Match 412, create-over-existing 409 (as documented), stored key unchanged",async()=>{
 const db=seed();const {s,call}=await server(db);
 try{
  await call("PUT",WS,"tok-a",env(1),{"if-none-match":"*"});
  assert.equal((await call("PUT",WS,"tok-a",env(2,{wrappedKey:wrapped(2)}),{"if-match":'"1"'})).status,200);
  const stale=await call("PUT",WS,"tok-a",env(2,{wrappedKey:wrapped(3)}),{"if-match":'"1"'});
  assert.equal(stale.status,412);assert.deepEqual(stale.json,{error:"version_mismatch"});
  const skip=await call("PUT",WS,"tok-a",env(4),{"if-match":"2"});assert.equal(skip.status,412);
  const dup=await call("PUT",WS,"tok-a",env(1,{wrappedKey:wrapped(9)}),{"if-none-match":"*"});
  assert.equal(dup.status,409);assert.deepEqual(dup.json,{error:"envelope_exists"});
  assert.equal(stored(db,ha,WS).wrappedKey,wrapped(2));assert.equal(stored(db,ha,WS).version,2);
  const upd=await call("PUT",WS_NONE,"tok-a",env(2),{"if-match":"1"});assert.equal(upd.status,404);
  for(const h of [{"if-match":"*"},{"if-match":'W/"2"'},{"if-none-match":'"2"'}])assert.equal((await call("PUT",WS,"tok-a",env(3),h)).status,400,JSON.stringify(h));
  assert.equal((await call("PUT",WS,"tok-a",env(3),{"if-match":"2","if-none-match":"*"})).status,400);
 }finally{s.close();}
});

test("concurrent create: exactly one 201, the rest 409",async()=>{
 const db=seed();const {s,call}=await server(db);
 try{
  const rs=await Promise.all([1,2,3,4,5].map(i=>call("PUT",WS,"tok-a",env(1,{wrappedKey:wrapped(i)}),{"if-none-match":"*"})));
  assert.deepEqual(rs.map(r=>r.status).sort(),[201,409,409,409,409]);
 }finally{s.close();}
});

test("no plaintext: stored doc has only {version,wrappedKey,kdf,kdfParams}; key-like fields rejected anywhere",async()=>{
 const db=seed();const {s,call}=await server(db);
 try{
  for(const f of ["key","rawKey","dek","workspaceKey","passphrase","password","plaintext","secret","privateKey","keyMaterial","unwrappedKey","masterKey"]){
   const r=await call("PUT",WS,"tok-a",{...env(1),[f]:wrapped(1,32)},{"if-none-match":"*"});
   assert.equal(r.status,400,f);assert.deepEqual(r.json,{error:"plaintext_rejected"},f);}
  const nested=await call("PUT",WS,"tok-a",env(1,{kdfParams:{...ARGON,key:"x"}}),{"if-none-match":"*"});
  assert.ok([400,422].includes(nested.status));
  assert.equal(stored(db,ha,WS),undefined);
  const ok=await call("PUT",WS,"tok-a",env(1),{"if-none-match":"*"});assert.equal(ok.status,201);
  const doc=stored(db,ha,WS);
  assert.deepEqual(Object.keys(doc).sort(),["kdf","kdfParams","version","wrappedKey"]);
  const walk=(o,p="")=>Object.entries(o).flatMap(([k,v])=>v&&typeof v==="object"?walk(v,p+k+"."):[p+k]);
  for(const k of walk(doc))assert.ok(!/(^|\.)(key|raw|plain|pass|secret|dek|kek|private)/i.test(k)||k==="wrappedKey",k);
  // whole-collection scan: no other doc under the account carries key-like fields
  for(const [k,v] of db.rows)if(k.includes("/key_envelopes/"))assert.deepEqual(Object.keys(v).sort(),["kdf","kdfParams","version","wrappedKey"]);
  const g=await call("GET",WS,"tok-a");assert.deepEqual(Object.keys(g.json).sort(),["kdf","kdfParams","version","wrappedKey"]);
 }finally{s.close();}
});

test("salt: there is no salt field; a top-level salt is 400 invalid_envelope (salt must live inside wrappedKey)",async()=>{
 const db=seed();const {s,call}=await server(db);
 try{
  for(const salt of ["","AAAA",wrapped(1,16),wrapped(1,64)]){
   const r=await call("PUT",WS,"tok-a",{...env(1),salt},{"if-none-match":"*"});assert.equal(r.status,400);assert.deepEqual(r.json,{error:"invalid_envelope"});}
  const inParams=await call("PUT",WS,"tok-a",env(1,{kdfParams:{...ARGON,salt:wrapped(1,16)}}),{"if-none-match":"*"});
  assert.equal(inParams.status,422);assert.deepEqual(inParams.json,{error:"kdf_params_invalid"});
 }finally{s.close();}
});
test.todo("salt length bounds: the API has no salt field, so 'wrong salt length' cannot be checked server-side; docs/API-key-envelope.md does not say the salt is packed in wrappedKey. Needs a documented layout (core owns the wrapping format).");

test("size: just under 4 KB accepted; over 4 KB -> 413 payload_too_large; over 16 KB still JSON 413 body",async()=>{
 const db=seed();const {s,call}=await server(db);
 try{
  // find the largest wrappedKey that fits
  let n=2900;while(Buffer.byteLength(JSON.stringify(env(1,{wrappedKey:wrapped(1,n+3)})))<=MAX_ENVELOPE_BYTES)n+=3;
  const fits=env(1,{wrappedKey:wrapped(1,n)});assert.ok(Buffer.byteLength(JSON.stringify(fits))<=MAX_ENVELOPE_BYTES);
  assert.equal((await call("PUT",WS,"tok-a",fits,{"if-none-match":"*"})).status,201);
  const over=env(2,{wrappedKey:wrapped(1,n+3)});
  const r=await call("PUT",WS,"tok-a",over,{"if-match":"1"});assert.equal(r.status,413);assert.deepEqual(r.json,{error:"payload_too_large"});
  const big=await call("PUT",WS,"tok-a",env(2,{wrappedKey:wrapped(1,20000)}),{"if-match":"1"});
  assert.equal(big.status,413);assert.equal(stored(db,ha,WS).version,1);
 }finally{s.close();}
});
test("BUG: a body over the 16 KB /v2 body-parser limit returns Express's HTML 413, not {error:\"payload_too_large\"}",{todo:"RISK-KE1: free_server.js:77 express.json({limit:'16kb'}) has no JSON error handler"},async()=>{
 const db=seed();const {s,call}=await server(db);
 try{const big=await call("PUT",WS,"tok-a",env(1,{wrappedKey:wrapped(1,20000)}),{"if-none-match":"*"});
  assert.equal(big.status,413);assert.deepEqual(big.json,{error:"payload_too_large"},"got: "+big.text.slice(0,60));}
 finally{s.close();}
});

test("KDF bounds: edges accepted, just outside -> 422 kdf_params_invalid, nothing written",async()=>{
 const db=seed();const {s,call}=await server(db);
 const ok=[{...ARGON,memory:19*MIB},{...ARGON,memory:GIB},{...ARGON,iterations:1},{...ARGON,iterations:10},{...ARGON,parallelism:1},{...ARGON,parallelism:4}];
 const okS=[{...SCRYPT,N:2**14},{...SCRYPT,N:2**20},{...SCRYPT,p:4}];
 const bad=[{...ARGON,memory:19*MIB-1},{...ARGON,memory:GIB+1},{...ARGON,memory:64*GIB},{...ARGON,memory:Number.MAX_SAFE_INTEGER+2},
  {...ARGON,memory:"19922944"},{...ARGON,memory:19922944.5},{...ARGON,iterations:0},{...ARGON,iterations:11},{...ARGON,iterations:1e9},
  {...ARGON,iterations:-1},{...ARGON,parallelism:0},{...ARGON,parallelism:5},{memory:19*MIB,iterations:2},{...ARGON,extra:1}];
 const badS=[{...SCRYPT,N:2**14-1},{...SCRYPT,N:2**20+1},{...SCRYPT,N:2**21},{...SCRYPT,r:7},{...SCRYPT,r:9},{...SCRYPT,p:0},{...SCRYPT,p:5}];
 try{
  let v=0;
  for(const p of ok){const r=await call("PUT",WS,"tok-a",env(++v,{kdfParams:p}),v===1?{"if-none-match":"*"}:{"if-match":String(v-1)});assert.ok([200,201].includes(r.status),JSON.stringify(p)+" "+r.text);}
  for(const p of okS){const r=await call("PUT",WS,"tok-a",env(++v,{kdf:"scrypt",kdfParams:p}),{"if-match":String(v-1)});assert.equal(r.status,200,JSON.stringify(p));}
  const before=JSON.stringify(stored(db,ha,WS));
  for(const p of bad){const r=await call("PUT",WS,"tok-a",env(v+1,{kdfParams:p}),{"if-match":String(v)});assert.equal(r.status,422,JSON.stringify(p));assert.deepEqual(r.json,{error:"kdf_params_invalid"});}
  for(const p of badS){const r=await call("PUT",WS,"tok-a",env(v+1,{kdf:"scrypt",kdfParams:p}),{"if-match":String(v)});assert.equal(r.status,422,JSON.stringify(p));}
  for(const k of ["pbkdf2","Argon2id","",null]){const r=await call("PUT",WS,"tok-a",env(v+1,{kdf:k}),{"if-match":String(v)});assert.equal(r.status,422,String(k));}
  assert.equal(JSON.stringify(stored(db,ha,WS)),before);
 }finally{s.close();}
});

test("account deletion (PR #9 carries the deletion job) removes the envelope; GET then 404",async()=>{
 const db=seed();const {s,call}=await server(db);
 try{
  assert.equal((await call("PUT",WS,"tok-a",env(1),{"if-none-match":"*"})).status,201);
  assert.equal((await call("PUT",WS_B,"tok-b",env(1,{wrappedKey:wrapped(8)}),{"if-none-match":"*"})).status,201);
  const now=1_800_000_000_000;const users=new Set([A,B]);
  const auth={revokeRefreshTokens:async()=>{},deleteUser:async u=>{users.delete(u);},getUser:async u=>{if(!users.has(u))throw Object.assign(Error("gone"),{code:"auth/user-not-found"});return {uid:u};}};
  const stripe={subscriptions:{list:async()=>({has_more:false,data:[]}),cancel:async()=>({})}};
  const svc=createAccountDeletion({db,stripe,bucket:{deleteFiles:async()=>{}},auth,byoProviders:{},hash,now:()=>now});
  const st=await svc.deleteAccount({user:{uid:A,auth_time:Math.floor(now/1000)-10},body:{confirm:"DELETE"}});
  let job;for(let i=0;i<500;i++){job=await svc.jobStatus(st.jobId);if(job?.status==="done"||job?.status==="failed")break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(job.status,"done");
  assert.equal(stored(db,ha,WS),undefined,"envelope doc removed");
  assert.equal([...db.rows.keys()].some(k=>k.startsWith("gd_accounts/"+ha+"/key_envelopes/")),false);
  const g=await call("GET",WS,"tok-a");assert.equal(g.status,404);assert.deepEqual(g.json,{error:"not_found"});
  assert.equal(stored(db,hb,WS_B).wrappedKey,wrapped(8),"other account untouched");
  for(const [k,v] of db.rows)assert.equal(JSON.stringify(v).includes(wrapped()),false,"wrappedKey copied into "+k);
 }finally{s.close();}
});

test("fixtures/key-envelope match the server (regenerated vs committed)",async()=>{
 const {execFileSync}=require("node:child_process");const os=require("node:os");
 const out=fs.mkdtempSync(path.join(os.tmpdir(),"kefx-"));
 execFileSync(process.execPath,[path.join(__dirname,"scripts/export_fixtures.js"),out],{stdio:"ignore"});
 const repo=path.join(__dirname,"../../fixtures/key-envelope");
 const names=fs.readdirSync(repo).sort();assert.deepEqual(fs.readdirSync(path.join(out,"key-envelope")).sort(),names);
 for(const n of names)assert.equal(fs.readFileSync(path.join(out,"key-envelope",n),"utf8"),fs.readFileSync(path.join(repo,n),"utf8"),n);
});
test.todo("wrong passphrase fails cleanly: client-side only (server never sees the passphrase). Owned by core (gendragoon-apps packages/core).");
