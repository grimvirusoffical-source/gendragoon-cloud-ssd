"use strict";
/* GenDragoonSSD free customer storage. No Stripe or privileged customer credentials.
   Firebase auth project: gendragoonssd. Runtime: Google Cloud gendragood-ssd.
   Private physical bucket: configured only on Cloud Run. Logical bucket per workspace. */
const express=require("express");
const crypto=require("node:crypto");
const {pipeline}=require("node:stream/promises");
const {initializeApp}=require("firebase-admin/app");
const {getAuth}=require("firebase-admin/auth");
const {Firestore,FieldValue}=require("@google-cloud/firestore");
const {Storage}=require("@google-cloud/storage");
const {TransferGovernor}=require("./free_performance");
const {installedBilling}=require("./billing_gateway");
const {createProjectService,ProjectError,listAccountProjects,summarizeProjects,lockBody}=require("./projects");
const {lockedWrite:lockedWriteWith}=require("./locked_write");
const {effectiveStorageQuota,effectiveWorkers}=require("./billing_v2");
const apiKeys=require("./api_keys");
const {createLoginGate}=require("./login_gate");
const required=["CUSTOMER_BUCKET","STORAGE_PROJECT_ID"];
for(const key of required)if(!process.env[key])throw Error("Missing deployment environment variable: "+key);
if(process.env.STORAGE_PROJECT_ID!=="gendragood-ssd")throw Error("Unexpected storage project");
if(process.env.CUSTOMER_BUCKET==="gen-dragoon-ssd")throw Error("Personal bucket is forbidden");
let firebaseApp,firestoreClient;
function firestore(){
 if(!firebaseApp)firebaseApp=initializeApp({projectId:"gendragoonssd"});
 if(!firestoreClient)firestoreClient=new Firestore({projectId:process.env.STORAGE_PROJECT_ID});
 return firestoreClient;
}
// Property access connects. Requiring this module does not.
const db=new Proxy({},{get(_target,prop){const real=firestore();const value=real[prop];return typeof value==="function"?value.bind(real):value;}});
const bucket=new Storage({projectId:process.env.STORAGE_PROJECT_ID}).bucket(process.env.CUSTOMER_BUCKET);
const app=express();
app.disable("x-powered-by");app.use((req,res,next)=>{
  res.set({"Cache-Control":"no-store","X-Content-Type-Options":"nosniff",
    "Referrer-Policy":"no-referrer","X-Frame-Options":"DENY"});
  next();
});
app.use("/mobile",(req,res,next)=>{
 res.setHeader("Content-Security-Policy","default-src 'none'; script-src 'self' https://www.gstatic.com https://apis.google.com; style-src 'self'; connect-src 'self' https://*.googleapis.com https://*.firebaseapp.com; frame-src https://gendragoonssd.firebaseapp.com https://accounts.google.com; img-src 'self' data:; base-uri 'none'; form-action 'self'; object-src 'none'; frame-ancestors 'none'");
 res.setHeader("Cross-Origin-Opener-Policy","same-origin-allow-popups");next();
},express.static(require("node:path").join(__dirname,"mobile"),{dotfiles:"deny",index:"index.html"}));
const QUOTA=2_000_000_000,CHUNK=8*1024*1024,MAX_CHUNKS=Math.ceil(QUOTA/CHUNK);
const governor=new TransferGovernor();
const accountKey=uid=>crypto.createHash("sha256").update("gd-v1:"+uid).digest("hex");
function workspaceRef(uid){return db.collection("tenants").doc(accountKey(uid)).collection("workspaces").doc("free")}
const freeProjectPolicy=createProjectService({db,stamp:()=>FieldValue.serverTimestamp(),hash:accountKey});
function filePrefix(uid){return "customer/"+accountKey(uid)+"/free"}
function accountURL(uid){return "https://firestore.googleapis.com/v1/projects/gendragoonssd/databases/(default)/documents/accepted_terms/"+encodeURIComponent(uid)}
const loginGate=createLoginGate({
 verifyIdToken:token=>getAuth().verifyIdToken(token),
 // Consent is verified against the *auth project's* Firestore rules, using the user's JWT.
 fetchTerms:(uid,token)=>fetch(accountURL(uid),{headers:{"Authorization":"Bearer "+token},signal:AbortSignal.timeout(8000)}),
 async decorate(req){
  req.workspaceRef=workspaceRef(req.user.uid);
  req.pathPrefix=filePrefix(req.user.uid);
  req.authKind="firebase";
  req.ownerBenefits=await require("./owner_benefits").grantOwnerBenefits({user:req.user,db,hash:accountKey,stamp:()=>FieldValue.serverTimestamp()});
 },
});
const firebaseAuth=loginGate.firebaseAuth;
const firebaseAuthWithoutTerms=loginGate.firebaseAuthWithoutTerms;
async function auth(req,res,next){
 const raw=(req.headers.authorization||"").replace(/^Bearer /,"");
 if(!raw.startsWith("gdsk_"))return firebaseAuth(req,res,next);
 try{
   const verified=await apiKeys.verify(raw,{db,auth:getAuth(),accountKey});
   if(!verified)return res.status(401).json({error:"Invalid, expired or revoked API key"});
   if(verified.workspaceId!=="free")
     return res.status(403).json({error:"This API key is restricted to a different workspace"});
   req.user={uid:verified.uid};
   req.workspaceRef=workspaceRef(verified.uid);
   req.pathPrefix=filePrefix(verified.uid);
   req.authKind="api_key";
   req.keyScopes=verified.scopes;
   next();
 }catch(_){res.status(503).json({error:"API key verification unavailable"})}
}
apiKeys.install(app,{db,firebaseAuth,accountKey,workspaceRef,FieldValue});
const requireRead=apiKeys.requireScope("files:read");
const requireWrite=apiKeys.requireScope("files:write");
// All paid-workspace drafts, pricing, Checkout links and signed Stripe events
// are registered here, but charging is OFF until secrets, webhooks and
// server-verified workspace provisioning have passed acceptance tests.
app.use("/v2",express.json({limit:"16kb"}));
require("./billing_bootstrap").installBillingBootstrap({app,db,bucket,admin:{firestore:{FieldValue}},firebaseAuth,firebaseAuthWithoutTerms,accountKey,adminAuth:getAuth()});
require("./key_envelope").registerKeyEnvelope({app,db,firebaseAuth,hash:accountKey});
require("./storage_urls").registerStorageUrls({app,db,bucket,firebaseAuth,hash:accountKey,now:()=>Date.now()});
const paidStorage=require("./paid_storage").registerPaidStorage({app,db,bucket,firebaseAuth,accountKey,FieldValue,apiKeys,getAuth});
require("./transfer_v3").registerTransferV3({app,db,bucket,firebaseAuth,accountKey,FieldValue,apiKeys,getAuth,freeGovernor:governor,paidGovernor:paidStorage.governor});
// Storage provider API for RedX (/provider/v1). OFF unless PROVIDER_V1_ENABLED=true, and provider_v1.js is not in
// deploy_free.py's runtime allow-list yet, so no deploy can enable it by accident. A binding's quota is a snapshot of
// the workspace quota at connect time; charging it against the workspace's own usedBytes is pricing decision 13.2 (open).
// Support email (password resets, account notices) from support@infected-nation.com. OFF unless
// SUPPORT_EMAIL_ENABLED=true; the SMTP password comes only from SUPPORT_EMAIL_PASSWORD and is never logged.
// support_email.js is not in deploy_free.py's allow-list yet, so it is required only when enabled.
let supportNotify=null;
if(process.env.SUPPORT_EMAIL_ENABLED==="true"){
 const supportEmail=require("./support_email");
 const sender=supportEmail.senderFromEnv(process.env);
 const log=(event,fields)=>console.log(JSON.stringify({event,...fields}));
 supportEmail.registerPasswordReset({app,adminAuth:getAuth(),sender,continueUrl:process.env.PASSWORD_RESET_CONTINUE_URL||undefined,log});
 supportNotify=supportEmail.createNotifier({sender,adminAuth:getAuth(),log});
}
if(process.env.PROVIDER_V1_ENABLED==="true"){
 require("./provider_v1").registerProviderV1({app,db,blobs:require("./provider_blobstore").gcsBlobStore(bucket),firebaseAuth,accountKey,notify:supportNotify,
  async resolveWorkspace(uid,workspaceId){
   const ref=workspaceId==="free"?workspaceRef(uid):db.collection("gd_accounts").doc(accountKey(uid)).collection("workspaces").doc(workspaceId);
   if(workspaceId!=="free"&&!/^[0-9a-f-]{36}$/.test(workspaceId))return null;
   const snap=await ref.get();if(!snap.exists)return null;
   const w=snap.data();if(w.accountKey!==undefined&&w.accountKey!==accountKey(uid)&&w.accountHash!==accountKey(uid))return null;
   const quotaBytes=effectiveStorageQuota(w);return quotaBytes>0?{quotaBytes}:null;
  },
  async isUserActive(uid){try{return !(await getAuth().getUser(uid)).disabled;}catch(_){return false;}}});
}

