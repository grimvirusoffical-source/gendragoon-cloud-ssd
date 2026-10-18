"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {reconcileAccount,isPaidWorkspace,mergeFilePlan,tierQualifies,MONTHLY_CENTS}=require("./workspace_subscriptions");
const {createProjectService}=require("./projects");
const {memoryFirestore}=require("./test_firestore");
const now=Date.parse("2026-10-18T00:00:00Z");
const future=now+86_400_000,past=now-1000;
const id=n=>"aaaaaaaa-bbbb-4ccc-8ddd-"+String(n).padStart(12,"0");
function workspace(n,patch){return {id:id(n),name:"Workspace "+n,projectStatus:"active",...patch};}
function paid(n,patch){return workspace(n,{workspaceSubscriptionStatus:"active",workspaceCurrentPeriodEnd:future,...patch});}

test("eight workspaces with five active subscriptions keep the free workspace plus those five",()=>{
 const rows=[...Array.from({length:5},(_,n)=>paid(n+1)),...Array.from({length:3},(_,n)=>workspace(n+6,{projectFeeStatus:"free"}))];
 const report=reconcileAccount(rows,now);
 assert.equal(report.openCount,8);assert.equal(report.paidCount,5);assert.equal(report.freeAllowance,1);assert.equal(report.allowed,6);
 assert.equal(report.excess,2);assert.equal(report.blocked,true);assert.equal(MONTHLY_CENTS,500);
 assert.deepEqual(report.removableIds,[id(6),id(7),id(8)]);
 assert.equal(report.removableIds.some(value=>report.paidIds.includes(value)),false);
});
test("the free workspace stays beside every paid subscription",()=>{
 const unpaid=Array.from({length:8},(_,n)=>workspace(n+1,{projectFeeStatus:"lapsed",workspaceSubscriptionStatus:"canceled",workspaceCurrentPeriodEnd:past}));
 const none=reconcileAccount(unpaid,now);
 assert.equal(none.paidCount,0);assert.equal(none.allowed,1);assert.equal(none.excess,7);assert.equal(none.blocked,true);
 assert.equal(reconcileAccount([workspace(1,{projectFeeStatus:"free"})],now).blocked,false);
 assert.equal(reconcileAccount(Array.from({length:5},(_,n)=>paid(n+1)),now).blocked,false);
 const mixed=reconcileAccount([workspace(1,{projectFeeStatus:"free"}),...Array.from({length:5},(_,n)=>paid(n+2))],now);
 assert.equal(mixed.openCount,6);assert.equal(mixed.paidCount,5);assert.equal(mixed.allowed,6);assert.equal(mixed.excess,0);
 assert.equal(mixed.blocked,false);assert.deepEqual(mixed.removableIds,[]);
});
test("owner waiver counts as paid, and a period that has ended does not",()=>{
 assert.equal(isPaidWorkspace(workspace(1,{projectFeeStatus:"owner"}),now),true);
 assert.equal(isPaidWorkspace(workspace(2,{workspaceSubscriptionStatus:"trialing",workspaceCurrentPeriodEnd:future}),now),true);
 assert.equal(isPaidWorkspace(workspace(3,{projectFeeStatus:"paid",workspaceSubscriptionStatus:"active",workspaceCurrentPeriodEnd:past}),now),false);
 assert.equal(isPaidWorkspace(workspace(4,{projectFeeStatus:"paid"}),now),true);
 assert.equal(isPaidWorkspace(workspace(6,{projectFeeStatus:"paid",workspaceSubscriptionStatus:"canceled",workspaceCurrentPeriodEnd:past}),now),false);
 assert.equal(isPaidWorkspace(workspace(5,{projectFeeStatus:"free",workspaceSubscriptionStatus:"active",workspaceCurrentPeriodEnd:future,projectStatus:"archived"}),now),false);
});
test("medium or highest storage or performance qualifies, and lower tiers do not",()=>{
 assert.equal(tierQualifies({storageActive:true,storageTier:"2TB",storageMode:"standard",performanceActive:false}),true);
 assert.equal(tierQualifies({storageActive:true,storageTier:"1TB"}),true);
 assert.equal(tierQualifies({storageActive:true,storageTier:"6TB"}),true);
 assert.equal(tierQualifies({storageActive:true,storageTier:"100GB",performanceActive:true,performanceTier:"boost"}),false);
 assert.equal(tierQualifies({storageActive:false,storageTier:"100GB",performanceActive:true,performanceTier:"turbo"}),true);
 assert.equal(tierQualifies({storageActive:true,storageTier:"500GB",performanceActive:true,performanceTier:"ultra"}),true);
 assert.equal(tierQualifies({storageActive:true,storageTier:"500GB",performanceActive:true,performanceTier:"max"}),true);
 assert.equal(tierQualifies({storageActive:false,storageTier:"2TB",storageMode:"bundle"}),false);
});
test("merging moves source files onto the kept workspace and renames collisions",()=>{
 const plan=mergeFilePlan(
   [{id:"a",name:"notes.txt",data:{name:"notes.txt",sizeBytes:4}},{id:"b",name:"clip.mov",data:{name:"clip.mov",sizeBytes:9}}],
   [{id:"a",name:"notes.txt"},{id:"kept",name:"clip.mov"}]);
 assert.deepEqual(plan.map(file=>({toId:file.toId,name:file.name})),[
   {toId:"a-merged-2",name:"notes.txt (merged)"},{toId:"b-merged-2",name:"clip.mov (merged)"}]);
 assert.equal(plan[0].data.mergedFromFileId,"a");assert.equal(plan[0].data.sizeBytes,4);
});
test("merge copies file records into the kept workspace and refuses a paid source",async()=>{
 const crypto=require("node:crypto");
 const owner=crypto.createHash("sha256").update("lapse-owner").digest("hex");
 const db=memoryFirestore([["gd_accounts/"+owner,{stripeCustomerId:"cus_own"}]]);
 const service=createProjectService({db,stamp:()=>123,hash:()=>owner,stripe:{},env:{},ensureCustomer:async()=>"cus_own"});
 const req={user:{uid:"owner"}};
 const future=Date.now()+86_400_000;
 const paidIds=[],unpaidIds=[];
 for(let n=1;n<=5;n++){
  const wid=id(n);
  db.rows.set("gd_accounts/"+owner+"/workspaces/"+wid,{name:"Paid "+n,kind:"paid",accountHash:owner,projectStatus:"active",projectBillingVersion:2,projectFeeStatus:"paid",provisioned:true,workspaceSubscriptionStatus:"active",workspaceCurrentPeriodEnd:future});
  paidIds.push(wid);
 }
 for(let n=6;n<=8;n++){
  const wid=id(n);
  db.rows.set("gd_accounts/"+owner+"/workspaces/"+wid,{name:"Unpaid "+n,kind:"paid",accountHash:owner,projectStatus:"active",projectBillingVersion:2,projectFeeStatus:"lapsed",provisioned:true,workspaceSubscriptionStatus:"canceled",workspaceCurrentPeriodEnd:now-1000});
  unpaidIds.push(wid);
 }
 db.rows.set("gd_accounts/"+owner+"/workspaces/"+id(6)+"/files/notes",{name:"notes.txt",sizeBytes:4});
 db.rows.set("gd_accounts/"+owner+"/workspaces/"+id(1)+"/files/notes",{name:"notes.txt",sizeBytes:1});
 const moved=[];
 await assert.rejects(service.mergeUnpaid(req,{sourceId:id(1),targetId:id(6),confirmName:"Paid 1"},async()=>{}),{code:"PAID_WORKSPACE_KEPT"});
 const result=await service.mergeUnpaid(req,{sourceId:id(6),targetId:id(1),confirmName:"Unpaid 6"},async file=>{moved.push(file);});
 assert.equal(result.files.length,1);assert.equal(result.files[0].name,"notes.txt (merged)");
 assert.equal(db.rows.get("gd_accounts/"+owner+"/workspaces/"+id(1)+"/files/"+result.files[0].toId).sizeBytes,4);
 assert.equal(db.rows.get("gd_accounts/"+owner+"/workspaces/"+id(6)).projectStatus,"archived");
 assert.equal(moved[0].toId,result.files[0].toId);
 assert.equal(result.reconciliation.excess,1);assert.equal(result.reconciliation.paidCount,5);assert.equal(result.reconciliation.allowed,6);
 assert.deepEqual(unpaidIds.slice(1).sort(),result.reconciliation.removableIds.sort());
});
