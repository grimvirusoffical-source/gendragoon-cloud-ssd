"use strict";
// Shared workspace policy for the Mac client and the Firebase/Stripe backend.
// The base workspace is free. Each additional workspace is its own $5/month
// subscription. This module only decides allowance; it does not migrate or
// rewrite stored billing records.
// A lapsed login keeps 1 free workspace plus every workspace with an active
// paid subscription. Example: 8 open workspaces and 5 active subscriptions
// means 2 unpaid extras must be removed or merged (8 - (1 + 5)).
const MONTHLY_CENTS=500,DEFAULT_LIMIT=10,QUALIFIED_LIMIT=20;
const MEDIUM_STORAGE=Object.freeze(["1TB","2TB","3TB"]);
const HIGHEST_STORAGE=Object.freeze(["4TB","5TB","6TB"]);
const MEDIUM_PERFORMANCE=Object.freeze(["turbo"]);
const HIGHEST_PERFORMANCE=Object.freeze(["ultra","max"]);
const QUALIFYING_STORAGE=new Set([...MEDIUM_STORAGE,...HIGHEST_STORAGE]);
const QUALIFYING_PERFORMANCE=new Set([...MEDIUM_PERFORMANCE,...HIGHEST_PERFORMANCE]);
const ACTIVE_SUBSCRIPTION=new Set(["active","trialing"]);

function periodEndMs(workspace){
 const end=workspace?.workspaceCurrentPeriodEnd;
 if(typeof end!=="number"||!Number.isFinite(end))return 0;
 return end>1e12?end:end*1000;
}
function isArchived(workspace){return workspace?.projectStatus==="archived";}
function isPaidWorkspace(workspace,now=Date.now()){
 if(!workspace||isArchived(workspace))return false;
 if(workspace.projectFeeStatus==="owner")return true;
 // A subscription row is authoritative once billing has written one. A stored
 // one-time "paid" flag with no subscription row is left unchanged.
 if(workspace.workspaceSubscriptionId||workspace.workspaceSubscriptionStatus){
  if(!ACTIVE_SUBSCRIPTION.has(workspace.workspaceSubscriptionStatus))return false;
  return periodEndMs(workspace)>now;
 }
 return workspace.projectFeeStatus==="paid";
}
function storageTierQualifies(tier,{active=false}={}){return active===true&&QUALIFYING_STORAGE.has(tier);}
function performanceTierQualifies(tier,{active=false}={}){return active===true&&QUALIFYING_PERFORMANCE.has(tier);}
function tierQualifies(workspace){
 return storageTierQualifies(workspace?.storageTier,{active:workspace?.storageActive===true})||
   performanceTierQualifies(workspace?.performanceTier,{active:workspace?.performanceActive===true});
}
function reconcileAccount(workspaces,now=Date.now()){
 const rows=(Array.isArray(workspaces)?workspaces:[]).filter(workspace=>workspace&&typeof workspace==="object");
 const open=rows.filter(workspace=>!isArchived(workspace));
 const paid=open.filter(workspace=>isPaidWorkspace(workspace,now));
 const unpaid=open.filter(workspace=>!isPaidWorkspace(workspace,now));
 const freeAllowance=1;
 const allowed=open.length===0?0:paid.length+freeAllowance;
 const excess=Math.max(0,open.length-allowed);
 const blocked=excess>0;
 const paidIds=paid.map(workspace=>workspace.id);
 const unpaidIds=unpaid.map(workspace=>workspace.id);
 return {monthlyCents:MONTHLY_CENTS,openCount:open.length,paidCount:paid.length,unpaidCount:unpaid.length,
   freeAllowance,allowed,excess,blocked,minimumKept:allowed,paidIds,unpaidIds,
   removableIds:blocked?unpaidIds:[]};
}
function mergeFilePlan(sourceFiles,targetFiles){
 const usedIds=new Set(targetFiles.map(file=>file.id));
 const usedNames=new Set(targetFiles.map(file=>file.name));
 return sourceFiles.map(file=>{
   let id=file.id,name=file.name,n=1;
   while(usedIds.has(id)||usedNames.has(name)){
     n+=1;id=file.id+"-merged-"+n;name=n===2?file.name+" (merged)":file.name+" (merged "+n+")";
   }
   usedIds.add(id);usedNames.add(name);
   return {fromId:file.id,toId:id,name,data:{...file.data,name,mergedFromFileId:file.id}};
 });
}
function qualificationLabel(){
 return "medium or highest storage (1 TB, 2 TB, 3 TB, or 4–6 TB) OR medium or highest performance (Turbo, or Ultra/Max)";
}

module.exports={MONTHLY_CENTS,DEFAULT_LIMIT,QUALIFIED_LIMIT,MEDIUM_STORAGE,HIGHEST_STORAGE,
 MEDIUM_PERFORMANCE,HIGHEST_PERFORMANCE,QUALIFYING_STORAGE,QUALIFYING_PERFORMANCE,
 isPaidWorkspace,isArchived,storageTierQualifies,performanceTierQualifies,tierQualifies,
 reconcileAccount,mergeFilePlan,qualificationLabel,periodEndMs};
