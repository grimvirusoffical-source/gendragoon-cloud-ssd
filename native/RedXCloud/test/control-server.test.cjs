'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createControl}=require('../control-server.cjs');
const {STORAGE,PERFORMANCE}=require('../../Backend/catalog.js');
const priceIds=require('../../Backend/stripe_live_catalog.json').priceIds;
function catalogPrice(id){const key=Object.keys(priceIds).find(k=>priceIds[k]===id),parts=key?.split('|')||[];const interval=parts.at(-1);return {id,active:true,livemode:true,currency:'usd',unit_amount:parts[0]==='storage'?STORAGE[parts[2]][parts[1]]*(interval==='year'?10:1):parts[0]==='performance'?PERFORMANCE[parts[1]].cents*(interval==='year'?10:1):499,...(parts[0]!=='one_time'?{recurring:{interval,interval_count:1}}:{})};}

class MemoryStore{
 constructor(){this.map=new Map()}
 async get(o){return this.map.has(o)?structuredClone(this.map.get(o)):null}
 async ensure(o,seed){if(!this.map.has(o))this.map.set(o,{schema:1,owner:o,revision:0,createdMs:1,stripeCustomerId:null,adFree:false,projects:{},...structuredClone(seed)});return this.get(o)}
 async change(o,fn){const s=await this.get(o);await fn(s);s.revision=(s.revision||0)+1;this.map.set(o,structuredClone(s));return this.get(o)}
}
class ReceiverStore{constructor(workspaces={}){this.workspaces=workspaces}async get(){return {workspaces:this.workspaces}}}
function fakeStripe(){
 let ci=0,si=0,subi=0,inline=0;const sessions=new Map(),subs=new Map(),canceled=[];
 return {
  _sessions:sessions,_subs:subs,_canceled:canceled,
  prices:{retrieve:async id=>catalogPrice(id)},
  customers:{create:async()=>({id:'cus_'+(++ci)})},
  checkout:{sessions:{
   create:async data=>{const id='cs_'+(++si),rows=data.line_items.map(x=>x.price?{price:catalogPrice(x.price),quantity:x.quantity}:{price:{id:'price_inline_'+(++inline),unit_amount:x.price_data.unit_amount,currency:x.price_data.currency,recurring:x.price_data.recurring},quantity:x.quantity});
     const s={id,status:'open',payment_status:'unpaid',url:'https://checkout.stripe.com/'+id,customer:data.customer,client_reference_id:data.client_reference_id,mode:data.mode,metadata:data.metadata,line_items:data.line_items,subscription:null,_rows:rows};
     sessions.set(id,s);return s;},
   retrieve:async id=>structuredClone(sessions.get(id)),
   expire:async id=>{sessions.get(id).status='expired';return structuredClone(sessions.get(id));},
   listLineItems:async id=>({data:structuredClone(sessions.get(id)._rows),has_more:false})
  }},
  subscriptions:{
   retrieve:async id=>structuredClone(subs.get(id)),
   update:async(id,data)=>{const s=subs.get(id);for(const u of data.items||[]){if(u.deleted){s.items.data=s.items.data.filter(x=>x.id!==u.id);continue;}if(u.id){const x=s.items.data.find(x=>x.id===u.id);x.price=catalogPrice(u.price);}else{s.items.data.push({id:'si_added_'+Math.random(),price:catalogPrice(u.price),quantity:1});}}s.metadata=data.metadata||s.metadata;return structuredClone(s);},
   cancel:async id=>{canceled.push(id);const s=subs.get(id);if(s)s.status='canceled';return structuredClone(s)}
  },
  billingPortal:{sessions:{create:async()=>({url:'https://billing.stripe.com/session/test'})}},
  complete(sessionId,status='active'){
   const s=sessions.get(sessionId),id='sub_'+(++subi);s.status='complete';s.payment_status='paid';s.subscription=id;
   subs.set(id,{id,status,customer:s.customer,metadata:s.metadata,items:{data:s._rows.map((x,i)=>({id:'si_'+id+'_'+i,price:x.price,quantity:1}))}});
  }
 };
}
const tokenA='rxca_'+ 'A'.repeat(43),tokenOwner='rxca_'+ 'O'.repeat(43);
function fakeFetch(url,opts){const owner=opts?.headers?.authorization==='Bearer '+tokenOwner;return Promise.resolve(new Response(JSON.stringify({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',sub:owner?'owner-sub':'user-sub',email:owner?'support@infected-nation.com':'user@example.com',email_verified:true}),{status:200,headers:{'content-type':'application/json'}}));}
async function fixture({owner=false,existing={},stripeOverride,deleteWorkspace,internalEntitlementToken}={}){
 const store=new MemoryStore(),stripe=stripeOverride===undefined?fakeStripe():stripeOverride,deleted=[];
 const c=await createControl({issuer:'https://red-xai.com',store,receiverStore:new ReceiverStore(existing),stripe,fetchImpl:fakeFetch,publicBase:'https://api.red-xai.com/gendragoon',internalEntitlementToken,deleteWorkspace:deleteWorkspace|| (async({project})=>deleted.push(project.id))});
 const root=await c.listen(),token=owner?tokenOwner:tokenA;
 const call=async(path,{method='GET',body}={})=>{const r=await fetch(root+path,{method,headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
 return {c,store,stripe,deleted,call,root};
}
function getState(f){return f.store.get([...f.store.map.keys()][0])}

async function internalProof(f,workspaceId,authorization='Bearer '+'I'.repeat(43)){
 const owner=[...f.store.map.keys()][0],subject=(await getState(f)).ownerBenefits?'owner-sub':'user-sub';
 const r=await fetch(f.root+'/internal/receiver-entitlements',{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify({owner,issuer:'https://red-xai.com',subject,workspaceId})});
 return {status:r.status,body:await r.json()};
}
test('internal storage delegation requires independent service auth and never migrates owner authority',async t=>{
 const f=await fixture({owner:true,internalEntitlementToken:'I'.repeat(43)});t.after(()=>f.c.close());
 const created=await f.call('/v2/projects',{method:'POST',body:{name:'Delegated note'}}),id=created.body.project.id;
 assert.equal((await internalProof(f,id,'Bearer '+tokenOwner)).status,401);
 const r=await internalProof(f,id);assert.equal(r.status,200);assert.equal(r.body.workspace.id,id);assert.equal(r.body.workspace.quotaBytes,6_000_000_000_000);
 assert.equal('ownerAdmin' in r.body,false);assert.equal((await getState(f)).ownerBenefits,true);
 assert.equal((await internalProof(f,'f'.repeat(32))).status,404);
 const owner=[...f.store.map.keys()][0];await f.store.change(owner,s=>{s.projects[id].status='deleting';});
 assert.equal((await internalProof(f,id)).status,404);
});
test('internal paid storage proof reconciles canceled subscriptions without a user bearer',async t=>{
 const f=await fixture({internalEntitlementToken:'I'.repeat(43)});t.after(()=>f.c.close());
 const p=await createAndPayPlans(f,'Delegated paid note','boost');
 f.stripe._subs.get(p.subscriptionId).status='canceled';
 const r=await internalProof(f,p.id);assert.equal(r.status,200);assert.equal(r.body.workspace.active,false);assert.equal(r.body.workspace.readOnly,true);assert.equal(r.body.workspace.workers,0);
 assert.equal(r.body.workspace.quotaBytes,0);
});

test('first workspace waives only the $5 fee and still requires storage + performance selection',async t=>{
 const f=await fixture();t.after(()=>f.c.close());
 let r=await f.call('/v2/projects',{method:'POST',body:{name:'First',storageTier:'100GB',performanceTier:'free',interval:'month'}});
 assert.equal(r.status,201);assert.equal(r.body.project.feeWaived,true);assert.equal(r.body.workspaceMonthlyCents,0);assert.match(r.body.url,/checkout/);
 let state=await getState(f),p=Object.values(state.projects)[0],session=f.stripe._sessions.get(p.checkoutSessionId);
 assert.equal(session.line_items.length,1); // storage only; free performance has no paid Stripe line and workspace fee is waived
 f.stripe.complete(p.checkoutSessionId);r=await f.call('/v2/projects');
 p=r.body.projects[0];assert.equal(p.active,true);assert.equal(p.quotaBytes,100_000_000_000);assert.equal(p.workers,1);
});

async function createAndPayPlans(f,name='First',performanceTier='free',interval='month'){
 const r=await f.call('/v2/projects',{method:'POST',body:{name,storageTier:'100GB',performanceTier,interval}});assert.equal(r.status,201,JSON.stringify(r.body));
 let state=await getState(f),p=state.projects[r.body.project.id];f.stripe.complete(p.checkoutSessionId);await f.call('/v2/projects');return (await getState(f)).projects[p.id];
}
async function payWorkspaceFee(f,p){
 const r=await f.call('/v2/projects/'+p.id+'/checkout',{method:'POST',body:{}});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.checkoutStage,'workspace_fee');
 const state=await getState(f);f.stripe.complete(state.projects[p.id].workspaceCheckoutSessionId);await f.call('/v2/projects');return (await getState(f)).projects[p.id];
}
test('additional workspaces require separate verified monthly fee for either plan interval',async t=>{
 for(const interval of ['month','year']){
  const f=await fixture();t.after(()=>f.c.close());await createAndPayPlans(f);
  let p=await createAndPayPlans(f,'Second','boost',interval);
  assert.equal(p.active,false);assert.equal(p.status,'workspace_fee_required');
  let r=await f.call('/v2/projects');assert.equal(r.body.projects.find(x=>x.id===p.id).checkoutPending,true);
  const plans=f.stripe._sessions.get(p.checkoutSessionId);assert.equal(plans.line_items.length,2);assert.ok(plans._rows.every(x=>x.price.recurring.interval===interval));
  p=await payWorkspaceFee(f,p);assert.equal(p.active,true);assert.equal(p.workers,4);
  const fee=f.stripe._subs.get(p.workspaceSubscriptionId);assert.equal(fee.items.data[0].price.unit_amount,500);assert.equal(fee.items.data[0].price.recurring.interval,'month');
 }
});

test('performance upgrades and downgrades change verified worker entitlement including Free',async t=>{
 const f=await fixture();t.after(()=>f.c.close());
 await f.call('/v2/projects',{method:'POST',body:{name:'First',storageTier:'100GB',performanceTier:'boost',interval:'month'}});
 let s=await getState(f),p=Object.values(s.projects)[0];f.stripe.complete(p.checkoutSessionId);await f.call('/v2/projects');
 let r=await f.call('/v2/projects/'+p.id+'/plan',{method:'PUT',body:{storageTier:'2TB',performanceTier:'turbo',interval:'month'}});
 assert.equal(r.body.project.workers,8);r=await f.call('/v2/receiver-entitlements');assert.equal(r.body.projectLimit,20);
 r=await f.call('/v2/projects/'+p.id+'/plan',{method:'PUT',body:{storageTier:'2TB',performanceTier:'free',interval:'month'}});
 assert.equal(r.body.project.workers,1);r=await f.call('/v2/receiver-entitlements');assert.equal(r.body.projectLimit,10);
});

test('deleting a workspace cancels billing, deletes Receiver data, and transfers the free fee slot',async t=>{
 const f=await fixture();t.after(()=>f.c.close());
 await f.call('/v2/projects',{method:'POST',body:{name:'First',storageTier:'100GB',performanceTier:'free',interval:'month'}});
 let s=await getState(f),first=Object.values(s.projects)[0];f.stripe.complete(first.checkoutSessionId);await f.call('/v2/projects');
 await f.call('/v2/projects',{method:'POST',body:{name:'Second',storageTier:'100GB',performanceTier:'lite',interval:'month'}});
 s=await getState(f);const second=Object.values(s.projects).find(x=>x.name==='Second');f.stripe.complete(second.checkoutSessionId);await f.call('/v2/projects');
 await payWorkspaceFee(f,(await getState(f)).projects[second.id]);
 s=await getState(f);const currentFirst=s.projects[first.id],currentFirstSubscription=currentFirst.subscriptionId;
 let r=await f.call('/v2/projects/'+first.id,{method:'DELETE',body:{confirmName:'First'}});
 assert.equal(r.status,200);assert.deepEqual(f.deleted,[first.id]);assert.ok(f.stripe._canceled.includes(currentFirstSubscription));
 s=await getState(f);assert.equal(s.projects[first.id],undefined);assert.equal(s.projects[second.id].feeWaived,true);assert.equal(s.projects[second.id].workspaceFeePriceId,null);assert.equal(s.projects[second.id].workspaceSubscriptionId,null);const r2=await f.call('/v2/projects');assert.equal(r2.body.projects[0].active,true);
});

test('owner account gets lifetime 6TB Max on every workspace without Checkout',async t=>{
 const wid='a'.repeat(32),f=await fixture({owner:true,existing:{[wid]:{id:wid,name:'Existing'}}});t.after(()=>f.c.close());
 let r=await f.call('/v2/receiver-entitlements');assert.equal(r.body.ownerBenefits,true);assert.equal(r.body.workspaces[0].quotaBytes,6_000_000_000_000);assert.equal(r.body.workspaces[0].workers,20);
 r=await f.call('/v2/projects',{method:'POST',body:{name:'Owner Two'}});assert.equal(r.body.project.owner,true);assert.equal(r.body.url,undefined);
});

test('every storage and performance tier grants the exact paid worker/quota entitlement in both intervals',async t=>{
 const f=await fixture();t.after(()=>f.c.close());let p=await createAndPayPlans(f);
 for(const interval of ['month','year'])for(const [storageTier,storage] of Object.entries(STORAGE))for(const [performanceTier,performance] of Object.entries({free:{workers:1},...PERFORMANCE})){
   const r=await f.call('/v2/projects/'+p.id+'/plan',{method:'PUT',body:{storageTier,performanceTier,interval}});
   assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.project.active,true);assert.equal(r.body.project.quotaBytes,storage.gb*1e9);assert.equal(r.body.project.workers,performance.workers);
 }
});

test('unpaid, mismatched customer, extra quantity, and canceled subscriptions never grant storage or workers',async t=>{
 const f=await fixture();t.after(()=>f.c.close());
 let r=await f.call('/v2/projects',{method:'POST',body:{name:'First',storageTier:'100GB',performanceTier:'max'}});
 let p=(await getState(f)).projects[r.body.project.id];r=await f.call('/v2/receiver-entitlements');assert.equal(r.body.workspaces[0].active,false);
 f.stripe.complete(p.checkoutSessionId);await f.call('/v2/projects');p=(await getState(f)).projects[p.id];const sub=f.stripe._subs.get(p.subscriptionId),customer=sub.customer;
 sub.customer='cus_other';r=await f.call('/v2/receiver-entitlements');assert.equal(r.body.workspaces[0].workers,0);assert.equal(r.body.workspaces[0].quotaBytes,0);
 sub.customer=customer;sub.items.data[0].quantity=2;r=await f.call('/v2/receiver-entitlements');assert.equal(r.body.workspaces[0].active,false);
 sub.items.data[0].quantity=1;sub.status='canceled';r=await f.call('/v2/receiver-entitlements');assert.equal(r.body.workspaces[0].workers,0);
});

test('workspace fee must belong to the same customer and stay current independently of annual plans',async t=>{
 const f=await fixture();t.after(()=>f.c.close());await createAndPayPlans(f);let p=await createAndPayPlans(f,'Second','max','year');p=await payWorkspaceFee(f,p);
 const sub=f.stripe._subs.get(p.workspaceSubscriptionId);sub.status='past_due';let r=await f.call('/v2/receiver-entitlements');assert.equal(r.body.workspaces.find(x=>x.id===p.id).active,false);
 sub.status='active';sub.items.data[0].price.unit_amount=499;r=await f.call('/v2/receiver-entitlements');assert.equal(r.body.workspaces.find(x=>x.id===p.id).workers,0);
 sub.items.data[0].price.unit_amount=500;sub.metadata.redxOwner='other';r=await f.call('/v2/receiver-entitlements');assert.equal(r.body.workspaces.find(x=>x.id===p.id).active,false);
});

test('concurrent workspace creation allocates one fee waiver and respects the limit',async t=>{
 const f=await fixture();t.after(()=>f.c.close());const responses=await Promise.all(Array.from({length:12},(_,i)=>f.call('/v2/projects',{method:'POST',body:{name:'Workspace '+i,storageTier:'100GB',performanceTier:'free'}})));
 assert.equal(responses.filter(r=>r.status===201).length,10);assert.equal(responses.filter(r=>r.status===409).length,2);
 const state=await getState(f);assert.equal(Object.values(state.projects).filter(p=>p.feeWaived).length,1);assert.equal(Object.keys(state.projects).length,10);
});

test('Checkout retry resumes the same workspace and expired sessions get a fresh generation',async t=>{
 const f=await fixture();t.after(()=>f.c.close());const body={name:'Retry Workspace',storageTier:'100GB',performanceTier:'free'};
 const a=await f.call('/v2/projects',{method:'POST',body}),b=await f.call('/v2/projects',{method:'POST',body});assert.equal(a.body.project.id,b.body.project.id);assert.equal(f.stripe._sessions.size,1);
 const p=(await getState(f)).projects[a.body.project.id];f.stripe._sessions.get(p.checkoutSessionId).status='expired';
 const c=await f.call('/v2/projects/'+p.id+'/checkout',{method:'POST',body:{}});assert.equal(c.status,200);assert.equal(f.stripe._sessions.size,2);assert.equal((await getState(f)).projects[p.id].checkoutGeneration,1);
});

test('imported first workspace can select plans and activate after storage payment',async t=>{
 const wid='b'.repeat(32),f=await fixture({existing:{[wid]:{id:wid,name:'Imported'}}});t.after(()=>f.c.close());
 let r=await f.call('/v2/projects');assert.equal(r.body.projects[0].status,'plan_required');
 r=await f.call('/v2/projects/'+wid+'/plan',{method:'PUT',body:{storageTier:'200GB',performanceTier:'free',interval:'year'}});assert.equal(r.status,200);assert.equal(r.body.project.checkoutPending,true);
 r=await f.call('/v2/projects/'+wid+'/checkout',{method:'POST',body:{}});assert.equal(r.status,200);
 const p=(await getState(f)).projects[wid];f.stripe.complete(p.checkoutSessionId);r=await f.call('/v2/projects');assert.equal(r.body.projects[0].active,true);assert.equal(r.body.projects[0].feeWaived,true);
});

test('changing unpaid plans expires the old checkout so obsolete prices cannot activate',async t=>{
 const f=await fixture();t.after(()=>f.c.close());const r=await f.call('/v2/projects',{method:'POST',body:{name:'First',storageTier:'100GB',performanceTier:'free'}});const p=(await getState(f)).projects[r.body.project.id];
 const change=await f.call('/v2/projects/'+p.id+'/plan',{method:'PUT',body:{storageTier:'1TB',performanceTier:'turbo',interval:'year'}});assert.equal(change.status,200);assert.equal(f.stripe._sessions.get(p.checkoutSessionId).status,'expired');
 const checkout=await f.call('/v2/projects/'+p.id+'/checkout',{method:'POST',body:{}});assert.equal(checkout.status,200);assert.notEqual((await getState(f)).projects[p.id].checkoutSessionId,p.checkoutSessionId);
});

test('deleting an additional workspace cancels both subscriptions and requires exact confirmation',async t=>{
 const f=await fixture();t.after(()=>f.c.close());await createAndPayPlans(f);let p=await createAndPayPlans(f,'Second','max','year');p=await payWorkspaceFee(f,p);
 let r=await f.call('/v2/projects/'+p.id,{method:'DELETE',body:{confirmName:' Second '}});assert.equal(r.status,409);assert.equal(f.stripe._canceled.length,0);
 r=await f.call('/v2/projects/'+p.id,{method:'DELETE',body:{confirmName:'Second'}});assert.equal(r.status,200);assert.ok(f.stripe._canceled.includes(p.subscriptionId));assert.ok(f.stripe._canceled.includes(p.workspaceSubscriptionId));
});

test('deleting the fee-waived workspace expires a pending fee checkout before transferring the waiver',async t=>{
 const f=await fixture();t.after(()=>f.c.close());const first=await createAndPayPlans(f);let second=await createAndPayPlans(f,'Second');await f.call('/v2/projects/'+second.id+'/checkout',{method:'POST',body:{}});second=(await getState(f)).projects[second.id];
 const r=await f.call('/v2/projects/'+first.id,{method:'DELETE',body:{confirmName:'First'}});assert.equal(r.status,200);assert.equal(f.stripe._sessions.get(second.workspaceCheckoutSessionId).status,'expired');
 const list=await f.call('/v2/projects');assert.equal(list.body.projects[0].active,true);assert.equal(list.body.projects[0].workspaceMonthlyCents,0);
});

test('owner benefits do not depend on Stripe being configured and owner checkout never bills',async t=>{
 const f=await fixture({owner:true,stripeOverride:null});t.after(()=>f.c.close());let r=await f.call('/v2/projects',{method:'POST',body:{name:'Owner Project'}});assert.equal(r.status,201);assert.equal(r.body.project.feeWaived,true);
 r=await f.call('/v2/projects/'+r.body.project.id+'/checkout',{method:'POST',body:{}});assert.equal(r.status,200);assert.equal(r.body.complimentary,true);
});

test('ad-free access requires a verified receipt for this account and exact product',async t=>{
 const f=await fixture();t.after(()=>f.c.close());let r=await f.call('/v2/remove-ads/checkout',{method:'POST',body:{}});assert.equal(r.status,200);
 let s=await getState(f),session=f.stripe._sessions.get(s.adsCheckoutSessionId);f.stripe.complete(session.id);session.mode='payment';session.customer='cus_other';
 r=await f.call('/v2/account');assert.equal(r.status,503);assert.equal((await getState(f)).adFree,false);
 session.customer=s.stripeCustomerId;r=await f.call('/v2/account');assert.equal(r.status,200);assert.equal(r.body.adFree,true);
});

test('startup refuses any missing or mispriced tier, including a high performance annual tier',async()=>{
 const stripe=fakeStripe(),original=stripe.prices.retrieve;stripe.prices.retrieve=async id=>{const p=await original(id);if(id===priceIds['performance|max|year'])p.unit_amount=1;return p;};
 await assert.rejects(fixture({stripeOverride:stripe}),/Stripe catalog\/account mismatch: performance\|max\|year/);
});

test('a canceled monthly workspace fee can be checked out again without rebilling annual plans',async t=>{
 const f=await fixture();t.after(()=>f.c.close());await createAndPayPlans(f);let p=await createAndPayPlans(f,'Second','max','year');p=await payWorkspaceFee(f,p);const plans=p.subscriptionId;
 f.stripe._subs.get(p.workspaceSubscriptionId).status='canceled';let r=await f.call('/v2/projects');assert.equal(r.body.projects.find(x=>x.id===p.id).checkoutPending,true);
 p=await payWorkspaceFee(f,p);assert.equal(p.active,true);assert.equal(p.subscriptionId,plans);assert.equal(p.workspaceCheckoutGeneration,1);
});

test('plan editor recovers a canceled storage subscription by selecting a fresh checkout',async t=>{
 const f=await fixture();t.after(()=>f.c.close());let p=await createAndPayPlans(f);f.stripe._subs.get(p.subscriptionId).status='canceled';
 let r=await f.call('/v2/projects/'+p.id+'/plan',{method:'PUT',body:{storageTier:'1TB',performanceTier:'turbo',interval:'year'}});assert.equal(r.status,200);assert.equal(r.body.project.checkoutPending,true);assert.equal(r.body.project.storageTier,'1TB');
 r=await f.call('/v2/projects/'+p.id+'/checkout',{method:'POST',body:{}});assert.equal(r.status,200);p=(await getState(f)).projects[p.id];f.stripe.complete(p.checkoutSessionId);
 r=await f.call('/v2/projects');assert.equal(r.body.projects[0].active,true);assert.equal(r.body.projects[0].quotaBytes,1e12);assert.equal(r.body.projects[0].workers,8);
});

test('MachineNotes routes and JSON aliases preserve the same legacy IDs, ledger and checkout metadata',async t=>{
 const f=await fixture();t.after(()=>f.c.close());
 const created=await f.call('/v2/machinenotes',{method:'POST',body:{name:'My MachineNote',storageTier:'200GB',performanceTier:'free',interval:'year'}});
 assert.equal(created.status,201);assert.deepEqual(created.body.machineNote,created.body.project);const id=created.body.machineNote.id;
 let s=await getState(f);assert.ok(s.projects[id]);assert.equal(s.machineNotes,undefined);const csid=s.projects[id].checkoutSessionId;
 assert.equal(f.stripe._sessions.get(csid).metadata.projectId,id);assert.equal(f.stripe._sessions.get(csid).metadata.kind,'workspace_plans');
 const alias=await f.call('/gendragoon/v2/machinenotes'),legacy=await f.call('/v2/projects');
 assert.equal(alias.status,200);assert.deepEqual(alias.body.machineNotes,alias.body.projects);assert.deepEqual(alias.body.projects,legacy.body.projects);assert.equal(alias.body.machineNoteLimit,alias.body.projectLimit);
 const resumed=await f.call('/v2/machinenotes/'+id+'/checkout',{method:'POST',body:{}});assert.equal(resumed.status,200);assert.equal(resumed.body.resumed,true);assert.deepEqual(resumed.body.machineNote,resumed.body.project);assert.equal(f.stripe._sessions.size,1);
 const changed=await f.call('/v2/machinenotes/'+id+'/plan',{method:'PUT',body:{storageTier:'1TB',performanceTier:'turbo',interval:'month'}});assert.equal(changed.status,200);assert.deepEqual(changed.body.machineNote,changed.body.project);assert.equal(changed.body.machineNote.id,id);
 s=await getState(f);assert.equal(s.projects[id].storageTier,'1TB');assert.equal(f.stripe._sessions.get(csid).status,'expired');
 const wrong=await f.call('/v2/machinenotes/'+id,{method:'DELETE',body:{confirmName:'Wrong'}});assert.equal(wrong.status,409);assert.equal(wrong.body.error,'confirm_name_required');assert.match(wrong.body.message,/MachineNote/);
 const deleted=await f.call('/v2/machinenotes/'+id,{method:'DELETE',body:{confirmName:'My MachineNote'}});assert.equal(deleted.status,200);assert.deepEqual(f.deleted,[id]);assert.equal((await getState(f)).projects[id],undefined);
});

test('MachineNote pricing and slot aliases retain all legacy policy fields',async t=>{
 const f=await fixture();t.after(()=>f.c.close());const r=await f.call('/v2/pricing');
 assert.equal(r.status,200);assert.deepEqual(r.body.machineNotes,r.body.projects);assert.equal(r.body.machineNotes.firstMachineNoteFeeWaived,true);assert.equal(r.body.machineNotes.additionalMachineNoteMonthlyCents,500);assert.equal(r.body.projects.firstWorkspaceFeeWaived,true);assert.equal(r.body.projects.additionalWorkspaceMonthlyCents,500);
 const account=await f.call('/v2/account');assert.equal(account.body.machineNoteLimit,account.body.projectLimit);assert.equal(account.body.usedMachineNoteSlots,account.body.usedProjectSlots);
 const invalid=await f.call('/v2/machinenotes-extra',{method:'POST',body:{name:'Invalid',storageTier:'100GB',performanceTier:'free'}});assert.equal(invalid.status,404);assert.equal(Object.keys((await getState(f)).projects).length,0);
});

test('owner MachineNote alias checkout stays complimentary and returns both object names',async t=>{
 const f=await fixture({owner:true,stripeOverride:null});t.after(()=>f.c.close());const r=await f.call('/v2/machinenotes',{method:'POST',body:{name:'Owner MachineNote'}});assert.equal(r.status,201);assert.deepEqual(r.body.machineNote,r.body.project);
 const checkout=await f.call('/v2/machinenotes/'+r.body.machineNote.id+'/checkout',{method:'POST',body:{}});assert.equal(checkout.status,200);assert.equal(checkout.body.complimentary,true);assert.deepEqual(checkout.body.machineNote,checkout.body.project);
});

test('first 2 GB free workspace works with no Stripe and remains active without checkout',async t=>{
 const f=await fixture({stripeOverride:null});t.after(()=>f.c.close());
 const r=await f.call('/v2/machinenotes',{method:'POST',body:{name:'Free Home',storageTier:'free2GB',performanceTier:'free'}});
 assert.equal(r.status,201);const p=r.body.project;
 assert.equal(p.active,true);assert.equal(p.quotaBytes,2_000_000_000);assert.equal(p.workers,1);
 assert.equal(p.checkoutPending,false);assert.equal(p.freeTier,true);assert.equal(r.body.url,undefined);
 let list=await f.call('/v2/receiver-entitlements');assert.equal(list.status,200);assert.equal(list.body.workspaces[0].quotaBytes,2_000_000_000);
 const checkout=await f.call('/v2/projects/'+p.id+'/checkout',{method:'POST',body:{}});
 assert.equal(checkout.status,200);assert.equal(checkout.body.complimentary,true);
 list=await f.call('/v2/projects');assert.equal(list.body.projects[0].active,true);
});
test('concurrent free-workspace requests cannot allocate multiple free quotas',async t=>{
 const f=await fixture({stripeOverride:null});t.after(()=>f.c.close());
 const replies=await Promise.all(Array.from({length:12},(_,n)=>f.call('/v2/projects',{method:'POST',body:{name:'Free '+n,storageTier:'free2GB'}})));
 assert.ok(replies.every(r=>r.status===201));assert.equal(new Set(replies.map(r=>r.body.project.id)).size,1);
 const state=await getState(f);assert.equal(Object.keys(state.projects).length,1);
 assert.equal(Object.values(state.projects).reduce((n,p)=>n+p.quotaBytes,0),2_000_000_000);
});
test('additional paid workspace after free storage still requires the monthly workspace fee',async t=>{
 const f=await fixture();t.after(()=>f.c.close());
 const free=await f.call('/v2/projects',{method:'POST',body:{name:'Starter free',storageTier:'free2GB'}});assert.equal(free.status,201);
 const second=await f.call('/v2/projects',{method:'POST',body:{name:'Additional paid',storageTier:'100GB',performanceTier:'free',interval:'month'}});
 assert.equal(second.status,201);assert.equal(second.body.project.feeWaived,false);assert.equal(second.body.project.workspaceMonthlyCents,500);
 assert.equal(second.body.project.active,false);assert.equal(f.stripe._sessions.size,1);
 const repeated=await f.call('/v2/projects',{method:'POST',body:{name:'Another alleged free',storageTier:'free2GB'}});
 assert.equal(repeated.body.project.id,free.body.project.id);assert.equal(Object.keys((await getState(f)).projects).length,2);
});
