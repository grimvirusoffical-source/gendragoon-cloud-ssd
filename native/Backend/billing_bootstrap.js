"use strict";
// The account owner adds credentials directly in Google Secret Manager.
// This server reads those two resources with its own scoped identity; no key enters a client or chat.
const express=require('express'),crypto=require('node:crypto');
const {GoogleAuth}=require('google-auth-library'),Stripe=require('stripe');
const {installedBilling,STRIPE_API_VERSION}=require('./billing_gateway'),{STORAGE,PERFORMANCE}=require('./catalog');
const PROJECT='gendragood-ssd',ACCOUNT='acct_1TqS8eIpkwStQhHM';
const API_SECRET='gendragoon-stripe-live-api',HOOK_SECRET='gendragoon-stripe-live-webhook';
const HOOK_ID='we_1UQgwBIpkwStQhHM7YZVubdd';
const PUBLIC='https://gendragoon-free-10068843866.us-central1.run.app';
function expectedCatalog(){
 const out={};for(const interval of ['month','year']){const factor=interval==='year'?10:1;
   // Legacy (retired) $5 fee prices: validated only so in-flight records keep reconciling.
  out['workspace|'+interval]={cents:500*factor,interval};out['byo|'+interval]={cents:500*factor,interval};
  for(const [tier,plan]of Object.entries(STORAGE))for(const mode of ['standard','bundle'])out['storage|'+mode+'|'+tier+'|'+interval]={cents:plan[mode]*factor,interval};
  for(const [tier,plan]of Object.entries(PERFORMANCE))out['performance|'+tier+'|'+interval]={cents:plan.cents*factor,interval};
 }
 out['one_time|remove_ads']={cents:499,interval:null};return out;
}
function validateCatalog(prices,products,{projectPriceId}={}){
 const out={},productMap=new Map(products.map(p=>[p.id,p]));
 for(const [key,expected]of Object.entries(expectedCatalog())){
  const lookup='gdssd_'+key.split('|').join('_')+'_v1';
  const matches=prices.filter(p=>p.metadata?.service==='GenDragoonSSD'&&(p.metadata.catalogKey===key||p.lookup_key===lookup));
  if(matches.length!==1)throw Error('CATALOG_COUNT:'+key);
  const p=matches[0],product=productMap.get(typeof p.product==='string'?p.product:p.product?.id);
  if(!p.active||!p.livemode||p.currency!=='usd'||p.unit_amount!==expected.cents||product?.active!==true)throw Error('CATALOG_VALUE:'+key);
  if(expected.interval?!(p.recurring?.interval===expected.interval&&p.recurring.interval_count===1):p.type!=='one_time')throw Error('CATALOG_INTERVAL:'+key);
  if(!/^price_[A-Za-z0-9]+$/.test(p.id))throw Error('CATALOG_ID:'+key);
  out[key]=p.id;
 }
 // Add the new one-time project Price only when explicitly configured or
 // uniquely tagged. Missing configuration must not break legacy subscriptions.
 const projectMatches=prices.filter(p=>projectPriceId?p.id===projectPriceId:
   p.metadata?.service==='GenDragoonSSD'&&(p.metadata.catalogKey==='one_time|project_creation'||p.lookup_key==='gdssd_one_time_project_creation_v2'));
 if(projectPriceId||projectMatches.length){
   if(projectMatches.length!==1)throw Error('CATALOG_COUNT:one_time|project_creation');
   const p=projectMatches[0],product=productMap.get(typeof p.product==='string'?p.product:p.product?.id);
   if(!p.active||!p.livemode||p.type!=='one_time'||p.recurring||p.currency!=='usd'||p.unit_amount!==500||
      p.billing_scheme!=='per_unit'||product?.active!==true||!/^price_[A-Za-z0-9]+$/.test(p.id))throw Error('CATALOG_VALUE:one_time|project_creation');
   out['one_time|project_creation']=p.id;
 }
 return out;
}
function projectCheckoutReady(catalog,hook){
 return !!catalog['one_time|project_creation']&&
   (hook.enabled_events?.includes('*')===true||['checkout.session.completed','checkout.session.async_payment_succeeded',
     'checkout.session.async_payment_failed','charge.refunded','charge.dispute.created'].every(name=>hook.enabled_events?.includes(name)));
}
async function validateUnpaidCheckoutTemplates(stripe,catalog){
 const expected={...expectedCatalog(),'one_time|project_creation':{cents:500}};
 // Workspace plans: storage + performance on one subscription (no workspace fee),
 // and custom storage with a performance plan only. The legacy workspace|/byo|
 // prices stay in expectedCatalog() so in-flight legacy subscriptions still reconcile.
 const scenarios=[['one_time|remove_ads'],['storage|standard|100GB|month','performance|boost|month'],
  ['storage|standard|1TB|year','performance|turbo|year'],['performance|lite|month']];
 for(const keys of scenarios){
  const session=await stripe.checkout.sessions.create({mode:keys[0].startsWith('one_time')?'payment':'subscription',
   line_items:keys.map(key=>({price:catalog[key],quantity:1})),success_url:PUBLIC+'/billing/success',cancel_url:PUBLIC+'/billing/cancel',
   metadata:{service:'GenDragoonSSD',purpose:'unpaid_setup_validation'}});
  try{
   if(!session.livemode||session.status!=='open'||new URL(session.url).hostname!=='checkout.stripe.com'||
      session.amount_total!==keys.reduce((n,key)=>n+expected[key].cents,0))throw Error('CHECKOUT_VALIDATION');
  }finally{await stripe.checkout.sessions.expire(session.id);}
 }
 return scenarios.length;
}
function crc32c(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0x82f63b78:0);}return (value^0xffffffff)>>>0;}
async function readVaultSecrets(){
 const auth=await new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']}).getClient();
 const result={},missing=[];
 for(const name of [API_SECRET,HOOK_SECRET]){
  try{
   const response=await auth.request({url:'https://secretmanager.googleapis.com/v1/projects/'+PROJECT+'/secrets/'+name+'/versions/latest:access',timeout:15000});
   const payload=response.data.payload||{},bytes=Buffer.from(payload.data||'','base64');
   if(!bytes.length||(payload.dataCrc32c!==undefined&&String(crc32c(bytes))!==String(payload.dataCrc32c)))throw Error('SECRET_INTEGRITY');
   result[name]=bytes.toString('utf8').trim();
  }catch(error){
   if([404,400].includes(error.response?.status)){missing.push(name);continue;}
   throw Error('VAULT_ACCESS:'+String(error.response?.status||error.code||'failed'));
  }
 }
 if(missing.length)throw Object.assign(Error('SECRET_VALUES_REQUIRED'),{missing});
 return {key:result[API_SECRET],webhook:result[HOOK_SECRET]};
}
function installBillingBootstrap(options){
 const env=options.env||process.env;
 if(env.STRIPE_VAULT_BOOTSTRAP!=='live')return installedBilling(options);
 const buildRouter=config=>{
  const router=express.Router();installedBilling({...options,app:router,env:config});return router;
 };
 let router=buildRouter({...env,STRIPE_CHECKOUT_ENABLED:'false',STRIPE_SECRET_KEY:'',STRIPE_WEBHOOK_SECRET:''});
 let activated=false,inFlight=null,retryAt=0;
 let setup={activationState:'waiting_for_secrets',pendingSecretResources:[API_SECRET,HOOK_SECRET]};
 async function activate(){
  const secrets=await (options.readVaultSecrets||readVaultSecrets)();
  if(!/^(sk|rk)_live_[A-Za-z0-9]+$/.test(secrets.key)||!/^whsec_[A-Za-z0-9]+$/.test(secrets.webhook))throw Error('INVALID_LIVE_CREDENTIAL_FORMAT');
  setup={activationState:'validating_live_stripe',pendingSecretResources:[]};
  const stripe=options.createStripe?options.createStripe(secrets.key):new Stripe(secrets.key,{apiVersion:STRIPE_API_VERSION,maxNetworkRetries:2,timeout:25000});
  const account=await stripe.accounts.retrieve();
  if(account.id!==ACCOUNT||account.charges_enabled!==true)throw Error('ACCOUNT_NOT_READY');
  const [prices,products,hook]=await Promise.all([
   stripe.prices.list({limit:100,active:true}).autoPagingToArray({limit:1000}),
   stripe.products.list({limit:100}).autoPagingToArray({limit:1000}),stripe.webhookEndpoints.retrieve(HOOK_ID)
  ]);
  const catalog=validateCatalog(prices,products,{projectPriceId:env.STRIPE_PROJECT_CREATION_PRICE_ID});
  if(!hook.livemode||hook.status!=='enabled'||hook.url!==PUBLIC+'/billing/stripe-webhook')throw Error('WEBHOOK_CONFIGURATION');
  await Promise.all([stripe.subscriptions.list({limit:1}),stripe.paymentIntents.list({limit:1}),stripe.charges.list({limit:1})]);
  const configurations=await stripe.billingPortal.configurations.list({limit:100});
  let portal=configurations.data.find(x=>x.active&&x.metadata?.service==='GenDragoonSSD');
  if(!portal)portal=await stripe.billingPortal.configurations.create({
   business_profile:{headline:'Manage your GenDragoon Cloud SSD subscription'},
   features:{invoice_history:{enabled:true},payment_method_update:{enabled:true},subscription_cancel:{enabled:true,mode:'at_period_end'},customer_update:{enabled:true,allowed_updates:['email']}},
   default_return_url:PUBLIC+'/mobile/',metadata:{service:'GenDragoonSSD'}
  });
  const hash=crypto.createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
  const checkRef=options.db.collection('system').doc('stripe-live-checkout-verification'),prior=await checkRef.get();
  if(!prior.exists||prior.data().catalogHash!==hash){
   await validateUnpaidCheckoutTemplates(stripe,catalog);
   await checkRef.set({catalogHash:hash,checkedAt:options.admin.firestore.FieldValue.serverTimestamp(),paymentSubmitted:false});
  }
  const values={STRIPE_SECRET_KEY:secrets.key,STRIPE_WEBHOOK_SECRET:secrets.webhook,
   STRIPE_ENVIRONMENT:'live',STRIPE_CHECKOUT_ENABLED:'true',PAID_STORAGE_READY:'approved',STRIPE_RUNTIME_PROBE:'true',
   STRIPE_PRICE_CATALOG_JSON:JSON.stringify(catalog),STRIPE_PORTAL_CONFIGURATION_ID:portal.id,PUBLIC_URL:PUBLIC,
   STRIPE_PROJECT_CHECKOUT_READY:projectCheckoutReady(catalog,hook)?'true':'false'};
  const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  try{
   for(const [key,value]of Object.entries(values))process.env[key]=value;
   router=buildRouter({...env,...values});activated=true;setup={activationState:'runtime_readiness_check',pendingSecretResources:[]};
   console.info('GenDragoon LIVE billing configured from vault; runtime readiness controls checkout availability.');
  }catch(error){for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}throw error;}
 }
 async function attempt(){
  if(activated||Date.now()<retryAt)return;
  if(!inFlight)inFlight=activate().catch(error=>{
   // Never log Stripe request objects, headers, responses or key values.
   const allowed=['SECRET_VALUES_REQUIRED','INVALID_LIVE_CREDENTIAL_FORMAT','ACCOUNT_NOT_READY','WEBHOOK_CONFIGURATION','CHECKOUT_VALIDATION'];
   const raw=String(error.message||''),code=allowed.includes(raw)?raw:raw.startsWith('CATALOG_')?'CATALOG_VALIDATION':raw.startsWith('VAULT_ACCESS')?'VAULT_ACCESS':'STRIPE_SETUP_FAILED';
   setup={activationState:code==='SECRET_VALUES_REQUIRED'?'waiting_for_secrets':'setup_error',setupError:code,pendingSecretResources:error.missing||[]};
   if(code!=='SECRET_VALUES_REQUIRED')console.warn('GenDragoon billing setup pending',code,error.statusCode||'');
  }).finally(()=>{retryAt=Date.now()+15000;inFlight=null;});
  await inFlight;
 }
 options.app.use(async(req,res,next)=>{
  if(!activated&&(req.path==='/v2/billing/status'||req.path==='/billing/stripe-webhook'))await attempt();
  if(!activated&&req.method==='GET'&&req.path==='/v2/billing/status')return res.json({
   checkoutEnabled:false,stripeMode:'live',webhookConfigured:false,liveStorageProvisioned:false,runtimeStorageVerified:false,
   availableKinds:['storage','performance','bundle','bring-your-own-cloud','remove-ads'],...setup,
   message:setup.activationState==='waiting_for_secrets'?'Account owner must add the two prepared Stripe secrets in Google Secret Manager. Activation runs automatically after that.':'Stripe setup is being verified; no payment can be taken yet.'
  });
  return router(req,res,next);
 });
 return {attempt,state:()=>({...setup,activated})};
}
module.exports={installBillingBootstrap,expectedCatalog,validateCatalog,projectCheckoutReady,validateUnpaidCheckoutTemplates,crc32c};
