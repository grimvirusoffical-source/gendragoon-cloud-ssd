"use strict";
// PR #5 review regressions (Avery's blockers), item 1 only: fail-open lock checks.
// Items 2-8 are covered separately by Casey. Every test here FAILS against PR #5
// head e9ef0e3 (verified locally without the todo marker) and is marked {todo}
// so CI stays honest. Riley: drop the todo marker on each test as its fix lands.
//
// Item 1 — fail-open: a null/missing account project list must LOCK writes (423 workspace_lock)
//   1a scopeFromWorkspace(w, owner, id, null) must report uploadsBlocked        (paid_storage.js)
//   1b listAccountProjects must not return null when canListWorkspaces fails      (workspace_policy.js)
//   1c lockedWrite in free_server.js must 423 when the list is null             (free_server.js)
//   1d transfer_v3 context must 423 a write when the list is unavailable        (transfer_v3.js)
//   1e projectsInSameIndex / registerWorkspaceIndex test hook not reachable from production modules
// No credentials or network beyond a loopback test server; in-memory Firestore + stubs.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const fs=require("node:fs"),path=require("node:path");
const {memoryFirestore}=require("./test_firestore");
const owner=crypto.createHash("sha256").update("pr5-review-owner").digest("hex");
const ID="12345678-1234-4000-8000-000000000001";
const paid={kind:"paid",accountHash:owner,name:"Paid",projectBillingVersion:2,projectStatus:"active",projectFeeStatus:"paid",
  provisioned:true,storageActive:false,performanceActive:false,usedBytes:0,reservedBytes:0};
// Firestore whose workspace collections cannot be listed (no .limit), so canListWorkspaces() fails.
function unlistable(db){
  const col=c=>({...c,limit:undefined,doc:id=>doc(c.doc(id))});
  const doc=d=>({...d,collection:n=>col(d.collection(n))});
  return {...db,collection:n=>col(db.collection(n)),doc:p=>doc(db.doc(p))};
}
const T="EXPECTED FAIL on e9ef0e3 (item 1 fail-open); drop todo when fixed";

test("1a scopeFromWorkspace treats a null project list as locked (uploadsBlocked + 423 workspace_lock body)",{todo:T},()=>{
  const {scopeFromWorkspace}=require("./paid_storage");
  const scope=scopeFromWorkspace(structuredClone(paid),owner,ID,null);
  assert.ok(scope,"owner still gets a (read) scope");
  assert.equal(scope.uploadsBlocked,true,"null list must block uploads, not fail open");
  assert.equal(scope.lock?.error,"workspace_lock");
});
test("1b listAccountProjects never returns null when the store cannot list workspaces (throw or lock sentinel)",{todo:T},async()=>{
  const {listAccountProjects}=require("./workspace_policy");
  const db=unlistable(memoryFirestore([["gd_accounts/"+owner+"/workspaces/"+ID,paid]]));
  let result;try{result=await listAccountProjects(db,owner);}catch(_){return;}
  assert.notEqual(result,null,"returning null lets callers fail open");
});
test("1c free_server lockedWrite responds 423 workspace_lock when the project list is null",{todo:T},async()=>{
  const src=fs.readFileSync(path.join(__dirname,"free_server.js"),"utf8");
  const m=src.match(/async function lockedWrite\(req,res\)\{[\s\S]*?\n\}\n/);
  assert.ok(m,"lockedWrite not found in free_server.js");
  const {summarizeProjects,lockBody}=require("./workspace_policy");
  const lockedWrite=new Function("db","accountKey","listAccountProjects","summarizeProjects","lockBody","return ("+m[0].trim()+")")(
    {},()=>owner,async()=>null,summarizeProjects,lockBody);
  const res={code:null,body:null,status(c){this.code=c;return this;},json(b){this.body=b;return this;}};
  const blocked=await lockedWrite({user:{uid:"u"}},res);
  assert.equal(blocked,true,"null list must block the write");
  assert.equal(res.code,423);assert.equal(res.body?.error,"workspace_lock");
});
test("1d transfer_v3 rejects a write with 423 workspace_lock when the project list is unavailable",{todo:T},async()=>{
  const express=require("express"),{registerTransferV3}=require("./transfer_v3");
  const db=unlistable(memoryFirestore([["gd_accounts/"+owner+"/workspaces/"+ID,paid]]));
  const gov={run:async(_k,_w,fn)=>fn()};
  const app=express();
  registerTransferV3({app,db,bucket:{file:()=>({})},firebaseAuth:(req,_res,next)=>{req.user={uid:"u"};next();},accountKey:()=>owner,
    FieldValue:{serverTimestamp:()=>1},apiKeys:{verify:async()=>null},getAuth:()=>({}),freeGovernor:gov,paidGovernor:gov});
  const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
  try{
    const res=await fetch("http://127.0.0.1:"+server.address().port+"/v3/cloud/"+ID+"/uploads",{method:"POST",
      headers:{"Content-Type":"application/json",Authorization:"Bearer test"},body:JSON.stringify({kind:"file",originalName:"a.bin",sizeBytes:1})});
    assert.equal(res.status,423,"write must be locked when the project list is unavailable");
    assert.equal((await res.json()).error,"workspace_lock");
  }finally{server.close();}
});
test("1e test-only index hook (projectsInSameIndex / registerWorkspaceIndex) is not reachable from production modules",{todo:T},()=>{
  const policy=require("./workspace_policy");
  assert.equal(policy.projectsInSameIndex,undefined,"workspace_policy must not export projectsInSameIndex");
  assert.equal(policy.registerWorkspaceIndex,undefined,"workspace_policy must not export registerWorkspaceIndex");
  for(const f of ["paid_storage.js","projects.js","free_server.js","transfer_v3.js"]){
    const src=fs.readFileSync(path.join(__dirname,f),"utf8");
    assert.doesNotMatch(src,/projectsInSameIndex|registerWorkspaceIndex/,f+" references the test index hook");
  }
});
