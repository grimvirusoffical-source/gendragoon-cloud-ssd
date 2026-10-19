"use strict";
// Starts /provider/v1 on 127.0.0.1 with in-memory Firestore and blob fakes, connects one binding, and prints one JSON
// line {"base","key","quotaBytes"} on stdout. Used by the Go contract test in contract/redxpack. Never touches a cloud.
const crypto=require("node:crypto");
const express=require("express");
const {memoryFirestore}=require("../test_firestore");
const {memoryBlobStore}=require("../provider_blobstore");
const {registerProviderV1}=require("../provider_v1");
const quotaBytes=Number(process.env.GD_CONTRACT_QUOTA||64*1024*1024);
const app=express(),db=memoryFirestore(),blobs=memoryBlobStore();
registerProviderV1({app,db,blobs,accountKey:u=>crypto.createHash("sha256").update("gd-v1:"+u).digest("hex"),
 firebaseAuth:(req,res,next)=>{req.user={uid:"contract-user"};next();},
 resolveWorkspace:async()=>({quotaBytes}),limits:{rps:10000,burst:10000}});
const server=app.listen(0,"127.0.0.1",async()=>{
 const base="http://127.0.0.1:"+server.address().port+"/provider/v1";
 const g=await (await fetch(base+"/connect/grants",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({workspaceId:"free"})})).json();
 const r=await (await fetch(base+"/connect/redeem",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({grant:g.grant})})).json();
 process.stdout.write(JSON.stringify({base,key:r.apiKey,quotaBytes})+"\n");
});
process.stdin.on("end",()=>process.exit(0));process.stdin.resume();
