#!/usr/bin/env node
"use strict";
/* Stripe prices still to create for the pricing Josh approved on 2026-10-19:
   team tiers, the RedX Storage add-on (+ download pack) and the master tiers.

   Default: dry run. Prints the plan; writes nothing and calls nothing.
   --apply --confirm-test-mode creates them in Stripe TEST mode only. A live key
   (sk_live_ / rk_live_) is always refused: live prices need Josh's go-ahead and
   are created from the Stripe dashboard or a reviewed run of this script with
   the live guard removed in a separate change.

   Output of --apply: a catalog JSON (catalogKey -> price id) on stdout, to merge
   into STRIPE_PRICE_CATALOG_JSON for the test environment. */
const path=require("node:path");
const pricing=require(path.join(__dirname,"../../../commercial/pricing.json"));

function plan(){
 const out=[];
 const recurring=(service,product,key,cents,interval,extra={})=>out.push({service,product,catalogKey:key,
   lookupKey:({GenDragoonSSD:"gdssd_",RedXStorage:key.startsWith("redx_")?"":"redx_",Everything:""}[service])+key.split("|").join("_")+"_v1",
   unitAmount:cents,currency:"usd",recurring:interval?{interval,interval_count:1}:null,...extra});
 for(const t of pricing.teams.tiers)for(const iv of ["month","year"])
   recurring("GenDragoonSSD","GenDragoon "+t.name+" ("+t.members+" members)","team|"+t.id+"|"+iv,iv==="year"?t.yearlyCents:t.monthlyCents,iv);
 for(const t of pricing.redxStorage.tiers.filter(t=>t.monthlyCents>0))for(const iv of ["month","year"])
   recurring("RedXStorage","RedX Storage "+t.id[0].toUpperCase()+t.id.slice(1)+" ("+(t.gb>=1000?t.gb/1000+" TB":t.gb+" GB")+", "+t.downloadGbPerMonth+" GB downloads/month)",
     "redx_storage|"+t.id+"|"+iv,iv==="year"?t.yearlyCents:t.monthlyCents,iv);
 const pack=pricing.redxStorage.downloadPack;
 recurring("RedXStorage","RedX download pack (+"+pack.downloadGb+" GB)","one_time|"+pack.id,pack.oneTimeCents,null);
 for(const t of pricing.masterTiers)for(const iv of ["month","year"])
   recurring("Everything",t.name+(t.people>1?" (up to "+t.people+")":""),"master|"+t.id+"|"+iv,iv==="year"?t.yearlyCents:t.monthlyCents,iv);
 return out;
}

async function apply(prices,{key,Stripe}){
 if(!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key||""))throw Error("Refusing: --apply needs a Stripe TEST key in STRIPE_SECRET_KEY (live keys are never used by this script)");
 const stripe=new Stripe(key,{apiVersion:require("../billing_gateway").STRIPE_API_VERSION});
 const catalog={},products=new Map();
 for(const p of prices){
   const existing=(await stripe.prices.list({lookup_keys:[p.lookupKey],limit:1})).data[0];
   if(existing){catalog[p.catalogKey]=existing.id;continue;}
   let product=products.get(p.product);
   if(!product){product=await stripe.products.create({name:p.product,metadata:{service:p.service}},{idempotencyKey:"gd-product-"+p.service+"-"+p.product});products.set(p.product,product);}
   const price=await stripe.prices.create({product:product.id,currency:p.currency,unit_amount:p.unitAmount,lookup_key:p.lookupKey,
     ...(p.recurring?{recurring:p.recurring}:{}),metadata:{service:p.service,catalogKey:p.catalogKey}},{idempotencyKey:"gd-price-"+p.lookupKey});
   catalog[p.catalogKey]=price.id;
 }
 return catalog;
}

if(require.main===module){
 const args=new Set(process.argv.slice(2)),prices=plan();
 if(!args.has("--apply")){
   console.log(JSON.stringify({mode:"dry-run",count:prices.length,prices},null,2));
 }else if(!args.has("--confirm-test-mode")){
   console.error("Add --confirm-test-mode to create these "+prices.length+" prices in Stripe test mode.");process.exit(2);
 }else{
   apply(prices,{key:process.env.STRIPE_SECRET_KEY,Stripe:require("stripe")})
     .then(c=>console.log(JSON.stringify(c,null,2)))
     .catch(e=>{console.error(e.message);process.exit(1);});
 }
}
module.exports={plan,apply};
