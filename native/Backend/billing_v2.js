"use strict";
const crypto=require("node:crypto");
const {STORAGE,PERFORMANCE,validateWorkspaceName}=require("./catalog");
const {GPU,GPU_READY,gpuQuote,tripleBundleQuote}=require("./gpu_catalog");
const FREE_GB=2,FREE_WORKERS=1,REMOVE_ADS_CENTS=499;
const VALID_INTERVALS=new Set(["month","year"]);
const ACTIVE_STATUSES=new Set(["active","trialing"]);
function yearFactor(period){return period==="year"?10:1}
function storageQuote(tier,interval,mode="standard"){
 if(typeof tier!=="string"||!Object.hasOwn(STORAGE,tier)||!VALID_INTERVALS.has(interval))throw Error("Invalid storage plan");
 if(!["standard","bundle"].includes(mode))throw Error("Invalid storage mode");
 const monthly=STORAGE[tier][mode];
 const recurringFee=500;
 return {tier,interval,mode,storageGB:STORAGE[tier].gb,storageCents:monthly*yearFactor(interval),
  workspaceFeeCents:recurringFee*yearFactor(interval),totalCents:(monthly+recurringFee)*yearFactor(interval)};
}
function byoQuote(interval){
 if(!VALID_INTERVALS.has(interval))throw Error("Invalid BYO interval");
 return {interval,kind:"byo",totalCents:1000*yearFactor(interval),storageGB:0,workers:1};
}
function performanceQuote(tier,interval){
 if(typeof tier!=="string"||!Object.hasOwn(PERFORMANCE,tier)||!VALID_INTERVALS.has(interval))throw Error("Invalid performance plan");
 return {tier,interval,workerLimit:PERFORMANCE[tier].workers,
  totalCents:PERFORMANCE[tier].cents*yearFactor(interval)};
}
function priceKeysStorage(plan){return ["workspace|"+plan.interval,
 "storage|"+plan.mode+"|"+plan.tier+"|"+plan.interval]}
