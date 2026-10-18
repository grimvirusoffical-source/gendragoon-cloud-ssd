"use strict";
/* Stripe boundary for GenDragoon.
   Never trust checkout success redirects, user-supplied prices or webhook JSON.
   Purchases default OFF; a signed Stripe webhook is mandatory.
*/
const crypto=require("node:crypto");
const express=require("express");
const {registerBillingV2}=require("./billing_v2");
const TERMS_VERSION="terms-2026-10-14-v1";
// Verified against Stripe's current stable versioning page, 2026-10-17.
const STRIPE_API_VERSION="2026-09-30.endive";
const RELEVANT=new Set([
 "customer.subscription.created","customer.subscription.updated","customer.subscription.deleted","customer.subscription.paused","customer.subscription.resumed",
 "invoice.paid","invoice.payment_failed","checkout.session.completed",
 "checkout.session.async_payment_succeeded","checkout.session.async_payment_failed","checkout.session.expired",
 "charge.refunded","charge.dispute.created"
]);
function parsePrices(raw){
 let prices;
 try{prices=JSON.parse(raw||"{}")}catch(_){throw Error("STRIPE_PRICE_CATALOG_JSON is invalid JSON")}
 if(!prices||Array.isArray(prices)||typeof prices!=="object")throw Error("Stripe price catalog invalid");
 for(const [k,v] of Object.entries(prices)){
  if(k.length>120||!/^price_[a-zA-Z0-9]+$/.test(v))throw Error("Invalid Stripe price identifier");
 }
 return Object.freeze(prices);
}
function environmentGuard(env){
 const hasSecret=typeof env.STRIPE_SECRET_KEY==="string" && /^(?:sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY);
 const hasHook=typeof env.STRIPE_WEBHOOK_SECRET==="string" && /^whsec_[A-Za-z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET);
 const enabled=env.STRIPE_CHECKOUT_ENABLED==="true";
 const priceCatalog=parsePrices(env.STRIPE_PRICE_CATALOG_JSON);
 if(enabled&&(!hasSecret||!hasHook))throw Error("Checkout requires Stripe API and webhook secrets");
 if(enabled&&(!env.PUBLIC_URL?.startsWith("https://")))throw Error("Checkout requires HTTPS PUBLIC_URL");
 if(enabled&&env.STRIPE_ENVIRONMENT!=="test"&&env.STRIPE_ENVIRONMENT!=="live")
  throw Error("Stripe test/live environment must be chosen explicitly");
 if(hasSecret && env.STRIPE_ENVIRONMENT && !new RegExp("^(sk|rk)_"+env.STRIPE_ENVIRONMENT+"_").test(env.STRIPE_SECRET_KEY))
  throw Error("Stripe environment and API key mode mismatch");
 // In production, never turn on live payments before external provisioning readiness review.
 if(enabled&&env.STRIPE_ENVIRONMENT==="live"&&env.PAID_STORAGE_READY!=="approved")
  throw Error("Live checkout requires PAID_STORAGE_READY=approved after provisioning acceptance");
 return {enabled,hasSecret,hasHook,priceCatalog};
}
function installedBilling({app,db,bucket,admin,firebaseAuth,firebaseAuthWithoutTerms,accountKey,env=process.env,stripeOverride,adminAuth,byoProviders,now}){
 const state=environmentGuard(env);
 const Stripe=state.hasSecret&&!stripeOverride?require("stripe"):null;
 const stripe=stripeOverride||(Stripe?new Stripe(env.STRIPE_SECRET_KEY,{apiVersion:STRIPE_API_VERSION,maxNetworkRetries:2,timeout:25000}):{
  customers:{create:async()=>{throw Error("Stripe not configured")}},
  checkout:{sessions:{create:async()=>{throw Error("Stripe not configured")}}},
 });
 async function provisionIfPaid(sub){
   if(!bucket||sub.metadata?.kind!=="storage")return;
   const {accountHash,workspaceId}=sub.metadata||{};
   if(!/^[0-9a-f]{64}$/.test(accountHash||"") ||
      !require("./projects").safeProjectId(workspaceId))return;
   const ref=workspaceId==="free"?db.collection("tenants").doc(accountHash).collection("workspaces").doc("free"):
     db.collection("gd_accounts").doc(accountHash).collection("workspaces").doc(workspaceId);
   const snap=await ref.get();
   if(!snap.exists||(workspaceId==="free"?snap.data().accountKey:snap.data().accountHash)!==accountHash)return;
   const active=snap.data().storageActive===true;
   if(!active){
     // Version2 project activation includes basic2GB independently of optional
     // storage renewal. A downgrade retains data; uploads enforce the lower quota.
     const basic=require("./projects").activatedBasicProject(snap.data())||workspaceId==="free";
     await ref.update({provisioned:basic,quotaBytes:basic?2_000_000_000:0});
     return;
   }
   if(require("./projects").projectStatus(snap.data())==="archived")return;
   const prefix="customer/"+accountHash+(workspaceId==="free"?"/free/":"/managed/"+workspaceId+"/");
   const marker=bucket.file(prefix+"internal-provisioning-marker");
   // Only a validated paid subscription triggers a server-side write. Customer
   // never obtains Google Cloud bucket credentials.
   await marker.save("GenDragoon managed workspace",{
     resumable:false,contentType:"text/plain",
   });
   await db.runTransaction(async tx=>{
     const fresh=await tx.get(ref);
     if(!fresh.exists||fresh.data().storageActive!==true||fresh.data().storageSubscriptionId!==sub.id||
        require("./projects").projectStatus(fresh.data())==="archived"||
        fresh.data().projectBillingVersion===2&&!["free","paid","owner"].includes(fresh.data().projectFeeStatus))return;
     // Do not overwrite counters from a stale webhook snapshot while transfers are active.
     const data=fresh.data(),patch={provisioned:true,quotaBytes:require("./catalog").STORAGE[data.storageTier].gb*1_000_000_000,
       provisionedAt:admin.firestore.FieldValue.serverTimestamp()};
     if(data.usedBytes===undefined)patch.usedBytes=0;
     if(data.reservedBytes===undefined)patch.reservedBytes=0;
     tx.update(ref,patch);
   });
 }
 const readiness={ok:env.STRIPE_RUNTIME_PROBE!=="true",checked:false,error:null};
 if(state.enabled&&env.STRIPE_RUNTIME_PROBE==="true"){
   (async()=>{
     const id="billing-"+crypto.randomUUID(),object=bucket.file("internal-readiness/"+id),record=db.collection("system").doc(id);
     const content=crypto.randomBytes(4096);
     try{
       await object.save(content,{resumable:false,validation:"crc32c"});
       const [received]=await object.download();
       if(!Buffer.from(received).equals(content))throw Error("STORAGE_INTEGRITY");
       await record.set({purpose:"billing-startup-check",createdAt:admin.firestore.FieldValue.serverTimestamp()});
       if(!(await record.get()).exists)throw Error("DATABASE_WRITE_READ");
       await object.delete({ignoreNotFound:true});await record.delete();
       readiness.ok=true;readiness.checked=true;
     }catch(error){
       readiness.error=String(error.code||error.name||"readiness_failure");
       console.error("Billing runtime readiness failed",readiness.error);
       await Promise.allSettled([object.delete({ignoreNotFound:true}),record.delete()]);
     }
   })();
 }
 app.use("/v2",(req,res,next)=>{
   if(req.method==="POST"&&(req.path.includes("/checkout")||req.path==="/projects")&&state.enabled&&!readiness.ok)
      return res.status(503).json({error:"Cloud payment readiness check is still pending"});
   next();
 });
 const auth=firebaseAuth,agreed=(_req,_res,next)=>next();
 const billing=registerBillingV2({app,db,stripe,admin,auth,agreed,hash:accountKey,prices:state.priceCatalog,env});
 app.get("/v2/billing/status",(_req,res)=>{
  res.json({checkoutEnabled:state.enabled&&readiness.ok,
    stripeMode:env.STRIPE_ENVIRONMENT==="test"?"test":env.STRIPE_ENVIRONMENT==="live"?"live":"unconfigured",
    availableKinds:["storage","performance","bundle","bring-your-own-cloud","remove-ads",...(billing.projects.paymentAvailable()?["project-creation"]:[])],
    projectCreationEnabled:billing.projects.paymentAvailable()&&readiness.ok,
    webhookConfigured:state.hasHook,runtimeStorageVerified:readiness.checked,
    liveStorageProvisioned:env.PAID_STORAGE_READY==="approved",
    message:state.enabled?"Stripe Checkout available":"Purchases disabled until billing and provisioning are verified"});
 });
 app.get("/billing/success",(_req,res)=>res.status(200).type("html")
   .send("<!doctype html><html><head><title>GenDragoon Checkout</title></head><body><h1>Checkout returned</h1><p>GenDragoon is verifying your payment with Stripe. Return to the app to refresh your entitlement. This page does not grant access.</p></body></html>"));
 app.get("/billing/cancel",(_req,res)=>res.status(200).type("html")
   .send("<!doctype html><html><head><title>GenDragoon Checkout</title></head><body><h1>Checkout canceled</h1><p>No GenDragoon entitlement was granted. You can return to the app.</p></body></html>"));
 app.post("/billing/customer-portal",firebaseAuth,async(req,res)=>{
  if(!state.enabled||!state.hasSecret||!readiness.ok)return res.status(503).json({error:"Billing not available"});
  try{
   const account=db.collection("gd_accounts").doc(accountKey(req.user.uid));
   const user=await account.get(),customer=user.data()?.stripeCustomerId;
   if(!customer)return res.status(404).json({error:"No billing account exists"});
   const url=new URL(env.PUBLIC_URL);
   const session=await stripe.billingPortal.sessions.create({customer,return_url:url.origin+"/mobile/",...(env.STRIPE_PORTAL_CONFIGURATION_ID?{configuration:env.STRIPE_PORTAL_CONFIGURATION_ID}:{})});
   res.setHeader("Cache-Control","no-store");
   res.json({url:session.url});
  }catch(_){res.status(503).json({error:"Billing portal temporarily unavailable"})}
 });
 app.post("/billing/stripe-webhook",express.raw({type:"application/json",limit:"768kb"}),async(req,res)=>{
  if(!state.enabled||!state.hasHook||!readiness.ok)return res.status(503).json({error:"Stripe webhooks not enabled"});
  let event;
  try{event=stripe.webhooks.constructEvent(req.body,req.headers["stripe-signature"],env.STRIPE_WEBHOOK_SECRET)}
  catch(_){return res.status(400).json({error:"Invalid Stripe webhook signature"})}
  if(!/^evt_[a-zA-Z0-9]+$/.test(event.id||""))return res.status(400).end();
  if(!RELEVANT.has(event.type))return res.status(200).json({received:true,ignored:true});
  const evt=db.collection("stripe_webhook_events").doc(event.id);
  try{
   const previous=await evt.get();
   if(previous.exists&&previous.data().processed===true)return res.json({received:true,replayed:true});
   const object=event.data?.object||{};
   async function applySubscription(latest,eventType,source){
    if(latest?.metadata?.kind==="workspace_fee")return billing.projects.reconcileWorkspaceFee(latest,{eventType,invoice:String(eventType).startsWith("invoice.")?source:null});
    if(await billing.reconcileSubscription(latest))await provisionIfPaid(latest);
   }
   if(event.type.startsWith("customer.subscription.")){
    const latest=await stripe.subscriptions.retrieve(object.id);
    await applySubscription(latest,event.type,object);
   } else if(event.type.startsWith("invoice.")){
    const id=typeof object.subscription==="string"?object.subscription:
      object.subscription?.id||object.parent?.subscription_details?.subscription;
    if(id){
      const latest=await stripe.subscriptions.retrieve(id);
      await applySubscription(latest,event.type,object);
    }
   } else if(event.type.startsWith("checkout.session.")){
    if(object.metadata?.kind==="project_creation"){
      const latest=await stripe.checkout.sessions.retrieve(object.id);
      await billing.projects.reconcilePayment(latest,{failed:event.type==="checkout.session.async_payment_failed"});
    } else if(object.metadata?.kind==="remove_ads"&&["checkout.session.completed","checkout.session.async_payment_succeeded"].includes(event.type)){
      const latest=await stripe.checkout.sessions.retrieve(object.id);
      await billing.reconcileAds(latest);
    } else if(object.subscription&&["checkout.session.completed","checkout.session.async_payment_succeeded"].includes(event.type)){
      const id=typeof object.subscription==="string"?object.subscription:object.subscription.id;
      if(id){
      const latest=await stripe.subscriptions.retrieve(id);
      await applySubscription(latest,event.type,object);
    }
    }
   } else if(event.type==="charge.refunded"||event.type==="charge.dispute.created"){
    const charge=event.type==="charge.refunded"?object:await stripe.charges.retrieve(object.charge);
    if(charge.payment_intent && (event.type==="charge.dispute.created"||
      charge.refunded||charge.amount_refunded>=charge.amount_captured)){
      const records=await db.collection("ad_purchases")
        .where("stripePaymentIntentId","==",charge.payment_intent).limit(10).get();
      const batch=db.batch();
      for(const d of records.docs)batch.update(d.ref,{active:false,
        revokedReason:event.type,revokedAt:admin.firestore.FieldValue.serverTimestamp()});
      if(!records.empty)await batch.commit();
    }
    if(charge.payment_intent&&(event.type==="charge.dispute.created"||charge.refunded||(charge.amount_refunded||0)>0))
      await billing.projects.revokePayment(charge.payment_intent,event.type);
   }
   await evt.set({processed:true,type:event.type,processedAt:admin.firestore.FieldValue.serverTimestamp()});
   res.json({received:true});
  }catch(error){
   console.error("Stripe webhook processing failed",event.type,event.id,String(error.code||error.name||"unknown"));
   res.status(503).json({error:"Webhook temporary failure; Stripe will retry"});
  }
 });
 if(app&&typeof (firebaseAuthWithoutTerms||firebaseAuth)==="function"){
  require("./account_delete").registerAccountDeletion({app,firebaseAuth:firebaseAuthWithoutTerms||firebaseAuth,db,bucket,stripe,
   auth:adminAuth||{async deleteUser(){throw Object.assign(Error("auth_unavailable"),{status:503,code:"auth_unavailable"});}},
   byoProviders:byoProviders||{},hash:accountKey,now:now||(()=>Date.now())});
 }
 return {...state,stripe,billing};
}
module.exports={installedBilling,environmentGuard,parsePrices,RELEVANT,STRIPE_API_VERSION};
