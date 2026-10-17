"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),express=require("express");
const {environmentGuard,parsePrices,installedBilling}=require("./billing_gateway");
const {STORAGE,PERFORMANCE}=require("./catalog");
const {storageQuote,byoQuote,performanceQuote,priceKeysStorage,priceKeysBYO,
 matchesStripePrices,effectiveWorkers}=require("./billing_v2");
const {TransferGovernor,rcloneLimits}=require("./performance");
test("no production checkout with missing webhook, secret or approval",()=>{
 assert.equal(environmentGuard({}).enabled,false);
 assert.throws(()=>environmentGuard({STRIPE_CHECKOUT_ENABLED:"true"}),/requires Stripe API and webhook/);
 const base={STRIPE_CHECKOUT_ENABLED:"true",STRIPE_SECRET_KEY:"sk_live_dummyABC123",
 STRIPE_WEBHOOK_SECRET:"whsec_dummyABC123",PUBLIC_URL:"https://example.com",STRIPE_ENVIRONMENT:"live"};
 assert.throws(()=>environmentGuard(base),/PAID_STORAGE_READY/);
 assert.equal(environmentGuard({...base,PAID_STORAGE_READY:"approved"}).enabled,true);
 assert.throws(()=>environmentGuard({...base,STRIPE_ENVIRONMENT:"test"}),/mismatch/);
});
test("price catalog rejects invalid injected price identifiers",()=>{
 assert.deepEqual(parsePrices("{}"),{});
 assert.throws(()=>parsePrices('{"fee":"a malicious price"}'),/Invalid Stripe price identifier/);
 assert.throws(()=>parsePrices('[1]'),/invalid/);
});
test("all ten storage tiers are quotable monthly or yearly, exact $5 fee",()=>{
 assert.equal(Object.keys(STORAGE).length,10);
 for(const [tier,t] of Object.entries(STORAGE)){
  for(const period of ["month","year"]){
   for(const mode of ["bundle","standard"]){
    const q=storageQuote(tier,period,mode);
    const factor=period==="month"?1:10;
    assert.equal(q.storageGB,t.gb);
    assert.equal(q.totalCents,(t[mode]+500)*factor);
    assert.equal(q.workspaceFeeCents,500*factor);
    assert.deepEqual(priceKeysStorage(q),["workspace|"+period,"storage|"+mode+"|"+tier+"|"+period]);
   }
  }
 }
});
test("all performance plans support month/year and workers are verifiably enforced",async()=>{
 const governor=new TransferGovernor();
 for(const [tier,v] of Object.entries(PERFORMANCE)){
  for(const period of ["month","year"]){
   const q=performanceQuote(tier,period);
   assert.equal(q.totalCents,v.cents*(period==="year"?10:1));
   assert.equal(q.workerLimit,v.workers);
  }
  const ws={kind:"paid",storageActive:true,storageTier:"100GB",provisioned:true,
    performanceActive:true,performanceTier:tier};
  assert.equal(rcloneLimits(ws)[1],String(v.workers));
  let n=0,m=0;
  await Promise.all(Array.from({length:36},()=>governor.run("performance-"+tier,ws,async()=>{
   n++;m=Math.max(n,m);await new Promise(r=>setTimeout(r,2));n--;
  })));
  assert.equal(m,Math.min(v.workers,36));
 }
});
test("BYO service is $10 monthly / $100 annual and requires manually configured credentials",()=>{
 assert.equal(byoQuote("month").totalCents,1000);
 assert.equal(byoQuote("year").totalCents,10000);
 assert.deepEqual(priceKeysBYO(byoQuote("year")),["byo|year"]);
 assert.equal(effectiveWorkers({kind:"byo",byoActive:true,manualProviderConfigured:false}),0);
 assert.equal(effectiveWorkers({kind:"byo",byoActive:true,manualProviderConfigured:true}),1);
 assert.equal(effectiveWorkers({kind:"byo",byoActive:false,manualProviderConfigured:true}),0);
});
test("mismatched Stripe price IDs and injected extra quantity never grant entitlements",()=>{
 const sub={items:{data:[{price:{id:"price_storage"},quantity:2},{price:{id:"price_fee"},quantity:1}]}};
 assert.equal(matchesStripePrices(sub,["price_storage","price_fee"]),false);
 assert.equal(matchesStripePrices(sub,["price_storage","price_storage","price_fee"]),false);
 assert.equal(matchesStripePrices({items:{data:[{price:{id:"price_storage"},quantity:1},{price:{id:"price_fee"},quantity:1}]}},["price_storage","price_fee"]),true);
});
test("signed-webhook endpoint rejects invalid signatures and ignores unrelated events",async()=>{
 const db={collection:()=>({})};
 const stripe={
  webhooks:{constructEvent:(_data,sig)=>{
   if(sig!=="valid-test")throw Error("Invalid signature");
   return {id:"evt_validtest123",type:"customer.created",data:{object:{}}};
  }}
 };
 const app=express();
 const env={STRIPE_CHECKOUT_ENABLED:"true",STRIPE_SECRET_KEY:"sk_test_dummyABC123",
 STRIPE_WEBHOOK_SECRET:"whsec_dummyABC123",STRIPE_ENVIRONMENT:"test",
 PUBLIC_URL:"https://example.com",STRIPE_PRICE_CATALOG_JSON:"{}"};
 installedBilling({app,db,admin:{firestore:{FieldValue:{serverTimestamp:()=>null}}},accountKey:x=>x,
 firebaseAuth:(_req,_res,next)=>next(),env,stripeOverride:stripe});
 const server=app.listen(0,"127.0.0.1");
 await new Promise(resolve=>server.once("listening",resolve));
 try{
  const url="http://127.0.0.1:"+server.address().port+"/billing/stripe-webhook";
  const invalid=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json",
   "Stripe-Signature":"invalid"},body:'{"id":"evt_bad"}'});
  assert.equal(invalid.status,400);
  const ignored=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json",
   "Stripe-Signature":"valid-test"},body:'{"id":"evt_validtest123"}'});
  assert.equal(ignored.status,200);
  assert.equal((await ignored.json()).ignored,true);
 }finally{await new Promise(resolve=>server.close(resolve))}
});
