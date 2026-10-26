'use strict';
// Real HTTP services and shared CAS ledger; Stripe is fake so no charge or live
// account is involved. In particular, deletion runs through its actual signed
// internal request while the control account lock is held.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createControl}=require('../control-server.cjs');
const {createCloud}=require('../server.cjs');
const {ControlState}=require('../control-state.cjs');
const {STORAGE,PERFORMANCE}=require('../../Backend/catalog.js');
const prices=require('../../Backend/stripe_live_catalog.json').priceIds;
class Ledger{
 constructor(){this.map=new Map();this.tail=Promise.resolve();}
 async get(owner){return this.map.has(owner)?structuredClone(this.map.get(owner)):null;}
 async ensure(owner,quota){if(!this.map.has(owner))this.map.set(owner,{schema:2,owner,id:owner,revision:0,quota,used:0,workspaces:{},objects:{},reservations:{},deletions:{},library:{}});return this.get(owner);}
 async change(owner,fn){const result=this.tail.then(async()=>{const s=await this.get(owner);fn(s);s.revision++;this.map.set(owner,s);return structuredClone(s);});this.tail=result.catch(()=>{});return result;}
}
function price(id){const p=Object.keys(prices).find(k=>prices[k]===id).split('|'),term=p.at(-1),factor=term==='year'?10:1;return {id,active:true,livemode:true,currency:'usd',unit_amount:p[0]==='storage'?STORAGE[p[2]][p[1]]*factor:p[0]==='performance'?PERFORMANCE[p[1]].cents*factor:499,...(p[0]!=='one_time'?{recurring:{interval:term,interval_count:1}}:{})};}
function fakeStripe(){
 const sessions=new Map(),subs=new Map(),canceled=[];let sequence=0;
 return {_sessions:sessions,_subs:subs,_canceled:canceled,
  prices:{retrieve:async id=>price(id)},customers:{create:async()=>({id:'cus_fixture'})},
  checkout:{sessions:{create:async data=>{const id='cs_'+(++sequence),rows=data.line_items.map(x=>({quantity:1,price:x.price?price(x.price):{id:'price_fee'+sequence,currency:'usd',unit_amount:x.price_data.unit_amount,recurring:x.price_data.recurring}}));const s={id,...data,status:'open',payment_status:'unpaid',url:'https://checkout.stripe.com/'+id,_rows:rows};sessions.set(id,s);return structuredClone(s);},retrieve:async id=>structuredClone(sessions.get(id)),listLineItems:async id=>({data:structuredClone(sessions.get(id)._rows),has_more:false}),expire:async id=>{sessions.get(id).status='expired';}}},
  subscriptions:{retrieve:async id=>structuredClone(subs.get(id)),cancel:async id=>{subs.get(id).status='canceled';canceled.push(id);}},
  complete(id){const session=sessions.get(id),sid='sub_'+(++sequence);Object.assign(session,{status:'complete',payment_status:'paid',subscription:sid});subs.set(sid,{id:sid,status:'active',customer:session.customer,metadata:session.metadata,items:{data:session._rows.map((r,i)=>({...r,id:'si_'+i}))}});}
 };
}
const token='rxca_'+'I'.repeat(43),key='integration-receiver-key';
const userInfo=()=>Response.json({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',sub:'integration-account',email:'integration@example.test',email_verified:true});
async function fixture(t){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'control-receiver-')),ledger=new Ledger(),stripe=fakeStripe();let controlURL,entitlementFetches=0;
 const entitlementURL='https://api.red-xai.com/gendragoon/v2/receiver-entitlements';
 const cloud=await createCloud({root,store:ledger,issuer:'https://red-xai.com',authProvider:'redx-site-session',productionReady:true,entitlementURL,redxKey:key,fetchImpl:async(url,opts)=>{
  if(url.endsWith('/userinfo'))return userInfo();assert.equal(url,entitlementURL);entitlementFetches++;return fetch(controlURL+'/v2/receiver-entitlements',opts);
 }});
 const receiverURL=await cloud.listen();
 const controlStore=new ControlState({url:'http://127.0.0.1:1',key,db:'integration_receivers',local:true});controlStore.receiver=ledger;
 const control=await createControl({issuer:'https://red-xai.com',store:controlStore,receiverStore:ledger,stripe,fetchImpl:async()=>userInfo(),receiverLocal:receiverURL,redxKey:key});controlURL=await control.listen();
 t.after(async()=>{await control.close();await cloud.close();await fs.rm(root,{recursive:true,force:true});});
 async function call(base,route,method='GET',body){const response=await fetch(base+route,{method,headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(3000)});return {status:response.status,body:await response.json()};}
 return {root,ledger,stripe,controlURL,receiverURL,controlStore,call,getEntitlementFetches:()=>entitlementFetches};
}
test('real control and Receiver agree on two-stage billing and delete through signed HTTP without deadlock',{timeout:15000},async t=>{
 const f=await fixture(t),created=[];
 for(const name of ['First','Second']){
  let r=await f.call(f.controlURL,'/v2/projects','POST',{name,storageTier:'100GB',performanceTier:'free',interval:'year'});assert.equal(r.status,201);const id=r.body.project.id;created.push(id);
  let state=await f.controlStore.get([...f.ledger.map.keys()][0]),project=state.projects[id];f.stripe.complete(project.checkoutSessionId);
  r=await f.call(f.receiverURL,'/v1/receivers/me','PUT');assert.equal(r.status,200);const workspace=r.body.workspaces.find(w=>w.id===id);assert.equal(workspace.active,name==='First');
  if(name==='Second'){
   r=await f.call(f.controlURL,'/v2/projects/'+id+'/checkout','POST',{});assert.equal(r.status,200);assert.equal(r.body.checkoutStage,'workspace_fee');
   state=await f.controlStore.get([...f.ledger.map.keys()][0]);f.stripe.complete(state.projects[id].workspaceCheckoutSessionId);
   r=await f.call(f.receiverURL,'/v1/receivers/me');assert.equal(r.status,200);assert.equal(r.body.workspaces.find(w=>w.id===id).active,true);
  }
 }
 const owner=[...f.ledger.map.keys()][0],doomed=created[1],kept=created[0],dir=path.join(f.root,owner,doomed);await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'encrypted-fixture.png'),Buffer.from('ciphertext'));
 await f.ledger.change(owner,s=>{s.used=10;s.workspaces[doomed].usedBytes=10;});
 const before=f.getEntitlementFetches();const deleted=await f.call(f.controlURL,'/v2/projects/'+doomed,'DELETE',{confirmName:'Second'});
 assert.equal(deleted.status,200,JSON.stringify(deleted.body));assert.equal(f.getEntitlementFetches(),before,'internal delete must not recursively call locked control entitlements');assert.equal(f.stripe._canceled.length,2);
 await assert.rejects(fs.stat(dir),{code:'ENOENT'});let s=await f.ledger.get(owner);assert.equal(s.used,0);assert.ok(s.deletedWorkspaces[doomed]);assert.equal(s.control.projects[doomed],undefined);assert.ok(s.control.projects[kept]);
 const refreshed=await f.call(f.receiverURL,'/v1/receivers/me');assert.equal(refreshed.status,200);assert.deepEqual(refreshed.body.workspaces.map(w=>w.id),[kept]);
});
