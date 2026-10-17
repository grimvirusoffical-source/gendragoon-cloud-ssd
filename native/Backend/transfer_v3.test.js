"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),express=require("express");
const crypto=require("node:crypto"),{Readable}=require("node:stream");
const {registerTransferV3,addRange,nextMissing,profile,CHUNK}=require("./transfer_v3");
const {parseRange}=require("./range_download");
const {TransferGovernor}=require("./performance");
const {TransferGovernor:FreeGovernor}=require("./free_performance");
const hash=x=>crypto.createHash("sha256").update("gd-v1:"+x).digest("hex");
const owner=hash("test-owner"),wid="ad075169-b982-4acb-a26d-7da17915b18f";
function fixture(tier="free",delay=0,saturate=0){
 let release;const barrier=saturate?new Promise(r=>{release=r}):null;
 let reached=false;
 const docs=new Map(),objects=new Map();let active=0,peak=0,generation=1,txQueue=Promise.resolve();
 const stamp=()=>({toMillis:()=>Date.now()});
 function ref(path){return {path,id:path.split("/").at(-1),collection:name=>collection(path+"/"+name),
  get:async()=>({exists:docs.has(path),data:()=>docs.get(path),id:path.split("/").at(-1),ref:ref(path)}),
  create:async d=>{if(docs.has(path))throw Error("EXISTS");docs.set(path,{...d});},
  update:async d=>{const old=docs.get(path);if(!old)throw Error("MISSING");const value={...old};for(const [k,v]of Object.entries(d))value[k]=v&&typeof v==="object"&&"increment"in v?(old[k]||0)+v.increment:v;docs.set(path,value);},
  delete:async()=>docs.delete(path)};}
 function collection(path,filters=[],limit=1e6,cursor=null){return {
  doc:id=>ref(path+"/"+id),where:(k,_op,v)=>collection(path,[...filters,[k,v]],limit,cursor),
  orderBy:()=>collection(path,filters,limit,cursor),limit:n=>collection(path,filters,n,cursor),
  startAfter:s=>collection(path,filters,limit,s.id),
  get:async()=>{let list=[...docs].filter(([k,v])=>k.startsWith(path+"/")&&k.slice(path.length+1).indexOf("/")<0&&filters.every(([a,b])=>v[a]===b));if(cursor)list=list.slice(list.findIndex(([k])=>k.endsWith("/"+cursor))+1);return {docs:list.slice(0,limit).map(([k,v])=>({id:k.split("/").at(-1),data:()=>v,ref:ref(k)}))};}
 };}
 const db={collection,failNextCommit:false,runTransaction:fn=>{
  const run=txQueue.catch(()=>{}).then(async()=>{const writes=[];const result=await fn({get:r=>r.get(),create:(r,d)=>writes.push(()=>r.create(d)),update:(r,d)=>writes.push(()=>r.update(d)),delete:r=>writes.push(()=>r.delete())});if(db.failNextCommit){db.failNextCommit=false;throw Error("Simulated database interruption");}for(const write of writes)await write();return result;});txQueue=run;return run;
 }};
 const bucket={file:key=>({
  save:async(buffer,opts)=>{active++;peak=Math.max(peak,active);try{if(barrier&&!reached){if(active>=saturate){reached=true;release()}let timeout;try{await Promise.race([barrier,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error("Expected concurrency was not reached")),10000)})])}finally{clearTimeout(timeout)}}if(delay)await new Promise(r=>setTimeout(r,delay));if(objects.has(key)&&opts.preconditionOpts?.ifGenerationMatch===0)throw Object.assign(Error("EXISTS"),{code:412});objects.set(key,{buffer:Buffer.from(buffer),generation:String(generation++),metadata:opts.metadata?.metadata||{}});}finally{active--; }},
  getMetadata:async()=>{const v=objects.get(key);if(!v)throw Object.assign(Error("NOT_FOUND"),{code:404});return [{size:String(v.buffer.length),metadata:v.metadata,generation:v.generation}];},
  createReadStream:opts=>{const v=objects.get(key);if(!v)throw Error("NOT_FOUND");return Readable.from([v.buffer.subarray(opts?.start||0,opts?.end===undefined?undefined:opts.end+1)]);},
  delete:async()=>objects.delete(key)
 }),combine:async(keys,target)=>{if(keys.some(k=>!objects.has(k)))throw Error("Missing compose input");objects.set(target,{buffer:Buffer.concat(keys.map(k=>objects.get(k).buffer)),generation:String(generation++),metadata:{}});},
 deleteFiles:async({prefix})=>{for(const key of objects.keys())if(key.startsWith(prefix))objects.delete(key);}};
 const isFree=tier==="free",id=isFree?"free":wid;
 const wsPath=(isFree?"tenants":"gd_accounts")+"/"+owner+"/workspaces/"+id;
 const workspace=isFree?{kind:"free",accountKey:owner,provisioned:true,name:"Test free",usedBytes:0,reservedBytes:0}:
  {kind:"paid",accountHash:owner,provisioned:true,storageActive:true,storageTier:"100GB",storageMode:"standard",performanceActive:tier!=="standard",performanceTier:tier,name:"Test paid",usedBytes:0,reservedBytes:0};
 docs.set(wsPath,workspace);
 const app=express();
 registerTransferV3({app,db,bucket,accountKey:hash,FieldValue:{increment:n=>({increment:n}),serverTimestamp:stamp},
  freeGovernor:new FreeGovernor(),paidGovernor:new TransferGovernor(),
  apiKeys:{verify:async token=>token==="gdsk_read"?{uid:"test-owner",workspaceId:id,scopes:["files:read"]}:null},getAuth:()=>({}),
  firebaseAuth:(req,res,next)=>{if(!["Bearer good","Bearer other"].includes(req.headers.authorization))return res.status(401).end();req.user={uid:req.headers.authorization==="Bearer good"?"test-owner":"other-user"};next();}
 });
 const server=app.listen(0,"127.0.0.1");
 const ready=new Promise(ok=>server.once("listening",ok));
 const call=async(path,options={})=>{await ready;return fetch("http://127.0.0.1:"+server.address().port+"/v3/cloud/"+id+path,{...options,headers:{Authorization:"Bearer good",...options.headers}});};
 const create=async(name,size,requestId=crypto.randomUUID())=>{const r=await call("/uploads",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,sizeBytes:size,requestId})});assert.equal(r.status,201,await r.clone().text());return r.json();};
 const chunk=(id,index,data,sha)=>call("/uploads/"+id+"/chunks/"+index,{method:"PUT",headers:{"Content-Type":"application/octet-stream","X-Chunk-SHA256":sha||hashBytes(data)},body:data});
 return {call,create,chunk,docs,db,objects,wsPath,peak:()=>peak,close:()=>new Promise(r=>server.close(r))};
}
function hashBytes(x){return crypto.createHash("sha256").update(x).digest("hex");}
test("single HTTP byte ranges: suffix, open ended, clamping and invalid ranges",()=>{
 assert.deepEqual(parseRange("bytes=10-19",100),{start:10,end:19});assert.deepEqual(parseRange("bytes=-10",100),{start:90,end:99});
 assert.deepEqual(parseRange("bytes=80-",100),{start:80,end:99});assert.deepEqual(parseRange("bytes=80-999",100),{start:80,end:99});assert.equal(parseRange(undefined,100),null);
 for(const input of ["bytes=-0","bytes=100-","bytes=10-1","bytes=0-1,4-5","bytes=90071992547409930-","invalid"])assert.throws(()=>parseRange(input,100));
});
test("compact out-of-order completion ranges never skip missing chunks",()=>{
 let r=[];for(const i of [3,1,4,1])r=addRange(r,i);assert.deepEqual(r,[[1,1],[3,4]]);assert.equal(nextMissing(r),0);r=addRange(r,0);assert.equal(nextMissing(r),2);r=addRange(r,2);assert.deepEqual(r,[[0,4]]);assert.equal(nextMissing(r),5);
});
test("free upload, resume, SHA verification, range restore and quota integrity",async()=>{
 const f=fixture();try{
  const bytes=crypto.randomBytes(64*1024),requestId=crypto.randomUUID(),job=await f.create("mobile-file.bin",bytes.length,requestId);
  assert.equal((await f.create("mobile-file.bin",bytes.length,requestId)).uploadId,job.uploadId);assert.equal(f.docs.get(f.wsPath).reservedBytes,bytes.length);
  const bad=await f.chunk(job.uploadId,0,bytes,"0".repeat(64));assert.equal(bad.status,422);assert.equal(f.objects.size,0);
  let put=await f.chunk(job.uploadId,0,bytes);assert.equal(put.status,200,await put.text());
  put=await f.chunk(job.uploadId,0,bytes);assert.equal(put.status,200);const conflict=await f.chunk(job.uploadId,0,Buffer.alloc(bytes.length));assert.equal(conflict.status,409);
  const state=await(await f.call("/uploads/"+job.uploadId)).json();assert.deepEqual(state.receivedRanges,[[0,0]]);assert.equal(state.uploadedBytes,bytes.length);
  for(let i=0;i<2;i++){const final=await f.call("/uploads/"+job.uploadId+"/finalize",{method:"POST"});assert.equal(final.status,200,await final.text());}
  assert.equal(f.docs.get(f.wsPath).usedBytes,bytes.length);assert.equal(f.docs.get(f.wsPath).reservedBytes,0);
  const url="/files/"+job.uploadId+"/download",full=await f.call(url);assert.equal(full.status,200);const etag=full.headers.get("etag");assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes);
  const slice=await f.call(url,{headers:{Range:"bytes=12-499"}});assert.equal(slice.status,206);assert.equal(slice.headers.get("content-range"),"bytes 12-499/65536");assert.deepEqual(Buffer.from(await slice.arrayBuffer()),bytes.subarray(12,500));
  const head=await f.call(url,{method:"HEAD"});assert.equal(head.status,200);assert.equal(head.headers.get("content-length"),String(bytes.length));assert.equal((await head.arrayBuffer()).byteLength,0);
  const stale=await f.call(url,{headers:{Range:"bytes=2-4","If-Range":"wrong"}});assert.equal(stale.status,200);await stale.arrayBuffer();
  const valid=await f.call(url,{headers:{Range:"bytes=-5","If-Range":etag}});assert.equal(valid.status,206);assert.deepEqual(Buffer.from(await valid.arrayBuffer()),bytes.subarray(-5));
  const invalid=await f.call(url,{headers:{Range:"bytes=999999-"}});assert.equal(invalid.status,416);
  const removed=await f.call("/files/"+job.uploadId,{method:"DELETE"});assert.equal(removed.status,200);assert.equal(f.docs.get(f.wsPath).usedBytes,0);
 }finally{await f.close();}
});
test("upload recovers when object saved but metadata transaction fails",async()=>{
 const f=fixture();try{const data=Buffer.from("safe retry"),j=await f.create("retry.txt",data.length);f.db.failNextCommit=true;assert.equal((await f.chunk(j.uploadId,0,data)).status,503);assert.equal((await f.chunk(j.uploadId,0,data)).status,200);const s=await(await f.call("/uploads/"+j.uploadId)).json();assert.equal(s.uploadedBytes,data.length);}finally{await f.close();}
});
test("parallel chunks arrive out of order, resume only missing ranges, compose exact bytes",async()=>{
 const f=fixture("boost",10);try{
  const parts=[crypto.randomBytes(CHUNK),crypto.randomBytes(CHUNK),crypto.randomBytes(217)],size=parts.reduce((n,b)=>n+b.length,0),job=await f.create("parallel-app-assets.bin",size);
  let result=await f.chunk(job.uploadId,2,parts[2]);assert.equal(result.status,200);
  const partial=await(await f.call("/uploads/"+job.uploadId)).json();assert.equal(partial.nextIndex,0);assert.deepEqual(partial.receivedRanges,[[2,2]]);
  assert.equal((await f.call("/uploads/"+job.uploadId+"/finalize",{method:"POST"})).status,409);
  for(const r of await Promise.all([1,0].map(i=>f.chunk(job.uploadId,i,parts[i]))))assert.equal(r.status,200,await r.text());
  result=await f.call("/uploads/"+job.uploadId+"/finalize",{method:"POST"});assert.equal(result.status,200,await result.text());
  const downloaded=Buffer.from(await(await f.call("/files/"+job.uploadId+"/download")).arrayBuffer());assert.equal(hashBytes(downloaded),hashBytes(Buffer.concat(parts)));
  assert.equal(f.docs.get(f.wsPath).reservedBytes,0);assert.equal(f.docs.get(f.wsPath).usedBytes,size);
 }finally{await f.close();}
});
test("cancel releases reservation exactly once and rejects further writes",async()=>{
 const f=fixture();try{const j=await f.create("cancel.bin",1024);for(let i=0;i<2;i++)assert.equal((await f.call("/uploads/"+j.uploadId,{method:"DELETE"})).status,200);assert.equal(f.docs.get(f.wsPath).reservedBytes,0);assert.equal((await f.chunk(j.uploadId,0,Buffer.alloc(1024))).status,409);}finally{await f.close();}
});
test("ownership, anonymous rejection, API key scopes and server-only tier enforcement",async()=>{
 const f=fixture();try{
  assert.equal((await f.call("/config",{headers:{Authorization:""}})).status,401);assert.equal((await f.call("/files",{headers:{Authorization:"Bearer other"}})).status,404);
  assert.equal((await f.call("/config",{headers:{Authorization:"Bearer gdsk_read"}})).status,200);
  assert.equal((await f.call("/uploads",{method:"POST",headers:{Authorization:"Bearer gdsk_read","Content-Type":"application/json"},body:'{"name":"x","sizeBytes":1}'})).status,403);
  const config=await(await f.call("/config?workers=24&tier=max")).json();assert.equal(config.transfer.workers,1);assert.equal(config.transfer.artificialBandwidthCapMbps,null);
 }finally{await f.close();}
});
test("unpaid and cancelled paid workspaces do not gain transfer access",async()=>{
 const f=fixture("max");try{f.docs.set(f.wsPath,{...f.docs.get(f.wsPath),storageActive:false});assert.equal((await f.call("/config")).status,403);}finally{await f.close();}
});
test("managed upload accepts metadata above the obsolete 2GB limit without allocating file",async()=>{
 const f=fixture("standard");try{const job=await f.create("large-app-archive.zip",3_000_000_000);assert.equal(job.sizeBytes,3_000_000_000);assert.equal(job.totalChunks,Math.ceil(3_000_000_000/CHUNK));await f.call("/uploads/"+job.uploadId,{method:"DELETE"});}finally{await f.close();}
});
for(const [tier,workers]of [["free",1],["standard",1],["lite",2],["boost",4],["turbo",8],["ultra",12],["max",20]]){
 test(`HTTP transfer path enforces ${tier}: ${workers} simultaneous storage operations`,async()=>{
  const f=fixture(tier,50,workers);try{
   const jobs=[];for(let i=0;i<20;i++)jobs.push(await f.create("bench-"+i+".bin",1024));
   const start=performance.now(),responses=await Promise.all(jobs.map(j=>f.chunk(j.uploadId,0,Buffer.alloc(1024,7))));
   for(const r of responses)assert.equal(r.status,200,await r.text());
   assert.equal(f.peak(),workers);
   console.log("SIMULATED_LATENCY_BENCHMARK",JSON.stringify({tier,workers,peak:f.peak(),files:20,seconds:Number(((performance.now()-start)/1000).toFixed(3)),note:"Local HTTP with mocked storage delay; not an internet speed measurement"}));
  }finally{await f.close();}
 });
}
module.exports={fixture};
