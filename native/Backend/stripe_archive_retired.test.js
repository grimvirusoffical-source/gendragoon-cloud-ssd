"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {RETIRED,main}=require("./scripts/stripe_archive_retired");
const {expectedCatalog,isRetired}=require("./billing_bootstrap");
function fake(prices){
 const state={prices,updates:[]};
 function Stripe(){return {prices:{list:()=>({async*[Symbol.asyncIterator](){yield* state.prices;}}),
  update:async(id,args)=>{state.updates.push(id);const p=state.prices.find(x=>x.id===id);Object.assign(p,args);return p;}}};}
 return {state,Stripe:()=>Stripe};
}
const price=(r,extra={})=>({id:"price_"+r.catalogKey.replace(/\W/g,""),active:true,livemode:true,currency:"usd",unit_amount:r.cents,
 type:r.interval?"recurring":"one_time",recurring:r.interval?{interval:r.interval,interval_count:1}:null,lookup_key:r.lookupKey,metadata:{service:"GenDragoonSSD",catalogKey:r.catalogKey},...extra});
const LIVE={STRIPE_SECRET_KEY:"rk_live_fixtureOnly123"};
const run=async(argv,f,env=LIVE)=>{let out="";const r=await main(argv,{env,Stripe:f.Stripe,write:s=>out+=s});return {...r,out:out&&JSON.parse(out)};};
test("the retired list matches the bootstrap's retired keys and amounts",()=>{
 const exp=expectedCatalog();
 for(const r of RETIRED){assert.ok(isRetired(r.catalogKey));if(exp[r.catalogKey])assert.equal(exp[r.catalogKey].cents,r.cents);}
 assert.equal(Object.keys(exp).filter(isRetired).length,4);
});
test("dry run is read-only; apply needs --live --confirm-archive; test keys refused",async()=>{
 const f=fake([...RETIRED.map(r=>price(r)),{id:"price_storage",active:true,metadata:{service:"GenDragoonSSD",catalogKey:"storage|standard|100GB|month"}}]);
 const dry=await run([],f);assert.equal(dry.out.prices.filter(p=>p.action==="archive").length,4);assert.equal(f.state.updates.length,0);
 assert.equal((await run(["--apply","--live"],f)).code,2);assert.equal(f.state.updates.length,0);
 await assert.rejects(run([],f,{STRIPE_SECRET_KEY:"sk_test_x1"}),/LIVE key/);
 const done=await run(["--apply","--live","--confirm-archive"],f);
 assert.deepEqual(f.state.updates.sort(),RETIRED.map(r=>price(r).id).sort(),"only the four retired recurring Prices");
 assert.equal(f.state.prices.find(p=>p.id==="price_storage").active,true);
 assert.ok(done.out.prices.every(p=>p.action==="archived"));
 const again=await run(["--apply","--live","--confirm-archive"],f);
 assert.ok(again.out.prices.every(p=>p.action==="already_archived"));assert.equal(f.state.updates.length,4,"idempotent");
});
test("an unexpected amount or a duplicate aborts before archiving anything",async()=>{
 const f=fake(RETIRED.map((r,i)=>price(r,i===3?{unit_amount:999}:{})));
 await assert.rejects(run(["--apply","--live","--confirm-archive"],f),/does not match/);assert.equal(f.state.updates.length,0);
 const g=fake([...RETIRED.map(r=>price(r)),price(RETIRED[0],{id:"price_dup"})]);
 await assert.rejects(run(["--apply","--live","--confirm-archive"],g),/2 Prices match/);assert.equal(g.state.updates.length,0);
});
