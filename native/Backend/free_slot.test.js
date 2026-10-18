"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const express=require("express");
const {memoryFirestore}=require("./test_firestore");
const {createProjectService,workspacePrice,freeWorkspaceId,byoLapsed,effectiveStorageQuota}=require("./projects");
const {WORKSPACE_FEE_CENTS,isGrandfathered}=require("./workspace_policy");
const {registerPaidStorage}=require("./paid_storage");
const owner=crypto.createHash("sha256").update("free-slot-owner").digest("hex");
const idFor=n=>"12345678-1234-4000-8000-"+String(n).padStart(12,"0");
const AFTER=Date.parse("2026-10-18T00:00:00Z");
const base={kind:"paid",accountHash:owner,name:"Existing",projectBillingVersion:2,projectStatus:"active",projectFeeStatus:"paid",
 provisioned:true,storageActive:false,performanceActive:false,usedBytes:0,reservedBytes:0,createdAt:1_700_000_000_000};
function hosted(id,createdAt,extra={}){
 return {...base,id,createdAt,workspaceFeeModel:"monthly",projectFeeStatus:"pending",projectStatus:"active",provisioned:true,...extra};
}
const byoBody={provider:"s3",endpoint:"https://bucket.s3.us-east-1.amazonaws.com",bucketFingerprint:"ab".repeat(8)};
function fixture(){
 const db=memoryFirestore([["gd_accounts/"+owner,{stripeCustomerId:"cus_own"}]]);
 const price={id:"price_month",active:true,type:"recurring",recurring:{interval:"month"},currency:"usd",unit_amount:500,billing_scheme:"per_unit",livemode:false,product:{active:true}};
 const stripe={prices:{retrieve:async()=>({...price})},checkout:{sessions:{create:async()=>({id:"cs_month",url:"https://checkout.stripe.com/c/pay/cs_month",status:"open"}),retrieve:async()=>{throw Error("missing");}}}};
 const env={STRIPE_CHECKOUT_ENABLED:"true",STRIPE_WORKSPACE_MONTHLY_READY:"true",STRIPE_WORKSPACE_MONTHLY_PRICE_ID:"price_month",STRIPE_ENVIRONMENT:"test",PUBLIC_URL:"https://billing.example"};
 const service=createProjectService({db,stamp:()=>AFTER,hash:()=>owner,stripe,env,ensureCustomer:async()=>"cus_own"});
 const req={user:{uid:"owner"}};
 const path=id=>"gd_accounts/"+owner+"/workspaces/"+id;
 return {db,service,req,path,create:(n,name)=>service.create(req,{name:name||"Project "+n,intentId:idFor(n)}),
  record:id=>db.rows.get(path(id)),account:()=>db.rows.get("gd_accounts/"+owner)};
}
function views(f){return [1,2,3,4,5,6,7].filter(n=>f.record(idFor(n))).map(n=>({...f.record(idFor(n)),id:idFor(n)}));}

test("freeWorkspaceId is the oldest non-grandfathered hosted workspace and never a BYO workspace",()=>{
 const older=hosted(idFor(2),AFTER);
 const newer=hosted(idFor(3),AFTER+1000);
 const byo={...hosted(idFor(1),AFTER-1000),kind:"byo",byoRegistered:true,providerType:"s3"};
 assert.equal(freeWorkspaceId({freeWorkspaceId:idFor(2)},[byo,newer,older]),idFor(2));
 assert.equal(freeWorkspaceId({},[byo,newer,older]),idFor(2));
 assert.equal(workspacePrice(byo,idFor(2)).isFree,false);
 assert.equal(workspacePrice(byo,idFor(2)).monthlyPriceCents,500);
 assert.deepEqual(workspacePrice(older,idFor(2)),{isFree:true,monthlyPriceCents:0});
 assert.deepEqual(workspacePrice(newer,idFor(2)),{isFree:false,monthlyPriceCents:WORKSPACE_FEE_CENTS});
});

