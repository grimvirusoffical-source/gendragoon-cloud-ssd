"use strict";
// Product projects are logical, account-owned workspaces. Archiving never deletes
// a Google Cloud project, a bucket, a file record, or an object.
const crypto=require("node:crypto");
const {STORAGE,PERFORMANCE,validateWorkspaceName}=require("./catalog");
const policy=require("./workspace_policy");
const {FREE_WORKSPACES,WORKSPACE_FEE_CENTS,BASE_CAP,RAISED_CAP,QUALIFYING_STORAGE_GB,QUALIFYING_WORKERS,
 monthlyPriceId,isGrandfathered,evaluateLapse,projectStatus,activatedBasicProject,
 qualifiesForRaisedCap:qualifiesForHigherLimit,summarizeProjects,lockBody,publicByoRegistration,rejectProviderSecrets,
 issueChallenge,verifyChallenge,collisionName,fileDigest,storedChecksums,checksumsAgree,invoicePaidThroughMs,isPrivateAddress,
 listAccountProjects,BYO_CHALLENGE_TTL_MS,isByoWorkspace,subscriptionActive,byoLapsed,
 chooseFreeWorkspaceId,freeWorkspaceId,workspacePrice,PLANS_BILLING_VERSION,isPlansWorkspace,plansEntitled}=policy;
// Legacy one-time/monthly workspace fee. New workspaces never pay it: the fee is
// included in storage plans. Kept only to read and reconcile existing records.
const PROJECT_FEE_CENTS=WORKSPACE_FEE_CENTS,DEFAULT_PROJECT_LIMIT=BASE_CAP,QUALIFIED_PROJECT_LIMIT=RAISED_CAP;
const BASIC_QUOTA_BYTES=2_000_000_000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const INTENT=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
class ProjectError extends Error {
 constructor(status,message,code="PROJECT_UNAVAILABLE"){super(message);this.status=status;this.code=code;}
}
function safeProjectId(id){return id==="free"||(typeof id==="string"&&UUID.test(id));}
function effectiveStorageQuota(w){
 if(!w||["archived","pending_payment","payment_revoked","payment_confirmed_pending_capacity"].includes(projectStatus(w)))return 0;
 if(isPlansWorkspace(w)){
  // Managed plans workspace: usable only while BOTH plans are entitled.
  if(w.kind!=="paid"||w.provisioned!==true||!plansEntitled(w)||w.storageActive!==true||w.performanceActive!==true)return 0;
  return Object.hasOwn(STORAGE,w.storageTier||"")?STORAGE[w.storageTier].gb*1e9:0;
 }
 if(w.kind==="free"&&w.provisioned!==false){
   return w.storageActive===true&&Object.hasOwn(STORAGE,w.storageTier||"")?STORAGE[w.storageTier].gb*1e9:BASIC_QUOTA_BYTES;
 }
 if(w.kind!=="paid"||w.provisioned!==true)return 0;
 // An unpaid BYO workspace stays readable so the lapse lock can answer 423.
 if(isByoWorkspace(w)&&projectStatus(w)==="active"){
  if(w.storageActive===true&&Object.hasOwn(STORAGE,w.storageTier||""))return STORAGE[w.storageTier].gb*1e9;
  return BASIC_QUOTA_BYTES;
 }
 if(w.projectBillingVersion===2&&!activatedBasicProject(w))return 0;
 if(w.storageActive===true&&Object.hasOwn(STORAGE,w.storageTier||""))return STORAGE[w.storageTier].gb*1e9;
 return activatedBasicProject(w)?BASIC_QUOTA_BYTES:0;
}
function policyFor(account,projects,{ownerBenefits=false,paymentAvailable=false}={}){
 const summary=summarizeProjects(projects);
 const freeId=freeWorkspaceId(account,projects);
 // Archive keeps the stored id, so deleting is what releases the slot.
 const freeClaimed=!!freeId;
 return {firstProjectFree:true,freeProjectClaimed:freeClaimed,freeProjectAvailable:!freeId,freeWorkspaceId:freeId,
   newProjectOneTimeCents:0,workspaceMonthlyCents:0,workspaceFeeIncluded:true,freeWorkspaces:FREE_WORKSPACES,
   firstWorkspaceIncludes:{storageGB:BASIC_QUOTA_BYTES/1e9,performanceTier:"free",workers:1},
   additionalWorkspaceRequires:["storage","performance"],customStorageRequires:["performance"],
   currency:"usd",feeIsOneTime:false,
   defaultLimit:DEFAULT_PROJECT_LIMIT,qualifiedLimit:QUALIFIED_PROJECT_LIMIT,
   qualifyingStorageTier:"2TB",qualifyingStorageGB:QUALIFYING_STORAGE_GB,
   qualifyingPerformanceTier:"turbo",qualifyingWorkers:QUALIFYING_WORKERS,
   qualificationLabel:"2 TB or more storage AND Turbo (8 workers) or higher on the same active project; equivalent bundles qualify",
   qualifiesForHigherLimit:summary.qualified,projectLimit:summary.projectLimit,
   usedProjectSlots:summary.used,activeProjects:summary.active,
   pendingProjects:summary.pending,
   archivedProjects:summary.archived,grandfatheredProjects:summary.grandfatheredProjects,
   ownerFeeWaived:ownerBenefits,paymentAvailable,
   locked:summary.locked,uploadsBlocked:summary.uploadsBlocked,overBy:summary.overBy,
   unpaidWorkspaceIds:summary.unpaidWorkspaceIds,reason:summary.reason};
}
function validateSelection(raw){
 if(!raw||Array.isArray(raw)||typeof raw!=="object")throw new ProjectError(400,"Choose a valid plan selection","INVALID_SELECTION");
 const out={};
 for(const key of ["storageTier","storageMode","storageInterval","performanceTier","performanceInterval","byoInterval"]){
   if(raw[key]===undefined)continue;
   const value=raw[key];
   if(typeof value!=="string"||
     key==="storageTier"&&!Object.hasOwn(STORAGE,value)||
     key==="performanceTier"&&!Object.hasOwn(PERFORMANCE,value)||
     key==="storageMode"&&!["standard","bundle"].includes(value)||
     key.endsWith("Interval")&&!["month","year"].includes(value))throw new ProjectError(400,"Invalid plan selection","INVALID_SELECTION");
   out[key]=value;
 }
 if(!Object.keys(out).length)throw new ProjectError(400,"Choose a plan to retain","INVALID_SELECTION");
 return out;
}
// Plans for a 2nd+ workspace. Managed storage needs a storage plan AND a
// performance plan; custom storage (own cloud/VPS/S3) needs a performance plan only.
// Both items share one interval because they bill on one subscription.
function validatePlans(raw,{custom=false}={}){
 const r=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw:{};
 const interval=r.interval||r.performanceInterval||r.storageInterval||"month";
 if(!["month","year"].includes(interval))throw new ProjectError(400,"Choose monthly or yearly billing","INVALID_SELECTION");
 for(const k of ["storageInterval","performanceInterval"])if(r[k]!==undefined&&r[k]!==interval)
   throw new ProjectError(400,"Storage and performance plans must use the same billing interval","INVALID_SELECTION");
 const performanceTier=r.performanceTier;
 if(typeof performanceTier!=="string"||!Object.hasOwn(PERFORMANCE,performanceTier))
   throw new ProjectError(400,custom?"Custom storage workspaces need a paid performance plan. Choose Lite, Boost, Turbo, Ultra or Max.":
     "Each additional workspace needs a storage plan and a performance plan. Choose both to continue.",custom?"PERFORMANCE_PLAN_REQUIRED":"PLANS_REQUIRED");
 if(custom){
   if(r.storageTier!==undefined&&r.storageTier!==null)throw new ProjectError(400,"Custom storage uses your own provider, so it has no storage plan","INVALID_SELECTION");
   return {storage:"custom",performanceTier,interval};
 }
 const storageTier=r.storageTier;
 if(typeof storageTier!=="string"||!Object.hasOwn(STORAGE,storageTier))
   throw new ProjectError(400,"Each additional workspace needs a storage plan and a performance plan. Choose both to continue.","PLANS_REQUIRED");
 if(r.storageMode!==undefined&&r.storageMode!=="standard")throw new ProjectError(400,"Bundles are not sold for new workspaces; choose a storage plan and a performance plan","INVALID_SELECTION");
 return {storage:"managed",storageTier,performanceTier,interval};
}
function planPriceKeys(plans){
 return [...(plans.storage==="managed"?["storage|standard|"+plans.storageTier+"|"+plans.interval]:[]),"performance|"+plans.performanceTier+"|"+plans.interval];
}
function plansMonthlyCents(plans){
 return (plans.storage==="managed"?STORAGE[plans.storageTier].standard:0)+PERFORMANCE[plans.performanceTier].cents;
}
function hasContinuingBilling(w){return ["storage","performance","byo","plans"].some(k=>w[k+"SubscriptionId"]&&!["canceled","incomplete_expired"].includes(w[k+"Status"]));}

