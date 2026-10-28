"use strict";
// Shared authenticated transfer protocol for desktop, mobile and browser clients.
// Existing v1/v2 APIs and file records remain compatible. Never trusts client tier claims.
const express=require("express"),crypto=require("node:crypto");
const {effectiveWorkers,effectiveStorageQuota}=require("./billing_v2");
const {scopeFromWorkspace,safeName}=require("./paid_storage");
const {listAccountProjects}=require("./projects");
const {summarizeProjects,lockBody,LIST_UNAVAILABLE_LOCK}=require("./workspace_policy");
const {sendObject}=require("./range_download");
const {nativeProfile}=require("./performance");
const {resolveTeamWorkspace}=require("./team_storage");
const CHUNK=8*1024*1024,FREE_QUOTA=2_000_000_000,MAX_FILE=5*1024**4;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
function problem(status,message){return Object.assign(Error(message),{status});}
function itemMetadata(body,size){
 const kind=body?.kind||"file",format=body?.archiveFormat;
 if(!["file","folder","app"].includes(kind))throw problem(400,"Invalid item kind");
 let originalName;
 try{originalName=safeName(body?.originalName??body?.name);}catch(_){throw problem(400,"Invalid original item name");}
 if(format===undefined||format===null){
  if(kind!=="file"||body?.manifestSHA256!==undefined||(body?.logicalBytes!==undefined&&body.logicalBytes!==size))
   throw problem(400,"Folders and applications require a verified package");
  return {kind,originalName,logicalBytes:size};
 }
 if(format!=="gendragoon-package-v1"||!SHA.test(body?.manifestSHA256||"")||
    !Number.isSafeInteger(body?.logicalBytes)||body.logicalBytes<0||body.logicalBytes>MAX_FILE)
  throw problem(400,"Invalid package metadata");
 if(kind==="app"&&!originalName.toLowerCase().endsWith(".app"))throw problem(400,"Invalid application package name");
 return {kind,originalName,archiveFormat:format,manifestSHA256:body.manifestSHA256,logicalBytes:body.logicalBytes};
}
function publicItem(id,data){
 return {id,name:data.name,sizeBytes:data.sizeBytes,generation:data.generation||null,crc32c:data.crc32c||null,
  kind:data.kind||"file",originalName:data.originalName||data.name,logicalBytes:data.logicalBytes??data.sizeBytes,
  ...(data.archiveFormat?{archiveFormat:data.archiveFormat,manifestSHA256:data.manifestSHA256}:{}),
  createdAt:data.createdAt?.toDate?data.createdAt.toDate().toISOString():null};
}
// Firestore Standard rejects arrays directly containing arrays. Persist map entries,
// while keeping the existing pair-array HTTP protocol and legacy job reads compatible.
function receivedRanges(job){
 const size=job.sizeBytes,raw=job.receivedRanges===undefined?[]:job.receivedRanges;
 if(!Number.isSafeInteger(size)||size<0||size>MAX_FILE||!Array.isArray(raw))
  throw problem(409,"Stored upload progress is invalid");
 const count=Math.ceil(size/CHUNK);let previousEnd=-2;
 return raw.map(value=>{
  let start,end;
  if(Array.isArray(value)&&value.length===2)[start,end]=value;
  else if(value&&typeof value==="object"&&!Array.isArray(value)&&
    Object.keys(value).length===2&&Object.hasOwn(value,"start")&&Object.hasOwn(value,"end"))
   ({start,end}=value);
  else throw problem(409,"Stored upload progress is invalid");
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||
    end>=count||start<=previousEnd+1)throw problem(409,"Stored upload progress is invalid");
  previousEnd=end;return [start,end];
 });
}
function storedRanges(ranges){return ranges.map(([start,end])=>({start,end}));}
function contains(ranges,index){return ranges.some(([a,b])=>index>=a&&index<=b);}
function addRange(ranges,index){
 const sorted=[...ranges.map(x=>[...x]),[index,index]].sort((a,b)=>a[0]-b[0]),out=[];
 for(const pair of sorted){const last=out[out.length-1];if(last&&pair[0]<=last[1]+1)last[1]=Math.max(last[1],pair[1]);else out.push(pair);}
 return out;
}
function nextMissing(ranges){return ranges[0]?.[0]===0?ranges[0][1]+1:0;}
function profile(workspace){
 const workers=effectiveWorkers(workspace);
 return {workers,chunkBytes:CHUNK,parallelUploads:true,rangeDownloads:true,resumable:true,
  maxMemoryBytes:workers*CHUNK*2,artificialBandwidthCapMbps:null,
  recommendedMobileWorkers:Math.min(4,workers),recommendedCellularWorkers:1,
  defaultPrefetchBytes:nativeProfile(workspace).preloadMiB*1024*1024,nativeApplication:nativeProfile(workspace),preloadOnCellular:false,
  speedGuarantee:false};
}
function registerTransferV3({app,db,bucket,firebaseAuth,accountKey,FieldValue,apiKeys,getAuth,freeGovernor,paidGovernor}){
 const router=express.Router({mergeParams:true}),locks=new Map();
 // Cloud Run max-instances must remain one until the governors use distributed leases.
 async function serial(key,fn){
  const previous=locks.get(key)||Promise.resolve();
  const current=previous.catch(()=>{}).then(fn);locks.set(key,current);
  try{return await current;}finally{if(locks.get(key)===current)locks.delete(key);}
 }
 async function authenticate(req,res,next){
  const token=(req.headers.authorization||"").replace(/^Bearer /,"");
  if(!token.startsWith("gdsk_"))return firebaseAuth(req,res,next);
  try{
   const verified=await apiKeys.verify(token,{db,auth:getAuth(),accountKey});
   if(!verified)return res.status(401).json({error:"Invalid API key"});
   if(verified.workspaceId!==req.params.workspaceId)return res.status(403).json({error:"API key workspace mismatch"});
   const required=["GET","HEAD"].includes(req.method)?"files:read":"files:write";
   if(!verified.scopes?.includes(required))return res.status(403).json({error:"Missing API key scope"});
   req.user={uid:verified.uid};req.authKind="api_key";next();
  }catch(_){res.status(503).json({error:"Authentication unavailable"});}
 }
 async function context(req){
  const id=req.params.workspaceId,hash=accountKey(req.user.uid);
  if(id!=="free"&&!UUID.test(id))throw problem(400,"Invalid workspace");
  const ref=id==="free"?db.collection("tenants").doc(hash).collection("workspaces").doc("free"):
   db.collection("gd_accounts").doc(hash).collection("workspaces").doc(id);
  const snap=await ref.get();
  if(!snap.exists){
   // Not a personal workspace: maybe a team workspace this account is a member of.
   // API keys are per personal workspace and never open a team workspace.
   const t=id!=="free"&&req.authKind!=="api_key"?await resolveTeamWorkspace(db,hash,id,{method:req.method}):null;
   if(!t)throw problem(404,"Workspace not found");
   if(!["GET","HEAD","DELETE"].includes(req.method)&&t.scope.uploadsBlocked){const error=problem(423,"workspace_lock");error.lock=t.scope.lock;throw error;}
   return {id,hash,ref:t.ref,workspace:t.view,quota:t.scope.limit,prefix:t.scope.prefix,governor:paidGovernor,key:t.governorKey,
    projects:null,team:t,scopeOf:data=>t.rescope(data)};
  }
  const w=snap.data();let quota,prefix,governor,key;
  if(!req._accountProjects)req._accountProjects=listAccountProjects(db,hash).catch(()=>null);
  const listed=await req._accountProjects;
  const write=!["GET","HEAD","DELETE"].includes(req.method);
  const projects=Array.isArray(listed)?listed:null;
  if(id==="free"){
   if(w.accountKey!==hash)throw problem(404,"Workspace not found");
   if(w.kind!=="free"||w.provisioned!==true)throw problem(403,"Free workspace unavailable");
   if(write){
    if(!projects){const error=problem(423,"workspace_lock");error.lock=LIST_UNAVAILABLE_LOCK;throw error;}
    const summary=summarizeProjects(projects);
    if(summary.locked){const error=problem(423,"workspace_lock");error.lock=lockBody(summary);throw error;}
    if(w.mergeLock&&w.mergeLock.expiresAtMs>Date.now()){const error=problem(423,"workspace_lock");error.lock={error:"workspace_lock",reason:"merge_in_progress",overBy:0,unpaidWorkspaceIds:[]};throw error;}
   }
   quota=effectiveStorageQuota(w);
   if(quota<=0)throw problem(403,"Project is archived or unavailable");
   prefix="customer/"+hash+"/free";governor=freeGovernor;key=hash;
  }else{
   if(w.accountHash!==hash)throw problem(404,"Workspace not found");
   const scope=scopeFromWorkspace(w,hash,id,projects);if(!scope)throw problem(403,"Active provisioned storage required");
   if(write&&scope.uploadsBlocked){const error=problem(423,"workspace_lock");error.lock=scope.lock||LIST_UNAVAILABLE_LOCK;throw error;}
   quota=scope.limit;prefix=scope.prefix;governor=paidGovernor;key=hash+"-"+id;
  }
  return {id,hash,ref,workspace:w,quota,prefix,governor,key,projects,team:null,
   scopeOf:data=>id==="free"?null:scopeFromWorkspace(data,hash,id,projects)};
 }
 async function work(req,fn){
  const c=await context(req);
  return c.governor.run(c.key,c.workspace,async()=>{
   if(req.aborted)throw problem(499,"Client disconnected");
   // Recheck ownership and entitlement after waiting in a transfer queue.
   const fresh=await context(req);return fn(fresh);
  });
 }
 function route(method,path,fn){router[method](path,async(req,res)=>{
  try{await fn(req,res);}catch(error){
   if(res.headersSent)return res.destroy();
   if(error.status===423&&error.lock)return res.status(423).json(error.lock);
   const status=error.status||(/Too many/.test(error.message)?429:503);
   if(status===429||status===503)res.set("Retry-After","2");
   res.status(status).json({error:error.status?error.message:"Transfer unavailable; retry safely",
    ...(error.status&&typeof error.code==="string"?{code:error.code}:{})});
  }
 });}
 const {makeLaunchIntent}=require('./app_launch_intents');
 const stamp=()=>FieldValue.serverTimestamp();
 const jobRef=(c,id)=>{if(!UUID.test(id))throw problem(400,"Invalid upload");return c.ref.collection("uploads").doc(id);};
 const temp=(c,id)=>c.prefix+"/tmp-v3/"+id+"/";
 function statusOf(x){const ranges=receivedRanges(x);return {status:x.status,uploadId:x.id,chunkBytes:CHUNK,
  totalChunks:Math.ceil(x.sizeBytes/CHUNK),sizeBytes:x.sizeBytes,
  receivedRanges:ranges,nextIndex:nextMissing(ranges),
  uploadedBytes:x.uploadedBytes||0};}
 router.use(express.json({limit:"8kb"}));
 route("post","/app-launch-intents",async(req,res)=>{
  if(req.authKind==="api_key")throw problem(403,"Account session required for application launch requests");
  const c=await context(req);if(c.team)throw problem(403,"Use a personal workspace for mobile launchers");
  if(!UUID.test(req.body?.key||""))throw problem(400,"Invalid application item");
  const file=c.ref.collection("files").doc(req.body.key),ref=c.ref.collection("appLaunchIntents").doc(req.body.key);
  let result;const now=Date.now();
  await db.runTransaction(async tx=>{
   const snap=await tx.get(file);if(!snap.exists)throw problem(404,"Application not found");
   const previous=await tx.get(ref);
   result={...makeLaunchIntent(snap.data(),req.body,now),workspace:c.id};
   if(previous.exists&&previous.data().id===result.id){result=previous.data();return;}
   if(previous.exists&&previous.data().createdMs>now-1000)throw problem(429,"Wait before requesting this app again");
   if(previous.exists)tx.update(ref,result);else tx.create(ref,result);
  });
  res.status(202).json(result);
 });
 route("get","/config",async(req,res)=>{
  const c=await context(req);res.json({workspaceId:c.id,name:c.workspace.name,
   quotaBytes:c.quota,usedBytes:c.workspace.usedBytes||0,reservedBytes:c.workspace.reservedBytes||0,
   maxFileBytes:Math.min(MAX_FILE,c.quota),transfer:profile(c.workspace),protocol:3});
 });
 route("get","/files",async(req,res)=>{
  const c=await context(req);let query=c.ref.collection("files").orderBy("createdAt","desc");
  if(req.query.cursor){
   if(!UUID.test(req.query.cursor))throw problem(400,"Invalid cursor");
   const cursor=await c.ref.collection("files").doc(req.query.cursor).get();
   if(!cursor.exists)throw problem(400,"Expired cursor");query=query.startAfter(cursor);
  }
  const result=await query.limit(151).get(),docs=result.docs.slice(0,150);
  res.json({files:docs.map(d=>publicItem(d.id,d.data())),nextCursor:result.docs.length>150?docs[149].id:null,
   quotaBytes:c.quota,usedBytes:c.workspace.usedBytes||0,workers:effectiveWorkers(c.workspace)});
 });
 async function cleanStale(c){
  const queries=await Promise.all(["active","assembling"].map(status=>c.ref.collection("uploads").where("status","==",status).limit(50).get()));
  for(const doc of queries.flatMap(x=>x.docs)){
   const x=doc.data(),time=x.updatedAt||x.createdAt;if(x.protocol!==3)continue;
   if(!["active","assembling"].includes(x.status)||!time?.toMillis||Date.now()-time.toMillis()<24*3600_000)continue;
   await serial(c.key+doc.id,async()=>{
    await db.runTransaction(async tx=>{
     const snap=await tx.get(doc.ref);if(!snap.exists||!["active","assembling"].includes(snap.data().status))return;
     const fresh=snap.data().updatedAt||snap.data().createdAt;
     if(!fresh?.toMillis||Date.now()-fresh.toMillis()<24*3600_000)return;
     tx.update(c.ref,{reservedBytes:FieldValue.increment(-snap.data().sizeBytes)});
     tx.update(doc.ref,{status:"expired",updatedAt:stamp()});
    });
    if((await doc.ref.get()).data()?.status==="expired")await bucket.deleteFiles({prefix:temp(c,doc.id),force:true});
   });
  }
 }
 route("post","/uploads",async(req,res)=>{
  const c=await context(req),size=req.body?.sizeBytes;
  let name;try{name=safeName(req.body?.name);}catch(_){throw problem(400,"Invalid file name");}
  if(!Number.isSafeInteger(size)||size<0||size>Math.min(MAX_FILE,c.quota))throw problem(400,"File exceeds workspace file limit");
  const metadata=itemMetadata(req.body,size);
  const id=req.body?.requestId||crypto.randomUUID(),ref=jobRef(c,id);
  await cleanStale(c);
  const result=await db.runTransaction(async tx=>{
   const [ws,existing]=await Promise.all([tx.get(c.ref),tx.get(ref)]);
   if(!ws.exists)throw problem(404,"Workspace removed");
   const w=ws.data();
   const scope=c.id==="free"?null:c.scopeOf(w);
   const quota=c.team?(scope?.limit||0):effectiveStorageQuota(w);
   if(quota<=0||(c.id==="free"?w.accountKey!==c.hash:!scope))throw problem(403,"Project storage inactive");
   if(scope&&scope.uploadsBlocked){const error=problem(423,"workspace_lock");error.lock=scope.lock||LIST_UNAVAILABLE_LOCK;throw error;}
   if(existing.exists){
    const old=existing.data();
    const previous=itemMetadata({name:old.name,kind:old.kind,originalName:old.originalName,
      archiveFormat:old.archiveFormat,manifestSHA256:old.manifestSHA256,logicalBytes:old.logicalBytes},old.sizeBytes);
    if(old.protocol!==3||old.name!==name||old.sizeBytes!==size||JSON.stringify(previous)!==JSON.stringify(metadata))throw problem(409,"Request ID already used");
    return old;
   }
   if((w.usedBytes||0)+(w.reservedBytes||0)+size>quota)throw problem(413,"Storage quota exceeded");
   const job={id,protocol:3,name,sizeBytes:size,...metadata,status:"active",receivedRanges:[],uploadedBytes:0,createdAt:stamp(),updatedAt:stamp()};
   tx.update(c.ref,{reservedBytes:FieldValue.increment(size)});tx.create(ref,job);return job;
  });
  res.status(201).json({...statusOf(result),workers:effectiveWorkers(c.workspace)});
 });
 route("get","/uploads/:id",async(req,res)=>{
  const c=await context(req),snap=await jobRef(c,req.params.id).get();
  if(!snap.exists||snap.data().protocol!==3)throw problem(404,"Upload not found");
  res.json(statusOf(snap.data()));
 });
 route("put","/uploads/:id/chunks/:index",async(req,res)=>{
  const index=Number(req.params.index),length=Number(req.headers["content-length"]),sha=req.headers["x-chunk-sha256"];
  if(!Number.isSafeInteger(index)||index<0||!SHA.test(sha||"")||!Number.isSafeInteger(length)||length<1||length>CHUNK)
   throw problem(400,"Chunk index, length and SHA-256 are required");
  await work(req,async c=>{
   const ref=jobRef(c,req.params.id);
   await serial(c.key+req.params.id+":"+index,async()=>{
    const snap=await ref.get();if(!snap.exists||snap.data().protocol!==3)throw problem(404,"Upload not found");
    const job=snap.data(),count=Math.ceil(job.sizeBytes/CHUNK),ranges=receivedRanges(job);
    if(job.status!=="active")throw problem(409,"Upload not active");
    if(index>=count||length!==Math.min(CHUNK,job.sizeBytes-index*CHUNK))throw problem(400,"Incorrect chunk size");
    if(index>nextMissing(ranges)+256)throw problem(429,"Too many out-of-order chunks; complete earlier chunks first");
    const file=bucket.file(temp(c,req.params.id)+"chunk-"+index);
    if(contains(ranges,index)){
     const [meta]=await file.getMetadata();if(meta.metadata?.sha256!==sha)throw problem(409,"Chunk already exists with different content");
     req.resume();return;
    }
    // Bound memory by one 8 MiB chunk per verified worker, never whole files.
    const chunks=[];let actual=0;
    for await(const data of req){actual+=data.length;if(actual>length)throw problem(400,"Chunk too long");chunks.push(data);}
    if(actual!==length)throw problem(400,"Incomplete chunk");
    const buffer=Buffer.concat(chunks,actual),actualHash=crypto.createHash("sha256").update(buffer).digest("hex");
    if(actualHash!==sha)throw problem(422,"Chunk SHA-256 mismatch");
    try{await file.save(buffer,{resumable:false,validation:"crc32c",preconditionOpts:{ifGenerationMatch:0},metadata:{metadata:{sha256:sha}}});}
    catch(error){
     if(Number(error.code)!==412)throw error;
     const [meta]=await file.getMetadata();
     if(Number(meta.size)!==length||meta.metadata?.sha256!==sha)throw problem(409,"Conflicting stored chunk");
    }
    await db.runTransaction(async tx=>{
     const current=await tx.get(ref);if(!current.exists||current.data().status!=="active")throw problem(409,"Upload changed");
     const r=receivedRanges(current.data());if(contains(r,index))return;
     tx.update(ref,{receivedRanges:storedRanges(addRange(r,index)),uploadedBytes:FieldValue.increment(length),updatedAt:stamp()});
    });
   });
  });
  res.json({saved:true,index});
 });
 route("post","/uploads/:id/finalize",async(req,res)=>{
  let response;
  await work(req,c=>serial(c.key+req.params.id,async()=>{
   const ref=jobRef(c,req.params.id),snap=await ref.get();
   if(!snap.exists||snap.data().protocol!==3)throw problem(404,"Upload not found");
   const job=snap.data(),count=Math.ceil(job.sizeBytes/CHUNK);
   if(job.status==="completed"){response={saved:true,fileId:req.params.id};return;}
   if(!["active","assembling"].includes(job.status)||nextMissing(receivedRanges(job))!==count||job.uploadedBytes!==job.sizeBytes)
    throw problem(409,"Upload incomplete");
   if(job.status==="active")await ref.update({status:"assembling",assemblyLevel:0,assemblyCursor:0,updatedAt:stamp()});
   let level=job.assemblyLevel||0,cursor=job.assemblyCursor||0,operations=0;
   const target=c.prefix+"/files/"+req.params.id;
   async function commitFile(meta){
    if(Number(meta.size)!==job.sizeBytes)throw Error("Composed size mismatch");
    const metadata=itemMetadata({name:job.name,kind:job.kind,originalName:job.originalName,
      archiveFormat:job.archiveFormat,manifestSHA256:job.manifestSHA256,logicalBytes:job.logicalBytes},job.sizeBytes);
    await db.runTransaction(async tx=>{
     const [ws,current]=await Promise.all([tx.get(c.ref),tx.get(ref)]);
     if(current.data()?.status==="completed")return;
     if(!ws.exists||current.data()?.status!=="assembling")throw problem(409,"Upload changed");
     const freshScope=c.id==="free"?null:c.scopeOf(ws.data());
     if((c.team?!freshScope:effectiveStorageQuota(ws.data())<=0)||(c.id!=="free"&&!freshScope))throw problem(403,"Project storage inactive");
     if(freshScope&&freshScope.uploadsBlocked){const error=problem(423,"workspace_lock");error.lock=freshScope.lock||LIST_UNAVAILABLE_LOCK;throw error;}
     tx.create(c.ref.collection("files").doc(req.params.id),{name:job.name,sizeBytes:job.sizeBytes,...metadata,
      generation:meta.generation||null,crc32c:meta.crc32c||null,createdAt:stamp()});
     tx.update(c.ref,{usedBytes:FieldValue.increment(job.sizeBytes),reservedBytes:FieldValue.increment(-job.sizeBytes)});
     tx.update(ref,{status:"completed",updatedAt:stamp()});
    });
    try{await bucket.deleteFiles({prefix:temp(c,req.params.id),force:true});}catch(_){await ref.update({cleanupNeeded:true});}
    response={saved:true,fileId:req.params.id,name:job.name,...metadata,crc32c:meta.crc32c||null};
   }
   if(count===0){
    const file=bucket.file(target);
    try{await file.save(Buffer.alloc(0),{resumable:false,validation:"crc32c",preconditionOpts:{ifGenerationMatch:0}});}
    catch(error){if(Number(error.code)!==412)throw error;}
    const [meta]=await file.getMetadata();await commitFile(meta);return;
   }
   const source=(lv,i)=>temp(c,req.params.id)+(lv===0?"chunk-"+i:"assembled-"+(lv-1)+"-"+i);
   while(operations<32){
    const inputs=Math.ceil(count/(32**level)),outputs=Math.ceil(inputs/32);
    if(cursor>=outputs){level++;cursor=0;}
    const n=Math.ceil(count/(32**level)),last=n<=32;
    const keys=Array.from({length:Math.min(32,n-cursor*32)},(_,j)=>source(level,cursor*32+j));
    const dest=last?target:temp(c,req.params.id)+"assembled-"+level+"-"+cursor;
    await bucket.combine(keys,dest);operations++;cursor++;
    if(last){
     const [meta]=await bucket.file(target).getMetadata();await commitFile(meta);return;
    }
    await ref.update({assemblyLevel:level,assemblyCursor:cursor,updatedAt:stamp()});
   }
   response={saved:false,status:"assembling",retryAfterSeconds:1};
  }));
  res.status(response.saved?200:202).json(response);
 });
 route("delete","/uploads/:id",async(req,res)=>{
  const c=await context(req),ref=jobRef(c,req.params.id);
  await serial(c.key+req.params.id,async()=>{
   await db.runTransaction(async tx=>{
    const snap=await tx.get(ref);if(!snap.exists||snap.data().protocol!==3)throw problem(404,"Upload not found");
    if(snap.data().status==="completed")throw problem(409,"Cannot cancel a completed file");
    if(!["active","assembling"].includes(snap.data().status))return;
    tx.update(c.ref,{reservedBytes:FieldValue.increment(-snap.data().sizeBytes)});tx.update(ref,{status:"cancelled",updatedAt:stamp()});
   });
   await bucket.deleteFiles({prefix:temp(c,req.params.id),force:true});
  });res.json({cancelled:true});
 });
 route("get","/files/:id/download",async(req,res)=>{
  const c=await context(req);if(!UUID.test(req.params.id))throw problem(400,"Invalid file");
  const snap=await c.ref.collection("files").doc(req.params.id).get();if(!snap.exists)throw problem(404,"File not found");
  const record=snap.data();
  const file=bucket.file(c.prefix+"/files/"+req.params.id,record.generation?{generation:record.generation}:{});
  await sendObject(req,res,{file,record,id:req.params.id,run:fn=>work(req,fn)});
 });
 route("delete","/files/:id",async(req,res)=>{
  const c=await context(req);if(!UUID.test(req.params.id))throw problem(400,"Invalid file");
  const ref=c.ref.collection("files").doc(req.params.id),snap=await ref.get();if(!snap.exists)throw problem(404,"File not found");
  await bucket.file(c.prefix+"/files/"+req.params.id).delete({ignoreNotFound:true});
  await db.runTransaction(async tx=>{const s=await tx.get(ref);if(!s.exists)return;tx.delete(ref);tx.update(c.ref,{usedBytes:FieldValue.increment(-s.data().sizeBytes)});});
  res.json({deleted:true});
 });
 app.use("/v3/cloud/:workspaceId",authenticate,router);
 app.get("/v3/capabilities",(_req,res)=>res.json({protocol:3,chunkBytes:CHUNK,
  authenticatedStorage:true,resumableUploads:true,parallelChunks:true,rangeDownloads:true,
  nativeMobileAppExecution:false,remoteComputeProvisioned:false,
  nativeFilesExtensionsInstalled:false,checkoutProvider:"stripe",checkoutEnabled:process.env.STRIPE_CHECKOUT_ENABLED==="true"}));
 return {router,profile};
}
module.exports={registerTransferV3,receivedRanges,storedRanges,addRange,contains,nextMissing,profile,itemMetadata,publicItem,CHUNK,MAX_FILE};
