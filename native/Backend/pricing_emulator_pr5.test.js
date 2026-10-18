"use strict";
// Real-concurrency pricing tests against the Firestore EMULATOR only.
// Skipped unless FIRESTORE_EMULATOR_HOST is set and the project id starts with "demo-",
// so this can never reach a real Firestore project. No credentials are used.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {Firestore,FieldValue}=require("@google-cloud/firestore");
const {createProjectService}=require("./projects");

const HOST=process.env.FIRESTORE_EMULATOR_HOST||"";
const PROJECT=process.env.GD_QA_EMULATOR_PROJECT||"demo-gendragoon-qa";
const skip=!HOST||!/^(127\.0\.0\.1|localhost):\d+$/.test(HOST)||!PROJECT.startsWith("demo-")
 ?"set FIRESTORE_EMULATOR_HOST=127.0.0.1:<port> (emulator only) to run":false;
const env={STRIPE_CHECKOUT_ENABLED:"true",STRIPE_WORKSPACE_MONTHLY_READY:"true",STRIPE_WORKSPACE_MONTHLY_PRICE_ID:"price_month",
 STRIPE_ENVIRONMENT:"test",PUBLIC_URL:"https://billing.example"};
const ROUNDS=Number(process.env.GD_QA_ROUNDS||15);

function device(owner){
 // Each "device" is a separate Firestore client, so transactions really contend on the emulator.
 const db=new Firestore({projectId:PROJECT,ignoreUndefinedProperties:true});
 const calls=[];
 const stripe={calls,subscriptions:{cancel:async id=>{calls.push(id);return {id,status:"canceled"};}}};
 const service=createProjectService({db,stamp:()=>FieldValue.serverTimestamp(),hash:()=>owner,stripe,env,ensureCustomer:async()=>"cus_emu"});
 return {db,service,req:{user:{uid:"owner"}}};
}
const uuid=()=>crypto.randomUUID();
async function state(d,owner){
 const acct=(await d.db.collection("gd_accounts").doc(owner).get()).data()||{};
 const docs=(await d.db.collection("gd_accounts").doc(owner).collection("workspaces").get()).docs.map(x=>({id:x.id,...x.data()}));
 return {acct,docs};
}
async function newOwner(){
 const owner=crypto.createHash("sha256").update("emu-"+uuid()).digest("hex");
 const seed=device(owner);
 await seed.db.collection("gd_accounts").doc(owner).set({stripeCustomerId:"cus_emu"});
 return owner;
}
function oneFree(s,label){
 const free=s.docs.filter(w=>w.projectFeeStatus==="free");
 assert.equal(free.length,1,label+": workspaces with projectFeeStatus free = "+free.map(w=>w.id));
 assert.equal(s.acct.freeWorkspaceId,free[0].id,label+": account.freeWorkspaceId points at the free record");
}

test("emulator: N devices create at once -> exactly one free workspace",{skip},async()=>{
 for(let round=0;round<ROUNDS;round++){
  const owner=await newOwner();
  const devices=Array.from({length:5},()=>device(owner));
  const results=await Promise.allSettled(devices.map((d,i)=>d.service.create(d.req,{name:"Device "+i,intentId:uuid()})));
  const ok=results.filter(r=>r.status==="fulfilled").map(r=>r.value);
  assert.equal(ok.length,5,"all creates succeed: "+results.filter(r=>r.status==="rejected").map(r=>r.reason?.code||r.reason?.message));
  assert.equal(ok.filter(r=>r.isFree===true&&r.monthlyPriceCents===0).length,1,"round "+round+" response isFree count");
  assert.equal(ok.filter(r=>r.isFree===false&&r.monthlyPriceCents===500).length,4);
  oneFree(await state(devices[0],owner),"round "+round);
  await Promise.all(devices.map(d=>d.db.terminate()));
 }
});

test("emulator: delete the free workspace while another device creates -> exactly one free, stored id consistent",{skip},async()=>{
 for(let round=0;round<ROUNDS;round++){
  const owner=await newOwner();
  const a=device(owner),b=device(owner);
  const freeId=uuid(),paidId=uuid();
  await a.service.create(a.req,{name:"Free",intentId:freeId});
  await a.service.create(a.req,{name:"Paid",intentId:paidId});
  const results=await Promise.allSettled([a.service.remove(a.req,freeId),b.service.create(b.req,{name:"Racing create",intentId:uuid()})]);
  assert.deepEqual(results.map(r=>r.status),["fulfilled","fulfilled"],JSON.stringify(results.map(r=>r.reason?.message)));
  const s=await state(a,owner);
  assert.equal(s.docs.length,2);
  oneFree(s,"round "+round);
  // The older remaining workspace (paidId) must be the free one, not the racing new create.
  assert.equal(s.acct.freeWorkspaceId,paidId,"round "+round+" oldest remaining hosted is free");
  await Promise.all([a.db.terminate(),b.db.terminate()]);
 }
});

test("emulator: tie-break -> two workspaces with identical createdAt, lower id takes the slot when it reopens",{skip},async()=>{
 const owner=await newOwner();
 const d=device(owner);
 const freeId="00000000-0000-4000-8000-000000000001";
 await d.service.create(d.req,{name:"Free",intentId:freeId});
 const ts=(await d.db.collection("gd_accounts").doc(owner).collection("workspaces").doc(freeId).get()).data().createdAt;
 const lo="00000000-0000-4000-8000-00000000000a",hi="00000000-0000-4000-8000-00000000000b";
 await d.service.create(d.req,{name:"Higher id",intentId:hi});
 await d.service.create(d.req,{name:"Lower id",intentId:lo});
 const later=new (require("@google-cloud/firestore").Timestamp)(ts.seconds+10,ts.nanoseconds);
 for(const id of [lo,hi])await d.db.collection("gd_accounts").doc(owner).collection("workspaces").doc(id).update({createdAt:later});
 await d.service.remove(d.req,freeId);
 const s=await state(d,owner);
 oneFree(s,"tie");
 assert.equal(s.acct.freeWorkspaceId,lo);
 await d.db.terminate();
});

test("emulator: concurrent BYO register of the free workspace and a create -> one free hosted workspace",{skip},async()=>{
 for(let round=0;round<ROUNDS;round++){
  const owner=await newOwner();
  const a=device(owner),b=device(owner);
  const freeId=uuid();
  await a.service.create(a.req,{name:"Free",intentId:freeId});
  const byo={provider:"s3",endpoint:"https://bucket.s3.us-east-1.amazonaws.com",bucketFingerprint:"ef".repeat(8)};
  const results=await Promise.allSettled([a.service.registerByo(a.req,freeId,byo),b.service.create(b.req,{name:"Racing",intentId:uuid()})]);
  assert.deepEqual(results.map(r=>r.status),["fulfilled","fulfilled"],JSON.stringify(results.map(r=>r.reason?.message)));
  const s=await state(a,owner);
  const hostedFree=s.docs.filter(w=>w.projectFeeStatus==="free"&&!w.byoRegistered);
  assert.equal(hostedFree.length,1,"round "+round);
  assert.equal(s.acct.freeWorkspaceId,hostedFree[0].id);
  await Promise.all([a.db.terminate(),b.db.terminate()]);
 }
});
