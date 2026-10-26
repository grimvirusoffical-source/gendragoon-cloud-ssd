'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createControl}=require('../control-server.cjs');

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
  prices:{retrieve:async id=>({id,active:true,livemode:true,currency:'usd'})},
  customers:{create:async()=>({id:'cus_'+(++ci)})},
  checkout:{sessions:{
   create:async data=>{const id='cs_'+(++si),rows=data.line_items.map(x=>x.price?{price:{id:x.price,unit_amount:999,recurring:{interval:'month'}},quantity:1}:{price:{id:'price_inline_'+(++inline),unit_amount:x.price_data.unit_amount,recurring:x.price_data.recurring},quantity:1});
     const s={id,status:'open',payment_status:'unpaid',url:'https://checkout.stripe.com/'+id,customer:data.customer,mode:data.mode,metadata:data.metadata,line_items:data.line_items,subscription:null,_rows:rows};
     sessions.set(id,s);return s;},
   retrieve:async id=>structuredClone(sessions.get(id)),
   listLineItems:async id=>({data:structuredClone(sessions.get(id)._rows),has_more:false})
  }},
  subscriptions:{
   retrieve:async id=>structuredClone(subs.get(id)),
   update:async(id,data)=>{const s=subs.get(id);for(const u of data.items||[]){if(u.deleted){s.items.data=s.items.data.filter(x=>x.id!==u.id);continue;}if(u.id){const x=s.items.data.find(x=>x.id===u.id);x.price={id:u.price,unit_amount:999,recurring:{interval:'month'}};}else{s.items.data.push({id:'si_added_'+Math.random(),price:{id:u.price,unit_amount:999,recurring:{interval:'month'}},quantity:1});}}s.metadata=data.metadata||s.metadata;return structuredClone(s);},
   cancel:async id=>{canceled.push(id);const s=subs.get(id);if(s)s.status='canceled';return structuredClone(s)}
  },
  billingPortal:{sessions:{create:async()=>({url:'https://billing.stripe.com/session/test'})}},
  complete(sessionId,status='active'){const s=sessions.get(sessionId),id='sub_'+(++subi);s.status='complete';s.payment_status='paid';s.subscription=id;subs.set(id,{id,status,metadata:s.metadata,items:{data:s._rows.map((x,i)=>({id:'si_'+id+'_'+i,price:x.price,quantity:1}))}});}
 };
}
const tokenA='rxca_'+ 'A'.repeat(43),tokenOwner='rxca_'+ 'O'.repeat(43);
function fakeFetch(url,opts){const owner=opts?.headers?.authorization==='Bearer '+tokenOwner;return Promise.resolve(new Response(JSON.stringify({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',sub:owner?'owner-sub':'user-sub',email:owner?'support@infected-nation.com':'user@example.com',email_verified:true}),{status:200,headers:{'content-type':'application/json'}}));}
async function fixture({owner=false,existing={}}={}){
 const store=new MemoryStore(),stripe=fakeStripe(),deleted=[];
 const c=await createControl({issuer:'https://red-xai.com',store,receiverStore:new ReceiverStore(existing),stripe,fetchImpl:fakeFetch,publicBase:'https://api.red-xai.com/gendragoon',deleteWorkspace:async({project})=>deleted.push(project.id)});
 const root=await c.listen(),token=owner?tokenOwner:tokenA;
 const call=async(path,{method='GET',body}={})=>{const r=await fetch(root+path,{method,headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
 return {c,store,stripe,deleted,call};
}
function getState(f){return f.store.get([...f.store.map.keys()][0])}

test('first workspace waives only the $5 fee and still requires storage + performance selection',async t=>{
 const f=await fixture();t.after(()=>f.c.close());
 let r=await f.call('/v2/projects',{method:'POST',body:{name:'First',storageTier:'100GB',performanceTier:'free',interval:'month'}});
 assert.equal(r.status,201);assert.equal(r.body.project.feeWaived,true);assert.equal(r.body.workspaceMonthlyCents,0);assert.match(r.body.url,/checkout/);
 let state=await getState(f),p=Object.values(state.projects)[0],session=f.stripe._sessions.get(p.checkoutSessionId);
 assert.equal(session.line_items.length,1);
 f.stripe.complete(p.checkoutSessionId);r=await f.call('/v2/projects');
 p=r.body.projects[0];assert.equal(p.active,true);assert.equal(p.quotaBytes,100_000_000_000);assert.equal(p.workers,1);
});

test('second workspace adds recurring $5 monthly fee plus storage and paid performance',async t=>{
 const f=await fixture();t.after(()=>f.c.close());
 await f.call('/v2/projects',{method:'POST',body:{name:'First',storageTier:'100GB',performanceTier:'free',interval:'month'}});
 let state=await getState(f),first=Object.values(state.projects)[0];f.stripe.complete(first.checkoutSessionId);await f.call('/v2/projects');
 let r=await f.call('/v2/projects',{method:'POST',body:{name:'Second',storageTier:'100GB',performanceTier:'boost',interval:'month'}});
 assert.equal(r.body.project.feeWaived,false);assert.equal(r.body.workspaceMonthlyCents,500);
 state=await getState(f);const second=Object.values(state.projects).find(x=>x.name==='Second'),session=f.stripe._sessions.get(second.checkoutSessionId);
 assert.equal(session.line_items.length,3);assert.equal(session.line_items[2].price_data.unit_amount,500);assert.deepEqual(session.line_items[2].price_data.recurring,{interval:'month'});
 f.stripe.complete(second.checkoutSessionId);r=await f.call('/v2/projects');const paid=r.body.projects.find(x=>x.name==='Second');assert.equal(paid.active,true);assert.equal(paid.workers,4);
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
 s=await getState(f);const currentFirst=s.projects[first.id],currentFirstSubscription=currentFirst.subscriptionId;
 let r=await f.call('/v2/projects/'+first.id,{method:'DELETE',body:{confirmName:'First'}});
 assert.equal(r.status,200);assert.deepEqual(f.deleted,[first.id]);assert.ok(f.stripe._canceled.includes(currentFirstSubscription));
 s=await getState(f);assert.equal(s.projects[first.id],undefined);assert.equal(s.projects[second.id].feeWaived,true);assert.equal(s.projects[second.id].workspaceFeePriceId,null);
});

test('owner account gets lifetime 6TB Max on every workspace without Checkout',async t=>{
 const wid='a'.repeat(32),f=await fixture({owner:true,existing:{[wid]:{id:wid,name:'Existing'}}});t.after(()=>f.c.close());
 let r=await f.call('/v2/receiver-entitlements');assert.equal(r.body.ownerBenefits,true);assert.equal(r.body.workspaces[0].quotaBytes,6_000_000_000_000);assert.equal(r.body.workspaces[0].workers,20);
 r=await f.call('/v2/projects',{method:'POST',body:{name:'Owner Two'}});assert.equal(r.body.project.owner,true);assert.equal(r.body.url,undefined);
});
