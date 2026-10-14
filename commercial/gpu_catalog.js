"use strict";
// PRELAUNCH ONLY. Runtime GPU workers, usage ledger, Stripe entitlements and quotas are not deployed.
const GPU=Object.freeze({
 spark:{name:"Spark",gpuMinutes:120,monthlyCents:2900,maxSessionMinutes:30},
 volt:{name:"Volt",gpuMinutes:360,monthlyCents:7900,maxSessionMinutes:60},
 storm:{name:"Storm",gpuMinutes:900,monthlyCents:18900,maxSessionMinutes:120},
 titan:{name:"Titan",gpuMinutes:1800,monthlyCents:36900,maxSessionMinutes:240}
});
const GPU_READY=false;
function gpuQuote(tier,interval="month"){
 if(!GPU[tier]||!["month","year"].includes(interval))throw Error("Invalid GPU tier or interval");
 const p=GPU[tier],factor=interval==="year"?10:1;
 return {tier,interval,gpuMinutesPerMonth:p.gpuMinutes,maxSessionMinutes:p.maxSessionMinutes,
   priceCents:p.monthlyCents*factor,available:GPU_READY,hardware:"not assigned",billingCap:true};
}
function tripleBundleQuote({storageTier,storageMode="standard",performanceTier,gpuTier,interval="month"}){
 const {STORAGE,PERFORMANCE}=require("./catalog");
 if(!STORAGE[storageTier]||!PERFORMANCE[performanceTier]||!GPU[gpuTier]||
    !["month","year"].includes(interval)||storageMode!=="standard")throw Error("Invalid triple bundle");
 const sum=STORAGE[storageTier].standard+500+PERFORMANCE[performanceTier].cents+GPU[gpuTier].monthlyCents;
 const month=Math.ceil(sum*0.9);
 return {storageTier,performanceTier,gpuTier,interval,discountPercent:10,
   monthlyCents:month,totalCents:month*(interval==="year"?10:1),
   gpuMinutesPerMonth:GPU[gpuTier].gpuMinutes,available:GPU_READY};
}
function requireGpuProvisioned(w){
 if(w?.gpuActive!==true||w?.gpuProvisioned!==true||w?.gpuMeteringActive!==true)
   throw Error("GPU hardware or metering unavailable");
 if(!GPU[w?.gpuTier])throw Error("Invalid GPU entitlement");
 return GPU[w.gpuTier];
}
module.exports={GPU,GPU_READY,gpuQuote,tripleBundleQuote,requireGpuProvisioned};
