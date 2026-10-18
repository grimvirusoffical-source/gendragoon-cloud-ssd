"use strict";
// Shared workspace object purge. This branch has no account-deletion job; deletion
// and this module share one retry/alert shape with subscription cancellation.
const {MAX_ATTEMPTS}=require("./billing_jobs");
const ACTIVE_UPLOADS=["active","assembling","committing","composing","verifying"];

function workspacePrefix(owner,workspaceId){return "customer/"+owner+"/managed/"+workspaceId+"/";}
const CHECKOUT_KEYS=["project","workspaceFee","storage","performance","byo"];
// Stripe Checkout sessions last 24 hours unless created with an earlier expires_at.
const CHECKOUT_SESSION_TTL_MS=24*60*60*1000;
function checkoutUnpaid(data){
 return data?.projectFeeStatus==="pending"||["pending","unpaid"].includes(data?.workspaceFeeStatus||"");
}
function storedCheckoutExpired(data,now=Date.now()){
 const at=data?.checkoutExpiresAtMs;
 return typeof at==="number"&&Number.isFinite(at)&&at<=now;
}
// Abandoned: never activated, still waiting for its first payment, and every Checkout it opened has expired.
// It holds no slot and does not count toward the workspace cap.
function abandonedCheckout(data,now=Date.now()){
 if(!data||data.projectStatus!=="pending_payment"||!checkoutUnpaid(data))return false;
 const ids=CHECKOUT_KEYS.map(key=>data[key+"CheckoutSessionId"]).filter(id=>typeof id==="string"&&id);
 return ids.length>0&&storedCheckoutExpired(data,now);
}
// sessions: optional {sessionId: status} resolved from Stripe just before the delete transaction.
// An expired session never blocks. An open session blocks only the first activation Checkout of a
// workspace that is still pending payment; a renewal Checkout on an active workspace in grace is
// expired by the delete instead. A complete session that is not reconciled yet always blocks.
function busyReason(data,{uploadsEmpty=true,now=Date.now(),sessions=null}={}){
 const lock=data?.mergeLock;
 if(lock&&(lock.phase==="copying"||(typeof lock.expiresAtMs==="number"&&lock.expiresAtMs>now)))return "merge_active";
 if((data?.reservedBytes||0)>0||uploadsEmpty===false)return "uploads_pending";
 if(data?.checkoutLease?.expiresAtMs>now)return "checkout_open";
 if(!checkoutUnpaid(data))return null;
 const ids=CHECKOUT_KEYS.map(key=>data?.[key+"CheckoutSessionId"]).filter(id=>typeof id==="string"&&id);
 if(!ids.length)return null;
 const activating=data?.projectStatus==="pending_payment";
 for(const id of ids){
  const status=sessions&&Object.hasOwn(sessions,id)?sessions[id]:null;
  if(status==="expired")continue;
  if(status==="complete"||status==="unknown")return "checkout_open";
  if(status==="open"){if(activating)return "checkout_open";continue;}
  // Not resolved from Stripe: fall back to the stored expiry.
  if(storedCheckoutExpired(data,now))continue;
  if(activating)return "checkout_open";
 }
 return null;
}
function subscriptionIdsOf(data){
 return [...new Set(["workspaceFee","storage","performance","byo"].map(key=>data?.[key+"SubscriptionId"]).filter(id=>typeof id==="string"&&id))];
}
function checkoutSessionIdsOf(data){
 return [...new Set(["project","workspaceFee","storage","performance","byo"].map(key=>data?.[key+"CheckoutSessionId"]).filter(id=>typeof id==="string"&&id))];
}
function errorStatus(error){return Number(error?.code)||Number(error?.statusCode||error?.status||error?.response?.status||0);}
function objectMissing(error){
 return errorStatus(error)===404||error?.code==="NotFound"||error?.code==="NoSuchKey"||/No such object|not found/i.test(String(error?.message||""));
}
function storageErrorPermanent(error){
 const status=errorStatus(error);
 return status===401||status===403||error?.code==="object_store_unavailable";
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
async function purgeWorkspace({db,owner,workspaceId,workspaceRef,objectStore,objectStoreRequired=false,now=Date.now(),alert=()=>{}}={}){
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
   if(storageErrorPermanent(error)||marker.attempts>=MAX_ATTEMPTS){
    alert("workspace_purge_failed",{workspaceId,step:name,attempts:marker.attempts});
   }
   throw error;
  }
 }
 // Fail closed: with file objects and no store, or any store error other than "not found",
 // the step stays in error and the purge is retried. It is never marked done unverified.
 await step("objects",async()=>{
  const files=await workspaceRef.collection("files").get();
  const keys=(files.docs||[]).map(doc=>doc.data()?.objectKey).filter(key=>typeof key==="string"&&key);
  if(!objectStore){
   if(keys.length||objectStoreRequired)throw Object.assign(new Error("object_store_unavailable"),{code:"object_store_unavailable"});
   return;
  }
  if(typeof objectStore.deletePrefix==="function")await objectStore.deletePrefix(prefix);
  // A retry re-deletes objects an earlier attempt already removed: not found counts as deleted.
  for(const key of keys){
   try{await objectStore.delete(key);}catch(error){if(!objectMissing(error))throw error;}
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

module.exports={ACTIVE_UPLOADS,CHECKOUT_KEYS,CHECKOUT_SESSION_TTL_MS,workspacePrefix,busyReason,abandonedCheckout,storedCheckoutExpired,objectMissing,subscriptionIdsOf,checkoutSessionIdsOf,purgeWorkspace};
