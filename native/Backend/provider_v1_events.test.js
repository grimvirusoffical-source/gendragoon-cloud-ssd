"use strict";
// Change polling (/usage changeSeq, list items with generations) and account notices on connect/revoke.
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const express=require("express");
const {memoryFirestore}=require("./test_firestore");
const {memoryBlobStore}=require("./provider_blobstore");
const {registerProviderV1}=require("./provider_v1");

const sha=b=>crypto.createHash("sha256").update(b).digest("hex");
async function rig(){
 const db=memoryFirestore(),blobs=memoryBlobStore(),notices=[];
 const app=express();
 const firebaseAuth=(req,res,next)=>{const uid=req.headers["x-test-uid"];if(!uid)return res.status(401).end();req.user={uid};next();};
 registerProviderV1({app,db,blobs,firebaseAuth,accountKey:u=>sha("gd-v1:"+u),resolveWorkspace:async()=>({quotaBytes:1_000_000}),
  notify:async(uid,kind,details)=>{notices.push({uid,kind,details});if(kind==="provider.revoked")throw Error("mail down");}});
 const server=await new Promise(r=>{const s=app.listen(0,"127.0.0.1",()=>r(s));});
 const base="http://127.0.0.1:"+server.address().port+"/provider/v1";
 const call=(path,{method="GET",uid,key,body,headers={}}={})=>{
  const h={...headers};if(uid)h["x-test-uid"]=uid;if(key)h.authorization="Bearer "+key;
  let b=body;if(body!==undefined&&!Buffer.isBuffer(body)){b=JSON.stringify(body);h["content-type"]="application/json";}
  return fetch(base+path,{method,headers:h,body:b});
 };
 const g=await (await call("/connect/grants",{method:"POST",uid:"alice",body:{workspaceId:"ws",requester:{name:"RedX",host:"mac"}}})).json();
 const c=await (await call("/connect/redeem",{method:"POST",body:{grant:g.grant}})).json();
 return {call,key:c.apiKey,bindingId:c.bindingId,notices,close:()=>server.close()};
}
const settle=()=>new Promise(r=>setTimeout(r,20));

test("changeSeq moves on manifest commits only; lists carry generations",async()=>{
 const t=await rig();try{
  const usage=async()=>(await t.call("/usage",{key:t.key})).json();
  assert.equal((await usage()).changeSeq,0);
  const blob=Buffer.from("chunk");
  assert.equal((await t.call("/blobs/"+sha(blob),{method:"PUT",key:t.key,body:blob})).status,201);
  assert.equal((await usage()).changeSeq,0,"blob writes are not events");
  const mk="a".repeat(64);
  const put=await t.call("/manifests/"+mk,{method:"PUT",key:t.key,body:Buffer.from("v1"),headers:{"if-none-match":"*"}});
  const u1=await usage();
  assert.equal(u1.changeSeq,1);assert.ok(u1.lastChangeAt);
  const list=await (await t.call("/manifests",{key:t.key})).json();
  assert.deepEqual(list.ids,[mk]);
  assert.deepEqual(list.items,[{id:mk,size:2,generation:put.headers.get("etag").replace(/"/g,"")}]);
  const blobs=await (await t.call("/blobs",{key:t.key})).json();
  assert.equal(blobs.items[0].id,sha(blob));assert.ok(blobs.items[0].generation);
  await t.call("/manifests/"+mk,{method:"PUT",key:t.key,body:Buffer.from("v2"),headers:{"if-match":put.headers.get("etag")}});
  assert.equal((await usage()).changeSeq,2);
  // Failed precondition: no change.
  assert.equal((await t.call("/manifests/"+mk,{method:"PUT",key:t.key,body:Buffer.from("v3"),headers:{"if-match":"\"999\""}})).status,412);
  assert.equal((await usage()).changeSeq,2);
  assert.equal((await t.call("/manifests/"+mk,{method:"DELETE",key:t.key})).status,204);
  assert.equal((await usage()).changeSeq,3);
  assert.equal((await t.call("/manifests/"+mk,{method:"DELETE",key:t.key})).status,204);
  assert.equal((await usage()).changeSeq,3,"deleting nothing is not a change");
 }finally{t.close();}
});

test("connect and revoke send notices without keys; a mail failure does not fail revoke",async()=>{
 const t=await rig();try{
  await settle();
  assert.equal(t.notices.length,1);
  assert.deepEqual(t.notices[0],{uid:"alice",kind:"provider.connected",details:{client:{name:"RedX",host:"mac"},workspaceId:"ws"}});
  assert.ok(!JSON.stringify(t.notices).includes("gdp"),"no key, grant or code in a notice");
  const r=await t.call("/bindings/"+t.bindingId,{method:"DELETE",uid:"alice"});
  assert.equal(r.status,200);
  await settle();
  assert.equal(t.notices[1].kind,"provider.revoked");
  assert.equal(t.notices[1].details.dataDeleted,false);
 }finally{t.close();}
});
