"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),crypto=require('crypto');
const {registerBillingV2}=require('./billing_v2');
const hash=x=>crypto.createHash('sha256').update('gd-v1:'+x).digest('hex');
function setup(){
 const uid='test-ads-owner',owner=hash(uid),store=new Map([['gd_accounts/'+owner,{stripeCustomerId:'cus_qa'}]]);
 function doc(path){return {get:async()=>({exists:store.has(path),data:()=>store.get(path)}),set:async(data,options)=>store.set(path,{...(options?.merge?store.get(path):{}),...data}),collection:name=>collection(path+'/'+name)};}
 function collection(path){return {doc:id=>doc(path+'/'+id)};}
 const db={collection,runTransaction:async fn=>fn({get:r=>r.get(),set:(r,v,o)=>r.set(v,o)})};
 const session={id:'cs_test_qa',mode:'payment',payment_status:'paid',customer:'cus_qa',payment_intent:'pi_testqa',metadata:{kind:'remove_ads',uid,accountHash:owner}};
 const charge={id:'ch_qa',refunded:false,disputed:false,amount_captured:499,amount_refunded:0};
 const intent={id:'pi_testqa',status:'succeeded',customer:'cus_qa',currency:'usd',amount_received:499,latest_charge:charge};
 const line={price:{id:'price_adsqa'},quantity:1};
 const stripe={checkout:{sessions:{listLineItems:async()=>({data:[line]})}},paymentIntents:{retrieve:async()=>intent},charges:{retrieve:async()=>charge}};
 const billing=registerBillingV2({app:express(),db,stripe,admin:{firestore:{FieldValue:{serverTimestamp:()=>new Date()}}},auth:(_q,_r,n)=>n(),agreed:(_q,_r,n)=>n(),hash,prices:{'one_time|remove_ads':'price_adsqa'}});
 return {uid,store,session,charge,intent,line,billing};
}
test('verified one-time payment grants account-wide ad-free access',async()=>{const f=setup();assert.equal(await f.billing.reconcileAds(f.session),true);assert.equal(f.store.get('ad_purchases/'+f.uid).active,true);assert.equal(f.store.get('ad_purchases/'+f.uid).stripePaymentIntentId,'pi_testqa');});
test('refunded, disputed and incomplete payments cannot grant ad-free access',async()=>{
 for(const change of [{refunded:true},{disputed:true},{amount_refunded:499}]){const f=setup();Object.assign(f.charge,change);assert.equal(await f.billing.reconcileAds(f.session),false);assert.equal(f.store.has('ad_purchases/'+f.uid),false);}
 const f=setup();f.intent.status='requires_payment_method';assert.equal(await f.billing.reconcileAds(f.session),false);
});
test('delayed checkout event cannot undo a recorded refund revocation',async()=>{const f=setup();f.store.set('ad_purchases/'+f.uid,{active:false,stripePaymentIntentId:'pi_testqa',revokedAt:new Date()});assert.equal(await f.billing.reconcileAds(f.session),false);assert.equal(f.store.get('ad_purchases/'+f.uid).active,false);});
test('ad-free fulfillment rejects customer mismatch and non-unit quantity',async()=>{const f=setup();f.intent.customer='cus_other';assert.equal(await f.billing.reconcileAds(f.session),false);f.intent.customer='cus_qa';f.line.quantity=2;assert.equal(await f.billing.reconcileAds(f.session),false);});
test('a genuinely new paid purchase can restore ad-free after an earlier refund',async()=>{const f=setup();f.store.set('ad_purchases/'+f.uid,{active:false,stripePaymentIntentId:'pi_old',revokedAt:new Date()});assert.equal(await f.billing.reconcileAds(f.session),true);assert.equal(f.store.get('ad_purchases/'+f.uid).active,true);});
