#!/usr/bin/env node
"use strict";
/* Stripe prices still to create for the pricing Josh approved on 2026-10-19:
   team tiers, the RedX Storage add-on (+ download pack) and the master tiers (19 prices).

   Modes (the key is read from STRIPE_SECRET_KEY and never printed):
     (no flags)                       plan only; no key, no Stripe calls.
     --dry-run [--live]               read-only: looks up every lookup_key and reports
                                      exists / missing / mismatch. Never creates anything.
                                      With --live the key must be sk_live_/rk_live_.
     --apply --confirm-test-mode      create missing prices in TEST mode (sk_test_/rk_test_ only).
     --apply --live --confirm-live    create missing prices in LIVE mode (sk_live_/rk_live_ only).
                                      Needs Josh's go-ahead; both flags are required.
     --full                           also plan the base catalog the live bootstrap validates (storage, performance,
                                      Remove Ads: every non-retired key of billing_bootstrap.expectedCatalog()). Use it
                                      when setting up a new Stripe account. The retired workspace/BYO fee and project
                                      activation prices are never created.
     --account acct_...               refuse unless STRIPE_SECRET_KEY belongs to this Stripe account.
   Idempotent: a price whose lookup_key already exists is reused when amount, currency,
   interval and active state match, and refused (nothing created) when they don't.
   Products are reused by metadata.gdProduct. Output: catalog JSON (catalogKey -> price id)
   on stdout, or --out <file>. */
const path=require("node:path");
const pricing=require(path.join(__dirname,"../../../commercial/pricing.json"));

const STORAGE_NAME=tier=>tier.replace(/^(\d+)(GB|TB)$/,"$1 $2");
function plan({full=false}={}){
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
 if(full){
   // Base catalog: names a key that billing_bootstrap.validateCatalog requires; prices come from catalog.js.
   const {expectedCatalog,isRetired}=require("../billing_bootstrap");
   const product=key=>{const [kind,a,b]=key.split("|");
     if(kind==="storage")return "GenDragoon Storage "+STORAGE_NAME(b)+(a==="bundle"?" (bundle)":"");
     if(kind==="performance")return "GenDragoon Performance "+a[0].toUpperCase()+a.slice(1);
     if(key==="one_time|remove_ads")return "GenDragoon Remove Ads";
     throw Error("No product name for "+key);};
   for(const [key,e] of Object.entries(expectedCatalog())){
     if(isRetired(key))continue;
     recurring("GenDragoonSSD",product(key),key,e.cents,e.interval);
   }
 }
 return out;
}

