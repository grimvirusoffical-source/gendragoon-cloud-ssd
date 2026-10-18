"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const express=require("express");
const {installV2Errors}=require("./v2_errors");

test("unmatched /v2 paths and parser failures are JSON errors with no stack",async()=>{
 const app=express();
 app.use("/v2",express.json({limit:"16kb"}));
 app.get("/v2/boom",(_req,_res,next)=>next(Object.assign(Error("secret stack"),{stack:"Error: secret stack\n at hidden"})));
 installV2Errors(app);
 const server=app.listen(0,"127.0.0.1");
 await new Promise(resolve=>server.once("listening",resolve));
 const base="http://127.0.0.1:"+server.address().port;
 try{
  const missing=await fetch(base+"/v2/not-a-route");
  assert.equal(missing.status,404);
  assert.deepEqual(await missing.json(),{error:"not_found"});
  const broken=await fetch(base+"/v2/account",{method:"POST",headers:{"content-type":"application/json"},body:"{"});
  assert.equal(broken.status,400);
  assert.deepEqual(await broken.json(),{error:"invalid_json"});
  const huge=await fetch(base+"/v2/account",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pad:"x".repeat(20*1024)})});
  assert.equal(huge.status,413);
  assert.deepEqual(await huge.json(),{error:"payload_too_large"});
  const failed=await fetch(base+"/v2/boom");
  assert.equal(failed.status,500);
  const body=await failed.json();
  assert.deepEqual(body,{error:"internal"});
  assert.equal(JSON.stringify(body).includes("secret stack"),false);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
