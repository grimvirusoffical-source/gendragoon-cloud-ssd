"use strict";
// Moving live billing to another Stripe account (2026-10-19: acct_1TqS8eIpkwStQhHM -> acct_1USFf5CtNDGcw0e6).
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),express=require("express");
const {memoryFirestore}=require("./test_firestore");
const {installedBilling}=require("./billing_gateway");
const {customerInAccount}=require("./billing_v2");
const {plan,apply}=require("./scripts/stripe_prices_to_create");
const {expectedCatalog,isRetired,optionalTeamCatalog}=require("./billing_bootstrap");
const hash=uid=>crypto.createHash("sha256").update(uid).digest("hex"),owner=hash("test-a");
const NEW="acct_1USFf5CtNDGcw0e6",OLD="acct_1TqS8eIpkwStQhHM";

test("a stored customer is reused only in the Stripe account it was created in",()=>{
 assert.equal(customerInAccount({stripeCustomerId:"cus_1"},undefined),true,"no account configured: unchanged behaviour");
 assert.equal(customerInAccount({stripeCustomerId:"cus_1"},OLD),true,"untagged records belong to the original account");
 assert.equal(customerInAccount({stripeCustomerId:"cus_1"},NEW),false);
 assert.equal(customerInAccount({stripeCustomerId:"cus_1",stripeAccountId:NEW},NEW),true);
 assert.equal(customerInAccount({stripeCustomerId:"cus_1",stripeAccountId:OLD},NEW),false);
 assert.equal(customerInAccount({},NEW),false);
});

async function fixture(t,account,seed){
 const db=memoryFirestore([["gd_accounts/"+owner,seed]]),created=[],portal=[];
 const stripe={customers:{create:async(args,options)=>{created.push({args,options});return {id:"cus_new"+created.length};}},
  checkout:{sessions:{create:async args=>({id:"cs_1",url:"https://checkout.stripe.com/c/pay/cs_1",customer:args.customer}),retrieve:async()=>{throw Error("not used");}}},
  billingPortal:{sessions:{create:async args=>{portal.push(args.customer);return {url:"https://billing.stripe.com/p/1"};}}}};
 const app=express();app.use("/v2",express.json());
 const firebaseAuth=(req,_res,next)=>{req.user={uid:"test-a"};next();};
 installedBilling({app,db,stripeOverride:stripe,admin:{firestore:{FieldValue:{serverTimestamp:()=>1}}},firebaseAuth,accountKey:hash,
  env:{STRIPE_SECRET_KEY:"sk_test_dummyABC123",STRIPE_WEBHOOK_SECRET:"whsec_fixture123",STRIPE_CHECKOUT_ENABLED:"true",STRIPE_ENVIRONMENT:"test",
   PUBLIC_URL:"https://billing.example",STRIPE_PRICE_CATALOG_JSON:JSON.stringify({"one_time|remove_ads":"price_ads"}),...(account?{STRIPE_ACCOUNT_ID:account}:{})}});
 const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));t.after(()=>new Promise(r=>server.close(r)));
 const post=async p=>{const r=await fetch("http://127.0.0.1:"+server.address().port+p,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});return {status:r.status,body:await r.json()};};
 return {db,created,portal,post};
}

test("checkout in the new account replaces a customer from the old account and keeps the old id on record",async t=>{
 const f=await fixture(t,NEW,{stripeCustomerId:"cus_oldaccount"});
 assert.equal((await f.post("/billing/customer-portal")).status,404,"the old customer cannot open the new account's portal");
 const r=await f.post("/v2/remove-ads/checkout");
 assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal(f.created.length,1);assert.match(f.created[0].options.idempotencyKey,new RegExp("^gd-customer-"+NEW+"-"));
 const a=(await f.db.collection("gd_accounts").doc(owner).get()).data();
 assert.equal(a.stripeCustomerId,"cus_new1");assert.equal(a.stripeAccountId,NEW);assert.deepEqual(a.legacyStripeCustomerIds,["cus_oldaccount"]);
 await f.post("/v2/remove-ads/checkout");assert.equal(f.created.length,1,"the tagged customer is reused afterwards");
});
test("without STRIPE_ACCOUNT_ID, and for a customer already in the configured account, the stored customer is reused",async t=>{
 for(const [account,seed] of [[null,{stripeCustomerId:"cus_keep"}],[NEW,{stripeCustomerId:"cus_keep",stripeAccountId:NEW}]]){
  const f=await fixture(t,account,seed);
  assert.equal((await f.post("/v2/remove-ads/checkout")).status,200);assert.equal(f.created.length,0);
  assert.equal((await f.post("/billing/customer-portal")).status,200);assert.deepEqual(f.portal,["cus_keep"]);
 }
});

test("--full plans every non-retired key the live bootstrap validates, plus teams, RedX Storage and master tiers",()=>{
 const p=plan({full:true}),keys=new Set(p.map(x=>x.catalogKey));
 assert.equal(p.length,70);assert.equal(new Set(p.map(x=>x.lookupKey)).size,70);
 for(const [k,e] of Object.entries(expectedCatalog())){
  if(isRetired(k)){assert.ok(!keys.has(k),"retired "+k+" is never created");continue;}
  const x=p.find(x=>x.catalogKey===k);assert.ok(x,k);assert.equal(x.unitAmount,e.cents);assert.equal(x.recurring?.interval??null,e.interval);
  assert.equal(x.service,"GenDragoonSSD");assert.equal(x.lookupKey,"gdssd_"+k.split("|").join("_")+"_v1");
 }
 for(const k of Object.keys(optionalTeamCatalog()))assert.ok(keys.has(k));
 assert.equal(plan().length,19,"the default plan is unchanged");
 // None collide with the Rotten Apple / RedX Hosted lookup keys already in the Red-XAI account.
 assert.ok(p.every(x=>!/^(ra_|redx_hosted_)/.test(x.lookupKey)));
});
test("--account refuses a key from another Stripe account before reading or creating any price",async()=>{
 let listed=0;
 const Stripe=function(){return {accounts:{retrieve:async()=>({id:OLD})},prices:{list:async()=>{listed++;return {data:[]};}}};};
 await assert.rejects(apply(plan({full:true}),{key:"sk_live_abc123",Stripe,live:true,account:NEW}),/belongs to acct_1TqS8eIpkwStQhHM/);
 assert.equal(listed,0);
});
