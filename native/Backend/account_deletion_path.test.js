"use strict";
// Contract pin for the account-deletion status path (Avery's final ruling):
//   GET /v2/account/deletions/:jobId   (plural)  -> served
//   GET /v2/account/deletion/:jobId    (singular) -> NOT served (404)
// Stub service only: no network, keys, or Stripe.
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");

const STATUS_PATH="/v2/account/deletions/";
const SINGULAR_PATH="/v2/account/deletion/";
const JOB_ID="3f2b8c1e-6a4d-4e7b-9c2a-1d5e8f0a7b36";
const MODULE=path.join(__dirname,"account_delete.js");

test("deletion status is served only at plural /v2/account/deletions/:jobId",async()=>{
 assert.ok(fs.existsSync(MODULE),"account_delete.js is not on this branch yet");
 const express=require("express");
 const {registerAccountDeletion}=require(MODULE);
 const {installV2Errors}=require("./v2_errors");
 const service={deleteAccount:async()=>({status:202,jobId:JOB_ID}),
  jobStatus:async(id)=>id===JOB_ID?{status:"running",retryable:false,failure:null}:null};
 const app=express();
 app.use(express.json());
 registerAccountDeletion({app,service,firebaseAuth:(req,_res,next)=>{req.user={uid:"u1",auth_time:0};next();}});
 installV2Errors(app);
 const server=app.listen(0,"127.0.0.1");
 await new Promise(r=>server.once("listening",r));
 try{
  const base="http://127.0.0.1:"+server.address().port;
  const plural=await fetch(base+STATUS_PATH+JOB_ID,{headers:{authorization:"Bearer idtoken.u1"}});
  assert.equal(plural.status,200);
  assert.equal((await plural.json()).jobId,JOB_ID);
  const missing=await fetch(base+STATUS_PATH+JOB_ID);
  assert.equal(missing.status,401);
  assert.deepEqual(await missing.json(),{error:"unauthorized"});
  const singular=await fetch(base+SINGULAR_PATH+JOB_ID);
  assert.equal(singular.status,404,"singular /deletion/ must not be served");
  assert.deepEqual(await singular.json(),{error:"not_found"});
  const unknown=await fetch(base+"/v2/not-a-route");
  assert.equal(unknown.status,404);
  assert.deepEqual(await unknown.json(),{error:"not_found"});
 }finally{server.close();}
});