function safeName(input){
 if(typeof input!=="string")throw Error("Choose a file or workspace name");
 const n=input.trim().normalize("NFC");
 if(n.length<1||n.length>150||/[\\/\x00-\x1f]/.test(n)||n==="."||n==="..")throw Error("Invalid name");
 return n;
}
async function currentWorkspace(req,res){
 const doc=await req.workspaceRef.get();
 if(!doc.exists){res.status(404).json({error:"Create free workspace first"});return null}
 const w=doc.data();
 if(w.accountKey!==accountKey(req.user.uid)){res.status(404).json({error:"Workspace not found"});return null}
 if(w.kind!=="free"){res.status(403).json({error:"Workspace access denied"});return null}
 if(effectiveStorageQuota(w)<=0){res.status(403).json({error:"This project is not active. Restore or activate it in Projects."});return null}
 return w;
}
function lockedWrite(req,res){
 return lockedWriteWith(req,res,{db,accountKey,listAccountProjects,summarizeProjects,lockBody});
}
async function runFreeTransfer(req,workspace,action){
 return governor.run(accountKey(req.user.uid),workspace,async()=>{
   const fresh=await req.workspaceRef.get();
   if(!fresh.exists||fresh.data().accountKey!==accountKey(req.user.uid)||effectiveStorageQuota(fresh.data())<=0)throw Error("PROJECT_NOT_ACTIVE");
   return action();
 });
}
async function cleanupExpired(req){
 const uploads=req.workspaceRef.collection("uploads");
 const stale=await uploads.where("status","==","active").limit(30).get();
 const now=Date.now();
 for(const doc of stale.docs){
   const x=doc.data();
   if(x.protocol===3)continue;
   if(!x.createdAt?.toMillis||now-x.createdAt.toMillis()<24*3600*1000)continue;
   try{
     await db.runTransaction(async tx=>{
       const [w,s]=await Promise.all([tx.get(req.workspaceRef),tx.get(doc.ref)]);
       if(!s.exists||s.data().status!=="active")return;
       tx.update(req.workspaceRef,{reservedBytes:FieldValue.increment(-s.data().sizeBytes)});
       tx.update(doc.ref,{status:"expired"});
     });
     await bucket.deleteFiles({prefix:req.pathPrefix+"/tmp/"+doc.id+"/",force:true});
   }catch(_){/* retry cleanup on next request */}
 }
}
let lastDeepCheck=0,deepCheckStatus=false;
app.get("/health",async(req,res)=>{
  if(req.query.deep==="1" && Date.now()-lastDeepCheck>300_000){
    lastDeepCheck=Date.now();
    try{
      await bucket.file("internal-readiness/missing-object").exists();
      await db.collection("system").doc("service-health").get();
      deepCheckStatus=true;
    }catch(error){
      console.error("Readiness dependency failure",String(error?.code||error?.status||error?.name||"unknown"));
      deepCheckStatus=false;
    }
  }
  const checked=lastDeepCheck>0;
  res.status(req.query.deep==="1" && !deepCheckStatus?503:200)
    .json({ok:req.query.deep==="1"?deepCheckStatus:true,stage:"free-storage-live",billing:process.env.STRIPE_CHECKOUT_ENABLED==="true",
      dependencies:checked?(deepCheckStatus?"ready":"unavailable"):"not-checked"});
});
app.get("/v1/me",auth,async(req,res)=>{
 try{
   const w=await req.workspaceRef.get();const d=w.exists?w.data():null;
   res.json({signedIn:true,termsAccepted:true,freeWorkspace:d?{
     name:d.name,quotaBytes:effectiveStorageQuota(d),usedBytes:d.usedBytes||0,reservedBytes:d.reservedBytes||0,
     workers:effectiveWorkers(d),provisioned:effectiveStorageQuota(d)>0,
     projectStatus:require("./projects").projectStatus(d)}:null,paidPurchasesEnabled:process.env.STRIPE_CHECKOUT_ENABLED==="true"});
 }catch(_){res.status(503).json({error:"Workspace database unavailable"})}
});
app.post("/v1/free",auth,requireWrite,express.json({limit:"4kb"}),async(req,res)=>{
 try{
   const name=safeName(req.body?.name||"My Free Cloud");
   const result=await freeProjectPolicy.create(req,{name,legacyFree:true});
   res.status(201).json({created:true,name,quotaBytes:QUOTA,workers:1,policy:result.policy});
 }catch(e){
   if(e instanceof ProjectError){
     const body={error:e.code};
     if(e.message&&e.message!==e.code)body.message=e.message;
     return res.status(e.status).json(body);
   }
   if(e.code===6||e.message?.includes("ALREADY_EXISTS"))return res.status(409).json({error:"Free workspace already exists"});
   res.status(503).json({error:"Unable to create free workspace"});
 }
});
app.get("/v1/files",auth,requireRead,async(req,res)=>{
 try{
   const w=await currentWorkspace(req,res);if(!w)return;
   const docs=await req.workspaceRef.collection("files").orderBy("createdAt","desc").limit(150).get();
   res.json({quotaBytes:effectiveStorageQuota(w),usedBytes:w.usedBytes||0,workers:effectiveWorkers(w),
     files:docs.docs.map(doc=>({id:doc.id,name:doc.data().name,sizeBytes:doc.data().sizeBytes}))});
 }catch(_){res.status(503).json({error:"File list unavailable"})}
});
app.post("/v1/uploads",auth,requireWrite,express.json({limit:"4kb"}),async(req,res)=>{
 try{
   if(await lockedWrite(req,res))return;
   const name=safeName(req.body?.name),size=req.body?.sizeBytes;
   if(!Number.isSafeInteger(size)||size<1||size>QUOTA)return res.status(400).json({error:"Invalid size"});
   await cleanupExpired(req);
   const id=crypto.randomUUID(),ref=req.workspaceRef.collection("uploads").doc(id);
   await db.runTransaction(async tx=>{
     const snap=await tx.get(req.workspaceRef);
     if(!snap.exists||snap.data().kind!=="free"||snap.data().accountKey!==accountKey(req.user.uid))throw Error("NO_FREE_WORKSPACE");
     const w=snap.data();
     const quota=effectiveStorageQuota(w);if(quota<=0)throw Error("PROJECT_NOT_ACTIVE");
     if((w.usedBytes||0)+(w.reservedBytes||0)+size>quota)throw Error("QUOTA_EXCEEDED");
     tx.update(req.workspaceRef,{reservedBytes:FieldValue.increment(size)});
     tx.create(ref,{name,sizeBytes:size,status:"active",nextIndex:0,uploadedBytes:0,
       createdAt:FieldValue.serverTimestamp()});
   });
   res.status(201).json({uploadId:id,chunkBytes:CHUNK,totalChunks:Math.ceil(size/CHUNK)});
 }catch(e){res.status(e.message==="QUOTA_EXCEEDED"?413:409).json({error:e.message==="QUOTA_EXCEEDED"?"Project storage quota exceeded":"Unable to begin upload"})}
});
function validID(id){return typeof id==="string"&&/^[0-9a-f-]{36}$/.test(id)}
app.get("/v1/uploads/:id",auth,requireRead,async(req,res)=>{
 if(!validID(req.params.id))return res.status(400).end();
 if(!await currentWorkspace(req,res))return;
 const doc=await req.workspaceRef.collection("uploads").doc(req.params.id).get();
 if(!doc.exists)return res.status(404).end();
 const x=doc.data();
 res.json({status:x.status,nextIndex:x.nextIndex,totalChunks:Math.ceil(x.sizeBytes/CHUNK)});
});
app.put("/v1/uploads/:id/chunks/:index",auth,requireWrite,async(req,res)=>{
 const id=req.params.id,index=Number(req.params.index),length=Number(req.headers["content-length"]);
 if(!validID(id)||!Number.isSafeInteger(index)||index<0||index>=MAX_CHUNKS)
   return res.status(400).json({error:"Invalid chunk"});
 const ref=req.workspaceRef.collection("uploads").doc(id);
 try{
   if(await lockedWrite(req,res))return;
   const workspace=await currentWorkspace(req,res);if(!workspace)return;
   const snap=await ref.get();
   if(!snap.exists||snap.data().status!=="active")return res.status(404).json({error:"Unknown upload"});
   const job=snap.data(),count=Math.ceil(job.sizeBytes/CHUNK);
   if(index>=count||index!==job.nextIndex)return res.status(409).json({error:"Out-of-order chunk; resume using upload status"});
   const expected=Math.min(CHUNK,job.sizeBytes-index*CHUNK);
   if(length!==expected)return res.status(400).json({error:"Chunk length mismatch"});
   await runFreeTransfer(req,workspace,async()=>{
     const key=req.pathPrefix+"/tmp/"+id+"/"+String(index).padStart(4,"0");
     const file=bucket.file(key);
     await pipeline(req,file.createWriteStream({resumable:false,validation:"crc32c",preconditionOpts:{ifGenerationMatch:0}}));
     const [metadata]=await file.getMetadata();
     if(Number(metadata.size)!==expected)throw Error("Cloud chunk verification failed");
     await db.runTransaction(async tx=>{
       const current=await tx.get(ref);
       if(!current.exists||current.data().status!=="active"||current.data().nextIndex!==index)throw Error("Upload modified");
       tx.update(ref,{nextIndex:index+1,uploadedBytes:FieldValue.increment(expected)});
     });
   });
   res.json({saved:true,nextIndex:index+1});
 }catch(_){res.status(503).json({error:"Chunk transfer failed; check upload status before retry"})}
});
async function composeChunks(prefix,uploadId,count,target){
 let paths=Array.from({length:count},(_,index)=>prefix+"/tmp/"+uploadId+"/"+String(index).padStart(4,"0"));
 let level=0;
 while(paths.length>32){
   const next=[];
   for(let i=0;i<paths.length;i+=32){
     const dest=prefix+"/tmp/"+uploadId+"/intermediate-"+level+"-"+Math.floor(i/32);
     await bucket.combine(paths.slice(i,i+32),dest);
     next.push(dest);
   }
   paths=next;level++;
 }
 await bucket.combine(paths,target);
}
app.post("/v1/uploads/:id/finalize",auth,requireWrite,async(req,res)=>{
 const id=req.params.id;if(!validID(id))return res.status(400).end();
 const ref=req.workspaceRef.collection("uploads").doc(id);
 try{
   if(await lockedWrite(req,res))return;
   const workspace=await currentWorkspace(req,res);if(!workspace)return;
   const snap=await ref.get();
   if(!snap.exists)return res.status(404).end();
   const job=snap.data();
   if(job.status==="completed")return res.json({saved:true,fileId:id});
   if(job.status!=="active"||job.uploadedBytes!==job.sizeBytes||
     job.nextIndex!==Math.ceil(job.sizeBytes/CHUNK))return res.status(409).json({error:"Upload is incomplete"});
   const target=req.pathPrefix+"/files/"+id;
   await runFreeTransfer(req,workspace,async()=>{
     await composeChunks(req.pathPrefix,id,Math.ceil(job.sizeBytes/CHUNK),target);
     const [metadata]=await bucket.file(target).getMetadata();
     if(Number(metadata.size)!==job.sizeBytes)throw Error("File size mismatch");
     await db.runTransaction(async tx=>{
       const [w,s]=await Promise.all([tx.get(req.workspaceRef),tx.get(ref)]);
       if(!s.exists||s.data().status!=="active")throw Error("Already finalized");
       if(!w.exists||w.data().kind!=="free"||effectiveStorageQuota(w.data())<=0)throw Error("Not authorized");
       if((w.data().usedBytes||0)+job.sizeBytes>effectiveStorageQuota(w.data()))throw Error("QUOTA_EXCEEDED");
       tx.update(req.workspaceRef,{usedBytes:FieldValue.increment(job.sizeBytes),reservedBytes:FieldValue.increment(-job.sizeBytes)});
       tx.create(req.workspaceRef.collection("files").doc(id),{name:job.name,sizeBytes:job.sizeBytes,createdAt:FieldValue.serverTimestamp()});
       tx.update(ref,{status:"completed",completedAt:FieldValue.serverTimestamp()});
     });
   });
   await bucket.deleteFiles({prefix:req.pathPrefix+"/tmp/"+id+"/",force:true}).catch(()=>{});
   res.json({saved:true,fileId:id,name:job.name});
 }catch(_){res.status(503).json({error:"Could not finalize cloud file; retry"})}
});
app.get("/v1/files/:id/download",auth,requireRead,async(req,res)=>{
 const id=req.params.id;if(!validID(id))return res.status(400).end();
 try{
   const workspace=await currentWorkspace(req,res);if(!workspace)return;
   const snap=await req.workspaceRef.collection("files").doc(id).get();
   if(!snap.exists)return res.status(404).end();
   const file=bucket.file(req.pathPrefix+"/files/"+id);
   const d=snap.data();
   await require("./range_download").sendObject(req,res,{file,record:d,id,
    run:fn=>runFreeTransfer(req,workspace,fn)});
 }catch(_){if(!res.headersSent)res.status(503).json({error:"Download unavailable"});else res.destroy()}
});
app.delete("/v1/files/:id",auth,requireWrite,async(req,res)=>{
 const id=req.params.id;if(!validID(id))return res.status(400).end();
 try{
   if(!await currentWorkspace(req,res))return;
   const ref=req.workspaceRef.collection("files").doc(id),snap=await ref.get();
   if(!snap.exists)return res.status(404).end();
   const doc=snap.data();
   await bucket.file(req.pathPrefix+"/files/"+id).delete({ignoreNotFound:true});
   await db.runTransaction(async tx=>{
     const [w,f]=await Promise.all([tx.get(req.workspaceRef),tx.get(ref)]);
     if(!f.exists)return;
     tx.delete(ref);
     tx.update(req.workspaceRef,{usedBytes:FieldValue.increment(-doc.sizeBytes)});
   });
   res.json({deleted:true});
 }catch(_){res.status(503).json({error:"Unable to remove file"})}
});
require("./v2_errors").installV2Errors(app);
function start(port=Number(process.env.PORT||8080)){
 const deletion=require("./account_delete");
 const gate=deletion.supportDiscordStartup(process.env);
 if(gate.exit){
  console.error(gate.message);
  process.exit(gate.code||1);
 }
 if(gate.warn)console.warn(gate.message);
 firestore();
 const timer=setInterval(()=>{
  Promise.resolve(deletion.sweepRegisteredSupportNotifications()).catch(()=>console.error("support_notify_sweep_failed"));
 },deletion.SUPPORT_SWEEP_INTERVAL_MS);
 if(typeof timer.unref==="function")timer.unref();
 return app.listen(port,()=>console.log("GenDragoon free storage API ready"));
}
if(require.main===module)start();
module.exports={app,QUOTA,CHUNK,safeName,validID,lockedWrite,start};
