#!/usr/bin/env node
"use strict";
/* Archive (active:false) the retired recurring fee Prices once the new revision is live and smoke-tested:
   workspace|month, workspace|year, byo|month, byo|year (the old $5 / $50 recurring fee).
   The $5 one-time project activation Price is active again and MUST NOT be archived.
   Archiving never touches existing subscriptions; Stripe keeps billing
   them and the live bootstrap still resolves these IDs for reconciliation (billing_bootstrap.js).

   Default / --dry-run: read-only, prints what would be archived.
   --apply --live --confirm-archive: archives them (sk_live_/rk_live_ key in STRIPE_SECRET_KEY only).
   Each Price is found by metadata.catalogKey or lookup key and must match the expected amount and
   interval exactly; anything unexpected aborts before any change. Already archived = no-op. */
const RETIRED=[
 {catalogKey:"workspace|month",lookupKey:"gdssd_workspace_month_v1",cents:500,interval:"month"},
 {catalogKey:"workspace|year",lookupKey:"gdssd_workspace_year_v1",cents:5000,interval:"year"},
 {catalogKey:"byo|month",lookupKey:"gdssd_byo_month_v1",cents:500,interval:"month"},
 {catalogKey:"byo|year",lookupKey:"gdssd_byo_year_v1",cents:5000,interval:"year"},
];
async function run({key,Stripe,apply=false}){
 if(!/^(sk|rk)_live_[A-Za-z0-9]+$/.test(key||""))throw Error("Refusing: needs a Stripe LIVE key (sk_live_/rk_live_) in STRIPE_SECRET_KEY");
 const stripe=new Stripe(key,{apiVersion:require("../billing_gateway").STRIPE_API_VERSION,maxNetworkRetries:2});
 const all=[];for await(const p of stripe.prices.list({limit:100}))all.push(p);
 const plan=[];
 for(const r of RETIRED){
  const found=all.filter(p=>p.metadata?.service==="GenDragoonSSD"&&(p.metadata?.catalogKey===r.catalogKey||p.lookup_key===r.lookupKey));
  if(found.length>1)throw Error("Refusing: "+found.length+" Prices match "+r.catalogKey+"; resolve by hand");
  if(!found.length){plan.push({...r,priceId:null,action:"not_found"});continue;}
  const p=found[0];
  if(!p.livemode||p.currency!=="usd"||p.unit_amount!==r.cents||(r.interval?p.recurring?.interval!==r.interval:p.type!=="one_time"))
   throw Error("Refusing: "+p.id+" ("+r.catalogKey+") does not match the expected retired Price; nothing was archived");
  plan.push({...r,priceId:p.id,action:p.active?"archive":"already_archived"});
 }
 if(apply)for(const x of plan.filter(x=>x.action==="archive")){
  const updated=await stripe.prices.update(x.priceId,{active:false});
  if(updated.active!==false)throw Error("Archive did not apply to "+x.priceId);
  x.action="archived";
 }
 return {mode:apply?"live-apply":"live-dry-run",prices:plan};
}
async function main(argv,{env=process.env,Stripe=()=>require("stripe"),write=s=>process.stdout.write(s)}={}){
 const a=new Set(argv),apply=a.has("--apply");
 if(apply&&!(a.has("--live")&&a.has("--confirm-archive")))return {code:2,error:"Archiving needs --apply --live --confirm-archive"};
 write(JSON.stringify(await run({key:env.STRIPE_SECRET_KEY,Stripe:Stripe(),apply}),null,2)+"\n");
 return {code:0};
}
if(require.main===module)main(process.argv.slice(2)).then(r=>{if(r.error)console.error(r.error);process.exit(r.code);})
 .catch(e=>{console.error(String(e.message||e).replace(/(sk|rk)_(live|test)_[A-Za-z0-9]+/g,"$1_$2_***"));process.exit(1);});
module.exports={RETIRED,run,main};