const KEY={test:/^(sk|rk)_test_[A-Za-z0-9]+$/,live:/^(sk|rk)_live_[A-Za-z0-9]+$/};
function matches(existing,p){
 return existing.active===true&&existing.currency===p.currency&&existing.unit_amount===p.unitAmount&&
  (p.recurring?existing.recurring?.interval===p.recurring.interval&&existing.recurring?.interval_count===1:!existing.recurring);
}
async function apply(prices,{key,Stripe,live=false,dryRun=false,account=null}){
 const mode=live?"live":"test";
 if(!KEY[mode].test(key||""))throw Error("Refusing: "+(live?"--live needs a Stripe LIVE key (sk_live_/rk_live_)":"--apply needs a Stripe TEST key (sk_test_/rk_test_); live keys need --live --confirm-live")+" in STRIPE_SECRET_KEY");
 const stripe=new Stripe(key,{apiVersion:require("../billing_gateway").STRIPE_API_VERSION,maxNetworkRetries:2});
 if(account){const a=await stripe.accounts.retrieve();if(a.id!==account)throw Error("Refusing: STRIPE_SECRET_KEY belongs to "+a.id+", not "+account+"; nothing was created");}
 const lookups=prices.map(p=>p.lookupKey);if(new Set(lookups).size!==lookups.length)throw Error("Refusing: duplicate lookup_key in plan");
 // Check every lookup key before writing anything, so a mismatch aborts with nothing created.
 const found=new Map(),report=[];
 for(const p of prices){
   const existing=(await stripe.prices.list({lookup_keys:[p.lookupKey],limit:1})).data[0];
   if(existing&&!matches(existing,p))throw Error("Refusing: lookup_key "+p.lookupKey+" exists ("+existing.id+") with a different amount, interval or active state; nothing was created");
   if(existing&&existing.livemode!==live)throw Error("Refusing: "+existing.id+" livemode does not match --"+mode);
   if(existing)found.set(p.lookupKey,existing.id);
   report.push({catalogKey:p.catalogKey,lookupKey:p.lookupKey,status:existing?"exists":"missing",priceId:existing?.id||null});
 }
 if(dryRun)return {mode:mode+"-dry-run",toCreate:report.filter(r=>r.status==="missing").length,prices:report};
 const products=new Map();
 for await(const product of stripe.products.list({limit:100,active:true}))if(product.metadata?.gdProduct)products.set(product.metadata.gdProduct,product);
 const catalog={};
 for(const p of prices){
   if(found.has(p.lookupKey)){catalog[p.catalogKey]=found.get(p.lookupKey);continue;}
   let product=products.get(p.product);
   if(!product){product=await stripe.products.create({name:p.product,metadata:{service:p.service,gdProduct:p.product}},{idempotencyKey:"gd-product-"+mode+"-"+p.service+"-"+p.product});products.set(p.product,product);}
   const price=await stripe.prices.create({product:product.id,currency:p.currency,unit_amount:p.unitAmount,lookup_key:p.lookupKey,
     ...(p.recurring?{recurring:p.recurring}:{}),metadata:{service:p.service,catalogKey:p.catalogKey}},{idempotencyKey:"gd-price-"+mode+"-"+p.lookupKey});
   if(price.livemode!==live)throw Error("Stripe returned livemode="+price.livemode+" for "+price.id);
   catalog[p.catalogKey]=price.id;
 }
 return catalog;
}

function parseArgs(argv){
 const args=new Set(argv),i=argv.indexOf("--out");
 return {apply:args.has("--apply"),dryRun:args.has("--dry-run"),live:args.has("--live"),confirmLive:args.has("--confirm-live"),
   confirmTest:args.has("--confirm-test-mode"),full:args.has("--full"),out:i>=0?argv[i+1]:null,
   account:argv.indexOf("--account")>=0?argv[argv.indexOf("--account")+1]:null};
}
async function main(argv,{env=process.env,Stripe=()=>require("stripe"),write=s=>process.stdout.write(s),writeFile=require("node:fs").writeFileSync}={}){
 const o=parseArgs(argv),prices=plan({full:o.full});
 if(o.account!==null&&!/^acct_[A-Za-z0-9]+$/.test(o.account||""))return {code:2,error:"--account needs an acct_ id"};
 const emit=value=>{const text=JSON.stringify(value,null,2)+"\n";if(o.out)writeFile(o.out,text,{mode:0o644});else write(text);};
 if(o.apply&&o.dryRun)return {code:2,error:"Choose --apply or --dry-run, not both"};
 if(!o.apply&&!o.dryRun){emit({mode:"plan",count:prices.length,prices});return {code:0};}
 if(o.apply&&o.live&&!o.confirmLive)return {code:2,error:"Add --confirm-live to create these "+prices.length+" prices in Stripe LIVE mode"};
 if(o.apply&&!o.live&&!o.confirmTest)return {code:2,error:"Add --confirm-test-mode to create these "+prices.length+" prices in Stripe test mode"};
 if(o.confirmLive&&!o.live)return {code:2,error:"--confirm-live needs --live"};
 emit(await apply(prices,{key:env.STRIPE_SECRET_KEY,Stripe:Stripe(),live:o.live,dryRun:o.dryRun,account:o.account}));
 return {code:0};
}

if(require.main===module){
 main(process.argv.slice(2)).then(r=>{if(r.error)console.error(r.error);process.exit(r.code);})
   .catch(e=>{console.error(String(e.message||e).replace(/(sk|rk)_(live|test)_[A-Za-z0-9]+/g,"$1_$2_***"));process.exit(1);});
}
module.exports={plan,apply,main,parseArgs};