function createProjectService({db,stamp,hash,stripe,env={},prices={},ensureCustomer,objectStore=null,byoFetch=null}){
 const accounts=db.collection("gd_accounts");
 const accountRef=owner=>accounts.doc(owner);
 const collection=owner=>accountRef(owner).collection("workspaces");
 const legacyRef=owner=>db.collection("tenants").doc(owner).collection("workspaces").doc("free");
 function refFor(owner,id){
   if(!safeProjectId(id))throw new ProjectError(400,"Invalid project identifier","INVALID_PROJECT");
   return id==="free"?legacyRef(owner):collection(owner).doc(id);
 }
 function owned(data,owner,id){return !!data&&(id==="free"?data.accountKey===owner:data.accountHash===owner);}
 // New workspaces pay only for plans (storage + performance); checkout availability
 // is the Stripe switch. The retired $5 fee prices are no longer used for new charges.
 function paymentAvailable(){return env.STRIPE_CHECKOUT_ENABLED==="true";}
 async function snapshot(owner,tx=null){
   const read=ref=>tx?tx.get(ref):ref.get();
   const [account,docs,legacy]=await Promise.all([read(accountRef(owner)),read(collection(owner).limit(201)),read(legacyRef(owner))]);
   if(docs.docs.length>200)throw new ProjectError(409,"Project inventory exceeds the supported review limit. Contact support.","INVENTORY_REVIEW_REQUIRED");
   const records=docs.docs.filter(d=>owned(d.data(),owner,d.id)).map(d=>({id:d.id,ref:d.ref,data:d.data()}));
   if(legacy.exists&&owned(legacy.data(),owner,"free"))records.push({id:"free",ref:legacy.ref||legacyRef(owner),data:legacy.data()});
   return {account:account.data()||{},records};
 }
 function projectViews(state){return state.records.map(w=>({...w.data,id:w.id}));}
 function policy(state,req){return policyFor(state.account,projectViews(state),{ownerBenefits:req.ownerBenefits===true,paymentAvailable:paymentAvailable()});}
 function assignFree(tx,record){
  if(!record)return;
  if(isGrandfathered(record.data)||record.data.projectFeeStatus==="owner"||record.data.projectFeeStatus==="free")return;
  tx.update(record.ref,{projectFeeStatus:"free",projectFeeCents:0,projectStatus:"active",provisioned:true,
    workspaceFeeModel:null,workspaceFeeStatus:null,workspaceFeePaid:null,workspaceFeeCents:0,updatedAt:stamp()});
 }
 function touch(tx,owner,state,extra={}){
   tx.set(accountRef(owner),{freeProjectClaimed:state.account.freeProjectClaimed===true||state.records.length>0,
     projectPolicyVersion:2,projectRevision:(state.account.projectRevision||0)+1,projectUpdatedAt:stamp(),...extra},{merge:true});
 }
 async function inventory(req){const state=await snapshot(hash(req.user.uid));return {...state,policy:policy(state,req)};}
 async function get(req,id){
   const owner=hash(req.user.uid),ref=refFor(owner,id),snap=await ref.get();
   // A foreign accountHash is not distinguishable from a missing workspace.
   if(!snap.exists||!owned(snap.data(),owner,id))throw new ProjectError(404,"Project not found","PROJECT_NOT_FOUND");
   return {id,ref,data:snap.data()};
 }
 async function create(req,{name,intentId,legacyFree=false,selection=null,storage="managed",plans=null}={}){
   try{name=validateWorkspaceName(name||"My Cloud Project");}catch(_){throw new ProjectError(400,"Choose a valid project name","INVALID_PROJECT_NAME");}
   if(!legacyFree&&(typeof intentId!=="string"||!INTENT.test(intentId)))throw new ProjectError(400,"A UUID checkout intent is required","INVALID_INTENT");
   if(!["managed","custom"].includes(storage))throw new ProjectError(400,"Choose managed or custom storage","INVALID_SELECTION");
   const custom=storage==="custom";
   if(legacyFree&&custom)throw new ProjectError(400,"The free workspace uses managed storage","INVALID_SELECTION");
   const id=legacyFree?"free":intentId.toLowerCase(),owner=hash(req.user.uid),ref=refFor(owner,id);
   const intended=selection?validateSelection(selection):{};
   // Validate supplied plans early so a bad request fails before the transaction.
   const supplied=plans?validatePlans(plans,{custom}):null;
   // Team workspaces share the storage routes, so their ids can't be reused here.
   if(!legacyFree&&(await db.collection("gd_team_workspace_index").doc(id).get()).exists)
     throw new ProjectError(409,"This creation intent belongs to another workspace","INTENT_CONFLICT");
   return db.runTransaction(async tx=>{
     const state=await snapshot(owner,tx),p=policy(state,req),previous=state.records.find(w=>w.id===id);
     if(previous){
       if(legacyFree)throw new ProjectError(409,"The free project already exists","PROJECT_EXISTS");
       if(previous.data.name!==name)throw new ProjectError(409,"This creation intent belongs to another project name","INTENT_CONFLICT");
       if(selection&&Object.keys(intended).some(key=>previous.data.creationSelection?.[key]!==intended[key]))throw new ProjectError(409,"This creation intent belongs to another plan selection","INTENT_CONFLICT");
       if(supplied&&previous.data.requiredPlans&&Object.keys(supplied).some(key=>previous.data.requiredPlans[key]!==supplied[key]))throw new ProjectError(409,"This creation intent belongs to another plan selection","INTENT_CONFLICT");
       return {project:previous,policy:p,resumed:true};
     }
     if(p.usedProjectSlots>=p.projectLimit)throw new ProjectError(409,"Project limit reached ("+p.projectLimit+"). Archive a project or qualify with 2 TB storage and Turbo performance.","PROJECT_LIMIT_REACHED");
     if(legacyFree&&!p.freeProjectAvailable)throw new ProjectError(409,"The free workspace has already been claimed. A new workspace needs a storage plan and a performance plan.","FREE_PROJECT_ALREADY_CLAIMED");
     const ownerBenefit=req.ownerBenefits===true;
     // The first managed workspace is free: 2 GB plus the free performance plan.
     // Custom storage never takes the free slot.
     const takesFree=!custom&&p.freeProjectAvailable;
     let data;
     if(takesFree){
       data={name,kind:legacyFree?"free":"paid",accountHash:owner,...(legacyFree?{accountKey:owner}:{}),
         projectBillingVersion:2,projectStatus:"active",projectFeeStatus:ownerBenefit?"owner":"free",projectFeeCents:0,workspaceFeeCents:0,
         storageBillingVersion:2,storageTier:null,storageMode:"standard",storageInterval:"month",storageActive:false,
         performanceTier:null,performanceActive:false,byoActive:false,manualProviderConfigured:false,
         intendedSelection:intended,creationSelection:intended,
         provisioned:true,quotaBytes:BASIC_QUOTA_BYTES,usedBytes:0,reservedBytes:0,createdAt:stamp(),updatedAt:stamp()};
     }else{
       // Every additional workspace: storage plan + performance plan, or for
       // custom storage a performance plan only. No separate workspace fee.
       const required=supplied||validatePlans(null,{custom});
       if(!ownerBenefit&&!plansCheckoutAvailable())throw new ProjectError(503,"Plan checkout is not available yet. Your existing workspaces remain available.","PLANS_CHECKOUT_UNAVAILABLE");
       const managed=required.storage==="managed";
       data={name,kind:managed?"paid":"byo",accountHash:owner,customStorage:!managed,
         projectBillingVersion:PLANS_BILLING_VERSION,projectStatus:ownerBenefit?"active":"pending_payment",
         projectFeeStatus:ownerBenefit?"owner":"included",projectFeeCents:0,workspaceFeeCents:0,
         requiredPlans:required,plansStatus:ownerBenefit?"owner":"pending",
         storageBillingVersion:2,storageTier:ownerBenefit&&managed?required.storageTier:null,storageMode:"standard",
         storageInterval:required.interval,storageActive:ownerBenefit&&managed,
         performanceTier:ownerBenefit?required.performanceTier:null,performanceInterval:required.interval,performanceActive:ownerBenefit,
         ...(ownerBenefit?{entitlementSource:"owner"}:{}),
         byoActive:false,manualProviderConfigured:false,intendedSelection:intended,creationSelection:intended,
         provisioned:ownerBenefit&&managed,quotaBytes:ownerBenefit&&managed?STORAGE[required.storageTier].gb*1e9:0,
         usedBytes:0,reservedBytes:0,createdAt:stamp(),updatedAt:stamp()};
     }
     tx.create(ref,data);
     const assignedFree=takesFree?id:p.freeWorkspaceId;
     touch(tx,owner,state,{freeProjectClaimed:p.freeProjectClaimed||takesFree,freeWorkspaceId:assignedFree,projectsCreatedLifetime:(state.account.projectsCreatedLifetime||state.records.length)+1});
     const next={...state,account:{...state.account,freeProjectClaimed:p.freeProjectClaimed||takesFree,freeWorkspaceId:assignedFree},records:[...state.records,{id,ref,data}]};
     const price=workspacePrice({...data,id},assignedFree);
     return {project:{id,ref,data},policy:policy(next,req),resumed:false,isFree:price.isFree,monthlyPriceCents:price.monthlyPriceCents};
   });
 }
 async function setSelection(req,id,raw){
   const selection=validateSelection(raw),owner=hash(req.user.uid),ref=refFor(owner,id);
   return db.runTransaction(async tx=>{
     const snap=await tx.get(ref);
     if(!snap.exists||!owned(snap.data(),owner,id))throw new ProjectError(404,"Project not found","PROJECT_NOT_FOUND");
     const data=snap.data();
     if(projectStatus(data)==="archived")throw new ProjectError(409,"Restore this project before choosing an upgrade","PROJECT_ARCHIVED");
     const patch={intendedSelection:{...(data.intendedSelection||{}),...selection},selectionUpdatedAt:stamp()};
     tx.update(ref,patch);return patch.intendedSelection;
   });
 }
 // A bounded lease closes the archive versus Checkout creation race. It is not
 // an entitlement: only signed, verified payment fulfillment can activate one.
 async function withLease(req,id,action){
   const owner=hash(req.user.uid),ref=refFor(owner,id),token=crypto.randomUUID();
   const data=await db.runTransaction(async tx=>{
     const snap=await tx.get(ref);
     if(!snap.exists||!owned(snap.data(),owner,id))throw new ProjectError(404,"Project not found","PROJECT_NOT_FOUND");
     const data=snap.data();
     if(projectStatus(data)==="archived")throw new ProjectError(409,"Restore this project before opening Checkout","PROJECT_ARCHIVED");
     if(data.checkoutLease?.expiresAtMs>Date.now())throw new ProjectError(409,"Another billing operation is preparing. Retry shortly.","CHECKOUT_BUSY");
     tx.update(ref,{checkoutLease:{token,expiresAtMs:Date.now()+180_000}});return data;
   });
   try{return await action({id,ref,data});}finally{
     await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(snap.exists&&snap.data().checkoutLease?.token===token)tx.update(ref,{checkoutLease:null});});
   }
 }
 function plansCheckoutAvailable(){return paymentAvailable();}
 function plansPriceIds(plans){
   return planPriceKeys(plans).map(key=>{
     const id=prices[key];
     if(typeof id!=="string"||!/^price_[A-Za-z0-9]+$/.test(id))throw new ProjectError(503,"Plan prices are not configured yet","PLANS_PRICE_UNCONFIGURED");
     return id;
   });
 }
 // One Checkout subscription with the storage plan + the performance plan (custom
 // storage: the performance plan only). The workspace fee is not a line item.
 async function checkoutPlans(req,w){
   const id=w.id,plans=w.data.requiredPlans;
   if(!plans)throw new ProjectError(409,"Choose a storage plan and a performance plan first","PLANS_REQUIRED");
   if(w.data.entitlementSource==="owner"||w.data.plansStatus==="owner")return {workspaceId:id,alreadyActivated:true,complimentary:true};
   if(w.data.plansSubscriptionId&&!["canceled","cancelled","incomplete_expired"].includes(w.data.plansStatus))
     return {workspaceId:id,alreadyActivated:true,message:"This workspace's plans are already set up. Use Manage Billing to change them."};
   if(!plansCheckoutAvailable())throw new ProjectError(503,"Plan checkout is not available yet","PLANS_CHECKOUT_UNAVAILABLE");
   const state=await inventory(req);
   if(state.policy.usedProjectSlots>state.policy.projectLimit)throw new ProjectError(409,"Archive projects before paying: the current account limit is "+state.policy.projectLimit,"PROJECT_LIMIT_REACHED");
   const lineItems=plansPriceIds(plans).map(price=>({price,quantity:1}));
   const customer=await ensureCustomer(req),origin=new URL(env.PUBLIC_URL);
   if(origin.protocol!=="https:")throw new ProjectError(503,"HTTPS Checkout return address required");
   const totalCents=plansMonthlyCents(plans)*(plans.interval==="year"?10:1);
   const priorId=w.data.plansCheckoutSessionId;
   if(priorId){
     const prior=await stripe.checkout.sessions.retrieve(priorId);
     if(prior.status==="open"&&prior.url)return {url:prior.url,workspaceId:id,plans,totalCents,resumed:true};
     if(prior.status!=="expired")throw new ProjectError(409,"Your workspace payment is being verified. Refresh before retrying.","PAYMENT_PENDING");
   }
   const metadata={kind:"workspace_plans",accountHash:hash(req.user.uid),workspaceId:id};
   const session=await stripe.checkout.sessions.create({mode:"subscription",customer,client_reference_id:id,
     line_items:lineItems,metadata,subscription_data:{metadata},
     success_url:origin.origin+"/billing/success?session_id={CHECKOUT_SESSION_ID}",cancel_url:origin.origin+"/billing/cancel"
   },{idempotencyKey:"gd-plans-"+hash(req.user.uid)+"-"+id+"-"+planPriceKeys(plans).join("+")+"-"+(priorId||"first")});
   await w.ref.update({plansCheckoutSessionId:session.id,plansStatus:"pending",updatedAt:stamp()});
   return {url:session.url,workspaceId:id,plans,totalCents};
 }
 async function checkout(req,id,body={}){
   return withLease(req,id,async w=>{
     if(isPlansWorkspace(w.data)){
       if(body&&(body.plans||body.storageTier||body.performanceTier)&&!w.data.plansSubscriptionId){
         const next=validatePlans(body.plans||body,{custom:w.data.customStorage===true});
         if(Object.keys(next).some(k=>w.data.requiredPlans?.[k]!==next[k])){
           // A changed choice before payment: expire the old open session first.
           if(w.data.plansCheckoutSessionId){
             const prior=await stripe.checkout.sessions.retrieve(w.data.plansCheckoutSessionId);
             if(prior.status==="open")await stripe.checkout.sessions.expire(prior.id);
             else if(prior.status!=="expired")throw new ProjectError(409,"Your workspace payment is being verified. Refresh before retrying.","PAYMENT_PENDING");
           }
           await w.ref.update({requiredPlans:next,plansCheckoutSessionId:null,updatedAt:stamp()});
           w={...w,data:{...w.data,requiredPlans:next,plansCheckoutSessionId:null}};
         }
       }
       return checkoutPlans(req,w);
     }
     if(["free","paid","owner"].includes(w.data.projectFeeStatus)||(w.data.workspaceFeeModel==="monthly"&&w.data.workspaceFeeSubscriptionId))
       return {workspaceId:id,alreadyActivated:true,message:"This workspace is already active."};
     if(w.data.projectBillingVersion!==2)throw new ProjectError(409,"This existing project uses legacy billing","LEGACY_PROJECT");
     // A workspace still waiting for the retired $5 fee moves to the plans model:
     // it needs a storage plan and a performance plan instead of the fee.
     const plans=validatePlans(body?.plans||body,{custom:false});
     const patch={projectBillingVersion:PLANS_BILLING_VERSION,projectFeeStatus:"included",projectFeeCents:0,workspaceFeeCents:0,
       workspaceFeeModel:null,workspaceFeeStatus:null,requiredPlans:plans,plansStatus:"pending",kind:"paid",customStorage:false,
       provisioned:false,quotaBytes:0,storageInterval:plans.interval,performanceInterval:plans.interval,updatedAt:stamp()};
     await w.ref.update(patch);
     return checkoutPlans(req,{...w,data:{...w.data,...patch}});
   });
 }
 async function reconcilePlans(sub){
   const meta=sub?.metadata||{};
   if(meta.kind!=="workspace_plans")return false;
   const owner=meta.accountHash,id=meta.workspaceId;
   if(!/^[a-f0-9]{64}$/.test(owner||"")||!safeProjectId(id)||id==="free")return false;
   const ref=refFor(owner,id),account=await accountRef(owner).get();
   const customer=typeof sub.customer==="string"?sub.customer:sub.customer?.id;
   if(!account.exists||account.data().stripeCustomerId!==customer)return false;
   return db.runTransaction(async tx=>{
     const state=await snapshot(owner,tx),current=state.records.find(x=>x.id===id);
     if(!current||!isPlansWorkspace(current.data)||!current.data.requiredPlans)return false;
     if(current.data.plansSubscriptionId&&current.data.plansSubscriptionId!==sub.id)return false;
     const plans=current.data.requiredPlans;
     let expected;try{expected=plansPriceIds(plans);}catch(_){return false;}
     const items=sub.items?.data||[];
     const matches=items.length===expected.length&&items.every(x=>x.quantity===undefined||x.quantity===1)&&
       expected.every(price=>items.filter(x=>x.price?.id===price).length===1);
     const status=String(sub.status||"");
     const entitled=matches&&["active","trialing","past_due"].includes(status);
     const managed=plans.storage==="managed";
     const patch={plansSubscriptionId:sub.id,plansStatus:matches?status:"mismatch",updatedAt:stamp(),
       storageActive:entitled&&managed,performanceActive:entitled,
       storageTier:managed&&entitled?plans.storageTier:(current.data.storageTier||null),
       performanceTier:entitled?plans.performanceTier:(current.data.performanceTier||null)};
     const status0=projectStatus(current.data);
     if(entitled&&["pending_payment","payment_confirmed_pending_capacity"].includes(status0)){
       const p=policy(state,{ownerBenefits:false}),canActivate=p.usedProjectSlots<=p.projectLimit;
       patch.projectStatus=canActivate?"active":"payment_confirmed_pending_capacity";
       patch.provisioned=canActivate&&managed;
     }
     if(entitled&&managed&&status0==="active")patch.provisioned=true;
     if(managed)patch.quotaBytes=entitled?STORAGE[plans.storageTier].gb*1e9:0;
     tx.update(ref,patch);
     return true;
   });
 }
 async function archive(req,id,{confirmName,acknowledgeBillingContinues}={}){
   const w=await get(req,id),owner=hash(req.user.uid);
   if(confirmName!==w.data.name)throw new ProjectError(400,"Enter the exact project name to confirm archiving","CONFIRM_NAME_REQUIRED");
   if(hasContinuingBilling(w.data)&&acknowledgeBillingContinues!==true)throw new ProjectError(409,"Archiving preserves cloud data and does not cancel subscriptions. Confirm continued billing or use Manage Billing first.","BILLING_ACKNOWLEDGEMENT_REQUIRED");
   if(w.data.checkoutLease?.expiresAtMs>Date.now())throw new ProjectError(409,"Wait for the billing operation to finish before archiving","CHECKOUT_BUSY");
   // Expire only this owned project's open, unpaid Checkout sessions. Completed
   // sessions must finish webhook reconciliation before their slot is released.
   const ids=["project","storage","performance","byo","plans"].map(k=>[k,w.data[k+"CheckoutSessionId"]]).filter(([,v])=>v);
   for(const [kind,sessionId] of ids){
     const settled=kind==="project"?["paid","free","owner","included"].includes(w.data.projectFeeStatus):!!w.data[kind+"SubscriptionId"];
     if(settled)continue;
     const session=await stripe.checkout.sessions.retrieve(sessionId);
     if(session.metadata?.accountHash!==owner||session.metadata?.workspaceId!==id)throw new ProjectError(409,"The payment reference needs a billing review","PAYMENT_REFERENCE_MISMATCH");
     if(session.status==="open")await stripe.checkout.sessions.expire(sessionId);
     else if(session.status!=="expired"&&!(kind==="project"&&(w.data.projectPaymentFailed||w.data.projectPaymentRevoked)))throw new ProjectError(409,"Wait for your payment verification before archiving","PAYMENT_PENDING");
   }
   return db.runTransaction(async tx=>{
     const state=await snapshot(owner,tx),current=state.records.find(x=>x.id===id);
     if(!current)throw new ProjectError(404,"Project not found","PROJECT_NOT_FOUND");
     const uploads=await tx.get(current.ref.collection("uploads").where("status","in",["active","assembling","committing","composing","verifying"]).limit(1));
     if(current.data.name!==confirmName)throw new ProjectError(409,"The project changed. Review it before archiving","PROJECT_CHANGED");
     if(current.data.checkoutLease?.expiresAtMs>Date.now()||["project","storage","performance","byo","plans"].some(k=>current.data[k+"CheckoutSessionId"]!==w.data[k+"CheckoutSessionId"]))throw new ProjectError(409,"Billing changed. Refresh before archiving","CHECKOUT_BUSY");
     if(hasContinuingBilling(current.data)&&acknowledgeBillingContinues!==true)throw new ProjectError(409,"Confirm that existing subscriptions continue billing","BILLING_ACKNOWLEDGEMENT_REQUIRED");
     if((current.data.reservedBytes||0)>0||!uploads.empty)throw new ProjectError(409,"Finish or cancel pending uploads before archiving this project","PROJECT_HAS_PENDING_UPLOADS");
     if(projectStatus(current.data)!=="archived"){
       tx.update(current.ref,{projectStatus:"archived",statusBeforeArchive:projectStatus(current.data),archivedAt:stamp(),dataRetained:true,updatedAt:stamp()});
       touch(tx,owner,state,{freeProjectClaimed:true});
     }
     return {workspaceId:id,archived:true,dataRetained:true,subscriptionsCanceled:false,
       message:"Removed from your projects. Cloud files and underlying cloud resources are retained. Existing subscriptions continue until canceled in Manage Billing."};
   });
 }
 async function restore(req,id){
   const owner=hash(req.user.uid);
   return db.runTransaction(async tx=>{
     const state=await snapshot(owner,tx),current=state.records.find(w=>w.id===id);
     if(!current)throw new ProjectError(404,"Project not found","PROJECT_NOT_FOUND");
     const status=projectStatus(current.data);
     if(!["archived","payment_confirmed_pending_capacity"].includes(status))return {workspaceId:id,restored:true,resumed:true};
     const plansWs=isPlansWorkspace(current.data),plansPaid=plansWs&&plansEntitled(current.data);
     const paid=plansPaid||current.data.projectBillingVersion===2&&["free","paid","owner"].includes(current.data.projectFeeStatus);
     const next=paid?"active":(plansWs||current.data.projectBillingVersion===2)?"pending_payment":current.data.statusBeforeArchive||"pending_activation";
     const patch={projectStatus:next,archivedAt:null,restoredAt:stamp(),...(paid&&current.data.kind!=="byo"?{provisioned:true}:{}),updatedAt:stamp()};
     // Include the restored project's verified entitlements in the same transaction's
     // capacity decision; restoring the qualifying project can itself restore the20-slot limit.
     const projected={...state,records:state.records.map(w=>w.id===id?{...w,data:{...w.data,...patch}}:w)};
     const p=policy(projected,req);
     if(p.usedProjectSlots>p.projectLimit)throw new ProjectError(409,"The current project limit is "+p.projectLimit+". Archive another project before restoring.","PROJECT_LIMIT_REACHED");
     tx.update(current.ref,patch);
     touch(tx,owner,state,{freeProjectClaimed:true});
     return {workspaceId:id,restored:true,projectStatus:next,newProjectFeeCharged:false,dataRetained:true};
   });
 }
 async function reconcilePayment(session,{failed=false}={}){
   if(session.metadata?.kind!=="project_creation"||session.mode!=="payment")return false;
   const owner=session.metadata.accountHash,id=session.metadata.workspaceId;
   if(!/^[a-f0-9]{64}$/.test(owner||"")||!safeProjectId(id)||id==="free")return false;
   const ref=refFor(owner,id),[a,w]=await Promise.all([accountRef(owner).get(),ref.get()]);
   if(!w.exists||!a.exists||!owned(w.data(),owner,id)||a.data().stripeCustomerId!==session.customer||w.data().projectBillingVersion!==2)return false;
   // A webhook can race the API response that persists its Session ID. Retry;
   // never mark an unbound payment fulfilled or processed successfully.
   if(!w.data().projectCheckoutSessionId)throw new ProjectError(503,"Project checkout binding is not ready","CHECKOUT_BINDING_PENDING");
   if(w.data().projectCheckoutSessionId!==session.id)return false;
   if(failed){
     if(session.payment_status==="paid"||w.data().projectFeeStatus==="paid")return false;
     await db.runTransaction(async tx=>{const now=await tx.get(ref);if(now.exists&&now.data().projectCheckoutSessionId===session.id&&now.data().projectFeeStatus==="pending")tx.update(ref,{projectPaymentFailed:true,updatedAt:stamp()});});
     return true;
   }
   if(session.payment_status!=="paid"||session.status!=="complete")return false;
   const lines=await stripe.checkout.sessions.listLineItems(session.id,{limit:2});
   if(lines.has_more||lines.data.length!==1||lines.data[0].price?.id!==w.data().projectPriceId||lines.data[0].quantity!==1||
     session.currency!=="usd"||session.amount_total!==PROJECT_FEE_CENTS)return false;
   const intentId=typeof session.payment_intent==="string"?session.payment_intent:session.payment_intent?.id;
   if(!/^pi_[A-Za-z0-9]+$/.test(intentId||""))return false;
   const intent=await stripe.paymentIntents.retrieve(intentId,{expand:["latest_charge"]});
   const customer=typeof intent.customer==="string"?intent.customer:intent.customer?.id;
   const charge=typeof intent.latest_charge==="string"?await stripe.charges.retrieve(intent.latest_charge):intent.latest_charge;
   if(intent.status!=="succeeded"||customer!==session.customer||intent.currency!=="usd"||intent.amount_received!==PROJECT_FEE_CENTS||
     !charge||charge.refunded||charge.disputed||(charge.amount_refunded||0)>0)return false;
   const receipt=db.collection("project_payments").doc(intentId);
   return db.runTransaction(async tx=>{
     const state=await snapshot(owner,tx),previousReceipt=await tx.get(receipt),current=state.records.find(x=>x.id===id);
     if(!current||current.data.projectCheckoutSessionId!==session.id)return false;
     if(previousReceipt.exists){
       if(previousReceipt.data().accountHash!==owner||previousReceipt.data().workspaceId!==id||previousReceipt.data().revokedAt)return false;
       if(current.data.projectPaymentIntentId===intentId&&current.data.projectFeeStatus==="paid")return true;
     }
     if(projectStatus(current.data)==="archived")throw new ProjectError(503,"Payment arrived for an archived project; billing review is required","PAID_ARCHIVED_PROJECT");
     const p=policy(state,{ownerBenefits:false}),canActivate=p.usedProjectSlots<=p.projectLimit;
     tx.update(ref,{projectFeeStatus:"paid",projectFeeCents:PROJECT_FEE_CENTS,projectPaymentIntentId:intentId,
       projectStatus:canActivate?"active":"payment_confirmed_pending_capacity",provisioned:canActivate,
       projectPaidAt:stamp(),projectPaymentFailed:false,projectPaymentRevoked:false,updatedAt:stamp()});
     tx.set(receipt,{accountHash:owner,workspaceId:id,checkoutSessionId:session.id,paidAt:stamp(),revokedAt:null},{merge:true});
     touch(tx,owner,state,{freeProjectClaimed:true});return true;
   });
 }
 async function revokePayment(intentId,reason){
   if(typeof intentId!=="string"||!/^pi_[A-Za-z0-9]+$/.test(intentId))return false;
   const receipt=db.collection("project_payments").doc(intentId);
   let binding=(await receipt.get()).data();
   // A refund/dispute can precede the successful-Checkout webhook. Resolve its
   // server-created PaymentIntent metadata and exact saved Checkout binding.
   if(!binding){
     const intent=await stripe.paymentIntents.retrieve(intentId);
     const m=intent?.metadata||{};
     if(m.kind!=="project_creation"||!/^[a-f0-9]{64}$/.test(m.accountHash||"")||!safeProjectId(m.workspaceId)||m.workspaceId==="free")return false;
     const [a,w]=await Promise.all([accountRef(m.accountHash).get(),refFor(m.accountHash,m.workspaceId).get()]);
     const customer=typeof intent.customer==="string"?intent.customer:intent.customer?.id;
     if(!a.exists||!w.exists||a.data().stripeCustomerId!==customer||!owned(w.data(),m.accountHash,m.workspaceId)||!w.data().projectCheckoutSessionId)return false;
     const session=await stripe.checkout.sessions.retrieve(w.data().projectCheckoutSessionId);
     if((typeof session.payment_intent==="string"?session.payment_intent:session.payment_intent?.id)!==intentId)return false;
     binding={accountHash:m.accountHash,workspaceId:m.workspaceId,checkoutSessionId:session.id};
   }
   return db.runTransaction(async tx=>{
     const payment=await tx.get(receipt);
     const {accountHash:owner,workspaceId:id}=payment.data()||binding,ref=refFor(owner,id),snap=await tx.get(ref);
     if(!snap.exists||!owned(snap.data(),owner,id))return false;
     tx.set(receipt,{...binding,revokedAt:stamp(),revokedReason:reason},{merge:true});
     if(snap.data().projectPaymentIntentId===intentId||snap.data().projectCheckoutSessionId===binding.checkoutSessionId){
       tx.update(ref,{projectFeeStatus:"revoked",projectPaymentRevoked:true,provisioned:false,
         projectStatus:projectStatus(snap.data())==="archived"?"archived":"payment_revoked",updatedAt:stamp()});
     }
     return true;
   });
 }
 async function listFiles(ref){
   const snap=await ref.collection("files").get();
   return snap.docs.map(d=>({id:d.id,ref:d.ref,data:d.data()}));
 }
 async function remove(req,id){
  const owner=hash(req.user.uid);
  return db.runTransaction(async tx=>{
    const state=await snapshot(owner,tx),current=state.records.find(w=>w.id===id);
    if(!current)throw new ProjectError(404,"Project not found","PROJECT_NOT_FOUND");
    const projects=projectViews(state),freeId=freeWorkspaceId(state.account,projects);
    const remaining=projects.filter(workspace=>workspace.id!==id);
    let nextFree=freeId===id?chooseFreeWorkspaceId(remaining):freeId;
    if(freeId===id&&nextFree)assignFree(tx,state.records.find(w=>w.id===nextFree));
    tx.delete(current.ref);
    touch(tx,owner,state,{freeWorkspaceId:nextFree||null});
    return {workspaceId:id,deleted:true,freeWorkspaceId:nextFree||null};
  });
 }
 async function registerByo(req,id,body){
   let registration;
   try{registration=publicByoRegistration(body);}catch(error){
     if(error.status){
       const wrapped=new ProjectError(error.status,error.message,error.code);
       if(error.provider)wrapped.provider=error.provider;
       throw wrapped;
     }
     throw error;
   }
   const owner=hash(req.user.uid),ref=refFor(owner,id);
   return db.runTransaction(async tx=>{
     const state=await snapshot(owner,tx),current=state.records.find(w=>w.id===id);
     if(!current)throw new ProjectError(404,"Project not found","PROJECT_NOT_FOUND");
     if(isPlansWorkspace(current.data)){
       if(current.data.customStorage!==true)throw new ProjectError(409,"This workspace uses managed storage. Create a new workspace and choose Custom storage.","CUSTOM_STORAGE_NEW_WORKSPACE");
       if(!(plansEntitled(current.data)&&current.data.performanceActive===true))
         throw new ProjectError(402,"Custom storage needs an active performance plan before setup. Complete the performance plan purchase first.","PERFORMANCE_PLAN_REQUIRED");
     }else if(!isByoWorkspace(current.data)){
       // Custom storage is its own workspace type now; it is no longer bolted onto a
       // hosted workspace with a separate $5 fee.
       throw new ProjectError(409,"Custom storage is set up from New workspace, Custom storage.","CUSTOM_STORAGE_NEW_WORKSPACE");
     }
     const plansWs=isPlansWorkspace(current.data);
     const projects=projectViews(state),freeId=freeWorkspaceId(state.account,projects),wasFree=!plansWs&&freeId===id;
     const patch={providerType:registration.providerType,endpoint:registration.endpoint,
       bucketFingerprint:registration.bucketFingerprint,byoRegistered:true,updatedAt:stamp()};
     // A new or changed endpoint invalidates the previous proof. First-time
     // registration leaves absent flags unset so callers can tell it never activated.
     const changed=!!current.data.endpoint&&current.data.endpoint!==registration.endpoint;
     if(changed||current.data.byoChallengeVerified===true||current.data.byoActive===true||current.data.manualProviderConfigured===true){
       patch.byoChallengeVerified=false;patch.byoActive=false;patch.manualProviderConfigured=false;patch.bucketFingerprint=null;
     }
     // BYO is never the free slot. A hosted free workspace becomes the $5 monthly fee.
     if(!plansWs&&!subscriptionActive(current.data)){
       patch.workspaceFeeModel="monthly";patch.feeIsOneTime=false;patch.workspaceFeeCents=WORKSPACE_FEE_CENTS;
       patch.workspaceFeeStatus="unpaid";patch.workspaceFeePaid=false;
     }
     if(wasFree){patch.projectFeeStatus="pending";patch.projectFeeCents=WORKSPACE_FEE_CENTS;patch.projectStatus="active";patch.provisioned=true;}
     let nextFree=freeId;
     if(wasFree){
       nextFree=chooseFreeWorkspaceId(projects.filter(workspace=>workspace.id!==id));
       if(nextFree)assignFree(tx,state.records.find(w=>w.id===nextFree));
     }
     tx.update(ref,patch);
     touch(tx,owner,state,{freeWorkspaceId:nextFree||null});
     const price=workspacePrice({...current.data,...patch,id,byoRegistered:true,providerType:registration.providerType},nextFree);
     return {...patch,isFree:price.isFree,monthlyPriceCents:price.monthlyPriceCents,freeWorkspaceId:nextFree||null,lapsed:byoLapsed({...current.data,...patch,id})};
   });
 }
 async function issueByoChallenge(req,id){
   const owner=hash(req.user.uid),ref=refFor(owner,id),challenge=issueChallenge(Date.now());
   await db.runTransaction(async tx=>{
     const snap=await tx.get(ref);
     if(!snap.exists||!owned(snap.data(),owner,id))throw new ProjectError(404,"Project not found","PROJECT_NOT_FOUND");
     if(!snap.data().providerType)throw new ProjectError(409,"Register the provider before requesting a challenge","BYO_NOT_REGISTERED");
     tx.update(ref,{byoChallenge:challenge,byoChallengeVerified:false,updatedAt:stamp()});
   });
   return {nonce:challenge.nonce,expiresAtMs:challenge.expiresAtMs,ttlMs:BYO_CHALLENGE_TTL_MS};
 }
 function challengeError(status,message,code){return new ProjectError(status,message,code);}
 function endpointHost(value){
  try{const url=new URL(value);if(url.protocol!=="https:"||url.username||url.password)return null;return url;}
  catch(_){return null;}
 }
 function fingerprintFromFetch(fetched,body){
  const headers=fetched?.headers||{};
  const etag=headers.etag||headers.ETag||headers.Etag;
  if(typeof etag==="string"){
   const clean=etag.replace(/^W\//i,"").replace(/"/g,"");
   if(/^[a-f0-9]{8,128}$/i.test(clean))return clean.toLowerCase();
  }
  if(typeof fetched?.fingerprint==="string"&&/^[a-f0-9]{8,128}$/i.test(fetched.fingerprint))return fetched.fingerprint.toLowerCase();
  return crypto.createHash("sha256").update(body).digest("hex");
 }
 async function defaultByoFetch(url){
  const parsed=endpointHost(url);
  if(!parsed)throw challengeError(400,"Challenge URL must be https","BYO_ENDPOINT_HOST_MISMATCH");
  const dns=require("node:dns").promises;
  const records=await dns.lookup(parsed.hostname,{all:true,verbatim:true});
  if(!records.length||records.some(record=>isPrivateAddress(record.address)))
   throw challengeError(400,"Challenge URL does not resolve to a public address","BYO_ENDPOINT_PRIVATE_ADDRESS");
  const response=await fetch(url,{method:"GET",redirect:"manual",signal:AbortSignal.timeout(3000)});
  if(response.status>=300&&response.status<400)throw challengeError(400,"Challenge URL must not redirect","BYO_ENDPOINT_REDIRECT");
  if(response.status!==200)throw challengeError(400,"Challenge object was not readable","BYO_CHALLENGE_MISMATCH");
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length>1024)throw challengeError(400,"Challenge object is too large","BYO_CHALLENGE_MISMATCH");
  const etag=response.headers.get("etag");
  return {status:200,body:bytes,headers:etag?{etag}:{},host:parsed.host};
 }
 async function verifyByo(req,id,body){
  try{rejectProviderSecrets(body||{});}catch(error){throw new ProjectError(error.status||400,error.message,error.code||"BYO_SECRET_REJECTED");}
  // Only presignedUrl is proof. readBack, proofUrl, and a missing URL are not.
  const presignedUrl=typeof body?.presignedUrl==="string"?body.presignedUrl.trim():"";
  if(!presignedUrl)throw challengeError(400,"presigned_url_required","presigned_url_required");
  const owner=hash(req.user.uid),ref=refFor(owner,id);
  const snap=await ref.get();
  if(!snap.exists||!owned(snap.data(),owner,id))throw new ProjectError(404,"Project not found","PROJECT_NOT_FOUND");
  const data=snap.data();
  if(data.providerType!=="s3")throw challengeError(422,"byo_provider_unsupported","byo_provider_unsupported");
  const registered=endpointHost(data.endpoint);
  const proof=endpointHost(presignedUrl);
  if(!registered||!proof||proof.host!==registered.host)
   throw challengeError(400,"Presigned URL host does not match the registered endpoint","BYO_ENDPOINT_HOST_MISMATCH");
  const challenge=data.byoChallenge;
  const gate=verifyChallenge(challenge,challenge?.nonce,Date.now());
  if(!gate.ok)throw challengeError(400,"Bring-your-own challenge was not verified",gate.code);
  if(!proof.pathname.includes("/.gendragoon-challenge/"+challenge.nonce))
   throw challengeError(400,"Challenge object path does not match the nonce","BYO_CHALLENGE_MISMATCH");
  const fetched=await (byoFetch||defaultByoFetch)(presignedUrl);
  if(fetched?.status&&fetched.status!==200)throw challengeError(400,"Challenge object was not readable","BYO_CHALLENGE_MISMATCH");
  const bytes=Buffer.isBuffer(fetched?.body)?fetched.body:Buffer.from(fetched?.body||"");
  if(bytes.length>1024||bytes.toString()!==challenge.nonce)
   throw challengeError(400,"Challenge object contents did not match the nonce","BYO_CHALLENGE_MISMATCH");
  const fingerprint=fingerprintFromFetch(fetched,bytes);
  return db.runTransaction(async tx=>{
    const fresh=await tx.get(ref);
    if(!fresh.exists||!owned(fresh.data(),owner,id))throw new ProjectError(404,"Project not found","PROJECT_NOT_FOUND");
    const again=verifyChallenge(fresh.data().byoChallenge,challenge.nonce,Date.now());
    if(!again.ok)throw challengeError(400,"Bring-your-own challenge was not verified",again.code);
    tx.update(ref,{byoChallenge:{...fresh.data().byoChallenge,used:true,nonce:null},byoChallengeVerified:true,
      manualProviderConfigured:true,byoActive:true,bucketFingerprint:fingerprint,updatedAt:stamp()});
    return {verified:true,workspaceId:id,bucketFingerprint:fingerprint};
  });
 }
 async function reconcileWorkspaceFee(sub,{eventType="",invoice=null}={}){
   const meta=sub?.metadata||{};
   if(meta.kind!=="workspace_fee")return false;
   const owner=meta.accountHash,id=meta.workspaceId;
   if(!/^[a-f0-9]{64}$/.test(owner||"")||!safeProjectId(id))return false;
   const ref=refFor(owner,id),[account,workspace]=await Promise.all([accountRef(owner).get(),ref.get()]);
   if(!account.exists||!workspace.exists||!owned(workspace.data(),owner,id))return false;
   const customer=typeof sub.customer==="string"?sub.customer:sub.customer?.id;
   if(account.data().stripeCustomerId!==customer)return false;
   // Grandfathered one-time and legacy free workspaces are never lapsed or rewritten.
   if(isGrandfathered(workspace.data()))return true;
   // Status comes only from the subscription retrieved for this delivery.
   // The event type must not overwrite a newer status from an older event.
   const status=sub.status||"";
   let workspaceFeeStatus="past_due",workspaceFeePaid=false;
   if(status==="active"||status==="trialing"){workspaceFeeStatus="active";workspaceFeePaid=true;}
   else if(status==="canceled"||status==="cancelled"||status==="incomplete_expired"){workspaceFeeStatus="canceled";workspaceFeePaid=false;}
   else {workspaceFeeStatus="past_due";workspaceFeePaid=false;}
   const current=workspace.data();
   const patch={workspaceFeeModel:"monthly",workspaceFeeStatus,workspaceFeePaid,workspaceFeeSubscriptionId:sub.id,
     feeIsOneTime:false,updatedAt:stamp()};
   if(eventType==="invoice.paid"){
     const paidEnd=invoicePaidThroughMs(invoice);
     if(paidEnd!=null){
       const previous=typeof current.paidThroughMs==="number"?current.paidThroughMs:null;
       const next=previous==null?paidEnd:Math.max(previous,paidEnd);
       patch.paidThroughMs=next;patch.workspaceFeePeriodEndMs=next;
     }
   }
   if(workspaceFeePaid&&current.projectStatus==="lapsed")patch.projectStatus="active";
   await ref.update(patch);return true;
 }
 async function mergePreview(req,sourceId,{targetId,confirmName}={}){
   if(!safeProjectId(sourceId)||!safeProjectId(targetId)||sourceId===targetId)throw new ProjectError(400,"Choose two different workspaces","INVALID_MERGE");
   const owner=hash(req.user.uid),sourceRef=refFor(owner,sourceId),targetRef=refFor(owner,targetId);
   const [source,target]=await Promise.all([sourceRef.get(),targetRef.get()]);
   if(!source.exists||!owned(source.data(),owner,sourceId))throw new ProjectError(404,"Project not found","PROJECT_NOT_FOUND");
   if(!target.exists||!owned(target.data(),owner,targetId))throw new ProjectError(404,"Project not found","PROJECT_NOT_FOUND");
   if(confirmName!==source.data().name)throw new ProjectError(400,"Enter the exact source workspace name","CONFIRM_NAME_REQUIRED");
   const taken=new Set((await listFiles(targetRef)).map(file=>file.data.name));
   const files=[];
   for(const file of await listFiles(sourceRef)){
     const renamedTo=collisionName(file.data.name,source.data().name,taken);
     taken.add(renamedTo);
     files.push({name:file.data.name,renamedTo,sizeBytes:file.data.sizeBytes||0});
   }
   return {sourceId,targetId,confirmName,files};
 }
 async function merge(req,sourceId,{targetId,confirmName}={}){
   if(!safeProjectId(sourceId)||!safeProjectId(targetId)||sourceId===targetId)throw new ProjectError(400,"Choose two different workspaces","INVALID_MERGE");
   const owner=hash(req.user.uid),sourceRef=refFor(owner,sourceId),targetRef=refFor(owner,targetId);
   const tombRef=accountRef(owner).collection("workspace_merges").doc(sourceId);
   const tomb=await tombRef.get();
   if(tomb.exists&&tomb.data().phase==="completed"){
     if(confirmName!==tomb.data().name)throw new ProjectError(400,"Enter the exact source workspace name","CONFIRM_NAME_REQUIRED");
     if(tomb.data().targetId!==targetId)throw new ProjectError(409,"This workspace was already merged elsewhere","MERGE_CONFLICT");
     for(const key of tomb.data().sourceObjectKeys||[])if(objectStore)await objectStore.delete(key);
     return {merged:true,idempotent:true,sourceDeleted:true,sourceId,workspaceId:targetId,copied:tomb.data().copied||0};
   }
   const token=crypto.randomUUID();
   let held=false;
   const verifyFailed=()=>new ProjectError(409,"Copied object failed verification","MERGE_VERIFY_FAILED");
   async function agrees(sourceMeta,destMeta,size){
     if(destMeta&&destMeta.size!=null&&destMeta.size!==size)throw verifyFailed();
     const verdict=checksumsAgree(storedChecksums(sourceMeta),storedChecksums(destMeta));
     if(verdict===false)throw verifyFailed();
     return verdict;
   }
   try{
     const locked=await db.runTransaction(async tx=>{
       const [source,target]=await Promise.all([tx.get(sourceRef),tx.get(targetRef)]);
       if(!source.exists||!owned(source.data(),owner,sourceId))throw new ProjectError(404,"Project not found","PROJECT_NOT_FOUND");
       if(!target.exists||!owned(target.data(),owner,targetId))throw new ProjectError(404,"Project not found","PROJECT_NOT_FOUND");
       if(confirmName!==source.data().name)throw new ProjectError(400,"Enter the exact source workspace name","CONFIRM_NAME_REQUIRED");
       const now=Date.now(),sourceLock=source.data().mergeLock,targetLock=target.data().mergeLock;
       const same=lock=>lock&&lock.sourceId===sourceId&&lock.targetId===targetId;
       if(sourceLock&&sourceLock.expiresAtMs>now&&!same(sourceLock))throw new ProjectError(409,"A merge is already running","MERGE_IN_PROGRESS");
       if(targetLock&&targetLock.expiresAtMs>now&&!same(targetLock))throw new ProjectError(409,"Target workspace is in another merge","MERGE_IN_PROGRESS");
       if(same(sourceLock)&&sourceLock.expiresAtMs>now)throw new ProjectError(409,"A merge is already running","MERGE_IN_PROGRESS");
       const lock={token,sourceId,targetId,expiresAtMs:now+120000,phase:"copying"};
       tx.update(sourceRef,{mergeLock:lock,updatedAt:stamp()});
       tx.update(targetRef,{mergeLock:lock,updatedAt:stamp()});
       return {source:source.data(),target:target.data()};
     });
     held=true;
     const sourceName=locked.source.name;
     // State record first, before any source file is removed, so a crash can resume.
     await tombRef.set({name:sourceName,targetId,phase:"copying",copied:0,mergeId:token},{merge:true});
     const copied=new Map((locked.source.mergeCopied||[]).map(entry=>[entry.fileId,entry]));
     const taken=new Set((await listFiles(targetRef)).map(file=>file.data.name));
     for(const entry of copied.values())if(entry.name)taken.add(entry.name);
     const sourceFiles=await listFiles(sourceRef);
     let heartbeat=0;
     for(const file of sourceFiles){
       const digest=fileDigest(file.data),size=file.data.sizeBytes||0;
       const previous=copied.get(file.id);
       if(previous){
         const dest=await targetRef.collection("files").doc(previous.destId).get();
         const stat=objectStore&&previous.objectKey?await objectStore.stat(previous.objectKey):null;
         const recordOk=dest.exists&&dest.data().sizeBytes===size&&(!digest||fileDigest(dest.data())===digest);
         const statOk=!stat||(stat.size===size&&checksumsAgree(storedChecksums(file.data),storedChecksums(stat))!==false);
         if(recordOk&&statOk){if(previous.name)taken.add(previous.name);continue;}
       }
       const name=previous?.name||collisionName(file.data.name,sourceName,taken);
       taken.add(name);
       const destId=previous?.destId||crypto.randomUUID();
       const objectKey=file.data.objectKey?("customer/"+owner+"/managed/"+targetId+"/files/"+file.id+"-from-"+sourceId):null;
       if(file.data.objectKey){
         if(!objectStore)throw new ProjectError(503,"Workspace file storage is not available for merge","MERGE_STORAGE_UNAVAILABLE");
         const copiedObject=await objectStore.copy(file.data.objectKey,objectKey);
         const copiedOk=await agrees(file.data,copiedObject,size);
         const stat=await objectStore.stat(objectKey);
         const statOk=await agrees(file.data,stat,size);
         if(copiedOk==null&&statOk==null){
           if(typeof objectStore.read!=="function")throw verifyFailed();
           const [left,right]=await Promise.all([objectStore.read(file.data.objectKey),objectStore.read(objectKey)]);
           const hashOf=buf=>crypto.createHash("sha256").update(buf).digest("hex");
           if(hashOf(left)!==hashOf(right))throw verifyFailed();
         }
       }
       const record={name,sizeBytes:size,copiedFrom:{workspaceId:sourceId,fileId:file.id,sizeBytes:size},createdAt:stamp()};
       if(digest){record.sha256=digest;record.copiedFrom.sha256=digest;}
       if(file.data.crc32c)record.crc32c=file.data.crc32c;
       if(file.data.md5Hash)record.md5Hash=file.data.md5Hash;
       if(file.data.md5)record.md5=file.data.md5;
       if(objectKey)record.objectKey=objectKey;
       const destRef=targetRef.collection("files").doc(destId);
       const existing=await destRef.get();
       if(existing.exists)await destRef.set(record);else await destRef.create(record);
       const saved=await destRef.get();
       if(!saved.exists||saved.data().sizeBytes!==size)throw verifyFailed();
       if(digest&&fileDigest(saved.data())!==digest)throw verifyFailed();
       if(file.data.crc32c&&saved.data().crc32c!==file.data.crc32c)throw verifyFailed();
       copied.set(file.id,{fileId:file.id,destId,name,sha256:digest,sizeBytes:size,objectKey,sourceObjectKey:file.data.objectKey||null});
       heartbeat++;
       const lock={token,sourceId,targetId,expiresAtMs:Date.now()+120000,phase:"copying"};
       const progress={mergeCopied:[...copied.values()],updatedAt:stamp(),...(heartbeat%50===0?{mergeLock:lock}:{})};
       await sourceRef.update(progress);
       if(heartbeat%50===0)await targetRef.update({mergeLock:lock,updatedAt:stamp()});
     }
     const freshSource=await sourceRef.get();
     if(freshSource.exists)await cancelSourceBilling(freshSource.data(),sourceId);
     const sourceObjectKeys=[...copied.values()].map(entry=>entry.sourceObjectKey).filter(Boolean);
     async function drain(collectionName){
       for(;;){
         const removed=await db.runTransaction(async tx=>{
           const snap=await tx.get(sourceRef.collection(collectionName).limit(399));
           const docs=snap.docs||[];
           if(!docs.length)return 0;
           for(const doc of docs)tx.delete(doc.ref);
           return docs.length;
         });
         if(!removed)break;
       }
     }
     await drain("files");
     await drain("uploads");
     await db.runTransaction(async tx=>{
       const state=await snapshot(owner,tx);
       const [targetFiles,leftover]=await Promise.all([tx.get(targetRef.collection("files")),tx.get(sourceRef.collection("files").limit(1))]);
       const source=state.records.find(w=>w.id===sourceId),target=state.records.find(w=>w.id===targetId);
       if((leftover.docs||[]).length)throw new ProjectError(409,"Source changed during merge. Retry to resume.","MERGE_SOURCE_CHANGED");
       if(!source||source.data.mergeLock?.token!==token)throw new ProjectError(409,"Merge lock lost","MERGE_LOCK_LOST");
       if(!target||!owned(target.data,owner,targetId))throw new ProjectError(404,"Project not found","PROJECT_NOT_FOUND");
       const projects=projectViews(state),freeId=freeWorkspaceId(state.account,projects);
       // The survivor keeps its own fee status. A deleted free source moves the slot elsewhere.
       let nextFree=freeId===sourceId?chooseFreeWorkspaceId(projects.filter(w=>w.id!==sourceId),{avoidId:targetId}):freeId;
       if(freeId===sourceId&&nextFree)assignFree(tx,state.records.find(w=>w.id===nextFree));
       const used=(targetFiles.docs||[]).reduce((sum,file)=>sum+(file.data().sizeBytes||0),0);
       tx.set(tombRef,{name:sourceName,targetId,phase:"completed",copied:copied.size,sourceObjectKeys,mergedAt:stamp()});
       tx.delete(sourceRef);
       tx.update(targetRef,{mergeLock:null,usedBytes:used,updatedAt:stamp()});
       touch(tx,owner,state,{freeWorkspaceId:nextFree||null});
     });
     held=false;
     if(objectStore)for(const key of sourceObjectKeys)await objectStore.delete(key);
     return {merged:true,idempotent:false,sourceDeleted:true,sourceId,workspaceId:targetId,copied:copied.size};
   }finally{
     if(held){
       await db.runTransaction(async tx=>{
         const source=await tx.get(sourceRef);
         if(!source.exists||source.data().mergeLock?.token!==token)return;
         tx.update(sourceRef,{mergeLock:{...source.data().mergeLock,expiresAtMs:0,phase:"interrupted"},updatedAt:stamp()});
         tx.update(targetRef,{mergeLock:{token,sourceId,targetId,expiresAtMs:0,phase:"interrupted"},updatedAt:stamp()});
       }).catch(()=>{});
     }
   }
 }
 async function cancelSourceBilling(data,mergeId){
   const cancel=stripe&&stripe.subscriptions&&stripe.subscriptions.cancel;
   if(typeof cancel!=="function")return;
   const ids=[...new Set(["workspaceFee","storage","performance","byo","plans"].map(key=>data[key+"SubscriptionId"]).filter(id=>typeof id==="string"&&id))];
   for(const id of ids)await cancel(id,{},{idempotencyKey:"gd-merge-"+mergeId+"-cancel-"+id});
 }
 return {inventory,get,create,setSelection,checkout,archive,restore,remove,withLease,reconcilePayment,revokePayment,
   registerByo,issueByoChallenge,verifyByo,reconcileWorkspaceFee,reconcilePlans,plansCheckoutAvailable,mergePreview,merge,
   paymentAvailable,refFor,legacyRef,policy,hasContinuingBilling};
}
module.exports={createProjectService,ProjectError,projectStatus,activatedBasicProject,effectiveStorageQuota,
 qualifiesForHigherLimit,policyFor,validateSelection,safeProjectId,hasContinuingBilling,listAccountProjects,
 PROJECT_FEE_CENTS,DEFAULT_PROJECT_LIMIT,QUALIFIED_PROJECT_LIMIT,BASIC_QUOTA_BYTES,FREE_WORKSPACES,
 evaluateLapse,isGrandfathered,lockBody,summarizeProjects,freeWorkspaceId,workspacePrice,byoLapsed,validatePlans,planPriceKeys,plansMonthlyCents};