test("freeWorkspaceId breaks ties by createdAtMs then workspace id",()=>{
 const sameTimeLow=hosted("b-low",AFTER,{createdAtMs:AFTER});
 const sameTimeHigh=hosted("c-high",AFTER-50_000,{createdAtMs:AFTER});
 assert.equal(freeWorkspaceId({},[sameTimeHigh,sameTimeLow]),"b-low");
 const earlier=hosted("z-later-id",AFTER+5_000,{createdAtMs:AFTER});
 const later=hosted("a-earlier-id",AFTER,{createdAtMs:AFTER+5_000});
 assert.equal(freeWorkspaceId({},[later,earlier]),"z-later-id");
 const undated=hosted("a-undated",null);
 delete undated.createdAt;delete undated.createdAtMs;
 assert.equal(freeWorkspaceId({},[undated,hosted("z-dated",AFTER+9_000)]),"z-dated");
});

test("a grandfathered one-time workspace never takes the free slot",()=>{
 const grandfathered={...base,id:idFor(2),feeIsOneTime:true,projectFeeStatus:"paid",createdAt:1_700_000_000_000};
 const newer=hosted(idFor(9),AFTER);
 assert.equal(isGrandfathered(grandfathered),true);
 assert.equal(freeWorkspaceId({freeWorkspaceId:idFor(2)},[grandfathered,newer]),idFor(9));
 assert.equal(freeWorkspaceId({},[grandfathered]),null);
 assert.deepEqual(workspacePrice(grandfathered,idFor(9)),{isFree:false,monthlyPriceCents:0});
 assert.deepEqual(workspacePrice(newer,idFor(9)),{isFree:true,monthlyPriceCents:0});
});

test("the first hosted workspace is free and a lone BYO workspace is $5 and lapsed",async()=>{
 const f=fixture();
 const first=await f.create(1,"Free Hosted");
 assert.equal(first.isFree,true);assert.equal(first.monthlyPriceCents,0);
 assert.equal(first.project.data.projectFeeStatus,"free");
 assert.equal(f.account().freeWorkspaceId,idFor(1));
 const registered=await f.service.registerByo(f.req,idFor(1),byoBody);
 assert.equal(registered.isFree,false);assert.equal(registered.monthlyPriceCents,500);
 assert.equal(registered.freeWorkspaceId,null);assert.equal(registered.lapsed,true);
 const state=await f.service.inventory(f.req);
 assert.equal(state.policy.freeWorkspaceId,null);
 assert.equal(state.policy.locked,true);assert.equal(state.policy.reason,"lapsed");
 assert.deepEqual(state.policy.unpaidWorkspaceIds,[idFor(1)]);
 assert.equal(byoLapsed(f.record(idFor(1))),true);
});

test("the second hosted workspace is $5 per month",async()=>{
 const f=fixture();
 await f.create(1);const second=await f.create(2,"Second");
 assert.equal(second.isFree,false);assert.equal(second.monthlyPriceCents,500);
 assert.equal(second.project.data.workspaceFeeModel,"monthly");
 assert.equal(second.project.data.projectFeeStatus,"pending");
 const state=await f.service.inventory(f.req);
 assert.equal(state.records.filter(w=>w.id===state.policy.freeWorkspaceId).length,1);
});

test("deleting the free workspace makes the oldest remaining hosted one free, or the next create",async()=>{
 const f=fixture();
 await f.create(1);await f.create(2);
 await f.service.remove(f.req,idFor(1));
 assert.equal(f.account().freeWorkspaceId,idFor(2));
 assert.equal(f.record(idFor(2)).projectFeeStatus,"free");
 assert.equal(f.record(idFor(1)),undefined);
 const third=await f.create(3,"Paid after promotion");
 assert.equal(third.isFree,false);assert.equal(third.monthlyPriceCents,500);
 const alone=fixture();
 await alone.create(1);
 await alone.service.remove(alone.req,idFor(1));
 assert.equal(alone.account().freeWorkspaceId,null);
 const replacement=await alone.create(2,"Replacement");
 assert.equal(replacement.isFree,true);assert.equal(replacement.monthlyPriceCents,0);
 const extra=await alone.create(3,"One at a time");
 assert.equal(extra.isFree,false);
 assert.equal(views(alone).filter(w=>w.id===alone.account().freeWorkspaceId).length,1);
});

