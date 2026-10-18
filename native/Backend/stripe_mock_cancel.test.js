"use strict";
// Sends the real subscription-cancel request to stripe-mock (stripe/stripe-mock), which validates
// parameters against Stripe's OpenAPI spec. CI runs it as a service and sets STRIPE_MOCK_URL with
// STRIPE_MOCK_REQUIRED=true, so an invalid cancel parameter fails the build. Locally it skips unless
// STRIPE_MOCK_URL is set. stripe-mock accepts any test-mode placeholder key; no real key is used.
const test=require("node:test"),assert=require("node:assert/strict");
const Stripe=require("stripe");
const {STRIPE_API_VERSION}=require("./billing_gateway");
const {cancelParams,idempotencyKey,classifyStripeError,sweepSubscriptionCancels}=require("./billing_jobs");

const url=process.env.STRIPE_MOCK_URL||"";
const required=process.env.STRIPE_MOCK_REQUIRED==="true";
function client(){
 const u=new URL(url);
 return new Stripe("sk_test_123",{apiVersion:STRIPE_API_VERSION,host:u.hostname,port:Number(u.port||80),protocol:u.protocol.replace(":",""),
  maxNetworkRetries:0,timeout:10000});
}
const skip=!url&&!required?"STRIPE_MOCK_URL not set (CI runs stripe-mock)":false;

test("stripe-mock is configured when CI requires it",{skip},()=>{
 assert.ok(url,"STRIPE_MOCK_REQUIRED=true but STRIPE_MOCK_URL is empty");
});
test("the production cancel request is accepted by stripe-mock (DELETE /v1/subscriptions/:id)",{skip},async()=>{
 const sub=await client().subscriptions.cancel("sub_gd_mock",cancelParams(),{idempotencyKey:idempotencyKey("sub_gd_mock")});
 assert.equal(sub.object,"subscription");
});
test("the sweep cancels through the real SDK against stripe-mock and clears the entry",{skip},async()=>{
 const alerts=[],cleared=[];
 const next=await sweepSubscriptionCancels({stripe:client(),now:Date.now(),alert:c=>alerts.push(c),onCleared:async i=>{cleared.push(i.subscriptionId);},
  pending:[{subscriptionId:"sub_gd_sweep",workspaceId:"w",attempts:0,status:"pending",nextAttemptAt:0}]});
 assert.deepEqual(next,[]);assert.deepEqual(cleared,["sub_gd_sweep"]);assert.deepEqual(alerts,[]);
});
test("control: stripe-mock rejects proration_behavior on cancel, and that 400 is permanent",{skip},async()=>{
 let error=null;
 try{await client().subscriptions.cancel("sub_gd_bad",{...cancelParams(),proration_behavior:"create_prorations"});}catch(e){error=e;}
 assert.ok(error,"stripe-mock accepted an invalid cancel parameter; the parameter check would prove nothing");
 assert.equal(error.statusCode,400);
 assert.equal(classifyStripeError(error),"permanent");
});
