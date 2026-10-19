// GenDragoon secure customer backend - preproduction, requires Firebase + Stripe TEST keys.
// Must be deployed with HTTPS and private Firestore IAM; never bundle secrets in desktop apps.
"use strict";
const express=require("express"),admin=require("firebase-admin"),Stripe=require("stripe"),crypto=require("crypto");
const required=["STRIPE_SECRET_KEY","STRIPE_WEBHOOK_SECRET","GOOGLE_CLOUD_PROJECT","STRIPE_PRICE_IDS_JSON","PUBLIC_URL"];
for(const key of required) if(!process.env[key])throw Error("Missing server config: "+key);
if(!process.env.STRIPE_SECRET_KEY.startsWith("sk_test_"))throw Error("Development only: Stripe test key required");
admin.initializeApp({projectId:process.env.GOOGLE_CLOUD_PROJECT});
const db=admin.firestore(),stripe=Stripe(process.env.STRIPE_SECRET_KEY);
const prices=JSON.parse(process.env.STRIPE_PRICE_IDS_JSON);
const app=express();app.disable("x-powered-by");
const termsVersion="terms-2026-10-14-v1";
let workspaceManager;
const hash=uid=>crypto.createHash("sha256").update("gd-v1:"+uid).digest("hex");
async function auth(req,res,next){
 const match=/^Bearer ([^\s]+)$/.exec(req.headers.authorization||"");
 if(!match)return res.status(401).json({error:"Google sign-in required"});
 try{
   req.user=await admin.auth().verifyIdToken(match[1],true);
   if(req.user.firebase?.sign_in_provider!=="google.com")return res.status(403).json({error:"Google sign-in required"});
   req.ref=db.collection("gd_accounts").doc(hash(req.user.uid));next();
 }catch(_){res.status(401).json({error:"Invalid login"});}
}
async function account(req){const snap=await req.ref.get();return snap.exists?snap.data():{};}
async function agreed(req,res,next){
 try{
   const snap=await db.collection("accepted_terms").doc(req.user.uid).get();
   const t=snap.exists?snap.data():{};
   if(t.termsVersion!==termsVersion || t.agreed!==true || t.readConfirmed!==true)
     return res.status(403).json({error:"Terms acceptance required",termsVersion});
   req.account=await account(req);
   next();
 }catch(_){res.status(503).json({error:"Terms verification unavailable"});}
}
// Stripe demands raw request bytes for signature validation.
app.post("/webhook/stripe",express.raw({type:"application/json"}),async(req,res)=>{
 let e;try{e=stripe.webhooks.constructEvent(req.body,req.headers["stripe-signature"],process.env.STRIPE_WEBHOOK_SECRET);}
 catch(_){return res.status(400).send("Invalid webhook signature");}
 try{
  if(e.type.startsWith("customer.subscription.")){
   const sub=e.data.object;
   if(sub.metadata?.workspaceId){
     const verified=await stripe.subscriptions.retrieve(sub.id,{expand:["items.data.price"]});
     await workspaceManager.reconcileSubscription(verified);
     return res.json({received:true});
   }
   const customer=typeof sub.customer==="string"?sub.customer:sub.customer.id;
   const matches=await db.collection("gd_accounts").where("stripeCustomerId","==",customer).limit(2).get();
   if(matches.size===1){
    const verified=await stripe.subscriptions.retrieve(sub.id);
    const tier=Object.keys(prices).find(k=>prices[k]===verified.items.data[0]?.price?.id);
    await matches.docs[0].ref.update({subscriptionStatus:verified.status,planId:tier||null,
      entitlementActive:!!tier&&["active","trialing"].includes(verified.status),
      updatedAt:admin.firestore.FieldValue.serverTimestamp()});
   }
  }
  if(e.type==="checkout.session.completed" && e.data.object?.metadata?.kind==="remove_ads"){
    const verified=await stripe.checkout.sessions.retrieve(e.data.object.id);
    await workspaceManager.reconcileAds(verified);
  }
  res.json({received:true});
 }catch(_){res.status(503).send("Retry event");}
});
app.use(express.json({limit:"128kb"}));
workspaceManager=require("./billing_v2").registerBillingV2({app,db,stripe,admin,auth,agreed,hash,prices});
app.get("/health",(_req,res)=>res.json({state:"development"}));
app.get("/session",auth,async(req,res)=>{
 try{const a=await account(req);const acceptance=await db.collection("accepted_terms").doc(req.user.uid).get();
   const t=acceptance.exists?acceptance.data():{};
   res.json({termsRequired:t.termsVersion!==termsVersion||t.agreed!==true||t.readConfirmed!==true,
   active:a.entitlementActive===true,planId:a.planId||null,
   owner:!!process.env.OWNER_FIREBASE_UID&&req.user.uid===process.env.OWNER_FIREBASE_UID});}
 catch(_){res.status(503).json({error:"Account unavailable"});}
});
app.post("/terms/accept",auth,async(req,res)=>{
 if(req.body.version!==termsVersion||req.body.scrolledToEnd!==true||
   req.body.readChecked!==true||req.body.agreeChecked!==true)
   return res.status(400).json({error:"Read and agree separately"});
 if(!process.env.TERMS_URL||!process.env.PRIVACY_URL)
   return res.status(503).json({error:"Final legal pages not published"});
 try{await req.ref.set({termsVersion,termsAcceptedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
 res.json({accepted:true});}catch(_){res.status(503).json({error:"Unable to store consent"});}
});
app.post("/billing/checkout",auth,agreed,async(req,res)=>{
 return res.status(410).json({error:"Legacy single-plan checkout retired. Create a workspace with its own storage and management fee."});
 /* retired single-bucket checkout: kept for migration reference only
 const price=prices[req.body.planId];
 if(!price)return res.status(400).json({error:"Invalid plan"});
 try{
  let a=await account(req);
  if(!a.stripeCustomerId){
   const c=await stripe.customers.create({metadata:{gdId:hash(req.user.uid)}});
   await req.ref.set({stripeCustomerId:c.id},{merge:true});a={...a,stripeCustomerId:c.id};
  }
  const origin=new URL(process.env.PUBLIC_URL);
  if(origin.protocol!=="https:")throw Error("HTTPS required");
  const s=await stripe.checkout.sessions.create({mode:"subscription",customer:a.stripeCustomerId,
   line_items:[{price,quantity:1}],
   success_url:origin.origin+"/billing/success?session_id={CHECKOUT_SESSION_ID}",
   cancel_url:origin.origin+"/billing/cancel"});
  res.json({url:s.url});
 }catch(_){res.status(503).json({error:"Checkout not available"});}
*/
});
app.post("/billing/portal",auth,agreed,async(req,res)=>{
 try{const a=await account(req);if(!a.stripeCustomerId)return res.status(404).json({error:"No subscription"});
 const s=await stripe.billingPortal.sessions.create({customer:a.stripeCustomerId,
 return_url:new URL(process.env.PUBLIC_URL).origin+"/account"});res.json({url:s.url});}
 catch(_){res.status(503).json({error:"Billing portal not available"});}
});
app.get("/storage/status",auth,agreed,async(req,res)=>{
 if(!req.account.entitlementActive)return res.status(402).json({error:"Active subscription required"});
 res.json({active:true,planId:req.account.planId,provisioned:false});
});
app.listen(Number(process.env.PORT||8080),()=>console.log("GenDragoon dev server started"));
