'use strict';
const http=require('node:http');
const crypto=require('node:crypto');
const {ControlState}=require('./control-state.cjs');
const {RedXState,CloudError,digest,origin}=require('./redx-state.cjs');
const {createInternalEntitlements}=require('./internal-entitlements.cjs');
const {createDeletionClient,createAccountDeletion,settleAccountBilling}=require('./account-deletion.cjs');
const {createControlLifecycle,runControlCLI}=require('./control-lifecycle.cjs');
const fs=require('node:fs/promises');
const path=require('node:path');
const {PRIVACY_HTML}=require('./privacy-page.cjs');
const {STORAGE,PERFORMANCE:PAID_PERFORMANCE}=require('../Backend/catalog.js');
// Receiver subscriptions support a genuinely free one-worker option. Keep the
// legacy Firebase paid-price catalog unchanged (there is no Stripe Free price).
const PERFORMANCE=Object.freeze({free:{cents:0,workers:1},...PAID_PERFORMANCE});

const OWNER_EMAIL='support@infected-nation.com';
const WORKSPACE_MONTHLY_CENTS=500;
const FREE_STORAGE_BYTES=2_000_000_000;
const REMOVE_ADS_CENTS=499;
const ID=/^[a-f0-9]{32}$/;
const RX=/^Bearer (rxca_[A-Za-z0-9_-]{43})$/;
const ACTIVE=new Set(['active','trialing']);
const CATALOG=require('../Backend/stripe_live_catalog.json');
const PRICE_IDS=CATALOG.priceIds||{};
const MAX_BODY=32*1024;

// MachineNote is the product name for an existing workspace. Wire aliases are
// additive; ledger fields, Stripe metadata and encrypted workspace context keep
// their original names so installed clients and existing data remain usable.
function machineNoteResponse(body){
 const out={...body};
 if(body.project)out.machineNote=body.project;
 if(body.projects)out.machineNotes=body.projects;
 if(Number.isInteger(body.projectLimit))out.machineNoteLimit=body.projectLimit;
 if(Number.isInteger(body.usedProjectSlots))out.usedMachineNoteSlots=body.usedProjectSlots;
 return out;
}
const send=(res,status,body,headers={})=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff',...headers});res.end(JSON.stringify(machineNoteResponse(body)));};
const MACHINE_NOTE_MESSAGES={
 workspace_name_invalid:'MachineNote names must contain 3–80 printable characters.',
 project_limit_reached:'Your account has reached its MachineNote limit.',
 project_not_found:'MachineNote not found.',
 plans_required:'Choose storage and performance plans for this MachineNote before continuing checkout.',
 confirm_name_required:'Type the exact MachineNote name to confirm deletion.',
 workspace_delete_unavailable:'MachineNote deletion is temporarily unavailable.',
 workspace_delete_failed:'MachineNote deletion could not finish. Retry to complete the operation.'
};
async function readJSON(req,max=MAX_BODY){let n=0,chunks=[];for await(const c of req){n+=c.length;if(n>max)throw new CloudError('body_too_large',413);chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw new CloudError('bad_json',400);}}
function cleanName(value){const n=String(value||'').trim().replace(/\s+/g,' ');if(n.length<3||n.length>80||/[\x00-\x1f]/.test(n))throw new CloudError('workspace_name_invalid',400);return n;}
function price(key){const id=PRICE_IDS[key];if(typeof id!=='string'||!/^price_[A-Za-z0-9]+$/.test(id))throw new CloudError('price_unavailable',503);return id;}
function storageTier(value){if(typeof value!=='string'||!Object.hasOwn(STORAGE,value))throw new CloudError('storage_plan_invalid',400);return value;}
function performanceTier(value){if(typeof value!=='string'||!Object.hasOwn(PERFORMANCE,value))throw new CloudError('performance_plan_invalid',400);return value;}
function interval(value){if(!['month','year'].includes(value))throw new CloudError('billing_interval_invalid',400);return value;}
function workersFor(tier){return PERFORMANCE[tier]?.workers||1;}
function qualifies(p){return p.active===true&&p.quotaBytes>=2_000_000_000_000&&p.workers>=8;}
function limitFor(state){return state.ownerBenefits===true?20:(Object.values(state.projects||{}).some(qualifies)?20:10);}
function recurringPriceIds(p){
 const ids=[price('storage|standard|'+p.storageTier+'|'+p.interval)];
 if(p.performanceTier!=='free')ids.push(price('performance|'+p.performanceTier+'|'+p.interval));
 return ids;
}
function recurringCents(p){if(p.freeTier===true)return 0;const factor=p.interval==='year'?10:1;return STORAGE[p.storageTier].standard*factor+PERFORMANCE[p.performanceTier].cents*factor;}
function feeRequired(p){return !p.owner&&!p.feeWaived;}
function publicProject(p){return {id:p.id,name:p.name,status:p.status,active:p.active===true,readOnly:p.readOnly===true,
 feeWaived:p.feeWaived===true,workspaceMonthlyCents:p.feeWaived?0:WORKSPACE_MONTHLY_CENTS,owner:p.owner===true,
 storageTier:p.storageTier||null,performanceTier:p.performanceTier||null,interval:p.interval||null,
 quotaBytes:p.quotaBytes||0,workers:p.workers||0,subscriptionStatus:p.subscriptionStatus||null,
 checkoutPending:!p.owner&&p.freeTier!==true&&Boolean(p.storageTier&&p.performanceTier)&&(!p.subscriptionId||['canceled','incomplete_expired'].includes(p.subscriptionStatus)||feeRequired(p)&&!p.workspaceFeePriceId&&(!p.workspaceSubscriptionId||['canceled','incomplete_expired'].includes(p.workspaceSubscriptionStatus))),
 freeTier:p.freeTier===true,checkoutStage:p.freeTier===true?null:!p.subscriptionId||['canceled','incomplete_expired'].includes(p.subscriptionStatus)?'plans':feeRequired(p)&&!p.workspaceFeePriceId&&(!p.workspaceSubscriptionId||['canceled','incomplete_expired'].includes(p.workspaceSubscriptionStatus))?'workspace_fee':null,createdMs:p.createdMs||null};}

