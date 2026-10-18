// GenDragoon commercial catalog. Monetary values are integer US cents.
// Each workspace has ONE independent Stripe subscription containing BOTH
// a $5 workspace fee and exactly one storage plan; never charge storage-only
// subscriptions without a workspace.
"use strict";
const STORAGE = Object.freeze({
  "100GB": {gb:100, bundle:799, standard:640},
  "200GB": {gb:200, bundle:1199, standard:960},
  "300GB": {gb:300, bundle:1599, standard:1280},
  "500GB": {gb:500, bundle:2499, standard:2000},
  "1TB": {gb:1000, bundle:4499, standard:3600},
  "2TB": {gb:2000, bundle:8999, standard:7200},
  "3TB": {gb:3000, bundle:12999, standard:10400},
  "4TB": {gb:4000, bundle:16999, standard:13600},
  "5TB": {gb:5000, bundle:20999, standard:16800},
  "6TB": {gb:6000, bundle:24999, standard:20000}
});
const PERFORMANCE=Object.freeze({
  lite:{cents:300,workers:2}, boost:{cents:600,workers:4},
  turbo:{cents:900,workers:8}, ultra:{cents:1400,workers:12},
  max:{cents:1900,workers:20}
});
// One workspace fee for every monthly price in this package.
const WORKSPACE_FEE_CENTS=500;
const BUCKET_MONTHLY_CENTS=WORKSPACE_FEE_CENTS;
// User-facing price text is derived from the one catalog price, never typed as a literal.
const WORKSPACE_FEE_LABEL="$"+(WORKSPACE_FEE_CENTS%100===0?String(WORKSPACE_FEE_CENTS/100):(WORKSPACE_FEE_CENTS/100).toFixed(2));
function yearly(monthly){return monthly*10;}
function buildQuote({storage,mode="bundle",interval="month",performance=null}){
 if(!Object.prototype.hasOwnProperty.call(STORAGE,storage))throw Error("Unknown storage tier");
 if(!["bundle","standard"].includes(mode))throw Error("Unknown storage mode");
 if(!["month","year"].includes(interval))throw Error("Unknown billing interval");
 if(performance && !Object.hasOwn(PERFORMANCE,performance))throw Error("Unknown performance tier");
 if(mode==="bundle"&&performance)throw Error("Bundle already includes performance");
 const base=STORAGE[storage][mode],extra=performance?PERFORMANCE[performance].cents:0;
 // All recurring parts share the same interval and annual discount.
 const multiplier=interval==="year"?10:1;
 const fee=BUCKET_MONTHLY_CENTS*multiplier;
 const storageCharge=base*multiplier, performanceCharge=extra*multiplier;
 return Object.freeze({storage,mode,interval,performance,
  storageGb:STORAGE[storage].gb,storageCents:storageCharge,
  workspaceFeeCents:fee,performanceCents:performanceCharge,
  totalCents:fee+storageCharge+performanceCharge,
  maxWorkers:performance?PERFORMANCE[performance].workers:mode==="bundle"?Math.min(24,Math.max(2,STORAGE[storage].gb/250|0)):1});
}
function validateWorkspaceName(name){
 if(typeof name!=="string")throw Error("Workspace name must be text");
 const v=name.trim().replace(/\s+/g," ");
 if(v.length<3||v.length>64||!(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u).test(v))
  throw Error("Workspace name must be 3–64 letters, numbers, spaces, dots, dashes or underscores");
 return v;
}
function stripeKeys(plan){
 const {storage,mode,interval,performance}=plan;
 const items=[`workspace|${interval}`,`storage|${mode}|${storage}|${interval}`];
 if(performance)items.push(`performance|${performance}|${interval}`);
 return items;
}
module.exports={STORAGE,PERFORMANCE,WORKSPACE_FEE_CENTS,WORKSPACE_FEE_LABEL,BUCKET_MONTHLY_CENTS,buildQuote,validateWorkspaceName,stripeKeys};
