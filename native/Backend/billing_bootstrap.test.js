"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {expectedCatalog,validateCatalog,projectCheckoutReady,validateUnpaidCheckoutTemplates,crc32c,installBillingBootstrap}=require('./billing_bootstrap');
const {STRIPE_API_VERSION}=require('./billing_gateway');
function data(){const product={id:'prod_gd',active:true};const prices=Object.entries(expectedCatalog()).map(([key,w],i)=>({id:'price_gd'+i,active:true,livemode:true,currency:'usd',unit_amount:w.cents,product:product.id,type:w.interval?'recurring':'one_time',recurring:w.interval?{interval:w.interval,interval_count:1}:null,metadata:{service:'GenDragoonSSD',catalogKey:key},lookup_key:'gdssd_'+key.split('|').join('_')+'_v1'}));return {prices,products:[product]};}
test('bootstrap validates all 55 existing price entries without inventing prices',()=>{const d=data(),catalog=validateCatalog(d.prices,d.products);assert.equal(Object.keys(catalog).length,55);assert.equal(expectedCatalog()['workspace|month'].cents,500);assert.equal(expectedCatalog()['one_time|remove_ads'].cents,499);});
test('bootstrap refuses archived products, missing prices, wrong intervals, duplicate and test prices',()=>{
 for(const mutate of [d=>d.products[0].active=false,d=>d.prices.pop(),d=>d.prices[0].unit_amount++,d=>d.prices[0].recurring.interval='week',d=>d.prices.push({...d.prices[0],id:'price_duplicate'}),d=>d.prices[0].livemode=false]){const d=data();mutate(d);assert.throws(()=>validateCatalog(d.prices,d.products));}
});
test('legacy monthly workspace price matches its existing lookup key',()=>{const d=data(),p=d.prices.find(p=>p.metadata.catalogKey==='workspace|month');delete p.metadata.catalogKey;assert.equal(Object.keys(validateCatalog(d.prices,d.products)).length,55);});
test('the optional project Price is distinct, one-time and exact; legacy55 prices remain required',()=>{
 const d=data(),project={id:'price_project',active:true,livemode:true,currency:'usd',unit_amount:500,type:'one_time',recurring:null,
  billing_scheme:'per_unit',product:d.products[0].id,metadata:{service:'GenDragoonSSD',catalogKey:'one_time|project_creation'}};
 assert.equal(Object.keys(validateCatalog([...d.prices,project],d.products)).length,56);
 for(const patch of [{type:'recurring',recurring:{interval:'month'}},{unit_amount:499},{livemode:false},{billing_scheme:'tiered'}])
  assert.throws(()=>validateCatalog([...d.prices,{...project,...patch}],d.products),/CATALOG_VALUE/);
 assert.throws(()=>validateCatalog(d.prices,d.products,{projectPriceId:'price_missing'}),/CATALOG_COUNT/);
 assert.throws(()=>validateCatalog([...d.prices.slice(1),project],d.products),/CATALOG_COUNT/);
});
test('project Checkout remains disabled until signed completion, asynchronous outcomes and revocation events are subscribed',()=>{
 const catalog={'one_time|project_creation':'price_project'},events=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','charge.refunded','charge.dispute.created'];
 assert.equal(projectCheckoutReady(catalog,{enabled_events:events}),true);assert.equal(projectCheckoutReady(catalog,{enabled_events:['*']}),true);
 assert.equal(projectCheckoutReady({}, {enabled_events:events}),false);
 for(let i=0;i<events.length;i++)assert.equal(projectCheckoutReady(catalog,{enabled_events:events.filter((_,index)=>index!==i)}),false);
});
test('the pinned current Stripe SDK and runtime API target match',()=>{
 const Stripe=require('stripe');assert.equal(Stripe.PACKAGE_VERSION,'23.0.0');assert.equal(STRIPE_API_VERSION,'2026-09-30.endive');assert.equal(Stripe.API_VERSION,STRIPE_API_VERSION);
});
test('unpaid bootstrap optionally validates the exact500-cent project template and expires it even on verification failure',async()=>{
 const d=data(),legacy=validateCatalog(d.prices,d.products);
 for(const {project,wrongAmount}of [{project:false},{project:true},{project:true,wrongAmount:true}]){
  const catalog={...legacy,...(project?{'one_time|project_creation':'price_project'}:{})},created=[],expired=[];
  const expected={...expectedCatalog(),'one_time|project_creation':{cents:500}},amounts=new Map(Object.entries(catalog).map(([key,id])=>[id,expected[key].cents]));
  const stripe={checkout:{sessions:{create:async args=>{
   const id='cs_validation'+created.length;created.push({id,args});
   const isProject=args.line_items[0].price==='price_project';
   return {id,livemode:true,status:'open',url:'https://checkout.stripe.com/c/pay/'+id,
    amount_total:wrongAmount&&isProject?501:args.line_items.reduce((sum,line)=>sum+amounts.get(line.price)*line.quantity,0)};
  },expire:async id=>{expired.push(id);}}}};
  if(wrongAmount)await assert.rejects(validateUnpaidCheckoutTemplates(stripe,catalog),/CHECKOUT_VALIDATION/);
  else assert.equal(await validateUnpaidCheckoutTemplates(stripe,catalog),project?4:3);
  assert.deepEqual(expired,created.map(item=>item.id));
  for(const {args}of created)assert.deepEqual(args.metadata,{service:'GenDragoonSSD',purpose:'unpaid_setup_validation'});
  if(project){const args=created.at(-1).args;assert.equal(args.mode,'payment');assert.deepEqual(args.line_items,[{price:'price_project',quantity:1}]);assert.equal(args.customer,undefined);}
 }
});
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
