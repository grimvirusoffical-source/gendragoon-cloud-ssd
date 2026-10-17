"use strict";
// Cloud GPU product definitions are an intentionally non-purchasable preview.
// A signed, metered, isolated worker scheduler is required before activation.
const GPU = Object.freeze({
  spark:Object.freeze({name:"Spark",gpuMinutes:120,monthlyCents:2900,maxSessionMinutes:30}),
  volt:Object.freeze({name:"Volt",gpuMinutes:360,monthlyCents:7900,maxSessionMinutes:60}),
  storm:Object.freeze({name:"Storm",gpuMinutes:900,monthlyCents:18900,maxSessionMinutes:120}),
  titan:Object.freeze({name:"Titan",gpuMinutes:1800,monthlyCents:36900,maxSessionMinutes:240})
});
const GPU_READY=false;
const GPU_BUNDLE_DISCOUNT_PERCENT=10;
function gpuQuote(tier,interval="month"){
  if(!GPU[tier]||!["month","year"].includes(interval))throw Error("Invalid GPU tier or interval");
  const x=GPU[tier],factor=interval==="year"?10:1;
  return Object.freeze({tier,interval,gpuMinutesPerMonth:x.gpuMinutes,maxSessionMinutes:x.maxSessionMinutes,
    priceCents:x.monthlyCents*factor,available:GPU_READY,hardware:"not assigned",billingCap:true});
}
function tripleBundleQuote({storageTier,storageMode="standard",performanceTier,gpuTier,interval="month"}){
  const {STORAGE,PERFORMANCE}=require("./catalog");
  if(!STORAGE[storageTier]||!PERFORMANCE[performanceTier]||!GPU[gpuTier] ||
     !["month","year"].includes(interval)||!["standard","bundle"].includes(storageMode))
     throw Error("Invalid triple bundle");
  if(storageMode!=="standard")throw Error("Do not stack the existing performance bundle with a separate performance tier");
  const m=STORAGE[storageTier].standard+500+PERFORMANCE[performanceTier].cents+GPU[gpuTier].monthlyCents;
  const monthly=Math.ceil(m*(100-GPU_BUNDLE_DISCOUNT_PERCENT)/100);
  return Object.freeze({storageTier,performanceTier,gpuTier,interval,discountPercent:10,
    monthlyCents:monthly,totalCents:monthly*(interval==="year"?10:1),
    gpuMinutesPerMonth:GPU[gpuTier].gpuMinutes,available:GPU_READY,
    note:"GPU bundles are preview-only until an isolated GPU scheduler and metering are live."});
}
function requireGpuProvisioned(w){
  if(w?.gpuActive!==true||w?.gpuProvisioned!==true||w?.gpuMeteringActive!==true)
    throw Error("GPU hardware is not provisioned or metering is unavailable");
  if(!GPU[w?.gpuTier])throw Error("Unknown GPU entitlement");
  return GPU[w.gpuTier];
}
module.exports={GPU,GPU_READY,GPU_BUNDLE_DISCOUNT_PERCENT,gpuQuote,tripleBundleQuote,requireGpuProvisioned};
