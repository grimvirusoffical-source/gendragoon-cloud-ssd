"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {storageQuote,performanceQuote,effectiveWorkers,
 matchesStripePrices,priceKeysStorage,priceKeysPerformance,FREE_GB,
 REMOVE_ADS_CENTS}=require("./billing_v2");
const {TransferGovernor,rcloneLimits}=require("./performance");
test("free tier is weakest and provides 2GB/1 worker",()=>{
 assert.equal(FREE_GB,2);
 assert.equal(effectiveWorkers({kind:"free",provisioned:true}),1);
 assert.deepEqual(rcloneLimits({kind:"free",provisioned:true}),[
 "--transfers","1","--checkers","1","--multi-thread-streams","1"]);
});
test("storage subscriptions include exactly the $5 workspace fee",()=>{
 const q=storageQuote("100GB","month");
 assert.equal(q.storageCents,640);assert.equal(q.workspaceFeeCents,500);
 assert.equal(q.totalCents,1140);
 assert.deepEqual(priceKeysStorage(q),["workspace|month","storage|standard|100GB|month"]);
 const yearly=storageQuote("100GB","year");
 assert.equal(yearly.totalCents,11400);
});
test("performance subscriptions remain separate",()=>{
 const q=performanceQuote("boost","month");
 assert.equal(q.totalCents,600);assert.equal(q.workerLimit,4);
 assert.deepEqual(priceKeysPerformance(q),["performance|boost|month"]);
 assert.equal(performanceQuote("max","year").totalCents,19000);
});
test("unpaid storage does not grant transfer workers",()=>{
 assert.equal(effectiveWorkers({kind:"paid",storageActive:false,performanceTier:"max",performanceActive:true}),0);
 assert.throws(()=>rcloneLimits({kind:"paid",storageActive:false}));
});
test("paid storage without performance receives only the free 1-worker class",()=>{
 assert.equal(effectiveWorkers({kind:"paid",storageActive:true,performanceTier:"max",performanceActive:false}),1);
});
test("verified performance tier directly determines actual rclone concurrency",()=>{
 for(const [tier,worker] of [["lite",2],["boost",4],["turbo",8],["ultra",12],["max",20]]){
  const record={kind:"paid",storageActive:true,performanceActive:true,performanceTier:tier};
  assert.equal(effectiveWorkers(record),worker);
  assert.equal(rcloneLimits(record)[1],String(worker));
 }
});
test("only exact storage line items match; missing $5 item fails",()=>{
 const sub={items:{data:[{price:{id:"price_fee"}},{price:{id:"price_storage"}}]}};
 assert.equal(matchesStripePrices(sub,["price_fee","price_storage"]),true);
 assert.equal(matchesStripePrices(sub,["price_fee","price_other"]),false);
 assert.equal(matchesStripePrices(sub,["price_storage"]),false);
});
test("one-time remove ads is not a subscription",()=>{
 assert.equal(REMOVE_ADS_CENTS,499);
});
test("transfer governor enforces 1 worker for free",async()=>{
 const gov=new TransferGovernor();let current=0,maximum=0;
 const ws={kind:"free",provisioned:true};
 await Promise.all(Array.from({length:12},()=>gov.run("a",ws,async()=>{
   current++;maximum=Math.max(maximum,current);
   await new Promise(resolve=>setTimeout(resolve,4));current--;
 })));
 assert.equal(maximum,1);
});
test("transfer governor scales to verified 4 worker Boost tier",async()=>{
 const gov=new TransferGovernor();let current=0,maximum=0;
 const ws={kind:"paid",provisioned:true,storageActive:true,performanceActive:true,performanceTier:"boost"};
 await Promise.all(Array.from({length:12},()=>gov.run("b",ws,async()=>{
   current++;maximum=Math.max(maximum,current);
   await new Promise(resolve=>setTimeout(resolve,4));current--;
 })));
 assert.equal(maximum,4);
});
test("transfer governor refuses unprovisioned workspaces",async()=>{
 const gov=new TransferGovernor();
 await assert.rejects(()=>gov.run("c",{kind:"free",provisioned:false},async()=>{}));
});
