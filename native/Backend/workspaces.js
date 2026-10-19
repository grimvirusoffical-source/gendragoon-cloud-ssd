"use strict";
const crypto=require("node:crypto");
const {buildQuote,stripeKeys,validateWorkspaceName}=require("./catalog");
// Server-only workspace operations. Stripe test mode and Firebase ID token are
// mandatory in server.js. A draft never receives storage access or API keys.
function registerWorkspaces({app,db,stripe,admin,auth,agreed,account,hash,prices}){
 const coll=req=>req.ref.collection("workspaces");
 async function ownedWorkspace(req,res,id){
  if(typeof id!=="string"||!(/^[a-f0-9-]{36}$/).test(id)){res.status(400).json({error:"Invalid workspace ID"});return null;}
  const ref=coll(req).doc(id);const doc=await ref.get();
  if(!doc.exists){res.status(404).json({error:"Workspace not found"});return null;}
  return {ref,data:doc.data()};
 }
 const stamp=()=>admin.firestore.FieldValue.serverTimestamp();
 app.get("/workspaces",auth,agreed,async(req,res)=>{
  try{
   const docs=await coll(req).orderBy("createdAt","desc").limit(100).get();
   res.json({workspaces:docs.docs.map(d=>{
     const v=d.data();return {id:d.id,name:v.name,plan:v.plan,status:v.status,
       quotaGB:v.quotaGB||0,provisioned:v.provisioned===true,createdAt:v.createdAt||null};
   })});
  }catch(_){res.status(503).json({error:"Workspace list unavailable"});}
 });
 app.post("/workspaces/draft",auth,agreed,async(req,res)=>{
  try{
   const name=validateWorkspaceName(req.body.name);
   const plan={storage:req.body.storage,mode:req.body.mode||"bundle",
     interval:req.body.interval||"month",performance:req.body.performance||null};
   const quote=buildQuote(plan);
   const id=crypto.randomUUID();
   await coll(req).doc(id).create({name,plan,quotaGB:quote.storageGb,
     status:"draft",provisioned:false,createdAt:stamp(),
     ownerHash:hash(req.user.uid),
     // Scoped credentials are minted by the server *after* verified payment.
     accessScope:"accounts/"+hash(req.user.uid)+"/workspaces/"+id+"/"
   });
   res.status(201).json({workspace:{id,name,plan,status:"draft"},quote});
  }catch(e){res.status(400).json({error:e.message.startsWith("Unknown")||e.message.startsWith("Workspace")||e.message.startsWith("Bundle")?"Invalid workspace parameters":"Unable to create workspace"});}
 });
 app.get("/workspaces/:id",auth,agreed,async(req,res)=>{
  try{
   const w=await ownedWorkspace(req,res,req.params.id);if(!w)return;
   const v=w.data;
   res.json({id:req.params.id,name:v.name,plan:v.plan,status:v.status,provisioned:v.provisioned===true,
     quotaGB:v.quotaGB||0,usedBytes:v.usedBytes||0,
     credentialMode:"server-minted, short-lived, workspace-scoped; no permanent user API keys"});
  }catch(_){res.status(503).json({error:"Workspace unavailable"});}
 });
 app.post("/workspaces/:id/checkout",auth,agreed,async(req,res)=>{
  try{
   const w=await ownedWorkspace(req,res,req.params.id);if(!w)return;
   if(w.data.status!=="draft" && w.data.status!=="checkout_pending")
     return res.status(409).json({error:"Existing workspace already billed; use billing portal"});
   if(w.data.ownerHash!==hash(req.user.uid))
     return res.status(403).json({error:"Access denied"});
   const quote=buildQuote(w.data.plan);
   const keys=stripeKeys(w.data.plan);
   const lineItems=keys.map(key=>{
     const price=prices[key];
     if(typeof price!=="string"||!price.startsWith("price_"))throw Error("Plan pricing not configured");
     return {price,quantity:1};
   });
   let a=await account(req);
   if(!a.stripeCustomerId){
     const c=await stripe.customers.create({metadata:{gdAccountHash:hash(req.user.uid)}});
     await req.ref.set({stripeCustomerId:c.id},{merge:true});
     a={...a,stripeCustomerId:c.id};
   }
   const base=new URL(process.env.PUBLIC_URL);
   if(base.protocol!=="https:")throw Error("Secure backend URL required");
   const session=await stripe.checkout.sessions.create({
     mode:"subscription",customer:a.stripeCustomerId,line_items:lineItems,
     metadata:{accountHash:hash(req.user.uid),workspaceId:req.params.id},
     subscription_data:{metadata:{accountHash:hash(req.user.uid),workspaceId:req.params.id}},
     success_url:base.origin+"/billing/success?session_id={CHECKOUT_SESSION_ID}",
     cancel_url:base.origin+"/billing/cancel",
     client_reference_id:req.params.id
   },{idempotencyKey:"gd-checkout-"+req.params.id+"-"+w.data.plan.storage+"-"+w.data.plan.interval});
   await w.ref.update({status:"checkout_pending",stripeCheckoutSessionId:session.id,
     expectedPriceIds:lineItems.map(v=>v.price),updatedAt:stamp()});
   res.json({checkoutUrl:session.url,workspaceId:req.params.id,quote});
  }catch(e){res.status(503).json({error:"Workspace checkout unavailable; confirm configured test-mode prices and billing account"});}
 });
 // The caller must NOT trust a client-selected workspace entitlement. The
 // webhook matches the server-recorded owner, Stripe customer and exact prices.
 async function reconcileSubscription(subscription){
  const meta=subscription.metadata||{},ownerId=meta.accountHash,workspaceId=meta.workspaceId;
  if(!/^[a-f0-9]{64}$/.test(ownerId||"")||!/^[a-f0-9-]{36}$/.test(workspaceId||""))return;
  const accRef=db.collection("gd_accounts").doc(ownerId);
  const wRef=accRef.collection("workspaces").doc(workspaceId);
  const [acc,wSnap]=await Promise.all([accRef.get(),wRef.get()]);
  if(!acc.exists||!wSnap.exists)return;
  const v=wSnap.data();
  const customerId=typeof subscription.customer==="string"?subscription.customer:subscription.customer?.id;
  if(acc.data().stripeCustomerId!==customerId||v.ownerHash!==ownerId)return;
  if(v.stripeSubscriptionId && v.stripeSubscriptionId!==subscription.id)return;
  const expected=stripeKeys(v.plan).map(key=>prices[key]);
  const actual=subscription.items.data.map(item=>item.price.id);
  const matches=expected.length===actual.length &&
   expected.every(id=>actual.filter(x=>x===id).length===1);
  const good=["active","trialing"].includes(subscription.status)&&matches;
  await wRef.update({
   stripeSubscriptionId:subscription.id,
   subscriptionStatus:subscription.status,
   status:good?"paid_pending_provisioning":subscription.status,
   paidEntitlementActive:good,
   paymentPricesValid:matches,
   updatedAt:stamp()
  });
 }
 return {reconcileSubscription};
}
module.exports={registerWorkspaces};
