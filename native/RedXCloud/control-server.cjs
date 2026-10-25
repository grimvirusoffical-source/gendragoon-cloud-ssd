'use strict';
const http=require('node:http');
const crypto=require('node:crypto');
const path=require('node:path');
const {ControlState}=require('./control-state.cjs');
const {RedXState,CloudError,digest,origin}=require('./redx-state.cjs');
const {STORAGE,PERFORMANCE}=require('../Backend/catalog.js');

const OWNER_EMAIL='support@infected-nation.com';
const FREE_BYTES=2_000_000_000;
const PROJECT_FEE_CENTS=500;
const REMOVE_ADS_CENTS=499;
const ID=/^[a-f0-9]{32}$/;
const RX=/^Bearer (rxca_[A-Za-z0-9_-]{43})$/;
const ACTIVE=new Set(['active','trialing']);
const CATALOG=require('../Backend/stripe_live_catalog.json');
const PRICE_IDS=CATALOG.priceIds||{};
const MAX_BODY=32*1024;

const send=(res,status,body,headers={})=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff',...headers});res.end(JSON.stringify(body));};
async function readJSON(req,max=MAX_BODY){let n=0,chunks=[];for await(const c of req){n+=c.length;if(n>max)throw new CloudError('body_too_large',413);chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw new CloudError('bad_json',400);}}
function cleanName(value){const n=String(value||'').trim().replace(/\s+/g,' ');if(n.length<3||n.length>80||/[\x00-\x1f]/.test(n))throw new CloudError('workspace_name_invalid',400);return n;}
function price(key){const id=PRICE_IDS[key];if(typeof id!=='string'||!/^price_[A-Za-z0-9]+$/.test(id))throw new CloudError('price_unavailable',503);return id;}
function storageTier(value){if(typeof value!=='string'||!Object.hasOwn(STORAGE,value))throw new CloudError('storage_plan_invalid',400);return value;}
function performanceTier(value){if(typeof value!=='string'||!Object.hasOwn(PERFORMANCE,value))throw new CloudError('performance_plan_invalid',400);return value;}
function interval(value){if(!['month','year'].includes(value))throw new CloudError('billing_interval_invalid',400);return value;}
function workersFor(tier){return PERFORMANCE[tier]?.workers||1;}
function qualifies(p){return p.active===true&&p.quotaBytes>=2_000_000_000_000&&p.workers>=8;}
function limitFor(state){return Object.values(state.projects||{}).some(qualifies)?20:10;}
function publicProject(p){return {id:p.id,name:p.name,status:p.status,active:p.active===true,readOnly:p.readOnly===true,
  free:p.free===true,owner:p.owner===true,storageTier:p.storageTier||null,performanceTier:p.performanceTier||null,
  interval:p.interval||null,quotaBytes:p.quotaBytes||0,workers:p.workers||0,subscriptionStatus:p.subscriptionStatus||null,
  checkoutPending:!!p.checkoutSessionId&&!p.subscriptionId,createdMs:p.createdMs||null};}

