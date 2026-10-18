'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const crypto = require('node:crypto');
const {registerBillingV2, storageQuote, performanceQuote} = require('./billing_v2');
const {memoryFirestore} = require('./test_firestore');

async function fixture(t, workspace = null, previous = null) {
 const owner = crypto.createHash('sha256').update('test-account').digest('hex');
 const id = '2d14db29-fd27-428c-bf5d-a36f9486e921';
 const rows = new Map([[`gd_accounts/${owner}`, {stripeCustomerId:'cus_own', uid:'test-account'}]]);
 if(workspace) rows.set(`gd_accounts/${owner}/workspaces/${id}`, {accountHash:owner,kind:'paid',storageActive:true,storageTier:'100GB',provisioned:true,...workspace});
 const db=memoryFirestore([...rows]);
 const sessions = new Map(previous ? [['cs_old',previous]] : []), created=[], expired=[];
 const stripe={customers:{create:async()=>({id:'cus_own'})},checkout:{sessions:{
   retrieve:async id=>{if(!sessions.has(id))throw Error('unknown checkout');return sessions.get(id)},
   expire:async id=>{expired.push(id);sessions.get(id).status='expired'},
   create:async(args,options)=>{created.push({args,options});const id='cs_new'+created.length;
     const session={id,status:'open',url:'https://checkout.stripe.com/c/pay/'+id};sessions.set(id,session);return session}
 }}};
 const app=express();app.use(express.json());
 const billing=registerBillingV2({app,db,stripe,admin:{firestore:{FieldValue:{serverTimestamp:()=>123}}},
   auth:(req,res,next)=>{req.user={uid:'test-account'};next()},agreed:(_req,_res,next)=>next(),hash:()=>owner,
   env:{STRIPE_CHECKOUT_ENABLED:'true',PUBLIC_URL:'https://billing.example'},
   prices:{'workspace|month':'price_fee','storage|standard|100GB|month':'price_storage',
     'performance|boost|month':'price_boost','performance|max|year':'price_maxyear'}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const post=async(path,payload)=>{const response=await fetch('http://127.0.0.1:'+server.address().port+path,
   {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
   return {status:response.status,body:await response.json()};};
 return {post,created,expired,rows:db.rows,id,owner,billing,record:()=>db.rows.get(`gd_accounts/${owner}/workspaces/${id}`)};
}
const selection={name:'Selected workspace',tier:'100GB',interval:'month',mode:'standard',intentId:'2d14db29-fd27-428c-bf5d-a36f9486e921'};
test('plan lookup rejects prototype names, arrays and unknown billing modes',()=>{
 for(const tier of ['__proto__','constructor','toString',['100GB'],null]) assert.throws(()=>storageQuote(tier,'month'));
 for(const tier of ['__proto__','constructor','toString',['boost'],null]) assert.throws(()=>performanceQuote(tier,'month'));
 assert.throws(()=>storageQuote('100GB','month','unknown'));
});
test('an exactly matching legacy draft resumes without writes or charges and keeps its original quote',async t=>{
 const f=await fixture(t,{name:selection.name,storageActive:false,provisioned:false,storageInterval:'month',storageMode:'standard'});
 const before=structuredClone(f.rows);
 const first=await f.post('/v2/workspaces/draft',selection);
 const retry=await f.post('/v2/workspaces/draft',selection);
 assert.equal(first.status,200);assert.equal(retry.status,200);
 assert.equal(first.body.workspaceId,retry.body.workspaceId);assert.equal(retry.body.resumed,true);
 assert.equal(first.body.quote.workspaceFeeCents,500);assert.equal(first.body.quote.totalCents,1140);
 assert.deepEqual(f.rows,before);assert.equal(f.created.length,0);
 const changed=await f.post('/v2/workspaces/draft',{...selection,tier:'6TB'});
 assert.equal(changed.status,409);assert.equal(changed.body.code,'INTENT_CONFLICT');assert.deepEqual(f.rows,before);
});
test('an existing annual BYO draft replays its original contract without migration or a project fee',async t=>{
 const f=await fixture(t,{name:selection.name,kind:'byo',storageTier:null,storageMode:null,storageInterval:'year',storageActive:false,provisioned:false});
 const before=structuredClone(f.rows),result=await f.post('/v2/workspaces/draft',{name:selection.name,mode:'byo',interval:'year',intentId:selection.intentId});
 assert.equal(result.status,200);assert.equal(result.body.resumed,true);assert.equal(result.body.quote.totalCents,5000);
 assert.equal(result.body.oneTimeProjectCents,0);assert.deepEqual(f.rows,before);assert.equal(f.created.length,0);
});
test('unknown legacy creation intents receive an update requirement before any workspace write or Checkout',async t=>{
 const f=await fixture(t),before=structuredClone(f.rows);
 for(const body of [selection,{...selection,intentId:undefined},{name:selection.name,mode:'byo',interval:'year',intentId:selection.intentId}]){
   const result=await f.post('/v2/workspaces/draft',body);assert.equal(result.status,426);
   assert.equal(result.body.code,'CLIENT_UPDATE_REQUIRED');assert.match(result.body.error,/Update GenDragoon.*\$5 once/);
   assert.equal(result.body.workspaceId,undefined);assert.equal(result.body.url,undefined);
 }
 assert.deepEqual(f.rows,before);assert.equal(f.created.length,0);assert.equal(f.expired.length,0);
});
test('invalid selections cannot silently become the standard tier or create workspaces',async t=>{
 const f=await fixture(t);
 for(const body of [{...selection,mode:'unrecognized'},{...selection,tier:'__proto__'},
   {...selection,intentId:'../../another-user'},{...selection,intentId:42}]) {
   assert.equal((await f.post('/v2/workspaces/draft',body)).status,400);
 }
 assert.equal(f.rows.size,1);
});
test('new storage checkout ignores client-supplied amounts and prices and excludes the old recurring workspace fee',async t=>{
 const f=await fixture(t);
 await f.post('/v2/projects',{name:selection.name,intentId:selection.intentId});
 const result=await f.post('/v2/workspaces/'+f.id+'/checkout/storage',{tier:'100GB',mode:'standard',interval:'month',price:'price_attacker',amount:1,ownerBenefits:true});
 assert.equal(result.status,200);assert.deepEqual(f.created[0].args.line_items,[{price:'price_storage',quantity:1}]);
 assert.equal(f.record().storageActive,false);assert.equal(result.body.quote.totalCents,640);
});
test('legacy storage contracts keep their existing price items and annual/monthly terms',async t=>{
 const f=await fixture(t,{storageActive:false,provisioned:false,storageInterval:'month',storageMode:'standard'});
 const result=await f.post('/v2/workspaces/'+f.id+'/checkout/storage',{});
 assert.equal(result.status,200);assert.deepEqual(f.created[0].args.line_items,[{price:'price_fee',quantity:1},{price:'price_storage',quantity:1}]);
 assert.equal(result.body.quote.totalCents,1140);
});
test('selected storage remains an intention until an exact server-verified subscription reconciles',async t=>{
 const f=await fixture(t);await f.post('/v2/projects',{name:selection.name,intentId:selection.intentId});
 await f.post('/v2/workspaces/'+f.id+'/checkout/storage',{tier:'100GB',mode:'standard',interval:'month'});
 assert.equal(f.record().storageTier,null);assert.equal(f.record().storageActive,false);
 const sub={id:'sub_selected',customer:'cus_own',status:'active',metadata:{kind:'storage',accountHash:f.owner,workspaceId:f.id},items:{data:[{price:{id:'price_storage'},quantity:1}]}};
 assert.equal(await f.billing.reconcileSubscription(sub),true);
 assert.equal(f.record().storageTier,'100GB');assert.equal(f.record().storageActive,true);assert.equal(f.record().storageBillingVersion,2);
 await f.billing.reconcileSubscription({...sub,status:'canceled'});assert.equal(f.record().storageActive,false);assert.equal(f.record().provisioned,true);
});
test('changing performance selection expires an old unpaid checkout and uses the newly selected exact price',async t=>{
 const f=await fixture(t,{performanceCheckoutSessionId:'cs_old',pendingPerformanceTier:'boost',pendingPerformanceInterval:'month'},
   {id:'cs_old',status:'open',url:'https://checkout.stripe.com/c/pay/old'});
 const path='/v2/workspaces/'+f.id+'/checkout/performance';
 const result=await f.post(path,{tier:'max',interval:'year'});
 assert.equal(result.status,200);assert.deepEqual(f.expired,['cs_old']);
 assert.deepEqual(f.created[0].args.line_items,[{price:'price_maxyear',quantity:1}]);
 assert.equal(result.body.quote.totalCents,19000);assert.equal(f.record().pendingPerformanceTier,'max');
 const repeated=await f.post(path,{tier:'max',interval:'year'});
 assert.equal(repeated.body.resumed,true);assert.equal(f.created.length,1);
});
test('a completed performance checkout must reconcile before selecting a different plan',async t=>{
 const f=await fixture(t,{performanceCheckoutSessionId:'cs_old',pendingPerformanceTier:'boost',pendingPerformanceInterval:'month'},
   {id:'cs_old',status:'complete'});
 const result=await f.post('/v2/workspaces/'+f.id+'/checkout/performance',{tier:'max',interval:'year'});
 assert.equal(result.status,409);assert.equal(f.created.length,0);assert.equal(f.expired.length,0);
});
