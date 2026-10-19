"use strict";
// Team workspace files on the personal-workspace routes (/v3/cloud/:id,
// /v2/workspaces/:id/cloud, /v2/workspaces/:id/storage-urls) with the team ACL.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {fixture}=require("./test_helpers/transfer_fixture");
const {registerPaidStorage}=require("./paid_storage");
const {issueStorageUrls}=require("./storage_urls");
const {teamScope}=require("./team_storage");
const hash=x=>crypto.createHash("sha256").update("gd-v1:"+x).digest("hex");
const member=hash("test-owner"),other=hash("other-user");
const teamId="7d1c0c0e-55aa-4c2b-9d43-0a7e5b1f2c3d",twid="c0ffee00-1111-4222-8333-444455556666";
const sha=b=>crypto.createHash("sha256").update(b).digest("hex");

function seed(f,{role="member",otherRole=null,workspace={},team={}}={}){
 f.docs.set("gd_team_workspace_index/"+twid,{teamId});
 f.docs.set("gd_teams/"+teamId,{name:"Studio",ownerHash:"o".repeat(64),tier:"team",subscriptionStatus:"active",memberCount:3,...team});
 f.docs.set("gd_teams/"+teamId+"/members/"+member,{memberId:"m1",accountHash:member,role,status:"active",color:"red-300"});
 if(otherRole)f.docs.set("gd_teams/"+teamId+"/members/"+other,{memberId:"m2",accountHash:other,role:otherRole,status:"active",color:"blue-300"});
 f.docs.set("gd_teams/"+teamId+"/workspaces/"+twid,{teamId,name:"Team files",requiredPlans:{storage:"managed",storageTier:"100GB",performanceTier:"turbo",interval:"month"},
  plansStatus:"active",plansSubscriptionId:"sub_tw",payerHash:"o".repeat(64),usedBytes:0,reservedBytes:0,...workspace});
}
async function v3(f,path,{as="good",...options}={}){
 await f.ready;
 return fetch("http://127.0.0.1:"+f.server.address().port+"/v3/cloud/"+twid+path,{...options,headers:{Authorization:"Bearer "+as,...options.headers}});
}
async function upload(f,data,{as="good",name="plan.txt"}={}){
 const r=await v3(f,"/uploads",{as,method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,sizeBytes:data.length})});
 if(r.status!==201)return r;
 const job=await r.json();
 const c=await v3(f,"/uploads/"+job.uploadId+"/chunks/0",{as,method:"PUT",headers:{"Content-Type":"application/octet-stream","X-Chunk-SHA256":sha(data)},body:data});
 assert.equal(c.status,200,await c.clone().text());
 return v3(f,"/uploads/"+job.uploadId+"/finalize",{as,method:"POST"});
}

test("team member uploads and downloads on /v3/cloud/<team workspace id>; objects live under the team prefix",async()=>{
 const f=fixture("turbo");seed(f);
 try{
  const done=await upload(f,Buffer.from("team plan v1"));
  assert.equal(done.status,200,await done.clone().text());
  const {fileId}=await done.json();
  assert.ok([...f.objects.keys()].some(k=>k==="customer/teams/"+teamId+"/"+twid+"/files/"+fileId));
  assert.ok(![...f.objects.keys()].some(k=>k.startsWith("customer/"+member+"/managed/"+twid)),"never in the member's personal prefix");
  const list=await (await v3(f,"/files")).json();
  assert.equal(list.files.length,1);assert.equal(list.usedBytes,12);assert.equal(list.quotaBytes,100e9);
  const dl=await v3(f,"/files/"+fileId+"/download");
  assert.equal(dl.status,200);assert.equal(await dl.text(),"team plan v1");
  const part=await v3(f,"/files/"+fileId+"/download",{headers:{Range:"bytes=5-8"}});
  assert.equal(part.status,206);assert.equal(await part.text(),"plan");
  assert.equal(f.docs.get("gd_teams/"+teamId+"/workspaces/"+twid).usedBytes,12,"quota is counted on the team workspace");
 }finally{await f.close();}
});

