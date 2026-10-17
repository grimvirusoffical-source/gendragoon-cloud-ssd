"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {STORAGE,PERFORMANCE,buildQuote,validateWorkspaceName,stripeKeys}=require("./catalog");
test("one workspace incurs a separate $5 fee and required storage",()=>{
 const x=buildQuote({storage:"100GB",interval:"month"});
 assert.equal(x.workspaceFeeCents,500);assert.equal(x.storageCents,799);assert.equal(x.totalCents,1299);
 assert.deepEqual(stripeKeys(x),["workspace|month","storage|bundle|100GB|month"]);
});
test("two workspaces double the full charge instead of sharing storage",()=>{
 const a=buildQuote({storage:"1TB",mode:"standard"});
 assert.equal(a.totalCents*2, (500+3600)*2);
});
test("annual term applies to every recurring component",()=>{
 const x=buildQuote({storage:"1TB",interval:"year",mode:"standard",performance:"boost"});
 assert.equal(x.totalCents,47000);
 assert.deepEqual(stripeKeys(x),["workspace|year","storage|standard|1TB|year","performance|boost|year"]);
});
test("bundle forbids double charging performance",()=>{
 assert.throws(()=>buildQuote({storage:"1TB",performance:"turbo"}));
});
test("invalid plans cannot create a bucket",()=>{
 for(const storage of ["6tb","TRIAL","",null,"10000TB"]){
  assert.throws(()=>buildQuote({storage}));
 }
});
test("invalid billing cycles are rejected",()=>{
 assert.throws(()=>buildQuote({storage:"100GB",interval:"weekly"}));
});
test("no storage-free workspace quote",()=>{
 assert.throws(()=>buildQuote({storage:undefined}));
});
test("names are validated before storage provisioning",()=>{
 assert.equal(validateWorkspaceName("  My Project   1 "), "My Project 1");
 for(const name of ["../etc", "x", "hi/there", "A".repeat(100),""]) assert.throws(()=>validateWorkspaceName(name));
});
test("ten tiers available to 6TB",()=>{
 assert.equal(Object.keys(STORAGE).length,10);
 assert.equal(STORAGE["6TB"].gb,6000);
 assert.equal(Object.keys(PERFORMANCE).length,5);
});
