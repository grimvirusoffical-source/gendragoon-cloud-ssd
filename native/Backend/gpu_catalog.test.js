"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const g=require("./gpu_catalog");
test("four GPU tiers have positive metered credit limits",()=>{
 assert.equal(Object.keys(g.GPU).length,4);
 for(const x of Object.values(g.GPU)){
  assert.ok(Number.isSafeInteger(x.gpuMinutes)&&x.gpuMinutes>0);
  assert.ok(x.maxSessionMinutes<=x.gpuMinutes);
  assert.ok(x.monthlyCents>0);
 }
});
test("GPU preview cannot be purchased or accidentally provisioned",()=>{
 assert.equal(g.GPU_READY,false);
 assert.throws(()=>g.requireGpuProvisioned({gpuActive:true,gpuTier:"titan",gpuProvisioned:false,gpuMeteringActive:false}));
 for(const tier of Object.keys(g.GPU))assert.equal(g.gpuQuote(tier).available,false);
});
test("GPU annual price and duration explicit",()=>{
 const month=g.gpuQuote("volt","month"),year=g.gpuQuote("volt","year");
 assert.equal(year.priceCents,month.priceCents*10);
 assert.equal(year.gpuMinutesPerMonth,month.gpuMinutesPerMonth);
});
test("triple plan discounts storage plus performance plus GPU by 10 percent",()=>{
 const p=g.tripleBundleQuote({storageTier:"1TB",performanceTier:"boost",gpuTier:"spark"});
 assert.equal(p.available,false);
 assert.equal(p.monthlyCents,Math.ceil((3600+500+600+2900)*0.9));
 assert.equal(g.tripleBundleQuote({storageTier:"1TB",performanceTier:"boost",gpuTier:"spark",interval:"year"}).totalCents,p.monthlyCents*10);
 assert.throws(()=>g.tripleBundleQuote({storageTier:"1TB",storageMode:"bundle",performanceTier:"boost",gpuTier:"spark"}));
});
test("invalid GPU input rejected",()=>{
 for(const tier of ["unknown","",null])assert.throws(()=>g.gpuQuote(tier));
 assert.throws(()=>g.gpuQuote("spark","week"));
});
