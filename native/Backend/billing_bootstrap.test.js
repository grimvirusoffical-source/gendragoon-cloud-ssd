"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {expectedCatalog,validateCatalog,crc32c,installBillingBootstrap}=require('./billing_bootstrap');
function data(){const product={id:'prod_gd',active:true};const prices=Object.entries(expectedCatalog()).map(([key,w],i)=>({id:'price_gd'+i,active:true,livemode:true,currency:'usd',unit_amount:w.cents,product:product.id,type:w.interval?'recurring':'one_time',recurring:w.interval?{interval:w.interval,interval_count:1}:null,metadata:{service:'GenDragoonSSD',catalogKey:key},lookup_key:'gdssd_'+key.split('|').join('_')+'_v1'}));return {prices,products:[product]};}
test('bootstrap validates all 55 existing price entries without inventing prices',()=>{const d=data(),catalog=validateCatalog(d.prices,d.products);assert.equal(Object.keys(catalog).length,55);assert.equal(expectedCatalog()['workspace|month'].cents,500);assert.equal(expectedCatalog()['one_time|remove_ads'].cents,499);});
test('bootstrap refuses archived products, missing prices, wrong intervals, duplicate and test prices',()=>{
 for(const mutate of [d=>d.products[0].active=false,d=>d.prices.pop(),d=>d.prices[0].unit_amount++,d=>d.prices[0].recurring.interval='week',d=>d.prices.push({...d.prices[0],id:'price_duplicate'}),d=>d.prices[0].livemode=false]){const d=data();mutate(d);assert.throws(()=>validateCatalog(d.prices,d.products));}
});
test('legacy monthly workspace price matches its existing lookup key',()=>{const d=data(),p=d.prices.find(p=>p.metadata.catalogKey==='workspace|month');delete p.metadata.catalogKey;assert.equal(Object.keys(validateCatalog(d.prices,d.products)).length,55);});
test('vault payload integrity uses the expected CRC32C checksum',()=>assert.equal(crc32c(Buffer.from('123456789')),0xe3069283));
test('missing owner-supplied vault values leave purchases locked and never expose secrets',async()=>{
 const app=express();let calls=0;
 const setup=installBillingBootstrap({app,env:{STRIPE_VAULT_BOOTSTRAP:'live'},db:{collection:()=>({})},admin:{firestore:{FieldValue:{serverTimestamp:()=>null}}},firebaseAuth:(_req,res)=>res.status(401).end(),accountKey:x=>x,
  readVaultSecrets:async()=>{calls++;throw Object.assign(Error('SECRET_VALUES_REQUIRED'),{missing:['gendragoon-stripe-live-api']});}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const root='http://127.0.0.1:'+server.address().port;
  for(let i=0;i<2;i++){const r=await fetch(root+'/v2/billing/status'),s=await r.json();assert.equal(r.status,200);assert.equal(s.checkoutEnabled,false);assert.equal(s.activationState,'waiting_for_secrets');}
  assert.equal(calls,1);assert.equal(setup.state().activated,false);
 }finally{await new Promise(r=>server.close(r));}
});
test('vault permission errors are sanitized rather than exposing request credentials',async()=>{
 const app=express();const setup=installBillingBootstrap({app,env:{STRIPE_VAULT_BOOTSTRAP:'live'},db:{collection:()=>({})},admin:{firestore:{FieldValue:{serverTimestamp:()=>null}}},firebaseAuth:(_req,res)=>res.status(401).end(),accountKey:x=>x,
  readVaultSecrets:async()=>{throw Error('Authorization Bearer confidential payload');}});
 await setup.attempt();const state=setup.state();assert.equal(state.activated,false);assert.equal(state.setupError,'STRIPE_SETUP_FAILED');assert.ok(!JSON.stringify(state).includes('confidential'));
});
