"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {plan,apply}=require("./scripts/stripe_prices_to_create");
const {TEAM_TIERS,teamPriceKey}=require("./teams");
test("the pending Stripe price plan covers the approved team, RedX Storage and master prices",()=>{
 const p=plan(),by=Object.fromEntries(p.map(x=>[x.catalogKey,x]));
 assert.equal(p.length,19);
 for(const t of Object.values(TEAM_TIERS))for(const iv of ["month","year"])
   assert.equal(by[teamPriceKey(t.id,iv)].unitAmount,iv==="year"?t.yearlyCents:t.monthlyCents,"team keys match what teams.js looks up");
 assert.equal(by["redx_storage|lite|month"].unitAmount,299);assert.equal(by["redx_storage|pro|year"].unitAmount,39990);
 assert.equal(by["one_time|download_pack_100"].unitAmount,1299);assert.equal(by["one_time|download_pack_100"].recurring,null);
 assert.equal(by["master|everything_family|year"].unitAmount,29990);
 assert.ok(!by["redx_storage|free|month"],"the free tier has no price");
 assert.equal(new Set(p.map(x=>x.lookupKey)).size,p.length);
});
test("apply refuses live or missing keys before calling Stripe",async()=>{
 let called=false;const Stripe=function(){called=true;};
 for(const key of [undefined,"sk_live_abc123","rk_live_abc123","pk_test_abc"])
   await assert.rejects(apply(plan(),{key,Stripe}),/TEST key/);
 assert.equal(called,false);
});

// Live path: deliberate flags, read-only dry run, idempotent via lookup_keys.
const {main}=require("./scripts/stripe_prices_to_create");
function fakeStripe({livemode=true}={}){
 const state={prices:[],products:[],writes:0,keys:[]};
 function Stripe(key){state.keys.push(key);return {
  prices:{list:async({lookup_keys})=>({data:state.prices.filter(p=>lookup_keys.includes(p.lookup_key))}),
   create:async(args,opts)=>{state.writes++;const p={id:"price_"+state.prices.length,livemode,active:true,type:args.recurring?"recurring":"one_time",...args};state.prices.push(p);return p;}},
  products:{list:()=>({async*[Symbol.asyncIterator](){yield* state.products;}}),
   create:async(args)=>{state.writes++;const p={id:"prod_"+state.products.length,active:true,...args};state.products.push(p);return p;}}};}
 return {state,Stripe:()=>Stripe};
}
const LIVE={STRIPE_SECRET_KEY:"rk_live_fixtureOnly123"},TESTKEY={STRIPE_SECRET_KEY:"sk_test_fixtureOnly123"};
const run=async(argv,env,f)=>{let out="";const r=await main(argv,{env,Stripe:f.Stripe,write:s=>out+=s});return {...r,out:out?JSON.parse(out):null};};
test("live: --apply --live without --confirm-live, or a test key, creates nothing",async()=>{
 const f=fakeStripe();
 assert.equal((await run(["--apply","--live"],LIVE,f)).code,2);
 assert.equal((await run(["--apply","--confirm-live"],LIVE,f)).code,2,"--confirm-live alone is not live mode");
 await assert.rejects(run(["--apply","--live","--confirm-live"],TESTKEY,f),/LIVE key/);
 await assert.rejects(run(["--apply","--confirm-test-mode"],LIVE,f),/TEST key/,"test mode still refuses live keys");
 assert.equal(f.state.writes,0);
});
test("live dry run is read-only and lists what would be created",async()=>{
 const f=fakeStripe(),r=await run(["--dry-run","--live"],LIVE,f);
 assert.equal(r.code,0);assert.equal(r.out.mode,"live-dry-run");assert.equal(r.out.toCreate,19);assert.equal(f.state.writes,0);
});
test("live apply creates 19 prices once; a rerun reuses them by lookup_key; products are reused",async()=>{
 const f=fakeStripe(),first=await run(["--apply","--live","--confirm-live"],LIVE,f);
 assert.equal(Object.keys(first.out).length,19);assert.equal(f.state.prices.length,19);
 const products=f.state.products.length,writes=f.state.writes;
 const again=await run(["--apply","--live","--confirm-live"],LIVE,f);
 assert.deepEqual(again.out,first.out);assert.equal(f.state.writes,writes,"no writes on rerun");assert.equal(f.state.products.length,products);
 const dry=await run(["--dry-run","--live"],LIVE,f);assert.equal(dry.out.toCreate,0);
 assert.ok(f.state.prices.every(p=>p.metadata.catalogKey&&p.lookup_key));
 assert.ok(f.state.prices.filter(p=>p.metadata.catalogKey.startsWith("team|")).every(p=>p.metadata.service==="GenDragoonSSD"),"team prices are found by the live bootstrap");
});
test("live apply refuses a lookup_key that exists with another amount, before creating anything",async()=>{
 const f=fakeStripe();
 f.state.prices.push({id:"price_x",lookup_key:"master_everything_year_v1",active:true,livemode:true,currency:"usd",unit_amount:1,recurring:{interval:"year",interval_count:1}});
 await assert.rejects(run(["--apply","--live","--confirm-live"],LIVE,f),/different amount/);
 assert.equal(f.state.writes,0);
});
test("a test-mode object under --live is refused",async()=>{
 const f=fakeStripe({livemode:false});
 await assert.rejects(run(["--apply","--live","--confirm-live"],LIVE,f),/livemode/);
});
