"use strict";
// Contract pin for the account-deletion status path (Avery's final ruling):
//   GET /v2/account/deletions/:jobId   (plural)  -> served
//   GET /v2/account/deletion/:jobId    (singular) -> NOT served (404)
// Marked todo until Riley's PR #6 (account_delete.js) is merged into this line
// and any singular alias is dropped. A todo failure does not fail CI; once it
// passes, drop the todo flag. Stub service only: no network, keys, or Stripe.
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");

const STATUS_PATH="/v2/account/deletions/";
const SINGULAR_PATH="/v2/account/deletion/";
const JOB_ID="3f2b8c1e-6a4d-4e7b-9c2a-1d5e8f0a7b36";
const MODULE=path.join(__dirname,"account_delete.js");

test("deletion status is served only at plural /v2/account/deletions/:jobId",
 {todo:"needs account_delete.js from PR #6 and the singular alias removed"},async()=>{
 assert.ok(fs.existsSync(MODULE),"account_delete.js is not on this branch yet");
 const express=require("express");
 const {registerAccountDeletion}=require(MODULE);
 const service={deleteAccount:async()=>({status:202,jobId:JOB_ID}),
  jobStatus:async(id)=>id===JOB_ID?{status:"running",retryable:false,failure:null}:null};
 const app=express();
 app.use(express.json());
 registerAccountDeletion({app,service,firebaseAuth:(req,_res,next)=>{req.user={uid:"u1",auth_time:0};next();}});
 const server=app.listen(0,"127.0.0.1");
 await new Promise(r=>server.once("listening",r));
 try{
  const base="http://127.0.0.1:"+server.address().port;
  const plural=await fetch(base+STATUS_PATH+JOB_ID);
  assert.equal(plural.status,200);
  assert.equal((await plural.json()).jobId,JOB_ID);
  const singular=await fetch(base+SINGULAR_PATH+JOB_ID);
  assert.equal(singular.status,404,"singular /deletion/ must not be served");
  const text=await singular.text();
  assert.ok(!text.includes('"running"'),"singular path leaked job status");
 }finally{server.close();}
});