test("registering BYO on the free workspace makes it billable and moves the slot",async()=>{
 const f=fixture();
 await f.create(1);await f.create(2);
 const moved=await f.service.registerByo(f.req,idFor(1),byoBody);
 assert.equal(moved.isFree,false);assert.equal(moved.monthlyPriceCents,500);
 assert.equal(moved.freeWorkspaceId,idFor(2));
 assert.equal(f.record(idFor(2)).projectFeeStatus,"free");
 assert.equal(f.record(idFor(1)).projectFeeStatus,"pending");
 assert.equal(byoLapsed(f.record(idFor(1))),true);
 const state=await f.service.inventory(f.req);
 assert.equal(state.policy.reason,"lapsed");
 assert.deepEqual(state.policy.unpaidWorkspaceIds,[idFor(1)]);
});

test("two simultaneous creates produce exactly one free workspace",async()=>{
 const f=fixture();
 const created=await Promise.all([f.create(1,"Concurrent A"),f.create(2,"Concurrent B")]);
 assert.equal(created.filter(item=>item.isFree===true&&item.monthlyPriceCents===0).length,1);
 assert.equal(created.filter(item=>item.isFree===false&&item.monthlyPriceCents===500).length,1);
 const state=await f.service.inventory(f.req);
 assert.equal(state.records.filter(w=>w.id===state.policy.freeWorkspaceId).length,1);
 assert.equal(state.records.filter(w=>w.data.projectFeeStatus==="free").length,1);
});

test("merge keeps the survivor's fee status",async()=>{
 const f=fixture();
 await f.create(1,"Source");await f.create(2,"Survivor");await f.create(3,"Other");
 await f.service.merge(f.req,idFor(1),{targetId:idFor(2),confirmName:"Source"});
 assert.equal(f.record(idFor(1)),undefined);
 assert.equal(f.record(idFor(2)).projectFeeStatus,"pending");
 assert.equal(f.account().freeWorkspaceId,idFor(3));
 assert.equal(f.record(idFor(3)).projectFeeStatus,"free");
 const kept=fixture();
 await kept.create(1,"Paid source");await kept.create(2,"Free survivor");
 await kept.service.remove(kept.req,idFor(1));
 assert.equal(kept.record(idFor(2)).projectFeeStatus,"free");
 await kept.create(3,"Later paid");
 await kept.service.merge(kept.req,idFor(3),{targetId:idFor(2),confirmName:"Later paid"});
 assert.equal(kept.record(idFor(2)).projectFeeStatus,"free");
 assert.equal(kept.account().freeWorkspaceId,idFor(2));
});

test("a workspace that returns from BYO is eligible again by its original createdAt",async()=>{
 const f=fixture();
 const olderAt=AFTER,youngerAt=AFTER+86_400_000;
 await f.create(5,"Returns");
 await f.create(1,"Younger");
 f.db.rows.set(f.path(idFor(5)),{...f.record(idFor(5)),createdAt:olderAt});
 f.db.rows.set(f.path(idFor(1)),{...f.record(idFor(1)),createdAt:youngerAt});
 await f.service.registerByo(f.req,idFor(5),byoBody);
 assert.equal(f.account().freeWorkspaceId,idFor(1));
 assert.equal(f.record(idFor(1)).projectFeeStatus,"free");
 const back=await f.service.makeHosted(f.req,idFor(5));
 assert.equal(back.createdAt,olderAt);
 assert.equal(back.freeWorkspaceId,idFor(5));
 assert.equal(f.record(idFor(5)).createdAt,olderAt);
 assert.equal(f.record(idFor(5)).projectFeeStatus,"free");
 assert.equal(f.record(idFor(5)).byoRegistered,false);
 assert.equal(f.record(idFor(5)).providerType,null);
 assert.equal(f.record(idFor(1)).projectFeeStatus,"pending");
 assert.equal(f.account().freeWorkspaceId,idFor(5));
});

