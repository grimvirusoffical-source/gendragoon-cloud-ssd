"use strict";
// Shared workspace object purge. This branch has no account-deletion job; deletion
// and this module share one retry/alert shape with subscription cancellation.
const {classifyStripeError,MAX_ATTEMPTS}=require("./billing_jobs");
const ACTIVE_UPLOADS=["active","assembling","committing","composing","verifying"];

function workspacePrefix(owner,workspaceId){return "customer/"+owner+"/managed/"+workspaceId+"/";}
function busyReason(data,{uploadsEmpty=true,now=Date.now()}={}){
 const lock=data?.mergeLock;
 if(lock&&(lock.phase==="copying"||(typeof lock.expiresAtMs==="number"&&lock.expiresAtMs>now)))return "merge_active";
 if((data?.reservedBytes||0)>0||uploadsEmpty===false)return "uploads_pending";
 if(data?.checkoutLease?.expiresAtMs>now)return "checkout_open";
 const sessionPending=["project","workspaceFee","storage","performance","byo"].some(key=>{
  const id=data?.[key+"CheckoutSessionId"];
  return typeof id==="string"&&id.length>0;
 })&&(data?.projectFeeStatus==="pending"||["pending","unpaid"].includes(data?.workspaceFeeStatus||""));
 if(sessionPending)return "checkout_open";
 return null;
}
function subscriptionIdsOf(data){
 return [...new Set(["workspaceFee","storage","performance","byo"].map(key=>data?.[key+"SubscriptionId"]).filter(id=>typeof id==="string"&&id))];
}
function checkoutSessionIdsOf(data){
 return [...new Set(["project","workspaceFee","storage","performance","byo"].map(key=>data?.[key+"CheckoutSessionId"]).filter(id=>typeof id==="string"&&id))];
}
async function drainCollection(db,ref,name){
 for(;;){
  const removed=await db.runTransaction(async tx=>{
   const snap=await tx.get(ref.collection(name).limit(399));
   const docs=snap.docs||[];
   if(!docs.length)return 0;
   for(const doc of docs)tx.delete(doc.ref);
   return docs.length;
  });
  if(!removed)break;
 }
}
async function purgeWorkspace({db,owner,workspaceId,workspaceRef,objectStore,now=Date.now(),alert=()=>{}}={}){
 const markerRef=db.collection("gd_accounts").doc(owner).collection("workspace_purges").doc(workspaceId);
 const existing=await markerRef.get();
 const marker=existing.exists?{...(existing.data()||{})}:{phase:"running",steps:{},attempts:0};
 marker.steps=marker.steps||{};
 const prefix=workspacePrefix(owner,workspaceId);
 async function step(name,fn){
  if(marker.steps[name]==="done")return;
  try{
   await fn();
   marker.steps[name]="done";
   marker.updatedAt=now;
   await markerRef.set(marker,{merge:true});
  }catch(error){
   marker.attempts=(marker.attempts||0)+1;
   marker.steps[name]="error";
   marker.lastError=String(error?.code||error?.message||"purge_failed");
   marker.updatedAt=now;
   await markerRef.set(marker,{merge:true});
   const kind=classifyStripeError(error);
   if(kind==="permanent"||marker.attempts>=MAX_ATTEMPTS){
    alert("workspace_purge_failed",{workspaceId,step:name,attempts:marker.attempts});
   }
   throw error;
  }
 }
 await step("objects",async()=>{
  if(!objectStore)return;
  if(typeof objectStore.deletePrefix==="function"){await objectStore.deletePrefix(prefix);return;}
  const files=await workspaceRef.collection("files").get();
  for(const doc of files.docs||[]){
   const key=doc.data()?.objectKey;
   if(key)await objectStore.delete(key);
  }
 });
 await step("files",()=>drainCollection(db,workspaceRef,"files"));
 await step("uploads",()=>drainCollection(db,workspaceRef,"uploads"));
 await step("record",()=>workspaceRef.delete());
 marker.phase="completed";
 marker.updatedAt=now;
 await markerRef.set(marker,{merge:true});
 return marker;
}

module.exports={ACTIVE_UPLOADS,workspacePrefix,busyReason,subscriptionIdsOf,checkoutSessionIdsOf,purgeWorkspace};
