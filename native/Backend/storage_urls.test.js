"use strict";
// V4 signed URL contract. google-auth-library is not asked to mint a token;
// the bucket double records getSignedUrl({version:"v4"}). No network or keys.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const express=require("express");
const {memoryFirestore}=require("./test_firestore");
const {registerStorageUrls,managedBucketPosture,URL_TTL_MS}=require("./storage_urls");
const uid="storage-owner",owner=crypto.createHash("sha256").update("gd-v1:"+uid).digest("hex");
const other="ab".repeat(32);
const wid="12345678-1234-4000-8000-000000000001";
const objectId="a".repeat(32);
const NOW=1_800_000_000_000;
function hash(value){return crypto.createHash("sha256").update("gd-v1:"+value).digest("hex");}
function harness({locked=false,present=true,foreign=false,isWriteLocked}={}){
 const prefix="customer/"+owner+"/managed/"+wid+"/objects/";
 const rows=[];
 if(present)rows.push(["gd_accounts/"+owner+"/workspaces/"+wid,{kind:"paid",accountHash:owner,locked,provisioned:true}]);
 if(foreign)rows.push(["gd_accounts/"+other+"/workspaces/"+wid,{kind:"paid",accountHash:other}]);
 const db=memoryFirestore(rows);
 const signed=[];
 const bucket={name:"gendragoon-managed-test",file(name){return {async getSignedUrl(opts){
  signed.push({name,opts});
  return ["https://storage.googleapis.com/"+bucket.name+"/"+name+"?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Expires=900"];
 }}}};
 const app=express();
 app.use(express.json({limit:"16kb"}));
 registerStorageUrls({app,db,bucket,firebaseAuth:(req,_res,next)=>{req.user={uid};next();},hash,now:()=>NOW,isWriteLocked});
 return {app,db,signed,prefix};
}
async function post(app,body,id=wid){
 const server=app.listen(0,"127.0.0.1");
 await new Promise(r=>server.once("listening",r));
 try{
  const res=await fetch("http://127.0.0.1:"+server.address().port+"/v2/workspaces/"+id+"/storage-urls",
   {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const text=await res.text();
  return {status:res.status,body:text?JSON.parse(text):{}};
 }finally{await new Promise(r=>server.close(r));}
}
test("owner receives a V4 signed URL under the workspace prefix only",async()=>{
 const h=harness();
 const res=await post(h.app,{op:"upload",objects:[objectId]});
 assert.equal(res.status,200);
 assert.equal(res.body.bucket,"gendragoon-managed-test");
 assert.equal(res.body.prefix,h.prefix);
 assert.equal(res.body.mode,"write");
 assert.equal(res.body.op,"upload");
 assert.equal(res.body.urls.length,1);
 assert.equal(res.body.urls[0].object,objectId);
 assert.equal(res.body.urls[0].method,"PUT");
 assert.ok(res.body.urls[0].url.startsWith("https://"));
 assert.ok(res.body.urls[0].url.includes(h.prefix+objectId));
 const expires=Date.parse(res.body.expiresAt);
 assert.equal(expires-NOW,URL_TTL_MS);
 assert.ok(expires-NOW<=15*60*1000);
 assert.equal(h.signed.length,1);
 assert.equal(h.signed[0].name,h.prefix+objectId);
 assert.equal(h.signed[0].opts.version,"v4");
 assert.equal(h.signed[0].opts.action,"write");
 assert.equal(h.signed[0].opts.expires-NOW,URL_TTL_MS);
 assert.equal(h.signed[0].opts.contentType,"application/octet-stream");
 assert.equal(h.signed[0].name.includes(".."),false);
 assert.equal(h.signed[0].name.startsWith("customer/"+owner+"/managed/"+wid+"/"),true);
});
test("a workspace owned by someone else is a 404 and nothing is signed",async()=>{
 const h=harness({present:false,foreign:true});
 const res=await post(h.app,{op:"download",objects:[objectId]});
 assert.equal(res.status,404);
 assert.equal(res.body.error,"not_found");
 assert.equal(h.signed.length,0);
 assert.ok(h.db.rows.has("gd_accounts/"+other+"/workspaces/"+wid));
});
test("a locked workspace refuses upload with 423 and still signs a read-only download",async()=>{
 const h=harness({locked:true});
 const upload=await post(h.app,{op:"upload",objects:[objectId]});
 assert.equal(upload.status,423);
 assert.equal(upload.body.error,"workspace_lock");
 assert.equal(h.signed.length,0);
 const download=await post(h.app,{op:"download",objects:[objectId]});
 assert.equal(download.status,200);
 assert.equal(download.body.mode,"read");
 assert.equal(download.body.urls[0].method,"GET");
 assert.equal(h.signed.length,1);
 assert.equal(h.signed[0].opts.action,"read");
 assert.equal(h.signed[0].name,h.prefix+objectId);
 assert.equal(Object.hasOwn(h.signed[0].opts,"contentType"),false);
});
test("an injected lock check blocks upload even when the workspace row is unlocked",async()=>{
 const h=harness({locked:false,isWriteLocked:async(ctx)=>{
  assert.equal(ctx.accountHash,owner);
  assert.equal(ctx.workspaceId,wid);
  return true;
 }});
 const upload=await post(h.app,{op:"upload",objects:[objectId]});
 assert.equal(upload.status,423);
 const download=await post(h.app,{op:"download",objects:[objectId]});
 assert.equal(download.status,200);
 assert.equal(download.body.mode,"read");
});
test("object ids cannot escape the workspace prefix and plaintext names or keys are refused",async()=>{
 const h=harness();
 const logs=[];
 const previous=console.error;
 console.error=(...args)=>logs.push(args.map(String).join(" "));
 try{
  for(const objects of [["../"+other],[".."],["report.pdf"],["a/b"],["../managed"],[objectId+"/../x"]]){
   const res=await post(h.app,{op:"download",objects});
   assert.equal(res.status,400,JSON.stringify(objects));
   assert.equal(res.body.error,"invalid_object_id");
  }
  const named=await post(h.app,{op:"upload",objects:[objectId],filename:"super-secret-report.pdf",encryptionKey:"not-a-real-key"});
  assert.equal(named.status,400);
  assert.equal(named.body.error,"plaintext_rejected");
  assert.equal(JSON.stringify(named.body).includes("super-secret-report.pdf"),false);
  assert.equal(JSON.stringify(named.body).includes("not-a-real-key"),false);
 }finally{console.error=previous;}
 assert.equal(h.signed.length,0);
 assert.equal(logs.join("\n").includes("super-secret-report.pdf"),false);
 assert.equal(logs.join("\n").includes("not-a-real-key"),false);
 const auth=require("google-auth-library");
 assert.equal(typeof auth.DownscopedClient,"function");
 assert.equal(h.signed.every(call=>call.opts.version==="v4"&&!call.opts.credentialAccessBoundary),true);
});
test("managed bucket posture keeps CMEK, uniform access, and public access prevention",()=>{
 const posture=managedBucketPosture({GDSSD_KMS_KEY:"projects/gendragood-ssd/locations/us-central1/keyRings/gdssd/cryptoKeys/managed-objects"});
 assert.equal(posture.encryption,"CMEK");
 assert.equal(posture.uniformBucketLevelAccess,true);
 assert.equal(posture.publicAccessPrevention,"enforced");
 assert.equal(posture.transport,"TLS");
 assert.equal(posture.clientEncryption,"AES-256-GCM");
 assert.match(posture.kmsKey,/cryptoKeys\/managed-objects$/);
 assert.throws(()=>managedBucketPosture({GDSSD_KMS_KEY:"not-a-resource-name"}),{code:"invalid_kms_key"});
});