async function createControl(config){
 const issuer=origin(config.issuer||'https://red-xai.com',false);
 const stripe=config.stripe||null;
 const store=config.store||new ControlState({url:config.redxURL,key:config.redxKey,db:config.redxDB||'gendragoon_receivers',local:config.redxLocal===true});
 const receiverStore=config.receiverStore||new RedXState({url:config.redxURL,key:config.redxKey,db:config.redxDB||'gendragoon_receivers',local:config.redxLocal===true});
 const publicBase=config.publicBase||'https://api.red-xai.com/gendragoon';
 const receiverLocal=config.receiverLocal||'http://127.0.0.1:17779';
 const receiverEndpoint=new URL(receiverLocal);
 if(receiverEndpoint.protocol!=='http:'||receiverEndpoint.hostname!=='127.0.0.1'||receiverEndpoint.username||receiverEndpoint.password||receiverEndpoint.pathname!=='/'||receiverEndpoint.search||receiverEndpoint.hash)throw new Error('Receiver delete endpoint must stay on local loopback');
 const deletionPage=await fs.readFile(path.join(__dirname,'account-deletion.html'),'utf8');
 let billingReady=false;
 if(stripe){
   const expected=[];
   for(const term of ['month','year']){
     const factor=term==='year'?10:1;
     for(const [tier,entry] of Object.entries(STORAGE))expected.push({key:'storage|standard|'+tier+'|'+term,amount:entry.standard*factor,term});
     for(const [tier,entry] of Object.entries(PAID_PERFORMANCE))expected.push({key:'performance|'+tier+'|'+term,amount:entry.cents*factor,term});
   }
   expected.push({key:'one_time|remove_ads',amount:REMOVE_ADS_CENTS,term:null});
   // Verify the entire purchasable catalog, not just a single cheap tier.
   for(let offset=0;offset<expected.length;offset+=6)await Promise.all(expected.slice(offset,offset+6).map(async item=>{
     const probe=await stripe.prices.retrieve(price(item.key));
     if(probe?.active!==true||probe?.livemode!==true||probe?.currency!=='usd'||probe.unit_amount!==item.amount||
       (item.term?probe.recurring?.interval!==item.term||(probe.recurring?.interval_count||1)!==1:Boolean(probe.recurring)))throw new Error('Stripe catalog/account mismatch: '+item.key);
   }));
   billingReady=true;
 }
 const secureFetch=async(url,opts={})=>{if(new URL(url).origin!==issuer)throw new CloudError('issuer_endpoint_invalid',503);return (config.fetchImpl||fetch)(url,{...opts,redirect:'error'});};
 async function identify(req){
   const m=RX.exec(req.headers.authorization||'');if(!m)throw new CloudError('login_required',401);
   let response;try{response=await secureFetch(issuer+'/redxai-connect/userinfo',{headers:{authorization:'Bearer '+m[1],accept:'application/json'},signal:AbortSignal.timeout(8000)});}catch{throw new CloudError('identity_unavailable',503);}
   if(response.status===401||response.status===403)throw new CloudError('login_required',401);
   if(!response.ok)throw new CloudError('identity_unavailable',503);
   const text=await response.text();if(text.length>65536)throw new CloudError('identity_invalid',503);
   let u;try{u=JSON.parse(text);}catch{throw new CloudError('identity_invalid',503);}
   if(u.protocol!=='redx-site-session-v1'||u.client_id!=='gendragoon'||u.scope!=='gendragoon.receiver'||typeof u.sub!=='string'||!u.sub||u.email_verified!==true)
     throw new CloudError('account_setup_required',403);
   return {owner:digest(JSON.stringify(['red-xai-receiver/v1',issuer,u.sub])),sub:u.sub,email:String(u.email||'').toLowerCase(),bearer:'Bearer '+m[1]};
 }
 async function seed(identity){
   const receiver=await receiverStore.get(identity.owner);
   const existing=Object.values(receiver?.workspaces||{});
   const owner=identity.email===OWNER_EMAIL;
   const projects={};
   existing.forEach((w,index)=>{
     const id=ID.test(w.id||'')?w.id:crypto.randomBytes(16).toString('hex');
     projects[id]={id,name:cleanName(w.name||('MachineNote '+(index+1))),createdMs:Date.now()+index,
       feeWaived:owner||index===0,owner,storageTier:owner?'6TB':null,performanceTier:owner?'max':null,
       interval:owner?'year':null,quotaBytes:owner?6_000_000_000_000:0,workers:owner?20:0,
       active:owner,readOnly:!owner,status:owner?'active':'plan_required',subscriptionStatus:owner?'owner':null};
   });
   return {policyVersion:3,ownerBenefits:owner,adFree:owner,projects};
 }
 async function state(identity){
   if((await receiverStore.get(identity.owner))?.accountDeletion)throw new CloudError('account_deleted',410);
   let s=await store.get(identity.owner);
   if(!s)s=await store.ensure(identity.owner,await seed(identity));
   if(identity.email===OWNER_EMAIL&&(!s.ownerBenefits||(s.policyVersion||0)<3)){
     s=await store.change(identity.owner,x=>{x.policyVersion=3;x.ownerBenefits=true;x.adFree=true;for(const p of Object.values(x.projects||{})){p.owner=true;p.feeWaived=true;p.storageTier='6TB';p.performanceTier='max';p.interval='year';p.quotaBytes=6_000_000_000_000;p.workers=20;p.active=true;p.readOnly=false;p.status='active';p.subscriptionStatus='owner';}});
   } else if(identity.email!==OWNER_EMAIL&&((s.policyVersion||0)<3||s.ownerBenefits)){
     s=await store.change(identity.owner,x=>{x.policyVersion=3;if(x.ownerBenefits)x.adFree=false;x.ownerBenefits=false;const ordered=Object.values(x.projects||{}).sort((a,b)=>(a.createdMs||0)-(b.createdMs||0));ordered.forEach((p,i)=>{
       p.owner=false;p.feeWaived=i===0;
       if(!p.subscriptionId){p.storageTier=null;p.performanceTier=null;p.interval=null;p.quotaBytes=0;p.workers=0;p.active=false;p.readOnly=true;p.status='plan_required';p.subscriptionStatus=null;}
     });});
   }
   return s;
 }
 async function ensureCustomer(identity,s){
   if(s.stripeCustomerId)return s.stripeCustomerId;
   if(!billingReady)throw new CloudError('billing_unavailable',503);
   const customer=await stripe.customers.create({email:identity.email||undefined,metadata:{service:'GenDragoonSSD',redxOwner:identity.owner}},
     {idempotencyKey:'gd-rx-customer-'+identity.owner});
   await store.change(identity.owner,x=>{x.stripeCustomerId=customer.id;});
   return customer.id;
 }
 function metadata(identity,p,kind){return {service:'GenDragoonSSD',kind,redxOwner:identity.owner,projectId:p.id};}
 function matchesIdentity(object,identity,p,kind,customer){
   const m=object?.metadata||{},cid=typeof object?.customer==='string'?object.customer:object?.customer?.id;
   return m.service==='GenDragoonSSD'&&m.kind===kind&&m.redxOwner===identity.owner&&m.projectId===p.id&&cid===customer;
 }
 function exactItems(object,expected){
   const rows=object?.data||[];
   return !object?.has_more&&rows.length===expected.length&&rows.every(x=>x.quantity===1)&&expected.every(id=>rows.filter(x=>x.price?.id===id).length===1);
 }
 function validFee(row){return row?.quantity===1&&row.price?.currency==='usd'&&row.price?.unit_amount===WORKSPACE_MONTHLY_CENTS&&row.price?.recurring?.interval==='month'&&(row.price.recurring.interval_count||1)===1;}
 async function openProjectCheckout(identity,p,s){
   if(p.owner)return {complimentary:true,message:'Owner lifetime access is active.',project:publicProject(p)};
   if(p.freeTier===true&&s.freeWorkspaceId===p.id)return {complimentary:true,message:'Free 2 GB workspace is active.',project:publicProject(p)};
   if(!billingReady)throw new CloudError('billing_unavailable',503);
   if(!p.storageTier||!p.performanceTier||!p.interval)throw new CloudError('plans_required',409);
   if(p.subscriptionId&&['canceled','incomplete_expired'].includes(p.subscriptionStatus)){
     s=await store.change(identity.owner,x=>{const q=x.projects[p.id];q.subscriptionId=null;q.checkoutSessionId=null;q.checkoutGeneration=(q.checkoutGeneration||0)+1;});p=s.projects[p.id];
   }
   const workspace=Boolean(p.subscriptionId&&feeRequired(p)&&!p.workspaceFeePriceId);
   if(p.subscriptionId&&!workspace)throw new CloudError('subscription_already_exists',409);
   if(workspace&&p.workspaceSubscriptionId&&!['canceled','incomplete_expired'].includes(p.workspaceSubscriptionStatus))throw new CloudError('billing_portal_required',409);
   if(workspace&&p.workspaceSubscriptionId){s=await store.change(identity.owner,x=>{const q=x.projects[p.id];q.workspaceSubscriptionId=null;q.workspaceCheckoutSessionId=null;q.workspaceCheckoutGeneration=(q.workspaceCheckoutGeneration||0)+1;});p=s.projects[p.id];}
   const sessionKey=workspace?'workspaceCheckoutSessionId':'checkoutSessionId',generationKey=workspace?'workspaceCheckoutGeneration':'checkoutGeneration';
   if(p[sessionKey]){
     const prior=await stripe.checkout.sessions.retrieve(p[sessionKey]);
     if(prior.status==='open'&&prior.url)return {url:prior.url,resumed:true,checkoutStage:workspace?'workspace_fee':'plans',project:publicProject(p)};
     if(prior.status==='complete')throw new CloudError('checkout_processing',409);
     s=await store.change(identity.owner,x=>{const q=x.projects[p.id];q[sessionKey]=null;q[generationKey]=(q[generationKey]||0)+1;});p=s.projects[p.id];
   }
   const customer=await ensureCustomer(identity,s),kind=workspace?'workspace_fee':'workspace_plans',meta=metadata(identity,p,kind);
   // Checkout cannot create mixed month/year subscriptions. The workspace fee
   // therefore has its own monthly Checkout, independent of the plan interval.
   const items=workspace?[{price_data:{currency:'usd',unit_amount:WORKSPACE_MONTHLY_CENTS,recurring:{interval:'month'},product_data:{name:'GenDragoon MachineNote'}},quantity:1}]:recurringPriceIds(p).map(id=>({price:id,quantity:1}));
   const session=await stripe.checkout.sessions.create({mode:'subscription',customer,client_reference_id:p.id,line_items:items,
     metadata:meta,subscription_data:{metadata:meta},success_url:publicBase+'/billing/success?session_id={CHECKOUT_SESSION_ID}',cancel_url:publicBase+'/billing/cancel'},
     {idempotencyKey:'gd-rx-'+kind+'-'+identity.owner+'-'+p.id+'-'+p.storageTier+'-'+p.performanceTier+'-'+p.interval+'-'+(p[generationKey]||0)});
   s=await store.change(identity.owner,x=>{const q=x.projects[p.id];q[sessionKey]=session.id;q.status=workspace?'workspace_fee_required':'pending_payment';});
   return {url:session.url,projectId:p.id,project:publicProject(s.projects[p.id]),checkoutStage:workspace?'workspace_fee':'plans',
     workspaceMonthlyCents:p.feeWaived?0:WORKSPACE_MONTHLY_CENTS,recurringCents:recurringCents(p),recurringInterval:p.interval,
     message:workspace?'Approve the separate $5/month MachineNote subscription.':'Storage and performance bill together. Additional MachineNotes also require a separate $5/month MachineNote checkout.'};
 }
 async function reconcileProject(identity,p,s){
   if(p.owner)return;
   if(p.freeTier===true){
     if(s.freeWorkspaceId!==p.id||p.subscriptionId||p.workspaceSubscriptionId)
       throw new CloudError('free_workspace_review_required',409);
     if(p.status==='deleting')return;
     await store.change(identity.owner,x=>Object.assign(x.projects[p.id],{
       feeWaived:true,storageTier:'free2GB',performanceTier:'free',interval:null,
       quotaBytes:FREE_STORAGE_BYTES,workers:1,active:true,readOnly:false,status:'active',subscriptionStatus:'free'}));
     return;
   }
   // Without a configured billing provider, existing paid entitlements fail
   // closed rather than retaining a stale paid worker/quota grant.
   if(!stripe){await store.change(identity.owner,x=>Object.assign(x.projects[p.id],{active:false,readOnly:true,quotaBytes:0,workers:0,status:'billing_unavailable'}));return;}
   if(p.checkoutSessionId&&!p.subscriptionId){
     const session=await stripe.checkout.sessions.retrieve(p.checkoutSessionId);
     if(session.status==='complete'&&session.payment_status==='paid'&&session.subscription){
       const line=await stripe.checkout.sessions.listLineItems(session.id,{limit:10}),expected=recurringPriceIds(p),rows=line.data||[];
       // Accept previously created monthly bundled fees, but never create new
       // mixed-interval Checkouts. Migration keeps the existing fee subscription.
       const feeRow=!p.feeWaived?rows.find(x=>!expected.includes(x.price?.id)&&validFee(x)):null;
       if(!matchesIdentity(session,identity,p,'workspace_plans',s.stripeCustomerId)||session.mode!=='subscription'||session.client_reference_id!==p.id||!exactItems(line,feeRow?[...expected,feeRow.price.id]:expected))throw new CloudError('checkout_verification_failed',503);
       const sid=typeof session.subscription==='string'?session.subscription:session.subscription.id;
       await store.change(identity.owner,x=>{const q=x.projects[p.id];q.subscriptionId=sid;q.workspaceFeePriceId=feeRow?.price?.id||null;});
       p.subscriptionId=sid;p.workspaceFeePriceId=feeRow?.price?.id||null;
     }
   }
   if(p.workspaceCheckoutSessionId&&!p.workspaceSubscriptionId&&!p.feeWaived){
     const session=await stripe.checkout.sessions.retrieve(p.workspaceCheckoutSessionId);
     if(session.status==='complete'&&session.payment_status==='paid'&&session.subscription){
       const line=await stripe.checkout.sessions.listLineItems(session.id,{limit:10});
       if(!matchesIdentity(session,identity,p,'workspace_fee',s.stripeCustomerId)||session.mode!=='subscription'||session.client_reference_id!==p.id||line.has_more||line.data?.length!==1||!validFee(line.data[0]))throw new CloudError('checkout_verification_failed',503);
       const sid=typeof session.subscription==='string'?session.subscription:session.subscription.id;
       await store.change(identity.owner,x=>{x.projects[p.id].workspaceSubscriptionId=sid;});p.workspaceSubscriptionId=sid;
     }
   }
   let entitled=false,status=p.storageTier?'pending_payment':'plan_required',subscriptionStatus=p.subscriptionStatus||null,workspaceSubscriptionStatus=p.workspaceSubscriptionStatus||null;
   if(p.subscriptionId){
     const sub=await stripe.subscriptions.retrieve(p.subscriptionId),expected=recurringPriceIds(p);
     if(p.workspaceFeePriceId)expected.push(p.workspaceFeePriceId);
     const feeRow=p.workspaceFeePriceId?(sub.items?.data||[]).find(x=>x.price?.id===p.workspaceFeePriceId):null;
     const plansActive=matchesIdentity(sub,identity,p,'workspace_plans',s.stripeCustomerId)&&exactItems(sub.items,expected)&&(!feeRow||validFee(feeRow))&&ACTIVE.has(sub.status);
     let feeActive=p.feeWaived||Boolean(feeRow&&validFee(feeRow));
     if(feeRequired(p)&&p.workspaceSubscriptionId){
       const fee=await stripe.subscriptions.retrieve(p.workspaceSubscriptionId);
       workspaceSubscriptionStatus=fee.status;
       feeActive=matchesIdentity(fee,identity,p,'workspace_fee',s.stripeCustomerId)&&!fee.items?.has_more&&fee.items?.data?.length===1&&validFee(fee.items.data[0])&&ACTIVE.has(fee.status);
     }
     subscriptionStatus=sub.status;entitled=plansActive&&feeActive;status=entitled?'active':plansActive?'workspace_fee_required':'subscription_required';
   }
   await store.change(identity.owner,x=>{const q=x.projects[p.id];Object.assign(q,{subscriptionStatus,workspaceSubscriptionStatus,active:entitled,readOnly:!entitled,status,quotaBytes:entitled?STORAGE[q.storageTier].gb*1e9:0,workers:entitled?workersFor(q.performanceTier):0});});
 }
 async function reconcile(identity,s){
   for(const p of Object.values(s.projects||{}))await reconcileProject(identity,p,s);
   if(s.adsCheckoutSessionId&&!s.adFree&&stripe){
     const c=await stripe.checkout.sessions.retrieve(s.adsCheckoutSessionId);
     if(c.status==='complete'&&c.payment_status==='paid'){
       const customer=typeof c.customer==='string'?c.customer:c.customer?.id,meta=c.metadata||{},lines=await stripe.checkout.sessions.listLineItems(c.id,{limit:10});
       if(c.mode!=='payment'||customer!==s.stripeCustomerId||meta.service!=='GenDragoonSSD'||meta.kind!=='remove_ads'||meta.redxOwner!==identity.owner||!exactItems(lines,[price('one_time|remove_ads')]))throw new CloudError('checkout_verification_failed',503);
       await store.change(identity.owner,x=>{x.adFree=true;});
     }
   }
   return store.get(identity.owner);
 }
 async function createFreeProject(identity,s,body){
   const name=cleanName(body.name||'My Free Cloud');
   const existing=Object.values(s.projects||{});
   const free=existing.find(p=>p.freeTier===true);
   if(free)return {state:s,project:free,checkout:null};
   if(existing.length)throw new CloudError('free_workspace_already_claimed',409);
   // Optional deployment eligibility gate may require attested signup signals;
   // a client-provided device ID alone is never treated as identity proof.
   if(config.freeEligibility && await config.freeEligibility(identity)!==true)
     throw new CloudError('free_workspace_eligibility_required',403);
   const id=crypto.randomBytes(16).toString('hex');
   s=await store.change(identity.owner,x=>{
     if(Object.keys(x.projects||{}).length)throw new CloudError('free_workspace_already_claimed',409);
     x.freeWorkspaceId=id;
     x.projects[id]={id,name,createdMs:Date.now(),feeWaived:true,owner:false,freeTier:true,
       storageTier:'free2GB',performanceTier:'free',interval:null,quotaBytes:FREE_STORAGE_BYTES,
       workers:1,active:true,readOnly:false,status:'active',subscriptionStatus:'free'};
   });
   return {state:s,project:s.projects[id],checkout:null};
 }
 async function createProject(identity,s,body){
   const name=cleanName(body.name),owner=s.ownerBenefits===true;
   if(!owner&&body.storageTier==='free2GB')return createFreeProject(identity,s,body);
   if(!owner&&!billingReady)throw new CloudError('billing_unavailable',503);
   const tier=owner?'6TB':storageTier(body.storageTier),perf=owner?'max':performanceTier(body.performanceTier||'free'),iv=owner?'year':interval(body.interval||'month');
   // A failed Checkout creation leaves a recoverable pending workspace. A retry
   // resumes it instead of consuming another slot or creating a duplicate bill.
   const pending=Object.values(s.projects||{}).find(p=>p.name===name&&!p.subscriptionId&&!p.owner&&p.storageTier===tier&&p.performanceTier===perf&&p.interval===iv);
   if(pending)return {state:s,project:pending,checkout:await openProjectCheckout(identity,pending,s)};
   const id=crypto.randomBytes(16).toString('hex');
   s=await store.change(identity.owner,x=>{
     const count=Object.keys(x.projects||{}).length;if(count>=limitFor(x))throw new CloudError('project_limit_reached',409);
     x.projects[id]={id,name,createdMs:Date.now(),feeWaived:owner||count===0,owner,storageTier:tier,performanceTier:perf,interval:iv,
       quotaBytes:owner?6_000_000_000_000:0,workers:owner?20:0,active:owner,readOnly:!owner,status:owner?'active':'pending_payment',subscriptionStatus:owner?'owner':null};
   });
   const p=s.projects[id];return {state:s,project:p,checkout:owner?null:await openProjectCheckout(identity,p,s)};
 }
 async function changePlan(identity,s,id,body){
   const p=s.projects[id];if(!p)throw new CloudError('project_not_found',404);
   if(body.storageTier==='free2GB'){
     if(s.freeWorkspaceId!==id||p.subscriptionId||p.workspaceSubscriptionId)throw new CloudError('cancel_subscription_before_free_plan',409);
     await store.change(identity.owner,x=>{x.projects[id].freeTier=true;});return;
   }
   const st=storageTier(body.storageTier),pt=performanceTier(body.performanceTier||'free'),iv=interval(body.interval||p.interval||'month');
   if(s.ownerBenefits){await store.change(identity.owner,x=>Object.assign(x.projects[id],{storageTier:st,performanceTier:pt,interval:iv,quotaBytes:STORAGE[st].gb*1e9,workers:workersFor(pt),active:true,readOnly:false,status:'active',owner:true,subscriptionStatus:'owner'}));return;}
   if(!p.subscriptionId||['canceled','incomplete_expired'].includes(p.subscriptionStatus)){
     if(!p.subscriptionId&&p.checkoutSessionId){const prior=await stripe.checkout.sessions.retrieve(p.checkoutSessionId);if(prior.status==='complete')throw new CloudError('checkout_processing',409);if(prior.status==='open')await stripe.checkout.sessions.expire(prior.id);}
     await store.change(identity.owner,x=>Object.assign(x.projects[id],{freeTier:false,storageTier:st,performanceTier:pt,interval:iv,subscriptionId:null,workspaceFeePriceId:null,checkoutSessionId:null,checkoutGeneration:(p.checkoutGeneration||0)+1,status:'pending_payment'}));return;
   }
   if(!billingReady)throw new CloudError('billing_unavailable',503);
   const sub=await stripe.subscriptions.retrieve(p.subscriptionId),items=sub.items?.data||[];
   const oldStorage=price('storage|standard|'+p.storageTier+'|'+p.interval),oldPerf=p.performanceTier==='free'?null:price('performance|'+p.performanceTier+'|'+p.interval);
   const storageItem=items.find(x=>x.price?.id===oldStorage),perfItem=oldPerf?items.find(x=>x.price?.id===oldPerf):null;
   if(!matchesIdentity(sub,identity,p,'workspace_plans',s.stripeCustomerId)||!exactItems(sub.items,p.workspaceFeePriceId?[...recurringPriceIds(p),p.workspaceFeePriceId]:recurringPriceIds(p))||!storageItem||(oldPerf&&!perfItem))throw new CloudError('subscription_review_required',409);
   // Legacy bundled fees cannot switch intervals inside Checkout. Migrate that
   // subscription to flexible mode before an API update that mixes intervals.
   if(p.workspaceFeePriceId&&iv!==p.interval&&sub.billing_mode?.type!=='flexible'){if(!stripe.subscriptions.migrate)throw new CloudError('subscription_review_required',409);await stripe.subscriptions.migrate(p.subscriptionId,{billing_mode:{type:'flexible'}});}
   const updates=[{id:storageItem.id,price:price('storage|standard|'+st+'|'+iv),quantity:1}];
   if(perfItem&&pt==='free')updates.push({id:perfItem.id,deleted:true});
   else if(perfItem)updates.push({id:perfItem.id,price:price('performance|'+pt+'|'+iv)});
   else if(pt!=='free')updates.push({price:price('performance|'+pt+'|'+iv),quantity:1});
   await stripe.subscriptions.update(p.subscriptionId,{items:updates,proration_behavior:'always_invoice',payment_behavior:'error_if_incomplete',metadata:{...sub.metadata,storageTier:st,performanceTier:pt,interval:iv}});
   await store.change(identity.owner,x=>Object.assign(x.projects[id],{storageTier:st,performanceTier:pt,interval:iv}));
 }
 async function transferFreeSlot(s,deletedId){
   const deleted=s.projects[deletedId];if(!deleted?.feeWaived||s.ownerBenefits)return;
   const next=Object.values(s.projects).filter(p=>p.id!==deletedId).sort((a,b)=>(a.createdMs||0)-(b.createdMs||0))[0];if(!next)return;
   if(next.workspaceSubscriptionId)await stripe.subscriptions.cancel(next.workspaceSubscriptionId);
   if(next.workspaceCheckoutSessionId){const session=await stripe.checkout.sessions.retrieve(next.workspaceCheckoutSessionId);if(session.status==='open')await stripe.checkout.sessions.expire(session.id);}
   if(next.subscriptionId&&next.workspaceFeePriceId){
     const sub=await stripe.subscriptions.retrieve(next.subscriptionId),item=(sub.items?.data||[]).find(x=>x.price?.id===next.workspaceFeePriceId);
     if(item)await stripe.subscriptions.update(next.subscriptionId,{items:[{id:item.id,deleted:true}],proration_behavior:'none'});
   }
   await store.change(s.owner,x=>{const q=x.projects[next.id];q.feeWaived=true;q.workspaceFeePriceId=null;q.workspaceSubscriptionId=null;q.workspaceCheckoutSessionId=null;});
 }
 async function deleteProject(identity,s,id,body){
   const p=s.projects[id];if(!p)throw new CloudError('project_not_found',404);
   if(typeof body.confirmName!=='string'||body.confirmName!==p.name)throw new CloudError('confirm_name_required',409);
   if((p.subscriptionId||p.workspaceSubscriptionId)&&!stripe)throw new CloudError('billing_unavailable',503);
   for(const sid of [p.subscriptionId,p.workspaceSubscriptionId].filter(Boolean)){const sub=await stripe.subscriptions.retrieve(sid);if(sub.status!=='canceled')await stripe.subscriptions.cancel(sid);}
   for(const csid of [p.checkoutSessionId,p.workspaceCheckoutSessionId].filter(Boolean)){const session=await stripe.checkout.sessions.retrieve(csid);if(session.status==='open')await stripe.checkout.sessions.expire(csid);}
   const remover=config.deleteWorkspace||(async()=>{
     if(!config.redxKey)throw new CloudError('workspace_delete_unavailable',503);
     const stamp=String(Date.now()),proof=crypto.createHmac('sha256',config.redxKey).update(identity.owner+'/'+id+'/'+stamp).digest('hex');
     const r=await fetch(receiverLocal+'/v1/receivers/me/workspaces/'+id,{method:'DELETE',headers:{authorization:identity.bearer,'x-confirm-workspace':id,'x-control-delete':proof,'x-control-delete-time':stamp},signal:AbortSignal.timeout(30000)});
     // A pending checkout may never have created its Receiver workspace.
     if(!r.ok&&r.status!==404)throw new CloudError('workspace_delete_failed',503);
   });
   await remover({identity,project:p});
   await transferFreeSlot({...s,owner:identity.owner},id);
   await store.change(identity.owner,x=>{delete x.projects[id];});
   return {deleted:true,id,name:p.name,subscriptionCanceled:Boolean(p.subscriptionId||p.workspaceSubscriptionId)};
 }
 async function removeAds(identity,s){
   if(s.ownerBenefits)return {complimentary:true,message:'Owner ad-free access is active.'};
   if(s.adFree)return {alreadyActivated:true,message:'Ad-free access is already active.'};
   if(!billingReady)throw new CloudError('billing_unavailable',503);
   if(s.adsCheckoutSessionId){const old=await stripe.checkout.sessions.retrieve(s.adsCheckoutSessionId);if(old.status==='open'&&old.url)return {url:old.url,resumed:true};if(old.status==='complete')throw new CloudError('checkout_processing',409);s=await store.change(identity.owner,x=>{x.adsCheckoutSessionId=null;x.adsCheckoutGeneration=(x.adsCheckoutGeneration||0)+1;});}
   const customer=await ensureCustomer(identity,s);
   const session=await stripe.checkout.sessions.create({mode:'payment',customer,line_items:[{price:price('one_time|remove_ads'),quantity:1}],metadata:{service:'GenDragoonSSD',kind:'remove_ads',redxOwner:identity.owner},
     success_url:publicBase+'/billing/success?session_id={CHECKOUT_SESSION_ID}',cancel_url:publicBase+'/billing/cancel'},{idempotencyKey:'gd-rx-ads-'+identity.owner+'-'+(s.adsCheckoutGeneration||0)});
   await store.change(identity.owner,x=>{x.adsCheckoutSessionId=session.id;});
   return {url:session.url,oneTimeCents:REMOVE_ADS_CENTS};
 }
 async function portal(identity,s){if(!billingReady||!s.stripeCustomerId)throw new CloudError('billing_account_not_found',404);return stripe.billingPortal.sessions.create({customer:s.stripeCustomerId,return_url:publicBase+'/billing/return'});}
 const pricing={currency:'usd',catalogVersion:4,free:{workspaceMonthlyCents:0,storageTier:'free2GB',quotaBytes:FREE_STORAGE_BYTES,performanceTier:'free',performanceMonthlyCents:0,workers:1},
   projects:{firstWorkspaceFeeWaived:true,additionalWorkspaceMonthlyCents:WORKSPACE_MONTHLY_CENTS,firstMachineNoteFeeWaived:true,additionalMachineNoteMonthlyCents:WORKSPACE_MONTHLY_CENTS,defaultLimit:10,qualifiedLimit:20,qualificationLabel:'2 TB storage and Turbo (8 workers) or higher on the same active MachineNote'},
   storage:{free2GB:{gb:2,monthlyCents:0,yearlyCents:0},...Object.fromEntries(Object.entries(STORAGE).map(([k,v])=>[k,{gb:v.gb,monthlyCents:v.standard,yearlyCents:v.standard*10}]))},
   performance:Object.fromEntries(Object.entries(PERFORMANCE).map(([k,v])=>[k,{workers:v.workers,monthlyCents:v.cents,yearlyCents:v.cents*10}])),
   removeAds:{oneTimeCents:REMOVE_ADS_CENTS},owner:{email:OWNER_EMAIL,allPlansIncluded:true,lifetime:true}};
 const accountLocks=new Map();
 async function serial(owner,fn){const before=accountLocks.get(owner)||Promise.resolve();let release;const gate=new Promise(r=>{release=r;});const tail=before.catch(()=>{}).then(()=>gate);accountLocks.set(owner,tail);await before.catch(()=>{});try{return await fn();}finally{release();if(accountLocks.get(owner)===tail)accountLocks.delete(owner);}}
 const deletionReceiver=createDeletionClient({url:receiverLocal,key:config.redxKey});
 const accountDeletion=createAccountDeletion({store:receiverStore,receiver:config.accountDeletionReceiver||deletionReceiver,
   autoRun:config.accountDeletionAutoRun!==false,settleBilling:(identity,s)=>settleAccountBilling(stripe,identity,s),
   removeWorkspace:async(identity,id)=>{
    if(config.deleteWorkspace)return config.deleteWorkspace({identity,project:{id}});
    if(!config.redxKey)throw new CloudError('account_deletion_unavailable',503);
    const stamp=String(Date.now()),proof=crypto.createHmac('sha256',config.redxKey).update(identity.owner+'/'+id+'/'+stamp).digest('hex');
    const r=await fetch(receiverLocal+'/v1/receivers/me/workspaces/'+id,{method:'DELETE',redirect:'error',headers:{authorization:identity.bearer,'x-confirm-workspace':id,'x-control-delete':proof,'x-control-delete-time':stamp},signal:AbortSignal.timeout(30000)});
    if(!r.ok)throw new CloudError('workspace_delete_failed',503);
    const text=await r.text();if(text.length>16384)throw new CloudError('workspace_delete_failed',503);
    let result;try{result=JSON.parse(text);}catch{throw new CloudError('workspace_delete_failed',503);}
    if(result.ok!==true||result.workspace!==id)throw new CloudError('workspace_delete_failed',503);
   }});
 const integrationProofs=new Map();
 const internalEntitlements=createInternalEntitlements({token:config.internalEntitlementToken,issuer,resolve:async(identity,workspaceId)=>serial(identity.owner,async()=>{
   let s=await store.get(identity.owner);const p=s?.projects?.[workspaceId];
   const receiver=await receiverStore.get(identity.owner);
   if(receiver?.accountDeletion)return null;
   if(!p||p.status==='deleting'||receiver?.workspaceDeletions?.[workspaceId]||receiver?.deletedWorkspaces?.[workspaceId])return null;
   // API keys delegate existing account storage. They never establish fresh
   // verified-owner/admin authority or create/migrate an account's benefits.
   if(!(s.ownerBenefits===true&&p.owner===true)){
     if(p.owner===true||s.ownerBenefits===true)throw new CloudError('entitlement_state_invalid',503);
     const key=identity.owner+':'+workspaceId,prior=integrationProofs.get(key);
     if(!prior||Date.now()-prior>10000){
       await reconcileProject({owner:identity.owner,sub:identity.subject},p,s);
       integrationProofs.set(key,Date.now());
       if(integrationProofs.size>10000)integrationProofs.delete(integrationProofs.keys().next().value);
     }
     s=await store.get(identity.owner);
   }
   const q=s?.projects?.[workspaceId];if(!q||q.status==='deleting')return null;
   return {id:workspaceId,active:q.active===true,readOnly:q.readOnly===true,quotaBytes:q.quotaBytes||0,workers:q.workers||0,checkedAtMs:Date.now()};
 })});
 const server=http.createServer();
 const lifecycle=createControlLifecycle(server,{drain:()=>accountDeletion.drain()});
 server.on('request',lifecycle.admit(async(req,res)=>{
   try{
     const host=req.headers.host||'',u=new URL(req.url,'http://'+host);if(req.headers.origin)throw new CloudError('invalid_origin',403);
     const legacyPath=u.pathname==='/gendragoon'?'/':u.pathname.startsWith('/gendragoon/')?u.pathname.slice('/gendragoon'.length):u.pathname;
     const pathname=legacyPath.replace(/^\/v2\/machinenotes(?=\/|$)/,'/v2/projects');
     if(await internalEntitlements(req,res,pathname))return;
     if(req.method==='GET'&&pathname==='/healthz')return send(res,200,{service:'gendragoon-control',redx:true,billing:billingReady});
     if(req.method==='GET'&&pathname==='/account-deletion'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"});return res.end(deletionPage);}
     if(req.method==='GET'&&['/privacy','/privacy.html'].includes(pathname)){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"});return res.end(PRIVACY_HTML);}
     if(req.method==='GET'&&pathname==='/v2/pricing')return send(res,200,pricing);
     if(req.method==='GET'&&['/billing/success','/billing/cancel','/billing/return'].includes(pathname)){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});return res.end('<!doctype html><meta charset="utf-8"><title>GenDragoon</title><body style="font-family:system-ui;background:#0b0912;color:#eee;padding:48px"><h1>GenDragoon billing</h1><p>Return to GenDragoon Cloud SSD. The app will verify your current entitlement with the server.</p></body>');}
     const identity=await identify(req);
     if(pathname==='/v2/account/deletion'&&req.method==='GET')return send(res,200,await accountDeletion.status(identity));
     if(pathname==='/v2/account/deletion'&&req.method==='POST'||pathname==='/v2/account'&&req.method==='DELETE'){
      const body=await readJSON(req,4096);
      return await serial(identity.owner,async()=>{const result=await accountDeletion.request(identity,body);return send(res,result.deletion.status==='completed'?200:202,result);});
     }
     return await serial(identity.owner,async()=>{let s=await state(identity);s=await reconcile(identity,s);
     if(req.method==='GET'&&pathname==='/v2/account')return send(res,200,{ownerBenefits:s.ownerBenefits===true,adFree:s.adFree===true,projectLimit:limitFor(s),usedProjectSlots:Object.keys(s.projects||{}).length,email:identity.email});
     if(req.method==='GET'&&pathname==='/v2/projects')return send(res,200,{ownerBenefits:s.ownerBenefits===true,projectLimit:limitFor(s),projects:Object.values(s.projects||{}).sort((a,b)=>a.createdMs-b.createdMs).map(publicProject)});
     if(req.method==='GET'&&pathname==='/v2/receiver-entitlements')return send(res,200,{schema:1,ownerBenefits:s.ownerBenefits===true,projectLimit:limitFor(s),usedProjectSlots:Object.keys(s.projects||{}).length,workspaces:Object.values(s.projects||{}).map(p=>({projectId:p.id,id:p.id,name:p.name,active:p.active===true,readOnly:p.readOnly===true,quotaBytes:p.quotaBytes||0,workers:p.workers||0,status:p.status,storageTier:p.storageTier||null,performanceTier:p.performanceTier||null,entitlementSource:p.owner?'owner':p.feeWaived?'fee-waived':'subscription'}))});
     if(req.method==='POST'&&pathname==='/v2/projects'){const r=await createProject(identity,s,await readJSON(req));return send(res,201,{project:publicProject(r.project),...(r.checkout||{})});}
     let m=/^\/v2\/projects\/([a-f0-9]{32})\/checkout$/.exec(pathname);if(req.method==='POST'&&m){const p=s.projects[m[1]];if(!p)throw new CloudError('project_not_found',404);return send(res,200,await openProjectCheckout(identity,p,s));}
     m=/^\/v2\/projects\/([a-f0-9]{32})\/plan$/.exec(pathname);if(req.method==='PUT'&&m){await changePlan(identity,s,m[1],await readJSON(req));s=await reconcile(identity,await store.get(identity.owner));return send(res,200,{project:publicProject(s.projects[m[1]])});}
     m=/^\/v2\/projects\/([a-f0-9]{32})$/.exec(pathname);if(req.method==='DELETE'&&m)return send(res,200,await deleteProject(identity,s,m[1],await readJSON(req)));
     if(req.method==='POST'&&pathname==='/v2/remove-ads/checkout')return send(res,200,await removeAds(identity,s));
     if(req.method==='POST'&&pathname==='/v2/billing/portal'){const x=await portal(identity,s);return send(res,200,{url:x.url});}
     throw new CloudError('not_found',404);
     });
   }catch(e){if(!res.headersSent){const code=e instanceof CloudError?e.code:'service_unavailable';send(res,e instanceof CloudError?e.status:503,{error:code,...(MACHINE_NOTE_MESSAGES[code]?{message:MACHINE_NOTE_MESSAGES[code]}:{})});}else res.destroy();}
 }));
 server.requestTimeout=60000;server.headersTimeout=10000;server.maxHeadersCount=30;
 return {server,store,accountDeletion,async listen(port=0){if(lifecycle.closing)throw new CloudError('service_closing',503);await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok)});return 'http://127.0.0.1:'+server.address().port;},close:lifecycle.close};
}
if(require.main===module){
 const Stripe=require('stripe'),secret=process.env.STRIPE_SECRET_KEY||'';
 const stripe=/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(secret)?new Stripe(secret,{apiVersion:'2026-09-30.endive',maxNetworkRetries:2,timeout:25000}):null;
 runControlCLI(()=>createControl({issuer:process.env.REDXAI_ISSUER||'https://red-xai.com',redxURL:process.env.REDX_URL,redxKey:process.env.REDX_RECEIVERS_KEY,redxDB:process.env.REDX_RECEIVERS_DB||'gendragoon_receivers',redxLocal:process.env.REDX_LOCAL_LOOPBACK==='1',publicBase:process.env.GENDRAGOON_PUBLIC_BASE||'https://api.red-xai.com/gendragoon',internalEntitlementToken:process.env.GENDRAGOON_CONTROL_INTERNAL_TOKEN,stripe}),{port:Number(process.env.GENDRAGOON_CONTROL_PORT||17778)});
}
module.exports={createControl,WORKSPACE_MONTHLY_CENTS,OWNER_EMAIL,pricing:()=>({STORAGE,PERFORMANCE})};
