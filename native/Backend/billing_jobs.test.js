"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {MAX_ATTEMPTS,classifyStripeError,sweepSubscriptionCancels}=require("./billing_jobs");

function stripeError(fields){return Object.assign(new Error(fields.message||fields.code||"stripe"),fields);}
function pending(id="sub_fee"){return [{subscriptionId:id,workspaceId:"ws",reason:"promoted_to_free",attempts:0,status:"pending",nextAttemptAt:0}];}

test("Stripe resource_missing on cancel counts as done and clears the id",async()=>{
 const cleared=[],alerts=[];
 let calls=0;
 const stripe={subscriptions:{cancel:async()=>{calls++;throw stripeError({code:"resource_missing",statusCode:404,type:"StripeInvalidRequestError"});}}};
 const next=await sweepSubscriptionCancels({stripe,pending:pending("sub_missing"),now:1000,
  alert:(code,detail)=>alerts.push({code,...detail}),onCleared:async item=>{cleared.push(item.subscriptionId);}});
 assert.deepEqual(cleared,["sub_missing"]);
 assert.deepEqual(next,[]);
 assert.deepEqual(alerts,[]);
 assert.equal(calls,1);
});

test("Stripe authentication_error stops retrying and alerts subscription_cancel_failed",async()=>{
 const cleared=[],alerts=[];
 let calls=0;
 const stripe={subscriptions:{cancel:async()=>{calls++;throw stripeError({code:"authentication_error",type:"StripeAuthenticationError",statusCode:401});}}};
 const failed=await sweepSubscriptionCancels({stripe,pending:pending("sub_auth"),now:1000,
  alert:(code,detail)=>alerts.push({code,...detail}),onCleared:async item=>{cleared.push(item.subscriptionId);}});
 assert.deepEqual(cleared,[]);
 assert.equal(failed.length,1);
 assert.equal(failed[0].status,"failed");
 assert.equal(alerts.length,1);
 assert.equal(alerts[0].code,"subscription_cancel_failed");
 assert.equal(alerts[0].subscriptionId,"sub_auth");
 const again=await sweepSubscriptionCancels({stripe,pending:failed,now:1000,
  alert:(code,detail)=>alerts.push({code,...detail}),onCleared:async()=>{}});
 assert.equal(calls,1);
 assert.equal(alerts.length,1);
 assert.equal(again[0].status,"failed");
});

test("Stripe permission_error stops retrying and alerts subscription_cancel_failed",async()=>{
 const alerts=[];
 let calls=0;
 const stripe={subscriptions:{cancel:async()=>{calls++;throw stripeError({code:"permission_error",type:"StripePermissionError",statusCode:403});}}};
 const failed=await sweepSubscriptionCancels({stripe,pending:pending("sub_perm"),now:1000,
  alert:(code,detail)=>alerts.push({code,...detail})});
 assert.equal(failed[0].status,"failed");
 assert.equal(alerts.length,1);
 assert.equal(alerts[0].code,"subscription_cancel_failed");
 await sweepSubscriptionCancels({stripe,pending:failed,now:9_000_000,alert:(code,detail)=>alerts.push({code,...detail})});
 assert.equal(calls,1);
 assert.equal(alerts.length,1);
 assert.equal(classifyStripeError({type:"StripePermissionError",statusCode:403}),"permanent");
 assert.equal(classifyStripeError({rawType:"permission_error"}),"permanent");
});

test("transient Stripe errors retry with backoff for 5 attempts, then alert subscription_cancel_failed",async()=>{
 assert.equal(classifyStripeError({statusCode:500,type:"StripeAPIError"}),"transient");
 assert.equal(classifyStripeError({statusCode:429,code:"rate_limit"}),"transient");
 assert.equal(classifyStripeError({code:"ETIMEDOUT"}),"transient");
 assert.equal(classifyStripeError({code:"ECONNRESET"}),"transient");
 assert.equal(classifyStripeError({message:"network timeout"}),"transient");
 const alerts=[];
 let calls=0;
 const kinds=[
  ()=>{throw stripeError({statusCode:429,code:"rate_limit",type:"StripeRateLimitError"});},
  ()=>{throw stripeError({statusCode:500,type:"StripeAPIError"});},
  ()=>{throw stripeError({code:"ETIMEDOUT",message:"timeout"});},
  ()=>{throw stripeError({code:"ECONNRESET",message:"network socket"});},
  ()=>{throw stripeError({statusCode:503,message:"upstream"});},
 ];
 const stripe={subscriptions:{cancel:async()=>{const fail=kinds[Math.min(calls,kinds.length-1)];calls++;fail();}}};
 let queued=pending("sub_retry");
 let now=10_000;
 for(let attempt=1;attempt<MAX_ATTEMPTS;attempt++){
  queued=await sweepSubscriptionCancels({stripe,pending:queued,now,alert:(code,detail)=>alerts.push({code,...detail})});
  assert.equal(queued[0].status,"pending");
  assert.equal(queued[0].attempts,attempt);
  assert.ok(queued[0].nextAttemptAt>now);
  assert.equal(alerts.length,0);
  const skipped=await sweepSubscriptionCancels({stripe,pending:queued,now,alert:(code,detail)=>alerts.push({code,...detail})});
  assert.equal(skipped[0].attempts,attempt);
  now=queued[0].nextAttemptAt;
 }
 queued=await sweepSubscriptionCancels({stripe,pending:queued,now,alert:(code,detail)=>alerts.push({code,...detail})});
 assert.equal(calls,MAX_ATTEMPTS);
 assert.equal(queued[0].status,"failed");
 assert.equal(queued[0].attempts,MAX_ATTEMPTS);
 assert.equal(alerts.length,1);
 assert.equal(alerts[0].code,"subscription_cancel_failed");
 assert.equal(alerts[0].subscriptionId,"sub_retry");
 const held=calls;
 await sweepSubscriptionCancels({stripe,pending:queued,now:now+86_400_000,alert:(code,detail)=>alerts.push({code,...detail})});
 assert.equal(calls,held);
 assert.equal(alerts.length,1);
});
