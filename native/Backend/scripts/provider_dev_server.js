"use strict";
// Local GenDragoon backend for SDK development and tests: the real /provider/v1 routes with in-memory Firestore and
// object storage (or the Storage emulator when STORAGE_EMULATOR_HOST is set). Loopback only, no cloud credentials.
//
//   PROVIDER_V1_ENABLED=true node scripts/provider_dev_server.js [--port 8787]
//
// Prints one JSON line {"origin","base"} on stdout once listening, then serves until SIGTERM (or, with
// --exit-with-stdin, until stdin closes, so a test harness cannot leak it).
//
// Signed-in user calls (connect grants, authorize, bindings) take a development token instead of a Firebase ID
// token:  Authorization: Bearer dev-user:<uid>.  Workspaces: any id; "small" has a 64 KiB quota, every other id
// has GD_DEV_QUOTA bytes (default 64 MiB).
if(process.env.PROVIDER_V1_ENABLED!=="true"){
 process.stderr.write("provider_dev_server: set PROVIDER_V1_ENABLED=true to start the provider API\n");process.exit(2);
}
const crypto=require("node:crypto");
const express=require("express");
const {memoryFirestore}=require("../test_firestore");
const {memoryBlobStore,gcsBlobStore}=require("../provider_blobstore");
const {registerProviderV1}=require("../provider_v1");

const arg=name=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:undefined;};
const port=Number(arg("--port")||process.env.PORT||0);
const quota=Number(process.env.GD_DEV_QUOTA||64*1024*1024);

async function blobStore(){
 if(!process.env.STORAGE_EMULATOR_HOST)return memoryBlobStore();
 const {Storage}=require("@google-cloud/storage");
 const storage=new Storage({apiEndpoint:process.env.STORAGE_EMULATOR_HOST,projectId:"gd-dev",useAuthWithCustomEndpoint:false});
 const bucket=storage.bucket(process.env.GD_DEV_BUCKET||"gd-dev");
 const [exists]=await bucket.exists();if(!exists)await storage.createBucket(bucket.name);
 return gcsBlobStore(bucket);
}

(async()=>{
 const app=express();
 app.set("trust proxy",false);
 const firebaseAuth=(req,res,next)=>{
  const m=/^Bearer dev-user:([A-Za-z0-9_-]{1,64})$/.exec(req.headers.authorization||"");
  if(!m)return res.status(401).json({error:"invalid_token"});
  req.user={uid:m[1]};next();
 };
 const notices=[];
 registerProviderV1({app,db:memoryFirestore(),blobs:await blobStore(),firebaseAuth,
  accountKey:uid=>crypto.createHash("sha256").update("gd-v1:"+uid).digest("hex"),
  resolveWorkspace:async(_uid,id)=>/^[A-Za-z0-9_-]{1,64}$/.test(id)?{quotaBytes:id==="small"?64*1024:quota}:null,
  limits:{rps:5000,burst:5000,grantsPer10Min:10_000,redeemPerMinPerIp:10_000},
  notify:async(uid,kind)=>{notices.push({uid,kind});}});
 app.get("/dev/notices",(req,res)=>res.json({notices}));
 const server=app.listen(port,"127.0.0.1",()=>{
  const origin="http://127.0.0.1:"+server.address().port;
  process.stdout.write(JSON.stringify({origin,base:origin+"/provider/v1"})+"\n");
 });
 const stop=()=>server.close(()=>process.exit(0));
 process.on("SIGTERM",stop);process.on("SIGINT",stop);
 if(process.argv.includes("--exit-with-stdin")){process.stdin.on("end",stop);process.stdin.resume();}
})().catch(e=>{process.stderr.write("provider_dev_server: "+e.message+"\n");process.exit(1);});
