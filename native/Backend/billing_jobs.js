"use strict";
// Subscription cancellation runs outside the Firestore transaction that promotes
// or deletes a workspace. The transaction only records pendingSubscriptionCancels.
// A sweep cancels each one in Stripe and retries from the stored entry.
const MAX_ATTEMPTS=5;

// Stripe error classes for DELETE /v1/subscriptions/:id.
// missing: only code resource_missing (the subscription is already gone). A bare 404 is not proof.
// permanent: 400 invalid_request_error, 401, 403 and any other non-retryable 4xx. Alert once and stop.
// transient: 429, 5xx, network errors and timeouts. Retried up to MAX_ATTEMPTS.
const NETWORK_CODES=["ETIMEDOUT","ECONNRESET","ECONNREFUSED","EAI_AGAIN","ENOTFOUND","EPIPE","ABORT_ERR","UND_ERR_CONNECT_TIMEOUT","UND_ERR_SOCKET"];
function classifyStripeError(error){
 const code=String(error?.code||error?.raw?.code||"");
 const type=String(error?.type||"");
 const rawType=String(error?.rawType||error?.raw?.type||"");
 const status=Number(error?.statusCode||error?.status||error?.raw?.statusCode||0);
 const message=String(error?.message||"");
 if(code==="resource_missing")return "missing";
 if(status===429||status>=500||NETWORK_CODES.includes(code)||
    type==="StripeConnectionError"||type==="StripeAPIError"||type==="StripeRateLimitError"||
    (!status&&/timeout|timed out|network|socket|ECONN/i.test(message)))return "transient";
 if(status===401||status===403||status===400||status===404||
    rawType==="invalid_request_error"||rawType==="authentication_error"||rawType==="permission_error"||
    type==="StripeInvalidRequestError"||type==="StripeAuthenticationError"||type==="StripePermissionError"||
    code==="authentication_error"||code==="permission_error")return "permanent";
 if(status>=400&&status<500&&status!==409)return "permanent";
 return "transient";
}
function backoffMs(attempts){return Math.min(60_000,1000*2**Math.max(0,attempts-1));}
// DELETE /v1/subscriptions/:id accepts cancellation_details, expand, invoice_now and prorate.
// proration_behavior belongs to subscription updates and makes Stripe answer 400.
function cancelParams(){return {invoice_now:true,prorate:true};}
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
// resource_missing is success. A permanent error (400, 401, 403) alerts once and stops.
// Transient errors (429, 5xx, network, timeout) retry until MAX_ATTEMPTS, then "failed" and the same alert.
async function sweepSubscriptionCancels({stripe,pending=[],now=Date.now(),alert=()=>{},onCleared=async()=>{}}={}){
 const cancel=stripe&&stripe.subscriptions&&stripe.subscriptions.cancel;
 const next=[];
 for(const item of pending){
  if(!item||item.status==="failed"||item.status==="done"){if(item&&item.status==="failed")next.push(item);continue;}
  if(item.nextAttemptAt&&item.nextAttemptAt>now){next.push(item);continue;}
  if(typeof cancel!=="function"){next.push(item);continue;}
  try{
   // Called on the resource, not as a detached function: the Stripe SDK needs its `this`.
   await stripe.subscriptions.cancel(item.subscriptionId,cancelParams(),{idempotencyKey:idempotencyKey(item.subscriptionId)});
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