function priceKeysBYO(plan){return ["byo|"+plan.interval]}
function priceKeysPerformance(plan){return ["performance|"+plan.tier+"|"+plan.interval]}
function matchesStripePrices(subscription,expected){
 const lineItems=subscription.items?.data||[];
 if(lineItems.some(x=>x.quantity!==undefined&&x.quantity!==1))return false;
 const actual=lineItems.map(x=>x.price?.id);
 return expected.length===actual.length&&expected.every(x=>typeof x==="string"&&actual.filter(y=>y===x).length===1);
}
function bundleWorkers(tier){
  const {STORAGE}=require("./catalog");
  if(!STORAGE[tier])return 1;
  return Math.min(24,Math.max(2,Math.floor(STORAGE[tier].gb/250)));
}
function effectiveWorkers(workspace){
 if(workspace.kind==="free")return FREE_WORKERS;
 if(workspace.kind==="byo"){
   if(!workspace.byoActive||!workspace.manualProviderConfigured)return 0;
   return workspace.performanceActive===true && PERFORMANCE[workspace.performanceTier] ?
     PERFORMANCE[workspace.performanceTier].workers:FREE_WORKERS;
 }
 if(!workspace.storageActive)return 0;
 const base=workspace.storageMode==="bundle" ? bundleWorkers(workspace.storageTier):FREE_WORKERS;
 return workspace.performanceActive===true && PERFORMANCE[workspace.performanceTier] ?
  Math.max(base,PERFORMANCE[workspace.performanceTier].workers):base;
}
function registerBillingV2({app,db,stripe,admin,auth,agreed,hash,prices,env=process.env}){
 const stamp=()=>admin.firestore.FieldValue.serverTimestamp();
 const accounts=db.collection("gd_accounts");
 const accRef=req=>accounts.doc(hash(req.user.uid));
 const coll=req=>accRef(req).collection("workspaces");
 function safeWorkspaceId(id){
   return typeof id==="string"&&/^[a-f0-9-]{36}$/.test(id);
 }
 async function getWorkspace(req,res){
   if(!safeWorkspaceId(req.params.id)){res.status(400).json({error:"Invalid workspace identifier"});return null}
   const ref=coll(req).doc(req.params.id);
   const snap=await ref.get();
   if(!snap.exists){res.status(404).json({error:"Workspace not found"});return null}
   const data=snap.data();
   if(data.accountHash!==hash(req.user.uid)){res.status(403).json({error:"Access denied"});return null}
   return {ref,data,id:req.params.id};
 }
 function publicWorkspace(w){
   return {id:w.id,name:w.data.name,kind:w.data.kind,storageMode:w.data.storageMode||null,
   byoActive:!!w.data.byoActive,manualProviderConfigured:!!w.data.manualProviderConfigured,
   storageTier:w.data.storageTier||null,
   storageActive:!!w.data.storageActive,performanceTier:w.data.performanceTier||null,
   performanceActive:!!w.data.performanceActive,workers:effectiveWorkers(w.data),
   quotaGB:w.data.kind==="free"?FREE_GB:(w.data.storageActive?STORAGE[w.data.storageTier]?.gb||0:0),
   provisioned:w.data.provisioned===true};
 }
 async function ensureCustomer(req){
   const ref=accRef(req), snap=await ref.get();
   if(snap.exists && snap.data().stripeCustomerId)return snap.data().stripeCustomerId;
   const customer=await stripe.customers.create({...(req.user.email?{email:req.user.email}:{}),metadata:{gdAccountHash:hash(req.user.uid)}},
       {idempotencyKey:"gd-customer-"+hash(req.user.uid)});
   await ref.set({stripeCustomerId:customer.id,uid:req.user.uid},{merge:true});
   return customer.id;
 }
 function verifiedPrice(key){
   const id=prices[key];
   if(typeof id!=="string"||!/^price_[a-zA-Z0-9]+$/.test(id))
     throw Error("Stripe price not configured");
   return id;
 }
 async function checkoutSession(req,kind,w,keys){
   if(env.STRIPE_CHECKOUT_ENABLED!=="true")throw Error("Checkout disabled until paid storage is provisioned");
   const customer=await ensureCustomer(req);
   const origin=new URL(env.PUBLIC_URL);
   if(origin.protocol!=="https:")throw Error("HTTPS backend is required");
   const lineItems=keys.map(k=>({price:verifiedPrice(k),quantity:1}));
   const metadata={accountHash:hash(req.user.uid),workspaceId:w.id,kind};
   const session=await stripe.checkout.sessions.create({
      mode:"subscription",customer,line_items:lineItems,
      client_reference_id:w.id,metadata,
      subscription_data:{metadata},
      success_url:origin.origin+"/billing/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url:origin.origin+"/billing/cancel"
   },{idempotencyKey:"gd-"+kind+"-"+w.id+"-"+keys.join("+")+"-"+(w.data[kind+"CheckoutSessionId"]||"first")});
   return session;
 }
 app.get("/v2/pricing",(_req,res)=>res.json({
   currency:"usd",catalogVersion:1,
   free:{storageGB:FREE_GB,workers:FREE_WORKERS,monthlyCents:0},
   workspaceFeeMonthlyCents:500,
   byo:{monthlyCents:1000,yearlyCents:10000,providerFeesExtra:true,manualSetupRequired:true},
   purchasesEnabled:env.STRIPE_CHECKOUT_ENABLED==="true",
   storage:Object.fromEntries(Object.keys(STORAGE).map(t=>[t,{
     gb:STORAGE[t].gb,monthlyCents:STORAGE[t].standard,
     yearlyCents:STORAGE[t].standard*10,
     bundleMonthlyCents:STORAGE[t].bundle,bundleYearlyCents:STORAGE[t].bundle*10,
     bundleWorkers:bundleWorkers(t)
   }])),
   performance:Object.fromEntries(Object.keys(PERFORMANCE).map(t=>[t,{
     workers:PERFORMANCE[t].workers,monthlyCents:PERFORMANCE[t].cents,
     yearlyCents:PERFORMANCE[t].cents*10
   }])),
   gpu:{available:GPU_READY,tiers:Object.fromEntries(Object.entries(GPU).map(([tier,plan])=>[tier,{name:plan.name,monthlyCents:plan.monthlyCents,yearlyCents:plan.monthlyCents*10,gpuMinutesPerMonth:plan.gpuMinutes,maxSessionMinutes:plan.maxSessionMinutes}]))},
   gpuBundles:{available:GPU_READY,discountPercent:10,requires:["storage","performance","gpu"],note:"GPU compute is not yet provisioned. Not purchasable."},
   removeAds:{oneTimeCents:REMOVE_ADS_CENTS}
 }));
 app.post("/v2/gpu/quote",auth,agreed,(req,res)=>{
   try{const quote=req.body?.bundle===true ? tripleBundleQuote({storageTier:req.body.storageTier,performanceTier:req.body.performanceTier,gpuTier:req.body.gpuTier,interval:req.body.interval||"month"}) : gpuQuote(req.body?.gpuTier,req.body?.interval||"month");res.json(quote)}
   catch(_){res.status(400).json({error:"Invalid GPU selection"})}
 });
 app.post("/v2/gpu/checkout",auth,agreed,(_req,res)=>res.status(503).json({error:"GPU checkout unavailable until dedicated workers, isolation, metering and provider costs are verified"}));
 app.get("/v2/workspaces",auth,agreed,async(req,res)=>{
   try{
     const docs=await coll(req).orderBy("createdAt","desc").limit(100).get();
     res.json({ownerBenefits:req.ownerBenefits===true,workspaces:docs.docs.map(d=>publicWorkspace({id:d.id,data:d.data()}))});
   }catch(_){res.status(503).json({error:"Workspaces unavailable"})}
 });
 app.post("/v2/workspaces/free",auth,agreed,async(req,res)=>{
   try{
     const name=validateWorkspaceName(req.body?.name||"Free Workspace");
     // Deterministic per-account free ID; Firestore create() atomically enforces one free workspace.
     const id="00000000-0000-4000-8000-"+hash(req.user.uid).slice(0,12);
     const ref=coll(req).doc(id);
     await ref.create({name,kind:"free",accountHash:hash(req.user.uid),
       storageTier:null,storageActive:false,performanceTier:null,performanceActive:false,
       provisioned:false,freeLimitBytes:FREE_GB*1000*1000*1000,
       createdAt:stamp()});
     return res.status(201).json({workspaceId:id,plan:"free",workers:FREE_WORKERS,
       storageGB:FREE_GB,provisioned:false});
   }catch(_){return res.status(400).json({error:"Cannot create free workspace"})}
 });
 app.post("/v2/workspaces/draft",auth,agreed,async(req,res)=>{
   try{
     const name=validateWorkspaceName(req.body?.name);
     const interval=req.body?.interval||"month";
     const kind=req.body?.mode==="byo"?"byo":"paid";
     const mode=req.body?.mode||"standard";
     const plan=kind==="byo"?byoQuote(interval):storageQuote(req.body?.tier,interval,mode);
     const intent=req.body?.intentId;
     if(intent!==undefined&&(typeof intent!=="string"||!(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i).test(intent)))
       return res.status(400).json({error:"Invalid checkout intent"});
     const id=intent?intent.toLowerCase():crypto.randomUUID();
     const ref=coll(req).doc(id);
     const record={
       name,kind,accountHash:hash(req.user.uid),
       storageTier:plan.tier||null,storageMode:plan.mode||null,storageInterval:plan.interval,
       byoActive:false,manualProviderConfigured:false,
       storageActive:false,performanceTier:null,performanceActive:false,
       provisioned:false,createdAt:stamp()};
     try{await ref.create(record)}catch(error){
       if(!intent||![6,"6","ALREADY_EXISTS"].includes(error.code))throw error;
       const previous=await ref.get(),saved=previous.data();
       if(!previous.exists||["name","kind","accountHash","storageTier","storageMode","storageInterval"].some(key=>saved[key]!==record[key]))
         return res.status(409).json({error:"This checkout intent belongs to a different selection. Choose the plan again."});
       return res.json({workspaceId:id,quote:plan,provisioned:saved.provisioned===true,resumed:true});
     }
     res.status(201).json({workspaceId:id,quote:plan,provisioned:false});
   }catch(_){res.status(400).json({error:"Invalid workspace or storage plan"})}
 });
 app.get("/v2/workspaces/:id",auth,agreed,async(req,res)=>{
   try{const w=await getWorkspace(req,res);if(w)res.json(publicWorkspace(w))}
   catch(_){res.status(503).json({error:"Workspace unavailable"})}
 });
 async function existingCheckout(w,kind,res,selection){
   if(w.data[kind+"SubscriptionId"]){res.status(409).json({error:"This subscription already exists. Use Manage Billing to change or cancel it."});return true;}
   const id=w.data[kind+"CheckoutSessionId"];
   if(!id)return false;
   const previous=await stripe.checkout.sessions.retrieve(id);
   // An old open performance checkout must not silently override the card the
   // customer just selected. Expire only that owned unpaid session, then create
   // a session for the new server-validated selection.
   if(kind==="performance"&&selection&&(w.data.pendingPerformanceTier!==selection.tier||w.data.pendingPerformanceInterval!==selection.interval)){
     if(previous.status==="open"){await stripe.checkout.sessions.expire(id);return false;}
     if(previous.status!=="expired"){res.status(409).json({error:"The previous performance payment is being verified. Refresh before changing plans."});return true;}
   }
   if(previous.status==="open"&&previous.url){res.json({url:previous.url,resumed:true});return true;}
   if(previous.status!=="expired"){res.status(409).json({error:"Payment is being verified. Refresh your workspace before trying again."});return true;}
   return false;
 }
 app.post("/v2/workspaces/:id/checkout/storage",auth,agreed,async(req,res)=>{
   try{
     const w=await getWorkspace(req,res);if(!w)return;
     if(w.data.kind!=="paid")return res.status(409).json({error:"Managed storage workspace required"});
     const plan=storageQuote(w.data.storageTier,w.data.storageInterval,w.data.storageMode||"standard");
     if(req.ownerBenefits===true){
       await w.ref.update({storageActive:true,provisioned:true,entitlementSource:"owner",updatedAt:stamp()});
       return res.json({complimentary:true,workspaceId:w.id,quote:{...plan,totalCents:0},message:"Owner storage activated at no charge."});
     }
     if(await existingCheckout(w,"storage",res))return;
     const session=await checkoutSession(req,"storage",w,priceKeysStorage(plan));
     await w.ref.update({storageCheckoutSessionId:session.id,updatedAt:stamp()});
     res.json({url:session.url,quote:plan});
   }catch(_){res.status(503).json({error:"Storage checkout unavailable; verify Stripe price configuration"})}
 });
 app.post("/v2/workspaces/:id/manual-provider",auth,agreed,async(req,res)=>{
   try{
     const w=await getWorkspace(req,res);if(!w)return;
     if(w.data.kind!=="byo")return res.status(409).json({error:"BYO workspace required"});
     const provider=String(req.body?.provider||"").trim().toLowerCase();
     const label=String(req.body?.label||"").trim();
     if(!["s3","gcs","r2","b2","sftp","webdav","google-drive","onedrive","other"].includes(provider)||
       label.length<3||label.length>100||req.body?.connectionTested!==true)
       return res.status(400).json({error:"Complete manual setup and local provider test first"});
     // Customer-managed credentials never reach GenDragoon's billing server.
     await w.ref.update({manualProviderConfigured:true,providerType:provider,
       providerLabel:label,updatedAt:stamp()});
     res.json({verifiedLocally:true,warning:"Customer is responsible for own provider access, charges and availability"});
   }catch(_){res.status(503).json({error:"Could not register BYO manual configuration"})}
 });
 app.post("/v2/workspaces/:id/checkout/byo",auth,agreed,async(req,res)=>{
   try{
     const w=await getWorkspace(req,res);if(!w)return;
     if(w.data.kind!=="byo"||!w.data.manualProviderConfigured)
       return res.status(409).json({error:"Complete and test a manual cloud configuration first"});
     if(req.ownerBenefits===true){
       await w.ref.update({byoActive:true,entitlementSource:"owner",updatedAt:stamp()});
       return res.json({complimentary:true,workspaceId:w.id,message:"Owner BYO access activated. Your provider's own charges still apply."});
     }
     if(await existingCheckout(w,"byo",res))return;
     const plan=byoQuote(w.data.storageInterval);
     const session=await checkoutSession(req,"byo",w,priceKeysBYO(plan));
     await w.ref.update({byoCheckoutSessionId:session.id,updatedAt:stamp()});
     res.json({url:session.url,quote:plan});
   }catch(_){res.status(503).json({error:"BYO checkout unavailable"})}
 });
 app.post("/v2/workspaces/:id/checkout/performance",auth,agreed,async(req,res)=>{
   try{
     const w=await getWorkspace(req,res);if(!w)return;
     if(!((w.data.kind==="paid"&&w.data.storageActive&&w.data.provisioned)||
            (w.data.kind==="byo"&&w.data.byoActive&&w.data.manualProviderConfigured)))
       return res.status(409).json({error:"Active provisioned storage required before performance upgrade"});
     const plan=performanceQuote(req.body?.tier,req.body?.interval||"month");
     if(req.ownerBenefits===true){
       await w.ref.update({performanceActive:true,performanceTier:plan.tier,entitlementSource:"owner",updatedAt:stamp()});
       return res.json({complimentary:true,workspaceId:w.id,quote:{...plan,totalCents:0},message:"Owner performance activated at no charge."});
     }
     if(await existingCheckout(w,"performance",res,plan))return;
     const session=await checkoutSession(req,"performance",w,priceKeysPerformance(plan));
     await w.ref.update({performanceCheckoutSessionId:session.id,
       pendingPerformanceTier:plan.tier,pendingPerformanceInterval:plan.interval,updatedAt:stamp()});
     res.json({url:session.url,quote:plan});
   }catch(_){res.status(503).json({error:"Performance checkout unavailable"})}
 });
 app.get("/v2/account/entitlements",auth,agreed,async(req,res)=>{
   try{const ads=await db.collection("ad_purchases").doc(req.user.uid).get();
     res.setHeader("Cache-Control","private, no-store");
     res.json({adFree:req.ownerBenefits===true||(ads.exists&&ads.data().active===true),ownerBenefits:req.ownerBenefits===true});
   }catch(_){res.status(503).json({error:"Entitlements temporarily unavailable"});}
 });
 app.post("/v2/remove-ads/checkout",auth,agreed,async(req,res)=>{
   try{
     if(req.ownerBenefits===true)return res.json({complimentary:true,message:"Owner ad-free access is already active."});
     if(env.STRIPE_CHECKOUT_ENABLED!=="true")return res.status(503).json({error:"Checkout not enabled"});
     const uid=req.user.uid;
     const adDoc=await db.collection("ad_purchases").doc(uid).get();
     if(adDoc.exists&&adDoc.data().active===true)
       return res.status(409).json({error:"Remove Ads already purchased"});
     const customer=await ensureCustomer(req),origin=new URL(env.PUBLIC_URL);
     if(origin.protocol!=="https:")throw Error("HTTPS required");
     const aRef=accRef(req),aSnap=await aRef.get(),priorId=aSnap.data()?.adsCheckoutSessionId;
     if(priorId){const prior=await stripe.checkout.sessions.retrieve(priorId);
       if(prior.status==="open"&&prior.url)return res.json({url:prior.url,oneTimeCents:REMOVE_ADS_CENTS});
       if(prior.status!=="expired"&&!(adDoc.exists&&adDoc.data().active===false&&adDoc.data().revokedAt))
         return res.status(409).json({error:"Your purchase is being verified. Refresh account status."});
     }
     const session=await stripe.checkout.sessions.create({
       mode:"payment",customer,line_items:[{price:verifiedPrice("one_time|remove_ads"),quantity:1}],
       client_reference_id:hash(uid),metadata:{kind:"remove_ads",uid,accountHash:hash(uid)},
       success_url:origin.origin+"/billing/success?session_id={CHECKOUT_SESSION_ID}",
       cancel_url:origin.origin+"/billing/cancel"
     },{idempotencyKey:"gd-remove-ads-"+hash(uid)+"-"+(priorId||"first")});
     await aRef.set({adsCheckoutSessionId:session.id},{merge:true});
     res.json({url:session.url,oneTimeCents:REMOVE_ADS_CENTS});
   }catch(_){res.status(503).json({error:"Remove Ads checkout unavailable"})}
 });
 async function reconcileSubscription(sub){
   const m=sub.metadata||{},kind=m.kind,owner=m.accountHash,id=m.workspaceId;
   if(!["storage","performance","byo"].includes(kind)||typeof owner!=="string"||
      !/^[a-f0-9]{64}$/.test(owner)||!safeWorkspaceId(id))return false;
   const aRef=accounts.doc(owner),wRef=aRef.collection("workspaces").doc(id);
   const [a,w]=await Promise.all([aRef.get(),wRef.get()]);
   if(!a.exists||!w.exists||w.data().accountHash!==owner)return false;
   const customer=typeof sub.customer==="string"?sub.customer:sub.customer?.id;
   if(a.data().stripeCustomerId!==customer)return false;
   const data=w.data(),active=ACTIVE_STATUSES.has(sub.status);
   let expected,patch;
   if(kind==="byo"){
     if(data.kind!=="byo" || (data.byoSubscriptionId && data.byoSubscriptionId!==sub.id))return false;
     expected=priceKeysBYO(byoQuote(data.storageInterval)).map(verifiedPrice);
     const matches=matchesStripePrices(sub,expected);
     patch={byoSubscriptionId:sub.id,byoStatus:sub.status,
       byoActive:active&&matches};
   } else if(kind==="storage"){
     if(data.kind!=="paid" || (data.storageSubscriptionId && data.storageSubscriptionId!==sub.id))return false;
     expected=priceKeysStorage(storageQuote(data.storageTier,data.storageInterval,data.storageMode||"standard")).map(verifiedPrice);
     const matches=matchesStripePrices(sub,expected);
     patch={storageSubscriptionId:sub.id,storageStatus:sub.status,
       storageActive:active&&matches};
   } else {
     if(!["paid","byo"].includes(data.kind) || (data.performanceSubscriptionId && data.performanceSubscriptionId!==sub.id))return false;
     const tier=data.pendingPerformanceTier||data.performanceTier;
     const interval=data.pendingPerformanceInterval||data.performanceInterval;
     if(!tier||!interval)return false;
     expected=priceKeysPerformance(performanceQuote(tier,interval)).map(verifiedPrice);
     const matches=matchesStripePrices(sub,expected);
     patch={performanceSubscriptionId:sub.id,performanceStatus:sub.status,
       performanceActive:active&&matches,
       performanceTier:matches?tier:(data.performanceTier||null),
       performanceInterval:matches?interval:(data.performanceInterval||null)};
   }
   await wRef.update({...patch,updatedAt:stamp()});
   return true;
 }
 async function reconcileAds(session){
   if(session.mode!=="payment"||session.payment_status!=="paid"||session.metadata?.kind!=="remove_ads")return false;
   const {uid,accountHash}=session.metadata;
   if(typeof uid!=="string"||uid.length>150||hash(uid)!==accountHash)return false;
   const acc=await accounts.doc(accountHash).get();
   if(!acc.exists||acc.data().stripeCustomerId!==session.customer)return false;
   const price=verifiedPrice("one_time|remove_ads");
   const lines=await stripe.checkout.sessions.listLineItems(session.id,{limit:10});
   if(lines.data.length!==1||lines.data[0]?.price?.id!==price||lines.data[0]?.quantity!==1)return false;
   const intentId=typeof session.payment_intent==="string"?session.payment_intent:session.payment_intent?.id;
   if(!/^pi_[A-Za-z0-9]+$/.test(intentId||""))return false;
   // Checkout completion can arrive after a refund/dispute. Verify current payment state.
   const intent=await stripe.paymentIntents.retrieve(intentId,{expand:["latest_charge"]});
   const customer=typeof intent.customer==="string"?intent.customer:intent.customer?.id;
   const charge=typeof intent.latest_charge==="string"?await stripe.charges.retrieve(intent.latest_charge):intent.latest_charge;
   if(intent.status!=="succeeded"||customer!==session.customer||intent.currency!=="usd"||
      intent.amount_received<REMOVE_ADS_CENTS||!charge||charge.disputed||charge.refunded||
      (charge.amount_captured>0&&charge.amount_refunded>=charge.amount_captured))return false;
   const ref=db.collection("ad_purchases").doc(uid);
   return db.runTransaction(async tx=>{
     const previous=await tx.get(ref);
     if(previous.exists&&previous.data().stripePaymentIntentId===intentId&&previous.data().revokedAt)return false;
     tx.set(ref,{active:true,stripeCustomerId:session.customer,checkoutSessionId:session.id,
       stripePaymentIntentId:intentId,purchasedAt:stamp(),revokedAt:null,revokedReason:null},{merge:true});
     return true;
   });
 }
 return {reconcileSubscription,reconcileAds,effectiveWorkers};
}
module.exports={registerBillingV2,storageQuote,performanceQuote,effectiveWorkers,
 FREE_GB,FREE_WORKERS,REMOVE_ADS_CENTS,matchesStripePrices,priceKeysStorage,priceKeysPerformance,
 byoQuote,priceKeysBYO};
