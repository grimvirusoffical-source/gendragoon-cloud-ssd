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
 let ci=0,si=0,subi=0;
 const sessions=new Map(),subs=new Map(),customers=new Map();
 return {
  _sessions:sessions,_subs:subs,
  prices:{retrieve:async id=>({id,active:true,livemode:true,currency:'usd'})},
  customers:{create:async d=>{const id='cus_'+(++ci);customers.set(id,{id,...d});return {id}}},
  checkout:{sessions:{
   create:async data=>{const id='cs_'+(++si),rec=data.line_items.filter(x=>x.price).map(x=>({price:{id:x.price},quantity:1}));
     const s={id,status:'open',payment_status:'unpaid',url:'https://checkout.stripe.com/'+id,customer:data.customer,mode:data.mode,metadata:data.metadata,line_items:data.line_items,subscription:null,_rec:rec};
     sessions.set(id,s);return s;},
   retrieve:async id=>structuredClone(sessions.get(id)),
   listLineItems:async id=>({data:[...sessions.get(id)._rec,...sessions.get(id).line_items.filter(x=>x.price_data).map(x=>({price:{id:'price_inline_'+id,unit_amount:x.price_data.unit_amount,recurring:null},quantity:1}))],has_more:false})
  }},
  subscriptions:{
   retrieve:async id=>structuredClone(subs.get(id)),
   update:async(id,data)=>{const s=subs.get(id);s.items.data=data.items.map((x,i)=>({id:x.id,price:{id:x.price},quantity:1}));s.metadata=data.metadata;return structuredClone(s)}
  },
  billingPortal:{sessions:{create:async()=>({url:'https://billing.stripe.com/session/test'})}},
  complete(sessionId,status='active'){
   const s=sessions.get(sessionId),id='sub_'+(++subi);s.status='complete';s.payment_status='paid';s.subscription=id;
   subs.set(id,{id,status,metadata:s.metadata,items:{data:s._rec.map((x,i)=>({id:'si_'+id+'_'+i,price:{id:x.price.id},quantity:1}))}});
  }
 };
}
const tokenA='rxca_'+ 'A'.repeat(43),tokenOwner='rxca_'+ 'O'.repeat(43);
function fakeFetch(url,opts){
 const auth=opts?.headers?.authorization||'';
 const data=auth==='Bearer '+tokenOwner?{sub:'owner-sub',email:'support@infected-nation.com'}:{sub:'user-sub',email:'user@example.com'};
 return Promise.resolve(new Response(JSON.stringify({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',
   sub:data.sub,email:data.email,email_verified:true}),{status:200,headers:{'content-type':'application/json'}}));
}
async function fixture({owner=false,existing={}}={}){
 const store=new MemoryStore(),stripe=fakeStripe();
 const c=await createControl({issuer:'https://red-xai.com',store,receiverStore:new ReceiverStore(existing),stripe,fetchImpl:fakeFetch,publicBase:'https://api.red-xai.com/gendragoon'});
 const root=await c.listen();
 const token=owner?tokenOwner:tokenA;
 const call=async(path,{method='GET',body}={})=>{
  const r=await fetch(root+path,{method,headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  return {status:r.status,body:await r.json()};
 };
 return {c,store,stripe,call};
}
test('first project is free and second project combines $5 activation with storage and performance',async t=>{
 const f=await fixture();t.after(()=>f.c.close());
 let r=await f.call('/v2/projects',{method:'POST',body:{name:'First Project'}});
 assert.equal(r.status,201);assert.equal(r.body.project.free,true);assert.equal(r.body.project.quotaBytes,2_000_000_000);assert.equal(r.body.project.workers,1);assert.equal(r.body.url,undefined);
 r=await f.call('/v2/projects',{method:'POST',body:{name:'Paid Project',storageTier:'100GB',performanceTier:'boost',interval:'month'}});
 assert.equal(r.status,201);assert.equal(r.body.oneTimeCents,500);assert.match(r.body.url,/checkout\.stripe\.com/);
 const pending=Object.values((await f.store.get([...f.store.map.keys()][0])).projects).find(x=>x.name==='Paid Project');
 const session=f.stripe._sessions.get(pending.checkoutSessionId);
 assert.equal(session.line_items.length,3);
 assert.equal(session.line_items[2].price_data.unit_amount,500);
 f.stripe.complete(pending.checkoutSessionId);
 r=await f.call('/v2/receiver-entitlements');
 const paid=r.body.workspaces.find(x=>x.name==='Paid Project');
 assert.equal(paid.active,true);assert.equal(paid.quotaBytes,100_000_000_000);assert.equal(paid.workers,4);
});
test('active paid project upgrades to 2TB Turbo and receiver entitlement changes',async t=>{
 const f=await fixture();t.after(()=>f.c.close());
 await f.call('/v2/projects',{method:'POST',body:{name:'First Project'}});
 let r=await f.call('/v2/projects',{method:'POST',body:{name:'Paid Project',storageTier:'100GB',performanceTier:'boost',interval:'month'}});
 const key=[...f.store.map.keys()][0],pending=Object.values((await f.store.get(key)).projects).find(x=>x.name==='Paid Project');
 f.stripe.complete(pending.checkoutSessionId);await f.call('/v2/projects');
 r=await f.call('/v2/projects/'+pending.id+'/plan',{method:'PUT',body:{storageTier:'2TB',performanceTier:'turbo',interval:'month'}});
 assert.equal(r.status,200);assert.equal(r.body.project.storageTier,'2TB');assert.equal(r.body.project.performanceTier,'turbo');
 r=await f.call('/v2/receiver-entitlements');const p=r.body.workspaces.find(x=>x.id===pending.id);
 assert.equal(p.quotaBytes,2_000_000_000_000);assert.equal(p.workers,8);assert.equal(r.body.projectLimit,20);
});
test('owner account adopts existing workspace and receives lifetime 6TB Max without checkout',async t=>{
 const wid='a'.repeat(32),existing={[wid]:{id:wid,name:'Existing Cloud'}};
 const f=await fixture({owner:true,existing});t.after(()=>f.c.close());
 let r=await f.call('/v2/receiver-entitlements');
 assert.equal(r.body.ownerBenefits,true);assert.equal(r.body.workspaces[0].quotaBytes,6_000_000_000_000);assert.equal(r.body.workspaces[0].workers,20);
 r=await f.call('/v2/projects',{method:'POST',body:{name:'Owner Two'}});
 assert.equal(r.status,201);assert.equal(r.body.project.owner,true);assert.equal(r.body.url,undefined);assert.equal(r.body.project.quotaBytes,6_000_000_000_000);
});
test('remove ads uses one-time checkout and becomes active after server verification',async t=>{
 const f=await fixture();t.after(()=>f.c.close());
 let r=await f.call('/v2/remove-ads/checkout',{method:'POST'});assert.equal(r.status,200);assert.match(r.body.url,/checkout\.stripe\.com/);
 const key=[...f.store.map.keys()][0],state=await f.store.get(key);f.stripe.complete(state.adsCheckoutSessionId);
 r=await f.call('/v2/account');assert.equal(r.body.adFree,true);
});
