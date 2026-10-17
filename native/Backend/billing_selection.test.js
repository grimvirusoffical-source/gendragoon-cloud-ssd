'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const crypto = require('node:crypto');
const {registerBillingV2, storageQuote, performanceQuote} = require('./billing_v2');

async function fixture(t, workspace = null, previous = null) {
 const owner = crypto.createHash('sha256').update('test-account').digest('hex');
 const id = '2d14db29-fd27-428c-bf5d-a36f9486e921';
 const rows = new Map([[`gd_accounts/${owner}`, {stripeCustomerId:'cus_own', uid:'test-account'}]]);
 if(workspace) rows.set(`gd_accounts/${owner}/workspaces/${id}`, {accountHash:owner,kind:'paid',storageActive:true,provisioned:true,...workspace});
 function doc(path) { return { get:async()=>({exists:rows.has(path),data:()=>rows.get(path)}),
   create:async value=>{if(rows.has(path))throw Object.assign(Error('exists'),{code:6});rows.set(path,value)},
   set:async(value)=>rows.set(path,{...rows.get(path),...value}),
   update:async(value)=>rows.set(path,{...rows.get(path),...value}),
   collection:name=>collection(path+'/'+name) }; }
 function collection(path) {return {doc:id=>doc(path+'/'+id)};}
 const sessions = new Map(previous ? [['cs_old',previous]] : []), created=[], expired=[];
 const stripe={customers:{create:async()=>({id:'cus_own'})},checkout:{sessions:{
   retrieve:async id=>{if(!sessions.has(id))throw Error('unknown checkout');return sessions.get(id)},
   expire:async id=>{expired.push(id);sessions.get(id).status='expired'},
   create:async(args,options)=>{created.push({args,options});const id='cs_new'+created.length;
     const session={id,status:'open',url:'https://checkout.stripe.com/c/pay/'+id};sessions.set(id,session);return session}
 }}};
 const app=express();app.use(express.json());
 registerBillingV2({app,db:{collection},stripe,admin:{firestore:{FieldValue:{serverTimestamp:()=>123}}},
   auth:(req,res,next)=>{req.user={uid:'test-account'};next()},agreed:(_req,_res,next)=>next(),hash:()=>owner,
   env:{STRIPE_CHECKOUT_ENABLED:'true',PUBLIC_URL:'https://billing.example'},
   prices:{'workspace|month':'price_fee','storage|standard|100GB|month':'price_storage',
     'performance|boost|month':'price_boost','performance|max|year':'price_maxyear'}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const post=async(path,payload)=>{const response=await fetch('http://127.0.0.1:'+server.address().port+path,
   {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
   return {status:response.status,body:await response.json()};};
 return {post,created,expired,rows,id,owner,record:()=>rows.get(`gd_accounts/${owner}/workspaces/${id}`)};
}
const selection={name:'Selected workspace',tier:'100GB',interval:'month',mode:'standard',intentId:'2d14db29-fd27-428c-bf5d-a36f9486e921'};
test('plan lookup rejects prototype names, arrays and unknown billing modes',()=>{
 for(const tier of ['__proto__','constructor','toString',['100GB'],null]) assert.throws(()=>storageQuote(tier,'month'));
 for(const tier of ['__proto__','constructor','toString',['boost'],null]) assert.throws(()=>performanceQuote(tier,'month'));
 assert.throws(()=>storageQuote('100GB','month','unknown'));
});
test('retrying a selected checkout intent reuses exactly the same workspace without a charge',async t=>{
 const f=await fixture(t);
 const first=await f.post('/v2/workspaces/draft',selection);
 const retry=await f.post('/v2/workspaces/draft',selection);
 assert.equal(first.status,201);assert.equal(retry.status,200);
 assert.equal(first.body.workspaceId,retry.body.workspaceId);assert.equal(retry.body.resumed,true);
 assert.equal(f.rows.size,2);assert.equal(f.created.length,0);
 const changed=await f.post('/v2/workspaces/draft',{...selection,tier:'6TB'});
 assert.equal(changed.status,409);assert.equal(f.record().storageTier,'100GB');
});
test('invalid selections cannot silently become the standard tier or create workspaces',async t=>{
 const f=await fixture(t);
 for(const body of [{...selection,mode:'unrecognized'},{...selection,tier:'__proto__'},
   {...selection,intentId:'../../another-user'},{...selection,intentId:42}]) {
   assert.equal((await f.post('/v2/workspaces/draft',body)).status,400);
 }
 assert.equal(f.rows.size,1);
});
test('storage checkout ignores client-supplied amounts and prices',async t=>{
 const f=await fixture(t);
 await f.post('/v2/workspaces/draft',selection);
 const result=await f.post('/v2/workspaces/'+f.id+'/checkout/storage',{price:'price_attacker',amount:1,ownerBenefits:true});
 assert.equal(result.status,200);assert.deepEqual(f.created[0].args.line_items,[{price:'price_fee',quantity:1},{price:'price_storage',quantity:1}]);
 assert.equal(f.record().storageActive,false);assert.equal(result.body.quote.totalCents,1140);
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