test("preload/backup profile: /config reports the team workspace quota and the paid performance plan's workers",async()=>{
 const f=fixture("turbo");seed(f);
 try{
  const r=await v3(f,"/config");assert.equal(r.status,200);
  const c=await r.json();
  assert.equal(c.quotaBytes,100e9);assert.equal(c.name,"Team files");
  assert.equal(c.transfer.workers,require("./billing_v2").effectiveWorkers({kind:"paid",projectBillingVersion:3,plansStatus:"active",projectStatus:"active",provisioned:true,storageActive:true,storageTier:"100GB",performanceActive:true,performanceTier:"turbo"}));
  assert.ok(c.transfer.workers>1,"turbo, not the free single worker");
  assert.ok(c.transfer.defaultPrefetchBytes>0,"preload budget comes from the native profile");
 }finally{await f.close();}
});

test("quota: an upload past the team workspace storage plan is 413",async()=>{
 const f=fixture("turbo");seed(f,{workspace:{usedBytes:100e9-5}});
 try{
  const r=await upload(f,Buffer.from("0123456789"));
  assert.equal(r.status,413);
 }finally{await f.close();}
});

test("ACL: non-members get 404, viewers read only, removed members lose access, API keys never open team storage",async()=>{
 const f=fixture("turbo");seed(f,{otherRole:null});
 try{
  const done=await upload(f,Buffer.from("secret"));const {fileId}=await done.json();
  assert.equal((await v3(f,"/files",{as:"other"})).status,404,"non-member can't tell the workspace exists");
  assert.equal((await v3(f,"/files/"+fileId+"/download",{as:"other"})).status,404);
  // viewer
  f.docs.set("gd_teams/"+teamId+"/members/"+other,{memberId:"m2",accountHash:other,role:"viewer",status:"active",color:"blue-300"});
  assert.equal((await v3(f,"/files",{as:"other"})).status,200);
  assert.equal(await (await v3(f,"/files/"+fileId+"/download",{as:"other"})).text(),"secret");
  const up=await upload(f,Buffer.from("x"),{as:"other"});
  assert.equal(up.status,403);assert.equal((await up.json()).code,"TEAM_ROLE_READ_ONLY");
  const del=await v3(f,"/files/"+fileId,{as:"other",method:"DELETE"});
  assert.equal(del.status,403,"viewers can't delete");
  // kicked
  f.docs.set("gd_teams/"+teamId+"/members/"+other,{memberId:"m2",accountHash:other,role:"member",status:"kicked",color:"blue-300"});
  assert.equal((await v3(f,"/files",{as:"other"})).status,404);
  // API key for a personal workspace never resolves a team workspace
  assert.equal((await v3(f,"/files",{as:"gdsk_read"})).status,403,"key bound to another workspace is refused");
  // platform suspension
  f.docs.set("account_state/"+member,{state:"suspended"});
  assert.equal((await v3(f,"/files")).status,403);
  f.docs.delete("account_state/"+member);
  // member deletes
  assert.equal((await v3(f,"/files/"+fileId,{method:"DELETE"})).status,200);
  assert.equal(f.docs.get("gd_teams/"+teamId+"/workspaces/"+twid).usedBytes,0);
 }finally{await f.close();}
});

test("billing: unpaid plans are 403; lapsed plans or team subscription keep files readable and lock writes (423); custom storage is 409",async()=>{
 let f=fixture("turbo");seed(f,{workspace:{plansStatus:"pending",plansSubscriptionId:null}});
 try{assert.equal((await v3(f,"/files")).status,403);}finally{await f.close();}
 f=fixture("turbo");seed(f);
 try{
  const done=await upload(f,Buffer.from("kept"));const {fileId}=await done.json();
  f.docs.set("gd_teams/"+teamId+"/workspaces/"+twid,{...f.docs.get("gd_teams/"+teamId+"/workspaces/"+twid),plansStatus:"canceled"});
  assert.equal(await (await v3(f,"/files/"+fileId+"/download")).text(),"kept");
  const locked=await upload(f,Buffer.from("new"));
  assert.equal(locked.status,423);assert.equal((await locked.json()).reason,"lapsed");
  f.docs.set("gd_teams/"+teamId+"/workspaces/"+twid,{...f.docs.get("gd_teams/"+teamId+"/workspaces/"+twid),plansStatus:"active"});
  f.docs.set("gd_teams/"+teamId,{...f.docs.get("gd_teams/"+teamId),subscriptionStatus:"unpaid"});
  assert.equal((await upload(f,Buffer.from("new"))).status,423,"team subscription lapse locks writes too");
  assert.equal((await v3(f,"/files")).status,200);
 }finally{await f.close();}
 f=fixture("turbo");seed(f,{workspace:{customStorage:true,requiredPlans:{storage:"custom",performanceTier:"turbo",interval:"month"}}});
 try{assert.equal((await v3(f,"/files")).status,409);}finally{await f.close();}
});

