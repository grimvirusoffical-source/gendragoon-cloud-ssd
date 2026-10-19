"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {fixture}=require("./test_helpers/transfer_fixture");
const {itemMetadata,profile}=require("./transfer_v3");
const {nativeProfile}=require("./performance");
test("empty files upload, finalize idempotently, list, restore and delete",async()=>{
 const f=fixture();try{
  const j=await f.create("empty file",0);assert.equal(j.totalChunks,0);
  for(let i=0;i<2;i++){
   const r=await f.call("/uploads/"+j.uploadId+"/finalize",{method:"POST"});assert.equal(r.status,200,await r.text());
  }
  const listing=await(await f.call("/files")).json();
  assert.equal(listing.files[0].sizeBytes,0);assert.equal(listing.files[0].kind,"file");
  const d=await f.call("/files/"+j.uploadId+"/download");assert.equal(d.status,200);assert.equal((await d.arrayBuffer()).byteLength,0);
  assert.equal((await f.call("/files/"+j.uploadId+"/download",{headers:{Range:"bytes=0-"}})).status,416);
  assert.equal(f.docs.get(f.wsPath).usedBytes,0);assert.equal(f.docs.get(f.wsPath).reservedBytes,0);
  assert.equal((await f.call("/files/"+j.uploadId,{method:"DELETE"})).status,200);
 }finally{await f.close();}
});
test("folder package metadata survives a real HTTP chunk path and cannot change on resume",async()=>{
 const f=fixture();try{
  const bytes=Buffer.from("a fixture package"),id=crypto.randomUUID();
  const body={requestId:id,name:"Song project",sizeBytes:bytes.length,kind:"folder",originalName:"Song project",
    archiveFormat:"gendragoon-package-v1",manifestSHA256:"a".repeat(64),logicalBytes:800};
  const create=value=>f.call("/uploads",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(value)});
  let r=await create(body);assert.equal(r.status,201,await r.text());
  assert.equal((await create({...body,manifestSHA256:"b".repeat(64)})).status,409);
  assert.equal((await create(body)).status,201);
  assert.equal((await f.chunk(id,0,bytes)).status,200);
  r=await f.call("/uploads/"+id+"/finalize",{method:"POST"});assert.equal(r.status,200,await r.text());
  const row=(await(await f.call("/files")).json()).files[0];
  for(const key of ["kind","originalName","archiveFormat","manifestSHA256","logicalBytes"])assert.equal(row[key],body[key]);
  assert.deepEqual(Buffer.from(await(await f.call("/files/"+id+"/download")).arrayBuffer()),bytes);
 }finally{await f.close();}
});
test("package declarations reject invalid names, shapes and bounds",()=>{
 const good={name:"Game.app",kind:"app",archiveFormat:"gendragoon-package-v1",manifestSHA256:"a".repeat(64),logicalBytes:10};
 assert.equal(itemMetadata(good,30).kind,"app");
 for(const patch of [{originalName:"../Game.app"},{kind:"script"},{kind:"app",archiveFormat:null},{manifestSHA256:"bad"},
  {logicalBytes:-1},{logicalBytes:Number.MAX_SAFE_INTEGER},{archiveFormat:"arbitrary-tar"},{originalName:"plain-file"}])
  assert.throws(()=>itemMetadata({...good,...patch},30));
 assert.throws(()=>itemMetadata({name:"folder",kind:"folder"},0));
});
test("verified performance affects transfer and native preload budgets without a bandwidth cap",()=>{
 const base={kind:"paid",provisioned:true,storageActive:true,storageTier:"100GB",storageMode:"standard"};
 const before=profile(base),after=profile({...base,performanceActive:true,performanceTier:"max"});
 assert.equal(before.workers,1);assert.equal(after.workers,20);
 assert.equal(before.defaultPrefetchBytes,8*1024*1024);assert.equal(after.defaultPrefetchBytes,128*1024*1024);
 assert.equal(after.artificialBandwidthCapMbps,null);assert.equal(after.speedGuarantee,false);
 assert.equal(after.nativeApplication.minimumFreeGiB,10);
 assert.equal(after.nativeApplication.preloadWorkers,8);assert.equal(after.nativeApplication.streamReaders,8);
 assert.throws(()=>nativeProfile({...base,storageActive:false}));
});
function setProject(f,patch={}){
 const value={...f.docs.get(f.wsPath),projectBillingVersion:2,projectStatus:"active",projectFeeStatus:"paid",
   provisioned:true,storageActive:false,performanceActive:false,...patch};f.docs.set(f.wsPath,value);return value;
}
test("an activated basic UUID project performs an exact HTTP roundtrip with2GB quota and one worker",async()=>{
 const f=fixture("standard");try{
  setProject(f);
  const config=await(await f.call("/config")).json();assert.equal(config.quotaBytes,2_000_000_000);assert.equal(config.transfer.workers,1);
  const bytes=Buffer.from("basic project data stays in its owned prefix"),job=await f.create("basic.txt",bytes.length);
  assert.equal((await f.chunk(job.uploadId,0,bytes)).status,200);
  assert.equal((await f.call("/uploads/"+job.uploadId+"/finalize",{method:"POST"})).status,200);
  assert.deepEqual(Buffer.from(await(await f.call("/files/"+job.uploadId+"/download")).arrayBuffer()),bytes);
  assert.equal(f.docs.get(f.wsPath).usedBytes,bytes.length);assert.equal(f.docs.get(f.wsPath).reservedBytes,0);
  const oversized=await f.call("/uploads",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"too large",sizeBytes:2_000_000_001})});
  assert.equal(oversized.status,400);assert.equal(f.docs.get(f.wsPath).reservedBytes,0);
 }finally{await f.close();}
});
test("archived, pending and revoked managed projects cannot read or mutate existing files, even with stale paid-tier fields",async()=>{
 const f=fixture("standard");try{
  setProject(f);const bytes=Buffer.from("retained cloud bytes"),job=await f.create("kept.txt",bytes.length);
  await f.chunk(job.uploadId,0,bytes);await f.call("/uploads/"+job.uploadId+"/finalize",{method:"POST"});
  const before=[...f.objects.values()].map(x=>Buffer.from(x.buffer));
  for(const status of ["archived","pending_payment","payment_confirmed_pending_capacity","payment_revoked"]){
   setProject(f,{projectStatus:status,storageActive:true,storageTier:"6TB",performanceActive:true,performanceTier:"max"});
   for(const path of ["/config","/files","/files/"+job.uploadId+"/download","/uploads/"+job.uploadId])assert.equal((await f.call(path)).status,403,status+path);
   assert.equal((await f.call("/files/"+job.uploadId,{method:"DELETE"})).status,403);
   assert.equal((await f.call("/uploads",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"new",sizeBytes:1})})).status,403);
   assert.equal((await f.chunk(job.uploadId,0,bytes)).status,403);
  }
  assert.deepEqual([...f.objects.values()].map(x=>x.buffer),before);assert.equal(f.docs.get(f.wsPath).usedBytes,bytes.length);
  setProject(f,{projectFeeStatus:"pending"});assert.equal((await f.call("/config")).status,403);
 }finally{await f.close();}
});
test("the existing free project's verified storage and performance upgrades govern quota, profile and real concurrency",async()=>{
 const f=fixture("free",25);try{
  const original=f.docs.get(f.wsPath);f.docs.set(f.wsPath,{...original,storageActive:true,storageTier:"2TB",storageMode:"standard",performanceActive:true,performanceTier:"turbo"});
  const config=await(await f.call("/config")).json();assert.equal(config.quotaBytes,2_000_000_000_000);assert.equal(config.transfer.workers,8);assert.equal(config.transfer.nativeApplication.preloadWorkers,4);
  const bytes=Buffer.from("legacy upgraded"),jobs=await Promise.all(Array.from({length:16},(_,i)=>f.create("item "+i,bytes.length)));
  const results=await Promise.all(jobs.map(j=>f.chunk(j.uploadId,0,bytes)));assert.ok(results.every(r=>r.status===200));assert.equal(f.peak(),8);
  const large=await f.create("metadata above basic quota",2_000_000_001);assert.equal(large.sizeBytes,2_000_000_001);
  assert.equal((await f.call("/uploads/"+large.uploadId,{method:"DELETE"})).status,200);
  const upgraded=f.docs.get(f.wsPath);f.docs.set(f.wsPath,{...upgraded,storageActive:false});
  const lower=await(await f.call("/config")).json();assert.equal(lower.quotaBytes,2_000_000_000);assert.equal(lower.transfer.workers,8);
  f.docs.set(f.wsPath,{...f.docs.get(f.wsPath),performanceActive:false});assert.equal((await(await f.call("/config")).json()).transfer.workers,1);
 }finally{await f.close();}
});
test("an archived legacy free project is denied while its objects and metadata remain retained",async()=>{
 const f=fixture("free");try{
  const bytes=Buffer.from("free archive"),job=await f.create("kept",bytes.length);await f.chunk(job.uploadId,0,bytes);await f.call("/uploads/"+job.uploadId+"/finalize",{method:"POST"});
  f.docs.set(f.wsPath,{...f.docs.get(f.wsPath),projectStatus:"archived",storageActive:true,storageTier:"2TB",performanceActive:true,performanceTier:"turbo"});
  assert.equal((await f.call("/config")).status,403);assert.equal((await f.call("/files")).status,403);
  assert.equal((await f.call("/files/"+job.uploadId+"/download")).status,403);
  assert.equal(f.docs.get(f.wsPath+"/files/"+job.uploadId).sizeBytes,bytes.length);
  assert.ok([...f.objects.values()].some(x=>x.buffer.equals(bytes)));
 }finally{await f.close();}
});
test("queued transfers recheck project activation after waiting and do not write after archival",async()=>{
 const f=fixture("standard",100);try{
  setProject(f);const bytes=Buffer.from("queued"),jobs=await Promise.all(Array.from({length:8},(_,i)=>f.create("queued "+i,bytes.length)));
  const requests=jobs.map(j=>f.chunk(j.uploadId,0,bytes));
  const deadline=Date.now()+2000;while(f.peak()===0&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(f.peak(),1);
  setProject(f,{projectStatus:"archived"});
  const responses=await Promise.all(requests);assert.ok(responses.some(r=>r.status===403));assert.ok(responses.filter(r=>r.status===200).length<=1);
  assert.ok(f.objects.size<=1);
 }finally{await f.close();}
});
test("fresh upload transactions recheck archival for both new uploads and idempotent resume",async()=>{
 for(const resume of [false,true]){
  const f=fixture("standard");try{
   setProject(f);const requestId=crypto.randomUUID(),body={requestId,name:"transaction race",sizeBytes:4};
   if(resume)await f.create(body.name,body.sizeBytes,requestId);
   const original=f.db.runTransaction;
   f.db.runTransaction=fn=>{setProject(f,{projectStatus:"archived"});return original(fn);};
   const r=await f.call("/uploads",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
   assert.equal(r.status,403,"resume="+resume);
   assert.equal(f.docs.get(f.wsPath).reservedBytes,resume?4:0);
  }finally{await f.close();}
 }
});
