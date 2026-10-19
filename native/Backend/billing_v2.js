"use strict";
const crypto=require("node:crypto");
const {STORAGE,PERFORMANCE,validateWorkspaceName}=require("./catalog");
const {GPU,GPU_READY,gpuQuote,tripleBundleQuote}=require("./gpu_catalog");
const {createProjectService,ProjectError,projectStatus,activatedBasicProject,effectiveStorageQuota,safeProjectId,hasContinuingBilling,isGrandfathered,evaluateLapse,workspacePrice,byoLapsed}=require("./projects");
const {rejectProviderSecrets,isPlansWorkspace,plansEntitled}=require("./workspace_policy");
const FREE_GB=2,FREE_WORKERS=1,REMOVE_ADS_CENTS=499;
const VALID_INTERVALS=new Set(["month","year"]);
const ACTIVE_STATUSES=new Set(["active","trialing"]);
function yearFactor(period){return period==="year"?10:1}
function storageQuote(tier,interval,mode="standard",billingVersion=1){
 if(typeof tier!=="string"||!Object.hasOwn(STORAGE,tier)||!VALID_INTERVALS.has(interval))throw Error("Invalid storage plan");
 if(!["standard","bundle"].includes(mode))throw Error("Invalid storage mode");
 const monthly=STORAGE[tier][mode];
 const recurringFee=billingVersion>=2?0:500;
 return {tier,interval,mode,storageGB:STORAGE[tier].gb,storageCents:monthly*yearFactor(interval),
  workspaceFeeCents:recurringFee*yearFactor(interval),totalCents:(monthly+recurringFee)*yearFactor(interval),
  ...(billingVersion>=2?{billingVersion:2}:{})};
}
function byoQuote(interval){
 if(!VALID_INTERVALS.has(interval))throw Error("Invalid BYO interval");
 return {interval,kind:"byo",totalCents:500*yearFactor(interval),storageGB:0,workers:1};
}
function performanceQuote(tier,interval){
 if(typeof tier!=="string"||!Object.hasOwn(PERFORMANCE,tier)||!VALID_INTERVALS.has(interval))throw Error("Invalid performance plan");
 return {tier,interval,workerLimit:PERFORMANCE[tier].workers,
  totalCents:PERFORMANCE[tier].cents*yearFactor(interval)};
}
function priceKeysStorage(plan){return [...(plan.workspaceFeeCents>0?["workspace|"+plan.interval]:[]),
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
 if(!workspace||["archived","pending_payment","payment_revoked","payment_confirmed_pending_capacity"].includes(projectStatus(workspace)))return 0;
 if(workspace.kind==="byo"){
   // Custom storage on the plans model runs only while its performance plan is paid.
   if(isPlansWorkspace(workspace)&&!(plansEntitled(workspace)&&workspace.performanceActive===true))return 0;
   if(!workspace.byoActive||!workspace.manualProviderConfigured||workspace.byoChallengeVerified!==true)return 0;
   return workspace.performanceActive===true && PERFORMANCE[workspace.performanceTier] ?
     PERFORMANCE[workspace.performanceTier].workers:FREE_WORKERS;
 }
 if(effectiveStorageQuota(workspace)<=0)return 0;
 const base=workspace.storageActive&&workspace.storageMode==="bundle" ? bundleWorkers(workspace.storageTier):FREE_WORKERS;
 return workspace.performanceActive===true && PERFORMANCE[workspace.performanceTier] ?
  Math.max(base,PERFORMANCE[workspace.performanceTier].workers):base;
}
 function registerBillingV2({app,db,stripe,admin,auth,agreed,hash,prices,env=process.env,byoFetch=null,bucket=null}){
 const stamp=()=>admin.firestore.FieldValue.serverTimestamp();
 const accounts=db.collection("gd_accounts");
 const accRef=req=>accounts.doc(hash(req.user.uid));
 const coll=req=>accRef(req).collection("workspaces");
 const safeWorkspaceId=safeProjectId;
 const projects=createProjectService({db,stamp,hash,stripe,env,prices,ensureCustomer,byoFetch});
 const teams=require("./teams").createTeamService({db,stamp,hash,stripe,env,prices,ensureCustomer,bucket});
 if(app)require("./teams").registerTeams({app,auth,agreed,service:teams});
 function projectError(res,error){
   if(!(error instanceof ProjectError))return res.status(503).json({error:"PROJECT_UNAVAILABLE"});
   const body={error:error.code};
   if(error.message&&error.message!==error.code)body.message=error.message;
   if(error.provider)body.provider=error.provider;
   return res.status(error.status).json(body);
 }
 async function getWorkspace(req,res){
   try{return await projects.get(req,req.params.id);}catch(error){projectError(res,error);return null;}
 }
 function publicWorkspace(w,freeId=null){
   const price=workspacePrice({...w.data,id:w.id},freeId);
   return {id:w.id,name:w.data.name,kind:w.data.kind,storageMode:w.data.storageMode||null,
   isFree:price.isFree,monthlyPriceCents:price.monthlyPriceCents,
   byoActive:!!w.data.byoActive,manualProviderConfigured:!!w.data.manualProviderConfigured,
   storageTier:w.data.storageTier||null,
   storageInterval:w.data.storageInterval||null,storageBillingVersion:w.data.storageBillingVersion||1,
   storageActive:!!w.data.storageActive,performanceTier:w.data.performanceTier||null,
   performanceInterval:w.data.performanceInterval||null,
   performanceActive:!!w.data.performanceActive,workers:effectiveWorkers(w.data),
   quotaGB:effectiveStorageQuota(w.data)/1e9,usedBytes:w.data.usedBytes||0,reservedBytes:w.data.reservedBytes||0,
   provisioned:w.data.provisioned===true||(w.data.kind==="free"&&w.data.provisioned!==false),
   projectStatus:projectStatus(w.data),projectBillingVersion:w.data.projectBillingVersion||1,
   projectFeeStatus:w.data.projectFeeStatus||"legacy",projectFeeCents:w.data.projectFeeCents||0,
   grandfathered:isGrandfathered(w.data),lapsed:evaluateLapse(w.data).lapsed||byoLapsed(w.data),
   workspaceFeeModel:w.data.workspaceFeeModel||(isGrandfathered(w.data)?"one_time":null),
   byoChallengeVerified:w.data.byoChallengeVerified===true,
   intendedSelection:w.data.intendedSelection||{},dataRetained:w.data.dataRetained===true,
   hasContinuingBilling:hasContinuingBilling(w.data),transferEligible:effectiveStorageQuota(w.data)>0,
   billingModel:isPlansWorkspace(w.data)?"plans":w.data.kind==="free"||price.isFree?"free":"legacy",
   customStorage:w.data.customStorage===true,requiredPlans:w.data.requiredPlans||null,plansStatus:w.data.plansStatus||null,
   workspaceFeeIncluded:isPlansWorkspace(w.data)||price.isFree};
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
   currency:"usd",catalogVersion:2,
   free:{storageGB:FREE_GB,workers:FREE_WORKERS,monthlyCents:0},
   // The workspace fee is included in storage plans; nothing is charged on top.
   workspaceFeeMonthlyCents:0,workspaceFeeIncluded:true,
   projects:{firstFree:true,firstFreeIncludes:{storageGB:FREE_GB,performanceTier:"free",workers:FREE_WORKERS},
     additionalRequires:["storage","performance"],customStorageRequires:["performance"],
     additionalOneTimeCents:0,workspaceMonthlyCents:0,feeIsOneTime:false,freeWorkspaces:1,defaultLimit:10,qualifiedLimit:20,
     qualifyingStorageTier:"2TB",qualifyingPerformanceTier:"turbo",qualifyingWorkers:8,
     qualificationLabel:"2 TB storage AND Turbo (8 workers) or higher on the same active project; equivalent bundles qualify",
     paymentAvailable:projects.paymentAvailable(),archiveRetainsData:true},
   customStorage:{storagePlanRequired:false,performancePlanRequired:true,extraFeeCents:0,providerFeesExtra:true,setupWizard:true},
   // Compatibility for released clients that still decode `byo`: there is no BYO fee any more.
   byo:{monthlyCents:0,yearlyCents:0,retired:true,replacedBy:"customStorage"},
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
   removeAds:{oneTimeCents:REMOVE_ADS_CENTS},
   // Team subscription; each team workspace still needs its own plans on top.
   teams:(({tiers,enterprise,perWorkspace})=>({tiers,enterprise,perWorkspace,yearlyMonthsCharged:10,
     purchasable:Object.keys(require("./teams").TEAM_TIERS).every(t=>["month","year"].every(iv=>typeof prices[require("./teams").teamPriceKey(t,iv)]==="string"))}))(require("./teams").catalog())
 }));
 app.post("/v2/gpu/quote",auth,agreed,(req,res)=>{
   try{const quote=req.body?.bundle===true ? tripleBundleQuote({storageTier:req.body.storageTier,performanceTier:req.body.performanceTier,gpuTier:req.body.gpuTier,interval:req.body.interval||"month"}) : gpuQuote(req.body?.gpuTier,req.body?.interval||"month");res.json(quote)}
   catch(_){res.status(400).json({error:"Invalid GPU selection"})}
 });
 app.post("/v2/gpu/checkout",auth,agreed,(_req,res)=>res.status(503).json({error:"GPU checkout unavailable until dedicated workers, isolation, metering and provider costs are verified"}));
 app.get("/v2/workspaces",auth,agreed,async(req,res)=>{
   try{
     const result=await projects.inventory(req);
     res.json({ownerBenefits:req.ownerBenefits===true,workspaces:result.records.filter(w=>projectStatus(w.data)!=="archived").map(w=>publicWorkspace(w,result.policy.freeWorkspaceId)),policy:result.policy});
   }catch(_){res.status(503).json({error:"Workspaces unavailable"})}
 });
 app.get("/v2/projects",auth,agreed,async(req,res)=>{
   try{const result=await projects.inventory(req);res.json({ownerBenefits:req.ownerBenefits===true,policy:result.policy,
     projects:result.records.filter(w=>req.query.includeArchived==="true"||projectStatus(w.data)!=="archived").map(w=>publicWorkspace(w,result.policy.freeWorkspaceId))});}
   catch(error){projectError(res,error);}
 });
 app.post("/v2/projects",auth,agreed,async(req,res)=>{
   try{
     const result=await projects.create(req,{name:req.body?.name,intentId:req.body?.intentId,
       storage:req.body?.storage||"managed",plans:req.body?.plans||null});
     let payment={};
     if(isPlansWorkspace(result.project.data)&&result.project.data.projectStatus==="pending_payment")payment=await projects.checkout(req,result.project.id);
     const project=publicWorkspace(result.project,result.policy.freeWorkspaceId);
     res.status(result.resumed?200:201).json({project,workspaceId:result.project.id,isFree:project.isFree,monthlyPriceCents:0,
       policy:result.policy,resumed:result.resumed,oneTimeCents:0,...payment});
   }catch(error){projectError(res,error);}
 });
 app.get("/v2/projects/:id",auth,agreed,async(req,res)=>{
   try{
     const result=await projects.inventory(req),w=result.records.find(item=>item.id===req.params.id);
     if(!w)return res.status(404).json({error:"PROJECT_NOT_FOUND",message:"Project not found"});
     res.json(publicWorkspace(w,result.policy.freeWorkspaceId));
   }catch(error){projectError(res,error);}
 });
 app.post("/v2/projects/:id/checkout",auth,agreed,async(req,res)=>{
   try{res.json(await projects.checkout(req,req.params.id,req.body||{}));}catch(error){projectError(res,error);}
 });
 app.put("/v2/projects/:id/selection",auth,agreed,async(req,res)=>{
   try{res.json({workspaceId:req.params.id,intendedSelection:await projects.setSelection(req,req.params.id,req.body)});}catch(error){projectError(res,error);}
 });
 app.delete("/v2/projects/:id",auth,agreed,async(req,res)=>{
   try{res.json(await projects.remove(req,req.params.id));}catch(error){projectError(res,error);}
 });
 app.post("/v2/projects/:id/archive",auth,agreed,async(req,res)=>{
   try{res.json(await projects.archive(req,req.params.id,req.body));}catch(error){projectError(res,error);}
 });
 app.post("/v2/projects/:id/restore",auth,agreed,async(req,res)=>{
   try{res.json(await projects.restore(req,req.params.id));}catch(error){projectError(res,error);}
 });
 app.post("/v2/workspaces/:id/merge/preview",auth,agreed,async(req,res)=>{
   try{res.json(await projects.mergePreview(req,req.params.id,{targetId:req.body?.targetId,confirmName:req.body?.confirmName}));}
   catch(error){projectError(res,error);}
 });
 app.post("/v2/workspaces/:id/merge",auth,agreed,async(req,res)=>{
   try{res.json(await projects.merge(req,req.params.id,{targetId:req.body?.targetId,confirmName:req.body?.confirmName}));}
   catch(error){projectError(res,error);}
 });
 app.post("/v2/workspaces/:id/byo/register",auth,agreed,async(req,res)=>{
   try{res.json(await projects.registerByo(req,req.params.id,req.body||{}));}catch(error){projectError(res,error);}
 });
 app.post("/v2/workspaces/:id/byo/challenge",auth,agreed,async(req,res)=>{
   try{res.json(await projects.issueByoChallenge(req,req.params.id));}catch(error){projectError(res,error);}
 });
 app.post("/v2/workspaces/:id/byo/verify",auth,agreed,async(req,res)=>{
   try{res.json(await projects.verifyByo(req,req.params.id,req.body||{}));}catch(error){projectError(res,error);}
 });
 app.post("/v2/workspaces/free",auth,agreed,async(req,res)=>{
   try{
     const result=await projects.create(req,{name:req.body?.name||"Free Workspace",legacyFree:true});
     return res.status(201).json({workspaceId:result.project.id,plan:"free",workers:FREE_WORKERS,
       storageGB:FREE_GB,provisioned:true,policy:result.policy});
   }catch(error){projectError(res,error);}
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
     const updateRequired=()=>res.status(426).json({error:"CLIENT_UPDATE_REQUIRED",projectFlow:"/v2/projects",
       message:"Update GenDragoon to create a workspace. Each new workspace after your first needs a storage plan and a performance plan."});
     // Older clients cannot complete the separate project-activation flow. This
     // compatibility endpoint may resume an existing legacy intent, but never
     // creates a new project or switches a storage purchase into a project fee.
     if(!intent)return updateRequired();
     let w;
     try{w=await projects.get(req,intent.toLowerCase());}
     catch(error){if(error instanceof ProjectError&&error.code==="PROJECT_NOT_FOUND")return updateRequired();throw error;}
     if(w.data.projectBillingVersion===2)return updateRequired();
     const expected={name,kind,accountHash:hash(req.user.uid),storageTier:plan.tier||null,
       storageMode:plan.mode||null,storageInterval:interval};
     if(Object.keys(expected).some(key=>w.data[key]!==expected[key]))
       return res.status(409).json({error:"INTENT_CONFLICT",message:"This checkout intent belongs to a different selection. Choose the plan again."});
     if(projectStatus(w.data)==="archived")return res.status(409).json({error:"PROJECT_ARCHIVED",message:"Restore this project in Cloud before continuing its purchase."});
     const quote=kind==="byo"?plan:storageQuote(plan.tier,interval,mode,w.data.storageBillingVersion||1);
     res.json({workspaceId:w.id,quote,provisioned:w.data.provisioned===true,
       projectStatus:projectStatus(w.data),projectActivationRequired:false,oneTimeProjectCents:0,resumed:true});
   }catch(error){if(error instanceof ProjectError)return projectError(res,error);res.status(400).json({error:"Invalid workspace or storage plan"})}
 });
 app.get("/v2/workspaces/:id",auth,agreed,async(req,res)=>{
   try{
     const w=await getWorkspace(req,res);
     if(!w)return;
     const result=await projects.inventory(req);
     res.json(publicWorkspace(w,result.policy.freeWorkspaceId));
   }
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
   const oldSelection=kind==="performance"?{tier:w.data.pendingPerformanceTier,interval:w.data.pendingPerformanceInterval}:
     kind==="storage"?{tier:w.data.pendingStorageTier||w.data.storageTier,interval:w.data.pendingStorageInterval||w.data.storageInterval,mode:w.data.pendingStorageMode||w.data.storageMode}:null;
   if(oldSelection&&selection&&Object.keys(oldSelection).some(k=>oldSelection[k]!==selection[k])){
     if(previous.status==="open"){await stripe.checkout.sessions.expire(id);return false;}
     if(previous.status!=="expired"){res.status(409).json({error:"The previous payment is being verified. Refresh before changing plans."});return true;}
   }
   if(previous.status==="open"&&previous.url){res.json({url:previous.url,resumed:true});return true;}
   if(previous.status!=="expired"){res.status(409).json({error:"Payment is being verified. Refresh your workspace before trying again."});return true;}
   return false;
 }
 app.post("/v2/workspaces/:id/checkout/storage",auth,agreed,async(req,res)=>{
   try{
     const w=await getWorkspace(req,res);if(!w)return;
     if(!["paid","free"].includes(w.data.kind))return res.status(409).json({error:"Managed storage project required"});
     if(isPlansWorkspace(w.data))return res.status(409).json({error:"PLANS_MANAGED_TOGETHER",message:"This workspace's storage and performance plans are billed together. Use Manage Billing to change them.",workspaceId:w.id});
     if(w.data.projectBillingVersion===2&&!activatedBasicProject(w.data))return res.status(409).json({error:"PROJECT_ACTIVATION_REQUIRED",
       message:"Activate or restore this project in Cloud before choosing a storage plan.",workspaceId:w.id});
     await projects.withLease(req,w.id,async fresh=>{
       const intent=fresh.data.intendedSelection||{};
       const plan=storageQuote(req.body?.tier||intent.storageTier||fresh.data.storageTier,
         req.body?.interval||intent.storageInterval||fresh.data.storageInterval||"month",
         req.body?.mode||intent.storageMode||fresh.data.storageMode||"standard",
         2); // New storage checkouts never add the retired workspace fee.
       const retained={...(fresh.data.intendedSelection||{}),storageTier:plan.tier,storageMode:plan.mode,storageInterval:plan.interval};
       if(req.ownerBenefits===true){
         await fresh.ref.update({storageTier:plan.tier,storageMode:plan.mode,storageInterval:plan.interval,storageBillingVersion:2,
           storageActive:true,provisioned:true,entitlementSource:"owner",intendedSelection:retained,updatedAt:stamp()});
         return res.json({complimentary:true,workspaceId:fresh.id,quote:{...plan,totalCents:0},message:"Owner storage activated at no charge."});
       }
       if(await existingCheckout(fresh,"storage",res,plan))return;
       const session=await checkoutSession(req,"storage",fresh,priceKeysStorage(plan));
       await fresh.ref.update({storageCheckoutSessionId:session.id,pendingStorageTier:plan.tier,pendingStorageMode:plan.mode,
         pendingStorageInterval:plan.interval,pendingStorageBillingVersion:plan.billingVersion||1,intendedSelection:retained,updatedAt:stamp()});
       res.json({url:session.url,quote:plan});
     });
   }catch(error){if(error instanceof ProjectError)return projectError(res,error);res.status(503).json({error:"Storage checkout unavailable; verify the selected plan and Stripe price configuration"})}
 });
 app.post("/v2/workspaces/:id/manual-provider",auth,agreed,async(req,res)=>{
   try{
     const w=await getWorkspace(req,res);if(!w)return;
     if(!["byo","paid","free"].includes(w.data.kind)||projectStatus(w.data)==="archived")return res.status(409).json({error:"An available project is required"});
     try{rejectProviderSecrets(req.body||{});}catch(error){return res.status(400).json({error:error.code||"BYO_SECRET_REJECTED",message:error.message});}
     // Custom storage is chosen when a workspace is created and is paid by its performance plan.
     if(isPlansWorkspace(w.data)&&w.data.customStorage!==true)
       return res.status(409).json({error:"CUSTOM_STORAGE_NEW_WORKSPACE",message:"Create a new workspace and choose Custom storage to connect your own provider."});
     if(isPlansWorkspace(w.data)&&!(plansEntitled(w.data)&&w.data.performanceActive===true))
       return res.status(402).json({error:"PERFORMANCE_PLAN_REQUIRED",message:"Finish paying for this workspace's performance plan before connecting custom storage."});
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
 // The separate $5 custom-storage fee is retired: custom storage is paid by its
 // performance plan (New workspace, Custom storage). Existing BYO subscriptions are
 // still reconciled below; no new BYO-fee Checkout is created.
 app.post("/v2/workspaces/:id/checkout/byo",auth,agreed,async(req,res)=>{
   try{
     const w=await getWorkspace(req,res);if(!w)return;
     if(req.ownerBenefits===true&&!isPlansWorkspace(w.data)){
       // Owner accounts were never charged; keep their legacy activation path, which
       // still requires a tested provider and a verified challenge.
       if(!w.data.manualProviderConfigured)return res.status(409).json({error:"Complete and test a manual cloud configuration first"});
       return await projects.withLease(req,w.id,async fresh=>{
         if(fresh.data.byoChallengeVerified!==true)
           return res.status(409).json({error:"BYO_CHALLENGE_REQUIRED",message:"Verify the bring-your-own challenge before activating storage"});
         await fresh.ref.update({byoActive:true,entitlementSource:"owner",updatedAt:stamp()});
         return res.json({complimentary:true,workspaceId:fresh.id,message:"Owner BYO access activated. Your provider's own charges still apply."});
       });
     }
     res.status(410).json({error:"CUSTOM_STORAGE_FEE_RETIRED",message:"Custom storage no longer has a separate fee. Create a new workspace, choose Custom storage and a performance plan.",workspaceId:w.id});
   }catch(error){if(error instanceof ProjectError)return projectError(res,error);res.status(503).json({error:"BYO checkout unavailable"})}
 });
 app.post("/v2/workspaces/:id/checkout/performance",auth,agreed,async(req,res)=>{
   try{
     const w=await getWorkspace(req,res);if(!w)return;
     if(isPlansWorkspace(w.data))return res.status(409).json({error:"PLANS_MANAGED_TOGETHER",message:"This workspace's storage and performance plans are billed together. Use Manage Billing to change them.",workspaceId:w.id});
     if(!((effectiveStorageQuota(w.data)>0)||
            (w.data.kind==="byo"&&w.data.byoActive&&w.data.manualProviderConfigured)))
       return res.status(409).json({error:"Active provisioned storage required before performance upgrade"});
     const plan=performanceQuote(req.body?.tier,req.body?.interval||"month");
     await projects.withLease(req,w.id,async fresh=>{
       const retained={...(fresh.data.intendedSelection||{}),performanceTier:plan.tier,performanceInterval:plan.interval};
       if(req.ownerBenefits===true){
         await fresh.ref.update({performanceActive:true,performanceTier:plan.tier,performanceInterval:plan.interval,
           entitlementSource:"owner",intendedSelection:retained,updatedAt:stamp()});
         return res.json({complimentary:true,workspaceId:fresh.id,quote:{...plan,totalCents:0},message:"Owner performance activated at no charge."});
       }
       if(await existingCheckout(fresh,"performance",res,plan))return;
       const session=await checkoutSession(req,"performance",fresh,priceKeysPerformance(plan));
       await fresh.ref.update({performanceCheckoutSessionId:session.id,intendedSelection:retained,
         pendingPerformanceTier:plan.tier,pendingPerformanceInterval:plan.interval,updatedAt:stamp()});
       res.json({url:session.url,quote:plan});
     });
   }catch(error){if(error instanceof ProjectError)return projectError(res,error);res.status(503).json({error:"Performance checkout unavailable"})}
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
   if(sub?.metadata?.kind==="workspace_plans")return projects.reconcilePlans(sub);
   if(String(sub?.metadata?.kind||"").startsWith("team_"))return teams.reconcileSubscription(sub);
   const m=sub.metadata||{},kind=m.kind,owner=m.accountHash,id=m.workspaceId;
   if(!["storage","performance","byo"].includes(kind)||typeof owner!=="string"||
      !/^[a-f0-9]{64}$/.test(owner)||!safeWorkspaceId(id))return false;
   const aRef=accounts.doc(owner),wRef=projects.refFor(owner,id);
   const [a,w]=await Promise.all([aRef.get(),wRef.get()]);
   if(!a.exists||!w.exists||(id==="free"?w.data().accountKey:w.data().accountHash)!==owner)return false;
   const customer=typeof sub.customer==="string"?sub.customer:sub.customer?.id;
   if(a.data().stripeCustomerId!==customer)return false;
   const data=w.data(),active=ACTIVE_STATUSES.has(sub.status);
   let expected,patch;
   if(kind==="byo"){
     if(!["byo","paid","free"].includes(data.kind) || (data.byoSubscriptionId && data.byoSubscriptionId!==sub.id))return false;
     const interval=data.pendingByoInterval||data.byoInterval||data.storageInterval;
     expected=priceKeysBYO(byoQuote(interval)).map(verifiedPrice);
     const matches=matchesStripePrices(sub,expected);
     patch={byoSubscriptionId:sub.id,byoStatus:sub.status,
       byoActive:active&&matches&&data.byoChallengeVerified===true,byoInterval:matches?interval:(data.byoInterval||null)};
   } else if(kind==="storage"){
     if(!["paid","free"].includes(data.kind) || (data.storageSubscriptionId && data.storageSubscriptionId!==sub.id))return false;
     const tier=data.pendingStorageTier||data.storageTier,interval=data.pendingStorageInterval||data.storageInterval,
       mode=data.pendingStorageMode||data.storageMode||"standard",version=data.pendingStorageBillingVersion||data.storageBillingVersion||1;
     if(!tier||!interval)return false;
     expected=priceKeysStorage(storageQuote(tier,interval,mode,version)).map(verifiedPrice);
     const matches=matchesStripePrices(sub,expected);
     patch={storageSubscriptionId:sub.id,storageStatus:sub.status,
       storageActive:active&&matches,storageTier:matches?tier:(data.storageTier||null),
       storageMode:matches?mode:(data.storageMode||null),storageInterval:matches?interval:(data.storageInterval||null),
       storageBillingVersion:matches?version:(data.storageBillingVersion||1)};
   } else {
     if(!["paid","byo","free"].includes(data.kind) || (data.performanceSubscriptionId && data.performanceSubscriptionId!==sub.id))return false;
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
 return {reconcileSubscription,reconcileAds,effectiveWorkers,projects,teams};
}
module.exports={registerBillingV2,storageQuote,performanceQuote,effectiveWorkers,
 FREE_GB,FREE_WORKERS,REMOVE_ADS_CENTS,matchesStripePrices,priceKeysStorage,priceKeysPerformance,
 byoQuote,priceKeysBYO,effectiveStorageQuota};
