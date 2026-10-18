"use strict";
// Subscription cancellation runs outside the Firestore transaction that promotes
// or deletes a workspace. The transaction only records pendingSubscriptionCancels.
// A sweep cancels each one in Stripe and retries from the stored entry.
const MAX_ATTEMPTS=5;

function classifyStripeError(error){
 const code=String(error?.code||error?.raw?.code||"");
 const type=String(error?.type||error?.raw?.type||"");
 const rawType=String(error?.rawType||error?.raw?.type||"");
 const status=Number(error?.statusCode||error?.status||error?.raw?.statusCode||0);
 const message=String(error?.message||"");
 if(code==="resource_missing"||status===404)return "missing";
 if(code==="authentication_error"||code==="permission_error"||
    rawType==="authentication_error"||rawType==="permission_error"||
    type==="StripeAuthenticationError"||type==="StripePermissionError"||
    status===401||status===403)return "permanent";
 if(status===429||status>=500||["ETIMEDOUT","ECONNRESET","ECONNREFUSED","EAI_AGAIN","ENOTFOUND","ABORT_ERR"].includes(code)||
    /timeout|network|socket|ECONN/i.test(message))return "transient";
 return "transient";
}
function backoffMs(attempts){return Math.min(60_000,1000*2**Math.max(0,attempts-1));}
function cancelParams(){return {invoice_now:true,prorate:true,proration_behavior:"create_prorations"};}
function idempotencyKey(subscriptionId){return "gd-sub-cancel-"+subscriptionId;}

function queueCancel(pending,entry){
 const list=Array.isArray(pending)?pending.slice():[];
 if(!entry||typeof entry.subscriptionId!=="string"||!entry.subscriptionId)return list;
 if(list.some(item=>item.subscriptionId===entry.subscriptionId&&item.status!=="done"))return list;
 list.push({subscriptionId:entry.subscriptionId,workspaceId:entry.workspaceId||null,reason:entry.reason||"promoted_to_free",
  attempts:0,status:"pending",nextAttemptAt:0});
 return list;
}
function queueExpire(pending,entry){
 const list=Array.isArray(pending)?pending.slice():[];
 if(!entry||typeof entry.sessionId!=="string"||!entry.sessionId)return list;
 if(list.some(item=>item.sessionId===entry.sessionId))return list;
 list.push({sessionId:entry.sessionId,workspaceId:entry.workspaceId||null});
 return list;
}

// One pass. Call again after nextAttemptAt for transient failures.
// resource_missing is success. authentication_error and permission_error stop immediately.
// Other transient errors retry until MAX_ATTEMPTS, then status "failed" and the same alert.
async function sweepSubscriptionCancels({stripe,pending=[],now=Date.now(),alert=()=>{},onCleared=async()=>{}}={}){
 const cancel=stripe&&stripe.subscriptions&&stripe.subscriptions.cancel;
 const next=[];
 for(const item of pending){
  if(!item||item.status==="failed"||item.status==="done"){if(item&&item.status==="failed")next.push(item);continue;}
  if(item.nextAttemptAt&&item.nextAttemptAt>now){next.push(item);continue;}
  if(typeof cancel!=="function"){next.push(item);continue;}
  try{
   await cancel(item.subscriptionId,cancelParams(),{idempotencyKey:idempotencyKey(item.subscriptionId)});
   await onCleared(item);
  }catch(error){
   const kind=classifyStripeError(error);
   if(kind==="missing"){await onCleared(item);continue;}
   if(kind==="permanent"){
    alert("subscription_cancel_failed",{subscriptionId:item.subscriptionId,workspaceId:item.workspaceId,reason:item.reason,stripeCode:error.code||error.type||kind});
    next.push({...item,status:"failed",attempts:(item.attempts||0)+1,failedAt:now});
    continue;
   }
   const attempts=(item.attempts||0)+1;
   if(attempts>=MAX_ATTEMPTS){
    alert("subscription_cancel_failed",{subscriptionId:item.subscriptionId,workspaceId:item.workspaceId,reason:item.reason,stripeCode:error.code||kind,attempts});
    next.push({...item,status:"failed",attempts,failedAt:now});
   }else next.push({...item,status:"pending",attempts,nextAttemptAt:now+backoffMs(attempts)});
   continue;
  }
 }
 return next;
}

module.exports={MAX_ATTEMPTS,classifyStripeError,backoffMs,cancelParams,idempotencyKey,queueCancel,queueExpire,sweepSubscriptionCancels};
