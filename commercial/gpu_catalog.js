"use strict";
// PRELAUNCH ONLY. Runtime GPU workers, usage ledger, Stripe entitlements and quotas are not deployed.
const GPU=Object.freeze({
 spark:{name:"Spark",gpuMinutes:120,monthlyCents:2900,maxSessionMinutes:30},
 volt:{name:"Volt",gpuMinutes:360,monthlyCents:7900,maxSessionMinutes:60},
 storm:{name:"Storm",gpuMinutes:900,monthlyCents:18900,maxSessionMinutes:120},
 titan:{name:"Titan",gpuMinutes:1800,monthlyCents:36900,maxSessionMinutes:240}
});
for (const plan of Object.values(GPU)) Object.freeze(plan);
const GPU_READY=false;
function gpuQuote(tier,interval="month"){
 if(typeof tier!=="string"||!Object.hasOwn(GPU,tier)||!["month","year"].includes(interval))throw Error("Invalid GPU tier or interval");
 const p=GPU[tier],factor=interval==="year"?10:1;
 return {tier,interval,gpuMinutesPerMonth:p.gpuMinutes,maxSessionMinutes:p.maxSessionMinutes,
   priceCents:p.monthlyCents*factor,available:GPU_READY,hardware:"not assigned",billingCap:true};
}
function tripleBundleQuote(options){
 if(!options||typeof options!=="object"||Array.isArray(options))throw Error("Invalid triple bundle");
 const {storageTier,storageMode="standard",performanceTier,gpuTier,interval="month"}=options;
 const {STORAGE,PERFORMANCE}=require("./catalog");
 if(typeof storageTier!=="string"||!Object.hasOwn(STORAGE,storageTier)||
    typeof performanceTier!=="string"||!Object.hasOwn(PERFORMANCE,performanceTier)||
    typeof gpuTier!=="string"||!Object.hasOwn(GPU,gpuTier)||
    !["month","year"].includes(interval)||storageMode!=="standard")throw Error("Invalid triple bundle");
 const sum=STORAGE[storageTier].standard+PERFORMANCE[performanceTier].cents+GPU[gpuTier].monthlyCents;
 // Apply the bundle discount once, round up to whole cents, then bill 10 months annually.
 const month=Math.ceil(sum*9/10);
 return {storageTier,performanceTier,gpuTier,interval,discountPercent:10,
   monthlyCents:month,totalCents:month*(interval==="year"?10:1),
   gpuMinutesPerMonth:GPU[gpuTier].gpuMinutes,available:GPU_READY};
}
function requireGpuProvisioned(w){
 if(w?.gpuActive!==true||w?.gpuProvisioned!==true||w?.gpuMeteringActive!==true)
   throw Error("GPU hardware or metering unavailable");
 if(typeof w?.gpuTier!=="string"||!Object.hasOwn(GPU,w.gpuTier))throw Error("Invalid GPU entitlement");
 return GPU[w.gpuTier];
}
module.exports={GPU,GPU_READY,gpuQuote,tripleBundleQuote,requireGpuProvisioned};
