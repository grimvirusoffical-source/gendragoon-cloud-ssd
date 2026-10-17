"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {registerWorkspaces}=require("./workspaces"),{stripeKeys}=require("./catalog");
function setup({ownerHash="a".repeat(64),customer="cus_ok",workspaceId="11111111-1111-4111-8111-111111111111"}={}){
 const plan={storage:"100GB",mode:"bundle",interval:"month"};
 const ws={plan,ownerHash,status:"checkout_pending"};
 const account={stripeCustomerId:customer};
 const updates=[];
 const doc={exists:true,data:()=>ws,ref:{update:async obj=>updates.push(obj)}};
 const accountDoc={exists:true,data:()=>account};
 const routes={};const app={get:(path,...f)=>routes[path]=f,post:(path,...f)=>routes[path]=f};
 const db={collection:()=>({doc:(id)=>({
    get:async()=>id===ownerHash?accountDoc:{exists:false},
    collection:()=>({doc:(w)=>({get:async()=>id===ownerHash&&w===workspaceId?doc:{exists:false},
      update:async obj=>updates.push(obj)})})
   })})};
 const keys=stripeKeys(plan);const prices=Object.fromEntries(keys.map((k,i)=>[k,"price_test_"+i]));
 const m=registerWorkspaces({app,db,stripe:{},admin:{firestore:{FieldValue:{serverTimestamp:()=>({})}}},
 auth:()=>{},agreed:()=>{},account:()=>account,hash:()=>ownerHash,prices});
 const make=(overrides={})=>({
   id:"sub_test",customer,metadata:{accountHash:ownerHash,workspaceId},
   items:{data:keys.map(k=>({price:{id:prices[k]}}))},status:"active",...overrides
 });
 return {m,updates,make,prices,keys,ws};
}
test("server confirms exact workspace fee plus storage price",async()=>{
 const {m,updates,make}=setup();
 await m.reconcileSubscription(make());
 assert.equal(updates.length,1);assert.equal(updates[0].paidEntitlementActive,true);
 assert.equal(updates[0].status,"paid_pending_provisioning");
});
test("storage-only subscription does not activate workspace",async()=>{
 const {m,updates,make}=setup();
 await m.reconcileSubscription(make({items:{data:[{price:{id:"price_test_1"}}]}}));
 assert.equal(updates[0].paidEntitlementActive,false);
});
test("unknown/mismatched prices never activate workspace",async()=>{
 const {m,updates,make}=setup();
 await m.reconcileSubscription(make({items:{data:[{price:{id:"price_test_0"}},{price:{id:"price_wrong"}}]}}));
 assert.equal(updates[0].paymentPricesValid,false);
});
test("failed and canceled subscription cannot activate workspace",async()=>{
 const {m,updates,make}=setup();
 await m.reconcileSubscription(make({status:"canceled"}));
 assert.equal(updates[0].paidEntitlementActive,false);
});
test("different customer cannot activate workspace",async()=>{
 const {m,updates,make}=setup();
 await m.reconcileSubscription(make({customer:"cus_attacker"}));
 assert.equal(updates.length,0);
});
test("different owner cannot activate workspace",async()=>{
 const {m,updates,make}=setup();
 await m.reconcileSubscription(make({metadata:{accountHash:"b".repeat(64),workspaceId:"11111111-1111-4111-8111-111111111111"}}));
 assert.equal(updates.length,0);
});
test("unknown workspace cannot be activated",async()=>{
 const {m,updates,make}=setup();
 await m.reconcileSubscription(make({metadata:{accountHash:"a".repeat(64),workspaceId:"22222222-2222-4222-8222-222222222222"}}));
 assert.equal(updates.length,0);
});
