"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),express=require("express");
const {registerBillingV2}=require("./billing_v2");
const hash=x=>"a".repeat(64),uid="google-uid-A",owner=hash(uid);
const wid="e30e09db-56c6-4d46-a056-44d2e33794e7";
function setup(record){
 const workspace={kind:"paid",accountHash:owner,storageTier:"100GB",
  storageMode:"standard",storageInterval:"month",
  provisioned:false,storageActive:false,
  performanceActive:false,...record};
 const account={stripeCustomerId:"cus_test_own",uid};
 let ads=null;
 const wref={get:async()=>({exists:true,data:()=>workspace}),
   update:async patch=>Object.assign(workspace,patch)};
 const aref={get:async()=>({exists:true,data:()=>account}),
   set:async patch=>Object.assign(account,patch),
   collection:()=>({doc:()=>wref})};
 const adref={get:async()=>({exists:!!ads,data:()=>ads}),
   set:async patch=>{ads={...ads,...patch}}};
 const db={collection:name=>({doc:id=>name==="gd_accounts"?aref:adref}),
  runTransaction:async fn=>fn({get:ref=>ref.get(),set:(ref,data,opts)=>ref.set(data,opts)})};
 const stripe={checkout:{sessions:{listLineItems:async()=>({
  data:[{price:{id:"price_adfree"},quantity:1}]})}},
  paymentIntents:{retrieve:async id=>({id,status:"succeeded",customer:"cus_test_own",
   currency:"usd",amount_received:499,latest_charge:{id:"ch_testads",
    refunded:false,disputed:false,amount_captured:499,amount_refunded:0}})}};
 const app=express();
 const prices={
  "workspace|month":"price_workspace","storage|standard|100GB|month":"price_storage",
  "performance|boost|month":"price_performance",
  "byo|month":"price_byo","one_time|remove_ads":"price_adfree"
 };
 const result=registerBillingV2({app,db,stripe,
  admin:{firestore:{FieldValue:{serverTimestamp:()=>new Date()}}},
  auth:(_req,_res,next)=>next(),agreed:(_req,_res,next)=>next(),hash,prices});
 return {workspace,account,result,ads:()=>ads};
}
const storage=(items=["price_workspace","price_storage"],status="active",customer="cus_test_own")=>({
 id:"sub_storage_test",customer,status,
 metadata:{kind:"storage",accountHash:owner,workspaceId:wid},
 items:{data:items.map(id=>({price:{id},quantity:1}))}
});
test("valid paid storage webhook activates entitlement only for correct Stripe customer and item prices",async()=>{
 const s=setup();
 assert.equal(await s.result.reconcileSubscription(storage()),true);
 assert.equal(s.workspace.storageActive,true);
 assert.equal(s.workspace.storageSubscriptionId,"sub_storage_test");
 const bad=setup();
 assert.equal(await bad.result.reconcileSubscription(storage(["price_wrong","price_storage"])),true);
 assert.equal(bad.workspace.storageActive,false);
 const outsider=setup();
 assert.equal(await outsider.result.reconcileSubscription(storage(undefined,"active","cus_stranger")),false);
 assert.equal(outsider.workspace.storageActive,false);
});
test("cancel or unpaid status immediately revokes existing storage entitlement",async()=>{
 const s=setup();
 await s.result.reconcileSubscription(storage());
 assert.equal(s.workspace.storageActive,true);
 await s.result.reconcileSubscription(storage(undefined,"canceled"));
 assert.equal(s.workspace.storageActive,false);
});
test("performance activates only exact separately subscribed tier",async()=>{
 const s=setup({storageActive:true,provisioned:true,
 pendingPerformanceTier:"boost",pendingPerformanceInterval:"month"});
 const sub={id:"sub_performance_test",customer:"cus_test_own",status:"active",
  metadata:{kind:"performance",accountHash:owner,workspaceId:wid},
  items:{data:[{price:{id:"price_performance"},quantity:1}]}};
 assert.equal(await s.result.reconcileSubscription(sub),true);
 assert.equal(s.workspace.performanceActive,true);
 assert.equal(s.workspace.performanceTier,"boost");
 assert.equal(s.result.effectiveWorkers(s.workspace),4);
 const wrong={...sub,items:{data:[{price:{id:"price_wrong"},quantity:1}]}};
 await s.result.reconcileSubscription(wrong);
 assert.equal(s.workspace.performanceActive,false);
});
test("BYO entitlements never create managed cloud storage or automatic provider credentials",async()=>{
 const sub={id:"sub_byo_test",customer:"cus_test_own",status:"active",
  metadata:{kind:"byo",accountHash:owner,workspaceId:wid},
  items:{data:[{price:{id:"price_byo"},quantity:1}]}};
 const unverified=setup({kind:"byo",storageTier:null,storageInterval:"month",
   manualProviderConfigured:true,byoChallengeVerified:false});
 assert.equal(await unverified.result.reconcileSubscription(sub),true);
 assert.notEqual(unverified.workspace.byoActive,true);
 assert.equal(unverified.workspace.provisioned,false);
 const s=setup({kind:"byo",storageTier:null,storageInterval:"month",
   manualProviderConfigured:true,byoChallengeVerified:true});
 assert.equal(await s.result.reconcileSubscription(sub),true);
 assert.equal(s.workspace.byoActive,true);
 assert.equal(s.workspace.provisioned,false);
});
test("a verified Stripe payment activates permanent ad-free only for own customer and exact price",async()=>{
 const s=setup();
 const session={id:"cs_test_complete",mode:"payment",payment_status:"paid",
  customer:"cus_test_own",payment_intent:"pi_testads",
  metadata:{kind:"remove_ads",uid,accountHash:owner}};
 assert.equal(await s.result.reconcileAds(session),true);
 assert.equal(s.ads().active,true);
 assert.equal(s.ads().stripePaymentIntentId,"pi_testads");
 const bad=setup();
 assert.equal(await bad.result.reconcileAds({...session,payment_status:"unpaid"}),false);
 assert.equal(bad.ads(),null);
 const outsider=setup();
 assert.equal(await outsider.result.reconcileAds({...session,customer:"cus_stranger"}),false);
 assert.equal(outsider.ads(),null);
});