async function createControl(config){
 const issuer=origin(config.issuer||'https://red-xai.com',false);
 const stripe=config.stripe||null;
 const store=config.store||new ControlState({url:config.redxURL,key:config.redxKey,db:config.redxDB||'gendragoon_receivers',local:config.redxLocal===true});
 const receiverStore=config.receiverStore||new RedXState({url:config.redxURL,key:config.redxKey,db:config.redxDB||'gendragoon_receivers',local:config.redxLocal===true});
 const publicBase=config.publicBase||'https://api.red-xai.com/gendragoon';
 let billingReady=false;
 if(stripe){
   const probe=await stripe.prices.retrieve(price('storage|standard|100GB|month'));
   if(probe?.active!==true||probe?.livemode!==true||probe?.currency!=='usd')throw new Error('Stripe catalog/account mismatch');
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
   const receiver=await receiverStore.get(identity.owner).catch(()=>null);
   const existing=Object.values(receiver?.workspaces||{});
   const owner=identity.email===OWNER_EMAIL;
   const projects={};
   existing.forEach((w,index)=>{
     const id=ID.test(w.id||'')?w.id:crypto.randomBytes(16).toString('hex');
     projects[id]={id,name:cleanName(w.name||('Workspace '+(index+1))),createdMs:Date.now()+index,
       free:!owner&&index===0,owner,storageTier:owner?'6TB':null,performanceTier:owner?'max':null,
       interval:owner?'year':null,quotaBytes:owner?6_000_000_000_000:(!owner&&index===0?FREE_BYTES:0),
       workers:owner?20:(!owner&&index===0?1:0),active:owner||index===0,readOnly:!(owner||index===0),
       status:owner||index===0?'active':'plan_required',activationPaid:owner||index===0,subscriptionStatus:owner?'owner':null};
   });
   return {ownerBenefits:owner,adFree:owner,projects};
 }
 async function state(identity){
   let s=await store.get(identity.owner);
   if(!s)s=await store.ensure(identity.owner,await seed(identity));
   if(identity.email===OWNER_EMAIL&&!s.ownerBenefits){
     s=await store.change(identity.owner,x=>{x.ownerBenefits=true;x.adFree=true;for(const p of Object.values(x.projects||{})){p.owner=true;p.free=false;p.storageTier='6TB';p.performanceTier='max';p.interval='year';p.quotaBytes=6_000_000_000_000;p.workers=20;p.active=true;p.readOnly=false;p.status='active';p.activationPaid=true;p.subscriptionStatus='owner';}});
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
 function recurringPriceIds(p){return [price('storage|standard|'+p.storageTier+'|'+p.interval),price('performance|'+p.performanceTier+'|'+p.interval)];}
 async function openProjectCheckout(identity,p,s){
   if(!billingReady)throw new CloudError('billing_unavailable',503);
   if(p.owner)return {complimentary:true,message:'Owner lifetime access is active.',project:publicProject(p)};
   if(p.free)return {complimentary:true,message:'Your first project is free.',project:publicProject(p)};
   if(p.checkoutSessionId&&!p.subscriptionId){
     const prior=await stripe.checkout.sessions.retrieve(p.checkoutSessionId);
     if(prior.status==='open'&&prior.url)return {url:prior.url,resumed:true,project:publicProject(p)};
   }
   const customer=await ensureCustomer(identity,s);
   const recurring=recurringPriceIds(p);
   const metadata={service:'GenDragoonSSD',kind:'workspace_plans',redxOwner:identity.owner,projectId:p.id};
   const session=await stripe.checkout.sessions.create({mode:'subscription',customer,client_reference_id:p.id,
     line_items:[
       {price:recurring[0],quantity:1},{price:recurring[1],quantity:1},
       {price_data:{currency:'usd',unit_amount:PROJECT_FEE_CENTS,product_data:{name:'GenDragoon Project Activation'}},quantity:1}
     ],metadata,subscription_data:{metadata},
     success_url:publicBase+'/billing/success?session_id={CHECKOUT_SESSION_ID}',cancel_url:publicBase+'/billing/cancel'},
     {idempotencyKey:'gd-rx-project-'+identity.owner+'-'+p.id+'-'+p.storageTier+'-'+p.performanceTier+'-'+p.interval});
   await store.change(identity.owner,x=>{x.projects[p.id].checkoutSessionId=session.id;x.projects[p.id].status='pending_payment';});
   return {url:session.url,projectId:p.id,oneTimeCents:PROJECT_FEE_CENTS};
 }
 async function reconcileProject(identity,p){
   if(p.owner||p.free||!stripe)return;
   if(p.checkoutSessionId&&!p.subscriptionId){
     const session=await stripe.checkout.sessions.retrieve(p.checkoutSessionId);
     if(session.status==='complete'&&session.payment_status==='paid'&&session.subscription){
       const line=await stripe.checkout.sessions.listLineItems(session.id,{limit:10});
       const rec=recurringPriceIds(p),ids=(line.data||[]).map(x=>x.price?.id).filter(Boolean);
       const setup=(line.data||[]).some(x=>!x.price?.recurring&&x.price?.unit_amount===PROJECT_FEE_CENTS&&x.quantity===1);
       if(!setup||rec.some(id=>!ids.includes(id)))throw new CloudError('checkout_verification_failed',503);
       const sid=typeof session.subscription==='string'?session.subscription:session.subscription.id;
       await store.change(identity.owner,x=>{const q=x.projects[p.id];q.subscriptionId=sid;q.activationPaid=true;q.checkoutSessionId=session.id;});
       p.subscriptionId=sid;p.activationPaid=true;
     }
   }
   if(p.subscriptionId){
     const sub=await stripe.subscriptions.retrieve(p.subscriptionId);
     const expected=recurringPriceIds(p),items=sub.items?.data||[];
     const matches=expected.length===items.length&&expected.every(id=>items.some(x=>x.price?.id===id));
     const entitled=matches&&ACTIVE.has(sub.status);
     await store.change(identity.owner,x=>{const q=x.projects[p.id];q.subscriptionStatus=sub.status;q.active=entitled;q.readOnly=!entitled;
       q.status=entitled?'active':'subscription_required';q.quotaBytes=entitled?STORAGE[q.storageTier].gb*1_000_000_000:0;q.workers=entitled?workersFor(q.performanceTier):0;});
   }
 }
 async function reconcile(identity,s){
   for(const p of Object.values(s.projects||{}))await reconcileProject(identity,p);
   if(s.adsCheckoutSessionId&&!s.adFree&&stripe){
     const c=await stripe.checkout.sessions.retrieve(s.adsCheckoutSessionId);
     if(c.status==='complete'&&c.payment_status==='paid')await store.change(identity.owner,x=>{x.adFree=true;});
   }
   return store.get(identity.owner);
 }
 async function createProject(identity,s,body){
   const name=cleanName(body.name),count=Object.keys(s.projects||{}).length,limit=limitFor(s);
   if(count>=limit)throw new CloudError('project_limit_reached',409);
   const first=count===0,owner=s.ownerBenefits===true,id=crypto.randomBytes(16).toString('hex');
   const tier=owner?'6TB':first?null:storageTier(body.storageTier);
   const perf=owner?'max':first?null:performanceTier(body.performanceTier);
   const iv=owner?'year':first?null:interval(body.interval||'month');
   const p={id,name,createdMs:Date.now(),free:first&&!owner,owner,storageTier:tier,performanceTier:perf,interval:iv,
     quotaBytes:owner?6_000_000_000_000:first?FREE_BYTES:0,workers:owner?20:first?1:0,
     active:owner||first,readOnly:!(owner||first),status:owner||first?'active':'pending_payment',activationPaid:owner||first};
   s=await store.change(identity.owner,x=>{x.projects[id]=p;});
   return {state:s,project:p,checkout:owner||first?null:await openProjectCheckout(identity,p,s)};
 }
 async function changePlan(identity,s,id,body){
   const p=s.projects[id];if(!p)throw new CloudError('project_not_found',404);
   const st=storageTier(body.storageTier),pt=performanceTier(body.performanceTier),iv=interval(body.interval||p.interval||'month');
   if(s.ownerBenefits){await store.change(identity.owner,x=>Object.assign(x.projects[id],{storageTier:st,performanceTier:pt,interval:iv,quotaBytes:STORAGE[st].gb*1e9,workers:workersFor(pt),active:true,readOnly:false,status:'active',owner:true,subscriptionStatus:'owner'}));return;}
   if(!p.subscriptionId)throw new CloudError('subscription_required',409);
   if(!billingReady)throw new CloudError('billing_unavailable',503);
   const sub=await stripe.subscriptions.retrieve(p.subscriptionId),newPrices=[price('storage|standard|'+st+'|'+iv),price('performance|'+pt+'|'+iv)];
   if((sub.items?.data||[]).length!==2)throw new CloudError('subscription_review_required',409);
   await stripe.subscriptions.update(p.subscriptionId,{items:sub.items.data.map((item,i)=>({id:item.id,price:newPrices[i]})),
     proration_behavior:'create_prorations',metadata:{...sub.metadata,storageTier:st,performanceTier:pt,interval:iv}});
   await store.change(identity.owner,x=>Object.assign(x.projects[id],{storageTier:st,performanceTier:pt,interval:iv}));
 }
 async function removeAds(identity,s){
   if(s.ownerBenefits)return {complimentary:true,message:'Owner ad-free access is active.'};
   if(s.adFree)return {alreadyActivated:true,message:'Ad-free access is already active.'};
   if(!billingReady)throw new CloudError('billing_unavailable',503);
   if(s.adsCheckoutSessionId){const old=await stripe.checkout.sessions.retrieve(s.adsCheckoutSessionId);if(old.status==='open'&&old.url)return {url:old.url,resumed:true};}
   const customer=await ensureCustomer(identity,s);
   const session=await stripe.checkout.sessions.create({mode:'payment',customer,line_items:[{price:price('one_time|remove_ads'),quantity:1}],
     metadata:{service:'GenDragoonSSD',kind:'remove_ads',redxOwner:identity.owner},
     success_url:publicBase+'/billing/success?session_id={CHECKOUT_SESSION_ID}',cancel_url:publicBase+'/billing/cancel'},
     {idempotencyKey:'gd-rx-ads-'+identity.owner});
   await store.change(identity.owner,x=>{x.adsCheckoutSessionId=session.id;});
   return {url:session.url,oneTimeCents:REMOVE_ADS_CENTS};
 }
 async function portal(identity,s){
   if(!stripe||!s.stripeCustomerId)throw new CloudError('billing_account_not_found',404);
   return stripe.billingPortal.sessions.create({customer:s.stripeCustomerId,return_url:publicBase+'/billing/return'});
 }
 const pricing={currency:'usd',catalogVersion:3,free:{storageGB:2,workers:1},projects:{firstFree:true,additionalOneTimeCents:PROJECT_FEE_CENTS,
   defaultLimit:10,qualifiedLimit:20,qualificationLabel:'2 TB storage and Turbo (8 workers) or higher on the same active project'},
   storage:Object.fromEntries(Object.entries(STORAGE).map(([k,v])=>[k,{gb:v.gb,monthlyCents:v.standard,yearlyCents:v.standard*10}])),
   performance:Object.fromEntries(Object.entries(PERFORMANCE).map(([k,v])=>[k,{workers:v.workers,monthlyCents:v.cents,yearlyCents:v.cents*10}])),
   removeAds:{oneTimeCents:REMOVE_ADS_CENTS},owner:{email:OWNER_EMAIL,allPlansIncluded:true,lifetime:true}};
 const server=http.createServer(async(req,res)=>{
   try{
     const host=req.headers.host||'',u=new URL(req.url,'http://'+host);
     if(req.headers.origin)throw new CloudError('invalid_origin',403);
     const pathname=u.pathname==='/gendragoon'?'/':u.pathname.startsWith('/gendragoon/')?u.pathname.slice('/gendragoon'.length):u.pathname;
     if(req.method==='GET'&&pathname==='/healthz')return send(res,200,{service:'gendragoon-control',redx:true,billing:billingReady});
     if(req.method==='GET'&&pathname==='/v2/pricing')return send(res,200,pricing);
     if(req.method==='GET'&&['/billing/success','/billing/cancel','/billing/return'].includes(pathname)){
       res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
       return res.end('<!doctype html><meta charset="utf-8"><title>GenDragoon</title><body style="font-family:system-ui;background:#0b0912;color:#eee;padding:48px"><h1>GenDragoon billing</h1><p>Return to GenDragoon Cloud SSD. The app will verify your current entitlement with the server.</p></body>');
     }
     const identity=await identify(req);let s=await state(identity);s=await reconcile(identity,s);
     if(req.method==='GET'&&pathname==='/v2/account')return send(res,200,{ownerBenefits:s.ownerBenefits===true,adFree:s.adFree===true,projectLimit:limitFor(s),usedProjectSlots:Object.keys(s.projects||{}).length,email:identity.email});
     if(req.method==='GET'&&pathname==='/v2/projects')return send(res,200,{ownerBenefits:s.ownerBenefits===true,projectLimit:limitFor(s),projects:Object.values(s.projects||{}).sort((a,b)=>a.createdMs-b.createdMs).map(publicProject)});
     if(req.method==='GET'&&pathname==='/v2/receiver-entitlements')return send(res,200,{schema:1,ownerBenefits:s.ownerBenefits===true,projectLimit:limitFor(s),usedProjectSlots:Object.keys(s.projects||{}).length,
       workspaces:Object.values(s.projects||{}).map(p=>({projectId:p.id,id:p.id,name:p.name,active:p.active===true,readOnly:p.readOnly===true,quotaBytes:p.quotaBytes||0,workers:p.workers||0,status:p.status,storageTier:p.storageTier||null,performanceTier:p.performanceTier||null,entitlementSource:p.owner?'owner':p.free?'free':'subscription'}))});
     if(req.method==='POST'&&pathname==='/v2/projects'){const body=await readJSON(req);const r=await createProject(identity,s,body);return send(res,201,{project:publicProject(r.project),...(r.checkout||{})});}
     let m=/^\/v2\/projects\/([a-f0-9]{32})\/checkout$/.exec(pathname);
     if(req.method==='POST'&&m){const p=s.projects[m[1]];if(!p)throw new CloudError('project_not_found',404);return send(res,200,await openProjectCheckout(identity,p,s));}
     m=/^\/v2\/projects\/([a-f0-9]{32})\/plan$/.exec(pathname);
     if(req.method==='PUT'&&m){await changePlan(identity,s,m[1],await readJSON(req));s=await reconcile(identity,await store.get(identity.owner));return send(res,200,{project:publicProject(s.projects[m[1]])});}
     if(req.method==='POST'&&pathname==='/v2/remove-ads/checkout')return send(res,200,await removeAds(identity,s));
     if(req.method==='POST'&&pathname==='/v2/billing/portal'){const x=await portal(identity,s);return send(res,200,{url:x.url});}
     throw new CloudError('not_found',404);
   }catch(e){if(!res.headersSent)send(res,e instanceof CloudError?e.status:503,{error:e instanceof CloudError?e.code:'service_unavailable'});else res.destroy();}
 });
 server.requestTimeout=60000;server.headersTimeout=10000;server.maxHeadersCount=30;
 return {server,store,async listen(port=0){await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok)});return 'http://127.0.0.1:'+server.address().port;},async close(){await new Promise(r=>server.close(r));}};
}
if(require.main===module){
 const Stripe=require('stripe');
 const secret=process.env.STRIPE_SECRET_KEY||'';
 const stripe=/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(secret)?new Stripe(secret,{apiVersion:'2026-09-30.endive',maxNetworkRetries:2,timeout:25000}):null;
 createControl({issuer:process.env.REDXAI_ISSUER||'https://red-xai.com',redxURL:process.env.REDX_URL,redxKey:process.env.REDX_RECEIVERS_KEY,
   redxDB:process.env.REDX_RECEIVERS_DB||'gendragoon_receivers',redxLocal:process.env.REDX_LOCAL_LOOPBACK==='1',
   publicBase:process.env.GENDRAGOON_PUBLIC_BASE||'https://api.red-xai.com/gendragoon',stripe}).then(async c=>{await c.listen(Number(process.env.GENDRAGOON_CONTROL_PORT||17778));});
}
module.exports={createControl,PROJECT_FEE_CENTS,FREE_BYTES,OWNER_EMAIL,pricing:()=>({STORAGE,PERFORMANCE})};
