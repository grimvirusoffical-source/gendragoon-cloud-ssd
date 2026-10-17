"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const k=require("./api_keys");
const accountKey=uid=>crypto.createHash("sha256").update("gd-v1:"+uid).digest("hex");
function mockDB(records){
 return {collection:()=>({doc:id=>({get:async()=>({exists:records.has(id),data:()=>records.get(id)})})})};
}
test("API keys are unpredictable, hashed and parsable",()=>{
 const a=k.generate(),b=k.generate();
 assert.notEqual(a.token,b.token);
 assert.match(a.token,/^gdsk_[0-9a-f]{24}_[A-Za-z0-9_-]{43}$/);
 assert.equal(k.parse(a.token).digest,a.digest);
 assert.equal(a.digest.length,64);
 assert.equal(a.token.includes(a.digest),false);
});
test("API key cannot be used after expiry or revocation",async()=>{
 const x=k.generate(),map=new Map();
 const base={ownerUid:"u1",ownerHash:accountKey("u1"),digest:x.digest,
  scopes:["files:read"],workspaceId:"free",termsVersion:"terms-2026-10-14-v1"};
 const environment={db:mockDB(map),accountKey,auth:{getUser:async()=>({disabled:false})}};
 map.set(x.id,{...base,expiresAt:{toMillis:()=>Date.now()+86400000}});
 assert.equal((await k.verify(x.token,environment)).uid,"u1");
 map.set(x.id,{...base,expiresAt:{toMillis:()=>Date.now()-1}});
 assert.equal(await k.verify(x.token,environment),null);
 map.set(x.id,{...base,revokedAt:1,expiresAt:{toMillis:()=>Date.now()+86400000}});
 assert.equal(await k.verify(x.token,environment),null);
});
test("key cannot be swapped or attached to a different Firebase account",async()=>{
 const a=k.generate(),b=k.generate(),records=new Map();
 records.set(a.id,{ownerUid:"u1",ownerHash:accountKey("u2"),digest:a.digest,
 scopes:["files:read"],workspaceId:"free",termsVersion:"terms-2026-10-14-v1",
 expiresAt:{toMillis:()=>Date.now()+50000}});
 const env={db:mockDB(records),auth:{getUser:async()=>({disabled:false})},accountKey};
 assert.equal(await k.verify(a.token,env),null);
 assert.equal(await k.verify(b.token,env),null);
});
test("disabled Firebase accounts are refused",async()=>{
 const a=k.generate(),records=new Map();
 records.set(a.id,{ownerUid:"u1",ownerHash:accountKey("u1"),digest:a.digest,
 scopes:["files:read"],workspaceId:"free",termsVersion:"terms-2026-10-14-v1",
 expiresAt:{toMillis:()=>Date.now()+50000}});
 const env={db:mockDB(records),auth:{getUser:async()=>({disabled:true})},accountKey};
 assert.equal(await k.verify(a.token,env),null);
});
test("read-only key cannot upload or delete",()=>{
 const middleware=k.requireScope("files:write");
 let sent=0;
 const response={status:s=>({json:p=>{sent++;return {s,p}}})};
 middleware({authKind:"api_key",keyScopes:["files:read"]},response,()=>{throw Error("Bad escalation")});
 assert.equal(sent,1);
 let called=false;
 middleware({authKind:"api_key",keyScopes:["files:read","files:write"]},response,()=>called=true);
 assert.equal(called,true);
});
test("unknown and duplicate scopes are rejected",()=>{
 for(const x of [[],["admin"],["files:read","files:read"],null])assert.throws(()=>k.checkScopes(x));
 assert.deepEqual(k.checkScopes(["files:read","files:write"]),["files:read","files:write"]);
});
