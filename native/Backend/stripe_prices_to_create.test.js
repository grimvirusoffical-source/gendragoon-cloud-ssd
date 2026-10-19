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