test("deleting the free workspace while a create runs leaves exactly one free workspace",async()=>{
 const alone=fixture();
 await alone.create(1,"Only free");
 await Promise.all([alone.service.remove(alone.req,idFor(1)),alone.create(3,"Replacement")]);
 const replaced=await alone.service.inventory(alone.req);
 assert.equal(replaced.records.length,1);
 assert.equal(replaced.policy.freeWorkspaceId,idFor(3));
 assert.equal(replaced.records.filter(w=>w.data.projectFeeStatus==="free").length,1);
 const f=fixture();
 await f.create(1,"Free");
 await f.create(2,"Stays");
 await Promise.all([f.service.remove(f.req,idFor(1)),f.create(3,"Arriving")]);
 const state=await f.service.inventory(f.req);
 assert.equal(state.records.length,2);
 assert.equal(state.policy.freeWorkspaceId,idFor(2));
 assert.equal(f.record(idFor(2)).projectFeeStatus,"free");
 assert.equal(f.record(idFor(3)).projectFeeStatus,"pending");
 assert.equal(state.records.filter(w=>w.id===state.policy.freeWorkspaceId).length,1);
});

test("a grandfathered one-time workspace stays exempt from the monthly lapse",()=>{
 const grandfathered={...base,id:idFor(1),feeIsOneTime:true,projectFeeStatus:"paid",createdAt:1_700_000_000_000};
 assert.equal(isGrandfathered(grandfathered),true);
 assert.equal(byoLapsed(grandfathered),false);
 assert.deepEqual(workspacePrice(grandfathered,idFor(1)),{isFree:false,monthlyPriceCents:0});
 const byoGrand={...grandfathered,kind:"byo",byoRegistered:true,providerType:"s3",workspaceFeeModel:"monthly",workspaceFeeStatus:"unpaid",workspaceFeePaid:false};
 assert.equal(isGrandfathered(byoGrand),false);
 assert.equal(workspacePrice(byoGrand,null).monthlyPriceCents,500);
 assert.equal(byoLapsed(byoGrand),true);
});

