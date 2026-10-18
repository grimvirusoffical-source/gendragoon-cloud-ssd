"use strict";
// Product projects are logical, account-owned workspaces. Archiving never deletes
// a Google Cloud project, a bucket, a file record, or an object.
const crypto=require("node:crypto");
const {STORAGE,PERFORMANCE,validateWorkspaceName}=require("./catalog");
const PROJECT_FEE_CENTS=500,DEFAULT_PROJECT_LIMIT=10,QUALIFIED_PROJECT_LIMIT=20;
const QUALIFYING_STORAGE_GB=2000,QUALIFYING_WORKERS=8,BASIC_QUOTA_BYTES=2_000_000_000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const INTENT=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
class ProjectError extends Error {
 constructor(status,message,code="PROJECT_UNAVAILABLE"){super(message);this.status=status;this.code=code;}
}
function safeProjectId(id){return id==="free"||(typeof id==="string"&&UUID.test(id));}
function projectStatus(w){
 if(w.projectStatus)return w.projectStatus;
 if(w.kind==="free"&&w.provisioned!==false)return "active";
 if(w.storageActive&&w.provisioned||w.kind==="byo"&&w.byoActive&&w.manualProviderConfigured)return "active";
 return "pending_activation";
}
function activatedBasicProject(w){
 return w.projectBillingVersion===2&&w.projectStatus==="active"&&
   ["free","paid","owner"].includes(w.projectFeeStatus)&&w.provisioned===true;
}
function effectiveStorageQuota(w){
 if(!w||["archived","pending_payment","payment_revoked","payment_confirmed_pending_capacity"].includes(projectStatus(w)))return 0;
 if(w.kind==="free"&&w.provisioned!==false){
   return w.storageActive===true&&Object.hasOwn(STORAGE,w.storageTier||"")?STORAGE[w.storageTier].gb*1e9:BASIC_QUOTA_BYTES;
 }
 if(w.kind!=="paid"||w.provisioned!==true)return 0;
 if(w.projectBillingVersion===2&&!activatedBasicProject(w))return 0;
 if(w.storageActive===true&&Object.hasOwn(STORAGE,w.storageTier||""))return STORAGE[w.storageTier].gb*1e9;
 return activatedBasicProject(w)?BASIC_QUOTA_BYTES:0;
}
function qualifiesForHigherLimit(w){
 if(projectStatus(w)!=="active"||w.storageActive!==true||w.provisioned!==true||
    !Object.hasOwn(STORAGE,w.storageTier||"")||STORAGE[w.storageTier].gb<QUALIFYING_STORAGE_GB)return false;
 if(w.projectBillingVersion===2&&!activatedBasicProject(w))return false;
 const extra=w.performanceActive===true&&Object.hasOwn(PERFORMANCE,w.performanceTier||"")?PERFORMANCE[w.performanceTier].workers:0;
 const bundled=w.storageMode==="bundle"?Math.min(24,Math.max(2,Math.floor(STORAGE[w.storageTier].gb/250))):0;
 return Math.max(extra,bundled)>=QUALIFYING_WORKERS;
}
function policyFor(account,projects,{ownerBenefits=false,paymentAvailable=false}={}){
 const current=projects.filter(w=>projectStatus(w)!=="archived");
 const qualified=current.some(qualifiesForHigherLimit);
 const freeClaimed=account.freeProjectClaimed===true||projects.length>0;
 return {firstProjectFree:true,freeProjectClaimed:freeClaimed,freeProjectAvailable:!freeClaimed,
   newProjectOneTimeCents:PROJECT_FEE_CENTS,currency:"usd",feeIsOneTime:true,
   defaultLimit:DEFAULT_PROJECT_LIMIT,qualifiedLimit:QUALIFIED_PROJECT_LIMIT,
   qualifyingStorageTier:"2TB",qualifyingStorageGB:QUALIFYING_STORAGE_GB,
   qualifyingPerformanceTier:"turbo",qualifyingWorkers:QUALIFYING_WORKERS,
   qualificationLabel:"2 TB or more storage AND Turbo (8 workers) or higher on the same active project; equivalent bundles qualify",
   qualifiesForHigherLimit:qualified,projectLimit:qualified?QUALIFIED_PROJECT_LIMIT:DEFAULT_PROJECT_LIMIT,
   usedProjectSlots:current.length,activeProjects:current.filter(w=>projectStatus(w)==="active").length,
   pendingProjects:current.filter(w=>projectStatus(w)!=="active").length,
   archivedProjects:projects.length-current.length,ownerFeeWaived:ownerBenefits,paymentAvailable};
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
function hasContinuingBilling(w){return ["storage","performance","byo"].some(k=>w[k+"SubscriptionId"]&&!["canceled","incomplete_expired"].includes(w[k+"Status"]));}

function createProjectService({db,stamp,hash,stripe,env={},prices={},ensureCustomer}){
 const accounts=db.collection("gd_accounts");
 const accountRef=owner=>accounts.doc(owner);
 const collection=owner=>accountRef(owner).collection("workspaces");
 const legacyRef=owner=>db.collection("tenants").doc(owner).collection("workspaces").doc("free");
 function refFor(owner,id){
   if(!safeProjectId(id))throw new ProjectError(400,"Invalid project identifier","INVALID_PROJECT");
   return id==="free"?legacyRef(owner):collection(owner).doc(id);
 }
 function owned(data,owner,id){return !!data&&(id==="free"?data.accountKey===owner:data.accountHash===owner);}
 function configuredPrice(){return env.STRIPE_PROJECT_CREATION_PRICE_ID||prices["one_time|project_creation"]||null;}
 function paymentAvailable(){return env.STRIPE_CHECKOUT_ENABLED==="true"&&env.STRIPE_PROJECT_CHECKOUT_READY==="true"&&/^price_[A-Za-z0-9]+$/.test(configuredPrice()||"");}
 async function snapshot(owner,tx=null){
   const read=ref=>tx?tx.get(ref):ref.get();
   const [account,docs,legacy]=await Promise.all([read(accountRef(owner)),read(collection(owner).limit(201)),read(legacyRef(owner))]);
   if(docs.docs.length>200)throw new ProjectError(409,"Project inventory exceeds the supported review limit. Contact support.","INVENTORY_REVIEW_REQUIRED");
   const records=docs.docs.filter(d=>owned(d.data(),owner,d.id)).map(d=>({id:d.id,ref:d.ref,data:d.data()}));
   if(legacy.exists&&owned(legacy.data(),owner,"free"))records.push({id:"free",ref:legacy.ref||legacyRef(owner),data:legacy.data()});
   return {account:account.data()||{},records};
 }
 function policy(state,req){return policyFor(state.account,state.records.map(w=>w.data),{ownerBenefits:req.ownerBenefits===true,paymentAvailable:paymentAvailable()});}
 function touch(tx,owner,state,extra={}){
   tx.set(accountRef(owner),{freeProjectClaimed:state.account.freeProjectClaimed===true||state.records.length>0,
     projectPolicyVersion:2,projectRevision:(state.account.projectRevision||0)+1,projectUpdatedAt:stamp(),...extra},{merge:true});
 }
 async function inventory(req){const state=await snapshot(hash(req.user.uid));return {...state,policy:policy(state,req)};}
 async function get(req,id){
   const owner=hash(req.user.uid),ref=refFor(owner,id),snap=await ref.get();
   if(!snap.exists)throw new ProjectError(404,"Project not found","PROJECT_NOT_FOUND");
   if(!owned(snap.data(),owner,id))throw new ProjectError(403,"Project access denied","PROJECT_FORBIDDEN");
   return {id,ref,data:snap.data()};
 }
 async function create(req,{name,intentId,legacyFree=false,selection=null}={}){
   try{name=validateWorkspaceName(name||"My Cloud Project");}catch(_){throw new ProjectError(400,"Choose a valid project name","INVALID_PROJECT_NAME");}
   if(!legacyFree&&(typeof intentId!=="string"||!INTENT.test(intentId)))throw new ProjectError(400,"A UUID checkout intent is required","INVALID_INTENT");
   const id=legacyFree?"free":intentId.toLowerCase(),owner=hash(req.user.uid),ref=refFor(owner,id);
   const intended=selection?validateSelection(selection):{};
   return db.runTransaction(async tx=>{
     const state=await snapshot(owner,tx),p=policy(state,req),previous=state.records.find(w=>w.id===id);
     if(previous){
       if(legacyFree)throw new ProjectError(409,"The free project already exists","PROJECT_EXISTS");
       if(previous.data.name!==name)throw new ProjectError(409,"This creation intent belongs to another project name","INTENT_CONFLICT");
       if(selection&&Object.keys(intended).some(key=>previous.data.creationSelection?.[key]!==intended[key]))throw new ProjectError(409,"This creation intent belongs to another plan selection","INTENT_CONFLICT");
       return {project:previous,policy:p,resumed:true};
     }
     if(p.usedProjectSlots>=p.projectLimit)throw new ProjectError(409,"Project limit reached ("+p.projectLimit+"). Archive a project or qualify with 2 TB storage and Turbo performance.","PROJECT_LIMIT_REACHED");
     if(legacyFree&&!p.freeProjectAvailable)throw new ProjectError(409,"The lifetime free project has already been claimed. Create an additional project for $5 once.","FREE_PROJECT_ALREADY_CLAIMED");
     const feeStatus=req.ownerBenefits===true?"owner":p.freeProjectAvailable?"free":"pending";
     if(feeStatus==="pending"&&!p.paymentAvailable)throw new ProjectError(503,"The $5 one-time project activation price is not configured. Your existing projects remain available.","PROJECT_PAYMENT_UNAVAILABLE");
     const data={name,kind:legacyFree?"free":"paid",accountHash:owner,...(legacyFree?{accountKey:owner}:{}),
       projectBillingVersion:2,projectStatus:feeStatus==="pending"?"pending_payment":"active",projectFeeStatus:feeStatus,
       projectFeeCents:feeStatus==="pending"?PROJECT_FEE_CENTS:0,storageBillingVersion:2,
       storageTier:null,storageMode:"standard",storageInterval:"month",storageActive:false,
       performanceTier:null,performanceActive:false,byoActive:false,manualProviderConfigured:false,
       intendedSelection:intended,creationSelection:intended,
       provisioned:feeStatus!=="pending",quotaBytes:BASIC_QUOTA_BYTES,usedBytes:0,reservedBytes:0,
       createdAt:stamp(),updatedAt:stamp()};
     tx.create(ref,data);
     touch(tx,owner,state,{freeProjectClaimed:true,projectsCreatedLifetime:(state.account.projectsCreatedLifetime||state.records.length)+1});
     const next={...state,account:{...state.account,freeProjectClaimed:true},records:[...state.records,{id,ref,data}]};
     return {project:{id,ref,data},policy:policy(next,req),resumed:false};
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
 async function verifiedProjectPrice(){
   if(!paymentAvailable())throw new ProjectError(503,"The $5 one-time project activation price is not configured","PROJECT_PAYMENT_UNAVAILABLE");
   const id=configuredPrice(),price=await stripe.prices.retrieve(id,{expand:["product"]});
   if(price.id!==id||price.active!==true||price.type!=="one_time"||price.recurring||price.currency!=="usd"||
     price.unit_amount!==PROJECT_FEE_CENTS||price.billing_scheme!=="per_unit"||price.product?.deleted||price.product?.active!==true||
     (env.STRIPE_ENVIRONMENT&&price.livemode!==(env.STRIPE_ENVIRONMENT==="live")))
     throw new ProjectError(503,"Project activation requires an active one-time USD $5 Price in the configured Stripe environment","PROJECT_PRICE_MISMATCH");
   return id;
 }
 async function checkout(req,id){
   return withLease(req,id,async w=>{
     if(w.data.projectBillingVersion!==2)throw new ProjectError(409,"This existing project uses legacy billing","LEGACY_PROJECT");
     if(["free","paid","owner"].includes(w.data.projectFeeStatus))return {workspaceId:id,alreadyActivated:true,message:"The project activation fee is already covered."};
     const state=await inventory(req);
     if(state.policy.usedProjectSlots>state.policy.projectLimit)throw new ProjectError(409,"Archive projects before paying: the current account limit is "+state.policy.projectLimit,"PROJECT_LIMIT_REACHED");
     const price=await verifiedProjectPrice(),customer=await ensureCustomer(req),origin=new URL(env.PUBLIC_URL);
     if(origin.protocol!=="https:")throw new ProjectError(503,"HTTPS Checkout return address required");
     const priorId=w.data.projectCheckoutSessionId;
     if(priorId){
       const prior=await stripe.checkout.sessions.retrieve(priorId);
       if(prior.status==="open"&&prior.url)return {url:prior.url,workspaceId:id,oneTimeCents:PROJECT_FEE_CENTS,resumed:true};
       if(prior.status!=="expired"&&!w.data.projectPaymentFailed&&!w.data.projectPaymentRevoked)
         throw new ProjectError(409,"Your project payment is being verified. Refresh before retrying.","PAYMENT_PENDING");
     }
     const metadata={kind:"project_creation",accountHash:hash(req.user.uid),workspaceId:id};
     const session=await stripe.checkout.sessions.create({mode:"payment",customer,client_reference_id:id,
       line_items:[{price,quantity:1}],metadata,payment_intent_data:{metadata},
       success_url:origin.origin+"/billing/success?session_id={CHECKOUT_SESSION_ID}",cancel_url:origin.origin+"/billing/cancel",
       custom_text:{submit:{message:"One-time $5 activation for this new project. Optional storage and performance subscriptions are separate."}}
     },{idempotencyKey:"gd-project-"+hash(req.user.uid)+"-"+id+"-"+(priorId||"first")});
     await w.ref.update({projectCheckoutSessionId:session.id,projectPriceId:price,projectStatus:"pending_payment",
       projectFeeStatus:"pending",projectPaymentFailed:false,projectPaymentRevoked:false,updatedAt:stamp()});
     return {url:session.url,workspaceId:id,oneTimeCents:PROJECT_FEE_CENTS};
   });
 }
 async function archive(req,id,{confirmName,acknowledgeBillingContinues}={}){
   const w=await get(req,id),owner=hash(req.user.uid);
   if(confirmName!==w.data.name)throw new ProjectError(400,"Enter the exact project name to confirm archiving","CONFIRM_NAME_REQUIRED");
   if(hasContinuingBilling(w.data)&&acknowledgeBillingContinues!==true)throw new ProjectError(409,"Archiving preserves cloud data and does not cancel subscriptions. Confirm continued billing or use Manage Billing first.","BILLING_ACKNOWLEDGEMENT_REQUIRED");
   if(w.data.checkoutLease?.expiresAtMs>Date.now())throw new ProjectError(409,"Wait for the billing operation to finish before archiving","CHECKOUT_BUSY");
   // Expire only this owned project's open, unpaid Checkout sessions. Completed
   // sessions must finish webhook reconciliation before their slot is released.
   const ids=["project","storage","performance","byo"].map(k=>[k,w.data[k+"CheckoutSessionId"]]).filter(([,v])=>v);
   for(const [kind,sessionId] of ids){
     const settled=kind==="project"?["paid","free","owner"].includes(w.data.projectFeeStatus):!!w.data[kind+"SubscriptionId"];
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
     if(current.data.checkoutLease?.expiresAtMs>Date.now()||["project","storage","performance","byo"].some(k=>current.data[k+"CheckoutSessionId"]!==w.data[k+"CheckoutSessionId"]))throw new ProjectError(409,"Billing changed. Refresh before archiving","CHECKOUT_BUSY");
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
     const paid=current.data.projectBillingVersion===2&&["free","paid","owner"].includes(current.data.projectFeeStatus);
     const next=paid?"active":current.data.projectBillingVersion===2?"pending_payment":current.data.statusBeforeArchive||"pending_activation";
     const patch={projectStatus:next,archivedAt:null,restoredAt:stamp(),...(paid?{provisioned:true}:{}),updatedAt:stamp()};
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
 return {inventory,get,create,setSelection,checkout,archive,restore,withLease,reconcilePayment,revokePayment,
   paymentAvailable,refFor,legacyRef,policy,hasContinuingBilling};
}
module.exports={createProjectService,ProjectError,projectStatus,activatedBasicProject,effectiveStorageQuota,
 qualifiesForHigherLimit,policyFor,validateSelection,safeProjectId,hasContinuingBilling,
 PROJECT_FEE_CENTS,DEFAULT_PROJECT_LIMIT,QUALIFIED_PROJECT_LIMIT,BASIC_QUOTA_BYTES};
