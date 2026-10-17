"use strict";
/* Customer-paid logical workspaces in a private Google Cloud bucket.
   Access requires an activated project (basic2GB or verified storage upgrade)
   and its authenticated Google account. Each project has its own
   isolated object prefix and independent quota/transfer governor.
*/
const crypto=require("node:crypto");
const express=require("express");
const {pipeline}=require("node:stream/promises");
const {effectiveStorageQuota}=require("./projects");
const {TransferGovernor}=require("./performance");
const CHUNK=8*1024*1024,MAX_SINGLE_FILE=2_000_000_000,MAX_CHUNKS=Math.ceil(MAX_SINGLE_FILE/CHUNK);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function safeName(name){
 if(typeof name!=="string")throw Error("File name must be a string");
 const n=name.trim().normalize("NFC");
 if(!n||n.length>150||n==="."||n===".."||/[\\/\x00-\x1f]/.test(n))throw Error("Invalid file name");
 return n;
}
function scopeFromWorkspace(workspace,accountHash,id){
 if(!UUID.test(id)||workspace?.kind!=="paid"||workspace.accountHash!==accountHash||
    effectiveStorageQuota(workspace)<=0)return null;
 return {
  prefix:"customer/"+accountHash+"/managed/"+id,
  limit:effectiveStorageQuota(workspace),
  workers:workspace.performanceActive?workspace.performanceTier:null
 };
}
function registerPaidStorage({app,db,bucket,firebaseAuth,accountKey,FieldValue,apiKeys,getAuth}){
 const governor=new TransferGovernor();
 const router=express.Router({mergeParams:true});
 router.use((req,res,next)=>{
  const required=req.method==="GET"?"files:read":"files:write";
  if(req.authKind==="api_key"&&!req.keyScopes?.includes(required))
   return res.status(403).json({error:"API key lacks "+required+" scope"});
  next();
 });
 async function authenticate(req,res,next){
  const token=(req.headers.authorization||"").replace(/^Bearer /,"");
  if(!token.startsWith("gdsk_"))return firebaseAuth(req,res,next);
  try{
   const verified=await apiKeys.verify(token,{db,auth:getAuth(),accountKey});
   if(!verified)return res.status(401).json({error:"Invalid, expired or revoked API key"});
   if(verified.workspaceId!==req.params.workspaceId)
     return res.status(403).json({error:"API key belongs to another workspace"});
   req.user={uid:verified.uid};req.authKind="api_key";req.keyScopes=verified.scopes;
   next();
  }catch(_){res.status(503).json({error:"API key verification unavailable"})}
 }
 app.use("/v2/workspaces/:workspaceId/cloud",authenticate,async(req,res,next)=>{
  const id=req.params.workspaceId;
  if(!UUID.test(id))return res.status(400).json({error:"Invalid workspace ID"});
  try{
   const userHash=accountKey(req.user.uid);
   const ref=db.collection("gd_accounts").doc(userHash).collection("workspaces").doc(id);
   const snap=await ref.get();
   if(!snap.exists)return res.status(404).json({error:"Workspace not found"});
   const info=scopeFromWorkspace(snap.data(),userHash,id);
   if(!info)return res.status(403).json({error:"An active, provisioned project is required"});
   req.paid={ref,workspace:snap.data(),...info};
   next();
  }catch(_){res.status(503).json({error:"Paid workspace unavailable"})}
 },router);
 const w=req=>req.paid.ref,uid=req=>accountKey(req.user.uid)+"-"+req.params.workspaceId;
 async function releaseExpiredUploads(req){
  const jobs=await w(req).collection("uploads").where("status","==","active").limit(30).get();
  for(const doc of jobs.docs){
   const job=doc.data();
   if(job.protocol===3)continue;
   if(!job.createdAt?.toMillis||Date.now()-job.createdAt.toMillis()<24*3600_000)continue;
   try{
    await db.runTransaction(async tx=>{
     const [ws,session]=await Promise.all([tx.get(w(req)),tx.get(doc.ref)]);
     if(!session.exists||session.data().status!=="active")return;
     tx.update(w(req),{reservedBytes:FieldValue.increment(-session.data().sizeBytes)});
     tx.update(doc.ref,{status:"expired",expiredAt:FieldValue.serverTimestamp()});
    });
    await bucket.deleteFiles({prefix:req.paid.prefix+"/temp/"+doc.id+"/",force:true});
   }catch(_){/* Retry stale-session cleanup next time. */}
  }
 }
 async function compose(prefix,id,count,dest){
  let parts=Array.from({length:count},(_,i)=>prefix+"/temp/"+id+"/"+String(i).padStart(4,"0"));
  let level=0;
  while(parts.length>32){
   const out=[];
   for(let i=0;i<parts.length;i+=32){
    const name=prefix+"/temp/"+id+"/level"+level+"-"+Math.floor(i/32);
    await bucket.combine(parts.slice(i,i+32),name);
    out.push(name);
   }
   parts=out;level++;
  }
  await bucket.combine(parts,dest);
 }
 router.get("/files",async(req,res)=>{
  try{
   const docs=await w(req).collection("files").orderBy("createdAt","desc").limit(150).get();
   const fresh=await w(req).get();
   const d=fresh.data();
   const current=scopeFromWorkspace(d,accountKey(req.user.uid),req.params.workspaceId);
   if(!current)return res.status(403).json({error:"Project is not active"});
   res.json({files:docs.docs.map(x=>({id:x.id,name:x.data().name,sizeBytes:x.data().sizeBytes})),
     quotaBytes:current.limit,usedBytes:d.usedBytes||0,
     workers:require("./billing_v2").effectiveWorkers(d)});
  }catch(_){res.status(503).json({error:"Paid file listing unavailable"})}
 });
 router.post("/uploads",express.json({limit:"4kb"}),async(req,res)=>{
  const size=req.body?.sizeBytes;
  let name;
  try{name=safeName(req.body?.name)}catch(_){return res.status(400).json({error:"Invalid file name"})}
  if(!Number.isSafeInteger(size)||size<1||size>Math.min(req.paid.limit,MAX_SINGLE_FILE))
   return res.status(400).json({error:"File size must be 1 byte to 2 GB"});
  const id=crypto.randomUUID(),ref=w(req).collection("uploads").doc(id);
  try{
   await releaseExpiredUploads(req);
   await db.runTransaction(async tx=>{
    const snap=await tx.get(w(req));
    if(!snap.exists)return Promise.reject(Error("MISSING"));
    const cur=scopeFromWorkspace(snap.data(),accountKey(req.user.uid),req.params.workspaceId);
    if(!cur)throw Error("NOT_ACTIVE");
    if((snap.data().usedBytes||0)+(snap.data().reservedBytes||0)+size>cur.limit)throw Error("QUOTA");
    tx.update(w(req),{reservedBytes:FieldValue.increment(size)});
    tx.create(ref,{name,sizeBytes:size,status:"active",nextIndex:0,uploadedBytes:0,
      createdAt:FieldValue.serverTimestamp()});
   });
   res.status(201).json({uploadId:id,chunkBytes:CHUNK,totalChunks:Math.ceil(size/CHUNK)});
  }catch(error){res.status(error.message==="QUOTA"?413:409).json({error:"Storage unavailable or quota exceeded"})}
 });
 router.get("/uploads/:uploadId",async(req,res)=>{
  if(!UUID.test(req.params.uploadId))return res.status(400).end();
  try{
   const snap=await w(req).collection("uploads").doc(req.params.uploadId).get();
   if(!snap.exists)return res.status(404).end();
   res.json({status:snap.data().status,nextIndex:snap.data().nextIndex,
     totalChunks:Math.ceil(snap.data().sizeBytes/CHUNK)});
  }catch(_){res.status(503).end()}
 });
 router.put("/uploads/:uploadId/chunks/:index",async(req,res)=>{
  const id=req.params.uploadId,index=Number(req.params.index),length=Number(req.headers["content-length"]);
  if(!UUID.test(id)||!Number.isSafeInteger(index)||index<0||index>=MAX_CHUNKS)
   return res.status(400).json({error:"Invalid chunk"});
  const ref=w(req).collection("uploads").doc(id);
  try{
   const snap=await ref.get();
   if(!snap.exists||snap.data().status!=="active")return res.status(404).end();
   const job=snap.data();
   if(index!==job.nextIndex||index>=Math.ceil(job.sizeBytes/CHUNK))
    return res.status(409).json({error:"Out-of-order chunk"});
   const expected=Math.min(CHUNK,job.sizeBytes-index*CHUNK);
   if(length!==expected)return res.status(400).json({error:"Incorrect chunk length"});
   await governor.run(uid(req),req.paid.workspace,async()=>{
    const key=req.paid.prefix+"/temp/"+id+"/"+String(index).padStart(4,"0");
    const file=bucket.file(key);
    await pipeline(req,file.createWriteStream({resumable:false,validation:"crc32c",
      preconditionOpts:{ifGenerationMatch:0}}));
    const [meta]=await file.getMetadata();
    if(Number(meta.size)!==expected)throw Error("Chunk size mismatch");
    await db.runTransaction(async tx=>{
     const current=await tx.get(ref);
     if(!current.exists||current.data().status!=="active"||current.data().nextIndex!==index)
      throw Error("Upload session changed");
     tx.update(ref,{uploadedBytes:FieldValue.increment(expected),nextIndex:index+1});
    });
   });
   res.json({nextIndex:index+1,saved:true});
  }catch(_){res.status(503).json({error:"Upload failed; query resumable upload status"})}
 });
 router.post("/uploads/:uploadId/finalize",async(req,res)=>{
  const id=req.params.uploadId;
  if(!UUID.test(id))return res.status(400).end();
  const ref=w(req).collection("uploads").doc(id);
  try{
   const snap=await ref.get();
   if(!snap.exists)return res.status(404).end();
   const job=snap.data();
   if(job.status==="completed")return res.json({saved:true,fileId:id});
   if(job.status!=="active"||job.uploadedBytes!==job.sizeBytes||
      job.nextIndex!==Math.ceil(job.sizeBytes/CHUNK))
    return res.status(409).json({error:"Upload incomplete"});
   const target=req.paid.prefix+"/files/"+id;
   await governor.run(uid(req),req.paid.workspace,async()=>{
    await compose(req.paid.prefix,id,Math.ceil(job.sizeBytes/CHUNK),target);
    const [meta]=await bucket.file(target).getMetadata();
    if(Number(meta.size)!==job.sizeBytes)throw Error("Cloud size mismatch");
    await db.runTransaction(async tx=>{
     const [ws,session]=await Promise.all([tx.get(w(req)),tx.get(ref)]);
     if(!ws.exists||!scopeFromWorkspace(ws.data(),accountKey(req.user.uid),req.params.workspaceId))
      throw Error("Storage subscription inactive");
     if(!session.exists||session.data().status!=="active")throw Error("Upload no longer active");
     tx.update(w(req),{usedBytes:FieldValue.increment(job.sizeBytes),
       reservedBytes:FieldValue.increment(-job.sizeBytes)});
     tx.create(w(req).collection("files").doc(id),
       {name:job.name,sizeBytes:job.sizeBytes,createdAt:FieldValue.serverTimestamp()});
     tx.update(ref,{status:"completed",completedAt:FieldValue.serverTimestamp()});
    });
   });
   bucket.deleteFiles({prefix:req.paid.prefix+"/temp/"+id+"/",force:true}).catch(()=>{});
   res.json({saved:true,fileId:id,name:job.name});
  }catch(_){res.status(503).json({error:"Finalize failed; retry safely"})}
 });
 router.get("/files/:fileId/download",async(req,res)=>{
  const id=req.params.fileId;if(!UUID.test(id))return res.status(400).end();
  try{
   const snap=await w(req).collection("files").doc(id).get();
   if(!snap.exists)return res.status(404).end();
   await require("./range_download").sendObject(req,res,{
    file:bucket.file(req.paid.prefix+"/files/"+id),record:snap.data(),id,
    run:fn=>governor.run(uid(req),req.paid.workspace,fn)});
  }catch(error){if(process.env.GD_LOCAL_TEST_DEBUG==="1")console.error("download error",error?.message);if(!res.headersSent)res.status(503).json({error:"Download unavailable"});else res.destroy()}
 });
 router.delete("/files/:fileId",async(req,res)=>{
  const id=req.params.fileId;if(!UUID.test(id))return res.status(400).end();
  const ref=w(req).collection("files").doc(id);
  try{
   const snap=await ref.get();if(!snap.exists)return res.status(404).end();
   await bucket.file(req.paid.prefix+"/files/"+id).delete({ignoreNotFound:true});
   await db.runTransaction(async tx=>{
    const f=await tx.get(ref);
    if(!f.exists)return;
    tx.delete(ref);
    tx.update(w(req),{usedBytes:FieldValue.increment(-f.data().sizeBytes)});
   });
   res.json({deleted:true});
  }catch(error){if(process.env.GD_LOCAL_TEST_DEBUG==="1")console.error("delete error",error?.message);res.status(503).json({error:"File removal unavailable"})}
 });
 return {governor};
}
module.exports={registerPaidStorage,scopeFromWorkspace,safeName,CHUNK,MAX_SINGLE_FILE};
