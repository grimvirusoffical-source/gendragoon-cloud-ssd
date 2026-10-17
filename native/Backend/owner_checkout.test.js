'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {registerBillingV2}=require('./billing_v2');
async function fixture(t,owner=true,record={}){
 const data={kind:'paid',accountHash:'account',storageTier:'6TB',storageInterval:'year',storageMode:'bundle',...record};
 const ws={get:async()=>({exists:true,data:()=>data}),update:async p=>Object.assign(data,p)};
 const account={collection:()=>({doc:()=>ws})};
 const db={collection:name=>({doc:()=>name==='gd_accounts'?account:{get:async()=>({exists:false})}})};
 const app=express();app.use(express.json());
 const stripe=new Proxy({},{get(){throw Error('Stripe must not be called for owner');}});
 registerBillingV2({app,db,stripe,admin:{firestore:{FieldValue:{serverTimestamp:()=>123}}},auth:(req,res,next)=>{req.user={uid:'uid'};req.ownerBenefits=owner;next()},agreed:(req,res,next)=>next(),hash:()=> 'account',prices:{}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const request=async(path,body)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()}};
 return {data,request};
}
const path='/v2/workspaces/00000000-0000-4000-9000-000000000000/checkout/';
test('owner storage, performance, and ads activate without a Stripe call',async t=>{
 const f=await fixture(t);let r=await f.request(path+'storage',{});assert.equal(r.status,200);assert.equal(r.body.complimentary,true);assert.equal(r.body.quote.totalCents,0);assert.equal(f.data.provisioned,true);
 for(const tier of ['lite','boost','turbo','ultra','max']){r=await f.request(path+'performance',{tier,interval:'year'});assert.equal(r.status,200);assert.equal(r.body.quote.totalCents,0);assert.equal(f.data.performanceTier,tier);}
 r=await f.request('/v2/account/entitlements');assert.deepEqual(r.body,{adFree:true,ownerBenefits:true});r=await f.request('/v2/remove-ads/checkout',{});assert.equal(r.body.complimentary,true);
});
test('owner BYO still requires configured provider',async t=>{const f=await fixture(t,true,{kind:'byo'});assert.equal((await f.request(path+'byo',{})).status,409);f.data.manualProviderConfigured=true;assert.equal((await f.request(path+'byo',{})).body.complimentary,true);assert.equal(f.data.byoActive,true);});
test('normal account cannot send ownerBenefits to bypass Stripe',async t=>{const f=await fixture(t,false);const r=await f.request(path+'storage',{ownerBenefits:true});assert.equal(r.status,503);assert.notEqual(f.data.storageActive,true);assert.deepEqual((await f.request('/v2/account/entitlements')).body,{adFree:false,ownerBenefits:false});});