test("an unpaid BYO workspace upload is 423 workspace_lock lapsed",async()=>{
 const f=fixture();
 await f.create(1,"Only BYO");
 await f.service.registerByo(f.req,idFor(1),byoBody);
 assert.ok(effectiveStorageQuota(f.record(idFor(1)))>0);
 const app=express();
 registerPaidStorage({app,db:f.db,bucket:{file:()=>({})},accountKey:()=>owner,
  apiKeys:{verify:async()=>null},getAuth:()=>({}),FieldValue:{increment:n=>({increment:n}),serverTimestamp:()=>1},
  firebaseAuth:(req,res,next)=>{if(req.headers.authorization!=="Bearer owner")return res.status(401).end();req.user={uid:"owner"};next();}});
 const server=app.listen(0,"127.0.0.1");
 await new Promise(resolve=>server.once("listening",resolve));
 try{
  const response=await fetch("http://127.0.0.1:"+server.address().port+"/v2/workspaces/"+idFor(1)+"/cloud/uploads",
   {method:"POST",headers:{Authorization:"Bearer owner","Content-Type":"application/json"},body:JSON.stringify({name:"notes.txt",sizeBytes:4})});
  const body=await response.json();
  assert.equal(response.status,423);
  assert.equal(body.error,"workspace_lock");
  assert.equal(body.reason,"lapsed");
  assert.deepEqual(body.unpaidWorkspaceIds,[idFor(1)]);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

function assertZeroIffFreeOrGrandfathered(body,label){
 const items=[...(Array.isArray(body.workspaces)?body.workspaces:[]),...(Array.isArray(body.projects)?body.projects:[])];
 if(body.project)items.push(body.project);
 for(const item of items){
  if(typeof item.monthlyPriceCents!=="number")continue;
  assert.equal(item.monthlyPriceCents===0,item.isFree===true||item.grandfathered===true,label+" "+(item.id||item.name));
 }
 if(typeof body.monthlyPriceCents==="number"&&typeof body.isFree==="boolean"){
  const grandfathered=body.grandfathered===true||body.project?.grandfathered===true;
  assert.equal(body.monthlyPriceCents===0,body.isFree===true||grandfathered,label+" response");
 }
}
test("monthlyPriceCents is 0 exactly when isFree or grandfathered on list and create responses",async()=>{
 const {registerBillingV2}=require("./billing_v2");
 const db=memoryFirestore([["gd_accounts/"+owner,{stripeCustomerId:"cus_own"}]]);
 db.rows.set("gd_accounts/"+owner+"/workspaces/"+idFor(8),{...base,name:"One-time",feeIsOneTime:true,projectFeeStatus:"paid",createdAt:1_700_000_000_000});
 const price={id:"price_month",active:true,type:"recurring",recurring:{interval:"month"},currency:"usd",unit_amount:500,billing_scheme:"per_unit",livemode:false,product:{active:true}};
 const stripe={prices:{retrieve:async()=>({...price})},customers:{create:async()=>({id:"cus_own"})},checkout:{sessions:{create:async()=>({id:"cs_month",url:"https://checkout.stripe.com/c/pay/cs_month",status:"open"}),retrieve:async()=>{throw Error("missing");}}}};
 const env={STRIPE_CHECKOUT_ENABLED:"true",STRIPE_WORKSPACE_MONTHLY_READY:"true",STRIPE_WORKSPACE_MONTHLY_PRICE_ID:"price_month",STRIPE_ENVIRONMENT:"test",PUBLIC_URL:"https://billing.example"};
 const app=express();
 app.use(express.json());
 registerBillingV2({app,db,stripe,admin:{firestore:{FieldValue:{serverTimestamp:()=>AFTER}}},
  auth:(req,_res,next)=>{req.user={uid:"owner"};next();},agreed:(_q,_s,n)=>n(),hash:()=>owner,env,prices:{}});
 const server=app.listen(0,"127.0.0.1");
 await new Promise(resolve=>server.once("listening",resolve));
 const root="http://127.0.0.1:"+server.address().port;
 const send=(method,path,body)=>fetch(root+path,{method,headers:{Authorization:"Bearer owner","Content-Type":"application/json"},body:body?JSON.stringify(body):undefined}).then(async response=>({status:response.status,body:await response.json()}));
 try{
  const created=await send("POST","/v2/projects",{name:"New Hosted",intentId:idFor(9)});
  assert.equal(created.status,201);
  assert.equal(created.body.isFree,true);
  assert.equal(created.body.project.grandfathered,false);
  assertZeroIffFreeOrGrandfathered(created.body,"create");
  const second=await send("POST","/v2/projects",{name:"Paid Hosted",intentId:idFor(10)});
  assert.equal(second.status,201);
  assert.equal(second.body.isFree,false);
  assert.equal(second.body.monthlyPriceCents,500);
  assert.equal(second.body.project.grandfathered,false);
  assertZeroIffFreeOrGrandfathered(second.body,"second create");
  const listed=await send("GET","/v2/workspaces");
  assert.equal(listed.status,200);
  const old=listed.body.workspaces.find(item=>item.id===idFor(8));
  const neu=listed.body.workspaces.find(item=>item.id===idFor(9));
  assert.equal(old.isFree,false);assert.equal(old.monthlyPriceCents,0);assert.equal(old.grandfathered,true);
  assert.equal(neu.isFree,true);assert.equal(neu.monthlyPriceCents,0);assert.equal(neu.grandfathered,false);
  assert.equal(listed.body.policy.freeWorkspaceId,idFor(9));
  assertZeroIffFreeOrGrandfathered(listed.body,"list");
  const projects=await send("GET","/v2/projects");
  assertZeroIffFreeOrGrandfathered(projects.body,"projects");
 }finally{await new Promise(resolve=>server.close(resolve));}
});
