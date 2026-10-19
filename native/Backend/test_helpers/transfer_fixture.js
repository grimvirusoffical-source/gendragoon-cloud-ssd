"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),express=require("express");
const crypto=require("node:crypto"),{Readable}=require("node:stream");
const {registerTransferV3,addRange,nextMissing,profile,CHUNK}=require("../transfer_v3");
const {parseRange}=require("../range_download");
const {TransferGovernor}=require("../performance");
const {TransferGovernor:FreeGovernor}=require("../free_performance");
const hash=x=>crypto.createHash("sha256").update("gd-v1:"+x).digest("hex");
const owner=hash("test-owner"),wid="ad075169-b982-4acb-a26d-7da17915b18f";
function fixture(tier="free",delay=0){
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
  save:async(buffer,opts)=>{active++;peak=Math.max(peak,active);try{if(delay)await new Promise(r=>setTimeout(r,delay));if(objects.has(key)&&opts.preconditionOpts?.ifGenerationMatch===0)throw Object.assign(Error("EXISTS"),{code:412});objects.set(key,{buffer:Buffer.from(buffer),generation:String(generation++),metadata:opts.metadata?.metadata||{}});}finally{active--; }},
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
 return {app,server,ready,call,create,chunk,docs,db,bucket,objects,wsPath,peak:()=>peak,close:()=>new Promise(r=>server.close(r))};
}
function hashBytes(x){return crypto.createHash("sha256").update(x).digest("hex");}
module.exports={fixture};
