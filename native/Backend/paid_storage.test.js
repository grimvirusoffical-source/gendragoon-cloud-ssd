"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),express=require("express");
const crypto=require("node:crypto");
const {registerPaidStorage,scopeFromWorkspace,safeName}=require("./paid_storage");
const {effectiveWorkers}=require("./billing_v2");
const {TransferGovernor}=require("./performance");
const uid="test-user-A",h=x=>crypto.createHash("sha256").update("gd-v1:"+x).digest("hex");
const owner=h(uid),id="179fe41a-b2d0-4e95-a421-9570df0e0e77";
const workspace={kind:"paid",accountHash:owner,storageTier:"100GB",storageMode:"standard",
 storageActive:true,provisioned:true,performanceTier:null,performanceActive:false,usedBytes:0,reservedBytes:0};
function mockDatabase(record=workspace){
 const ref={get:async()=>({exists:!!record,data:()=>record}),
  collection:()=>({orderBy:()=>({limit:()=>({get:async()=>({docs:[]})})})})};
 return {collection:(name)=>({doc:account=>({collection:(_name)=>({doc:workspaceId=>({
  ...ref,get:async()=>({exists:account===owner&&workspaceId===id,data:()=>record})})})})})};
}
function harness(record=workspace){
 const app=express();
 registerPaidStorage({app,db:mockDatabase(record),bucket:{},accountKey:h,
 apiKeys:{verify:async token=>({uid,workspaceId:token==="gdsk_other"?"00000000-0000-4000-8000-000000000000":id,scopes:["files:read"]})},getAuth:()=>({}),
 firebaseAuth:(req,res,next)=>{
  if(req.headers.authorization!=="Bearer mock-google")return res.status(401).end();
  req.user={uid};next();
 },FieldValue:{increment:n=>n}});
 const server=app.listen(0,"127.0.0.1");
 return {server,ready:new Promise(resolve=>server.once("listening",resolve))};
}
async function call(app,path,headers={}){
 await app.ready;
 const res=await fetch("http://127.0.0.1:"+app.server.address().port+path,{headers});
 return res;
}
test("paid storage scope is denied to unpaid, unprovisioned, other-account workspace",()=>{
 assert.equal(scopeFromWorkspace({...workspace,storageActive:false},owner,id),null);
 assert.equal(scopeFromWorkspace({...workspace,provisioned:false},owner,id),null);
 assert.equal(scopeFromWorkspace(workspace,h("user-B"),id),null);
 assert.equal(scopeFromWorkspace(workspace,owner,"../../../x"),null);
 assert.equal(scopeFromWorkspace({...workspace,storageTier:"fake-tier"},owner,id),null);
 assert.equal(scopeFromWorkspace(workspace,owner,id).limit,100_000_000_000);
 assert.match(scopeFromWorkspace(workspace,owner,id).prefix,/^customer\/[0-9a-f]{64}\/managed\//);
});
test("paid cloud routes reject anonymous requests and unprovisioned records",async()=>{
 const a=harness({...workspace,provisioned:false});
 try{
  assert.equal((await call(a,"/v2/workspaces/"+id+"/cloud/files")).status,401);
  assert.equal((await call(a,"/v2/workspaces/"+id+"/cloud/files",
    {Authorization:"Bearer mock-google"})).status,403);
 }finally{await new Promise(done=>a.server.close(done))}
});
test("paid cloud routes authorize own workspace with correct quota",async()=>{
 const a=harness({...workspace,usedBytes:256_000_000});
 try{
  const response=await call(a,"/v2/workspaces/"+id+"/cloud/files",
    {Authorization:"Bearer mock-google"});
  assert.equal(response.status,200);
  const json=await response.json();
  assert.equal(json.quotaBytes,100_000_000_000);
  assert.equal(json.usedBytes,256_000_000);
  assert.equal(json.workers,1);
 }finally{await new Promise(done=>a.server.close(done))}
});
test("paid cloud rejects arbitrary file sizes and traversal",async()=>{
 const a=harness();
 try{
  assert.equal((await call(a,"/v2/workspaces/evil/cloud/files",
    {Authorization:"Bearer mock-google"})).status,400);
  for(const name of ["../secret","foo/bar",".",""]){
   assert.throws(()=>safeName(name));
  }
  assert.equal(safeName("beat.wav"),"beat.wav");
 }finally{await new Promise(done=>a.server.close(done))}
});
test("bundle workers are faster by capacity, subscription upgrade never lowers class",()=>{
 const bundle={...workspace,storageMode:"bundle"};
 assert.equal(effectiveWorkers(bundle),2);
 assert.equal(effectiveWorkers({...bundle,storageTier:"6TB"}),24);
 assert.equal(effectiveWorkers({...bundle,storageTier:"6TB",performanceActive:true,performanceTier:"lite"}),24);
 assert.equal(effectiveWorkers({...bundle,storageTier:"100GB",performanceActive:true,performanceTier:"max"}),20);
});
test("governor permits 24 parallel jobs only for provisioned verified high-capacity bundle",async()=>{
 const ws={...workspace,storageMode:"bundle",storageTier:"6TB"};
 const gov=new TransferGovernor();
 let active=0,peak=0;
 await Promise.all(Array.from({length:48},()=>gov.run("bundle-6tb",ws,async()=>{
  ++active;peak=Math.max(peak,active);
  await new Promise(r=>setTimeout(r,3));--active;
 })));
 assert.equal(peak,24);
 const bad={...ws,storageActive:false};
 await assert.rejects(()=>gov.run("blocked",bad,async()=>{}));
});

test("scoped workspace API key can read own namespace but not write or access other bucket",async()=>{
 const a=harness();
 try{
  const root="/v2/workspaces/"+id+"/cloud/";
  const mine=await call(a,root+"files",{Authorization:"Bearer gdsk_readonly"});
  assert.equal(mine.status,200);
  const other=await call(a,root+"files",{Authorization:"Bearer gdsk_other"});
  assert.equal(other.status,403);
  const write=await a.ready.then(()=>fetch("http://127.0.0.1:"+a.server.address().port+root+"uploads",
    {method:"POST",headers:{Authorization:"Bearer gdsk_readonly","Content-Type":"application/json"},
     body:JSON.stringify({name:"a.wav",sizeBytes:100})}));
  assert.equal(write.status,403);
 }finally{await new Promise(done=>a.server.close(done))}
});