test("v2 /v2/workspaces/<id>/cloud (core client path) serves team workspaces with the same ACL and quota",async()=>{
 const f=fixture("turbo");seed(f,{otherRole:"viewer"});
 registerPaidStorage({app:f.app,db:f.db,bucket:f.bucket,accountKey:hash,FieldValue:{increment:n=>({increment:n}),serverTimestamp:()=>({toMillis:()=>Date.now()})},
  apiKeys:{verify:async()=>null},getAuth:()=>({}),
  firebaseAuth:(req,res,next)=>{req.user={uid:req.headers.authorization==="Bearer good"?"test-owner":"other-user"};next();}});
 const v2=async(path,{as="good",...o}={})=>{await f.ready;return fetch("http://127.0.0.1:"+f.server.address().port+"/v2/workspaces/"+twid+"/cloud"+path,{...o,headers:{Authorization:"Bearer "+as,"Content-Type":"application/json",...o.headers}});};
 try{
  const list=await v2("/files");assert.equal(list.status,200);
  assert.equal((await list.json()).quotaBytes,100e9);
  const up=await v2("/uploads",{method:"POST",body:JSON.stringify({name:"a.txt",sizeBytes:3})});
  assert.equal(up.status,201,await up.clone().text());
  assert.equal(f.docs.get("gd_teams/"+teamId+"/workspaces/"+twid).reservedBytes,3);
  const viewer=await v2("/uploads",{as:"other",method:"POST",body:JSON.stringify({name:"b.txt",sizeBytes:3})});
  assert.equal(viewer.status,403);
  assert.equal((await v2("/files",{as:"other"})).status,200);
  f.docs.set("gd_teams/"+teamId+"/workspaces/"+twid,{...f.docs.get("gd_teams/"+teamId+"/workspaces/"+twid),usedBytes:100e9});
  assert.equal((await v2("/uploads",{method:"POST",body:JSON.stringify({name:"c.txt",sizeBytes:3})})).status,413);
 }finally{await f.close();}
});

test("storage-urls: signed URLs are scoped to the team prefix; viewers can't get write URLs",async()=>{
 const f=fixture("turbo");seed(f,{otherRole:"viewer"});
 const deps={db:f.db,hash,env:{CUSTOMER_BUCKET:"gd-customers"},bucket:{name:"gd-customers"},
  sign:async({objectPath})=>"https://storage.googleapis.com/gd-customers/"+objectPath+"?sig=x"};
 try{
  const ok=await issueStorageUrls(deps,{user:{uid:"test-owner"},params:{id:twid},body:{op:"put",objects:["a".repeat(32)]}});
  assert.equal(ok.prefix,"customer/teams/"+teamId+"/"+twid+"/objects/");
  const read=await issueStorageUrls(deps,{user:{uid:"other-user"},params:{id:twid},body:{op:"get",objects:["a".repeat(32)]}});
  assert.equal(read.mode,"read");
  await assert.rejects(issueStorageUrls(deps,{user:{uid:"other-user"},params:{id:twid},body:{op:"put",objects:["a".repeat(32)]}}),e=>e.status===403&&e.code==="TEAM_ROLE_READ_ONLY");
  await assert.rejects(issueStorageUrls(deps,{user:{uid:"stranger"},params:{id:twid},body:{op:"get",objects:["a".repeat(32)]}}),e=>e.status===404);
 }finally{await f.close();}
});

test("teamScope: owner and member write, viewer reads, unknown roles fall back to member, never-paid is no access",()=>{
 const base={team:{subscriptionStatus:"active"},workspace:{teamId,requiredPlans:{storageTier:"100GB",performanceTier:"boost"},plansStatus:"active"},wid:twid,teamId};
 assert.equal(teamScope({...base,member:{status:"active",role:"owner"}}).canWrite,true);
 assert.equal(teamScope({...base,member:{status:"active",role:"viewer"}}).canWrite,false);
 assert.equal(teamScope({...base,member:{status:"left",role:"member"}}),null);
 assert.equal(teamScope({...base,workspace:{...base.workspace,plansStatus:"pending"},member:{status:"active",role:"member"}}),null);
 const lapsed=teamScope({...base,workspace:{...base.workspace,plansStatus:"canceled",plansEverPaid:true},member:{status:"active",role:"member"}});
 assert.equal(lapsed.uploadsBlocked,true);assert.equal(lapsed.lock.reason,"lapsed");
});
