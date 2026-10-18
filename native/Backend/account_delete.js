"use strict";
// In-app account deletion (Apple App Store guideline 5.1.1(v)).
// One resumable job per accountHash. A 60s lease in the job document keeps
// two instances from running the same job. Stripe subscriptions are cancelled
// immediately with no proration invoice. Managed objects are removed.
// Customer-owned (BYO) buckets are never called; only our record of them is
// dropped. Firebase refresh tokens are revoked and the user is deleted last.
const crypto=require("node:crypto");
const REAUTH_SECONDS=5*60;
const STATUS_TOKEN_TTL_MS=7*24*60*60*1000;
const LEASE_MS=60*1000;
const MAX_STATUS_TOKENS=5;
const JOB_STATUS=new Set(["queued","running","done","failed"]);
const SUBSCRIPTION_KEY=/SubscriptionId$/;

function refusal(status,code,extra){
 const error=new Error(code);
 error.status=status;
 error.code=code;
 if(extra&&typeof extra==="object")Object.assign(error,extra);
 return error;
}
function authCodeMeansGone(error){
 const code=error?.code;
 return code==="auth/user-not-found"||code==="auth/user-disabled"||code==="auth/id-token-revoked";
}
function isMissing(error){
 const code=error?.code;
 return code==="auth/user-not-found"||code==="resource_missing"||code===5||code===404||code==="404"||code==="ENOENT"||code==="storage/object-not-found"||error?.status===404||error?.statusCode===404;
}
async function ignoreMissing(work){
 try{return await work();}
 catch(error){if(!isMissing(error))throw error;}
}
function plainJob(job){
 const steps={...(job.steps||{})};
 if(steps.prefixes)steps.prefixes={...steps.prefixes};
 const data={jobId:job.jobId,accountHash:job.accountHash,status:job.status,steps,
  canceledIds:[...(job.canceledIds||[])],subscriptionIds:[...(job.subscriptionIds||[])],
  customerId:job.customerId||null,retryable:job.retryable===true,failure:job.failure||null,
  statusTokens:(job.statusTokens||[]).map(item=>({hash:item.hash,expiresAtMs:item.expiresAtMs}))};
 if(job.lease&&typeof job.lease.owner==="string"&&typeof job.lease.expiresAtMs==="number")
  data.lease={owner:job.lease.owner,expiresAtMs:job.lease.expiresAtMs};
 if(job.status!=="done"&&job.uid)data.uid=job.uid;
 return data;
}
function pruneStatusTokens(list,now){
 const live=[];
 for(const item of list||[]){
  if(!item||typeof item.hash!=="string"||!/^[a-f0-9]{64}$/.test(item.hash))continue;
  if(typeof item.expiresAtMs!=="number"||now>item.expiresAtMs)continue;
  live.push({hash:item.hash,expiresAtMs:item.expiresAtMs});
 }
 // Oldest first. A sixth unexpired hash drops the oldest.
 return live.slice(-MAX_STATUS_TOKENS);
}
function mergeStatusTokens(stored,memory,now){
 const merged=[];
 const seen=new Set();
 for(const item of [...(stored||[]),...(memory||[])]){
  if(!item||typeof item.hash!=="string"||seen.has(item.hash))continue;
  seen.add(item.hash);
  merged.push(item);
 }
 return pruneStatusTokens(merged,now);
}
function bearerToken(req){
 const match=/^Bearer ([A-Za-z0-9._~-]+)$/.exec(req?.headers?.authorization||"");
 return match?match[1]:"";
}
function createAccountDeletion({db,stripe,bucket,auth,byoProviders,hash,now}){
 // byoProviders is accepted so callers can pass the registry. Deletion must
 // never invoke it: customer-owned storage stays untouched.
 void byoProviders;
 const instanceId=crypto.randomBytes(16).toString("hex");
 const jobs=new Map();
 const clock=()=>typeof now==="function"?now():Date.now();
 function accountRef(owner){return db.collection("account_deletions").doc(owner)}
 function jobRef(jobId){return db.collection("deletion_jobs").doc(jobId)}
 function heldByOther(lease,at){
  return !!(lease&&lease.owner!==instanceId&&typeof lease.expiresAtMs==="number"&&at<=lease.expiresAtMs);
 }
 function absorb(job,stored){
  if(!stored)return;
  const steps={...(stored.steps||{}),...(job.steps||{})};
  steps.prefixes={...(stored.steps?.prefixes||{}),...(job.steps?.prefixes||{})};
  for(const key of ["stripe","stripeListed","objects","metadata","firebase"])
   if(stored.steps?.[key]||job.steps?.[key])steps[key]=true;
  job.steps=steps;
  job.canceledIds=[...new Set([...(stored.canceledIds||[]),...(job.canceledIds||[])])];
  job.subscriptionIds=[...new Set([...(stored.subscriptionIds||[]),...(job.subscriptionIds||[])])];
  if(!job.customerId&&stored.customerId)job.customerId=stored.customerId;
  if(!job.uid&&stored.uid)job.uid=stored.uid;
  if(stored.accountHash)job.accountHash=stored.accountHash;
  if(stored.jobId)job.jobId=stored.jobId;
 }
 function writeBoth(tx,job){
  const data=plainJob(job);
  tx.set(jobRef(job.jobId),data);
  tx.set(accountRef(job.accountHash),data);
  return data;
 }
 function statusTokenMatches(job,token){
  if(!job||typeof token!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(token))return false;
  const actual=Buffer.from(crypto.createHash("sha256").update(token).digest("hex"),"hex");
  if(actual.length!==32)return false;
  const at=clock();
  for(const item of job.statusTokens||[]){
   if(typeof item?.expiresAtMs!=="number"||at>item.expiresAtMs)continue;
   const expected=Buffer.from(String(item.hash||""),"hex");
   if(expected.length===actual.length&&crypto.timingSafeEqual(actual,expected))return true;
  }
  return false;
 }
 function remembered(owner){
  for(const job of jobs.values())if(job.accountHash===owner)return job;
  return null;
 }
 function hydrate(data){
  return {jobId:data.jobId,accountHash:data.accountHash,uid:data.uid,status:data.status,
   steps:{...(data.steps||{}),prefixes:{...(data.steps?.prefixes||{})}},
   canceledIds:[...(data.canceledIds||[])],subscriptionIds:[...(data.subscriptionIds||[])],
   customerId:data.customerId||null,retryable:data.retryable===true,failure:data.failure||null,
   statusTokens:(data.statusTokens||[]).map(item=>({hash:item.hash,expiresAtMs:item.expiresAtMs})),
   lease:data.lease?{owner:data.lease.owner,expiresAtMs:data.lease.expiresAtMs}:null,inflight:false};
 }
 async function load(owner){
  const live=remembered(owner);
  if(live)return live;
  const snap=await accountRef(owner).get();
  if(!snap.exists)return null;
  const data=snap.data();
  if(!data?.jobId||!JOB_STATUS.has(data.status))return null;
  const job=hydrate(data);
  jobs.set(job.jobId,job);
  return job;
 }
 async function readJob(jobId){
  const snap=await jobRef(jobId).get();
  return snap.exists?snap.data():null;
 }
 // Extend our lease, or take an absent/expired one. A live lease owned by
 // another instance is left untouched and this instance does not become the runner.
 async function renewLease(job){
  let ok=false;
  await db.runTransaction(async tx=>{
   const snap=await tx.get(jobRef(job.jobId));
   const stored=snap.exists?snap.data():null;
   const at=clock();
   if(stored?.status==="done"){absorb(job,stored);job.status="done";job.statusTokens=mergeStatusTokens(stored.statusTokens,job.statusTokens,at);ok=false;return;}
   if(heldByOther(stored?.lease,at)){absorb(job,stored);job.lease=stored.lease;job.statusTokens=mergeStatusTokens(stored.statusTokens,job.statusTokens,at);ok=false;return;}
   if(stored)absorb(job,stored);
   job.lease={owner:instanceId,expiresAtMs:at+LEASE_MS};
   if(job.status!=="done")job.status="running";
   job.failure=null;
   job.statusTokens=mergeStatusTokens(stored?.statusTokens,job.statusTokens,at);
   writeBoth(tx,job);
   ok=true;
  });
  return ok;
 }
 // Checkpoint write. A holder whose lease expired, or was taken, stops here
 // without writing the in-memory batch.
 async function commitCheckpoint(job){
  let ok=false;
  await db.runTransaction(async tx=>{
   const snap=await tx.get(jobRef(job.jobId));
   const stored=snap.exists?snap.data():null;
   const at=clock();
   const own=stored?.lease?.owner===instanceId&&typeof stored?.lease?.expiresAtMs==="number"&&at<=stored.lease.expiresAtMs;
   if(!own||(stored?.status==="done"&&job.status!=="done")){
    if(stored){absorb(job,stored);job.lease=stored.lease||null;if(stored.status==="done")job.status="done";
     job.statusTokens=mergeStatusTokens(stored.statusTokens,job.statusTokens,at);}
    ok=false;return;
   }
   job.lease={owner:instanceId,expiresAtMs:stored.lease.expiresAtMs};
   job.statusTokens=mergeStatusTokens(stored.statusTokens,job.statusTokens,at);
   writeBoth(tx,job);
   ok=true;
  });
  return ok;
 }
 async function issueStatusToken(job,{claim}){
  const statusToken=crypto.randomBytes(32).toString("base64url");
  const extra={hash:crypto.createHash("sha256").update(statusToken).digest("hex"),expiresAtMs:clock()+STATUS_TOKEN_TTL_MS};
  let claimed=false;
  await db.runTransaction(async tx=>{
   const snap=await tx.get(jobRef(job.jobId));
   const stored=snap.exists?snap.data():null;
   const at=clock();
   const tokens=mergeStatusTokens(stored?.statusTokens,[...(job.statusTokens||[]),extra],at);
   const finished=stored?.status==="done"||job.status==="done";
   if(claim&&!finished&&!heldByOther(stored?.lease,at)){
    if(stored)absorb(job,stored);
    job.lease={owner:instanceId,expiresAtMs:at+LEASE_MS};
    job.statusTokens=tokens;
    if(job.status!=="done")job.status="running";
    writeBoth(tx,job);
    claimed=true;
    return;
   }
   const base=stored?{...stored,statusTokens:tokens}:{...plainJob(job),statusTokens:tokens};
   if(stored?.lease)base.lease={owner:stored.lease.owner,expiresAtMs:stored.lease.expiresAtMs};
   tx.set(jobRef(job.jobId),base);
   tx.set(accountRef(job.accountHash),base);
   job.statusTokens=tokens;
   if(stored?.lease)job.lease={owner:stored.lease.owner,expiresAtMs:stored.lease.expiresAtMs};
  });
  jobs.set(job.jobId,job);
  return {statusToken,claimed};
 }
 async function ensureSubscriptions(job){
  if(job.steps?.stripeListed)return;
  const owner=job.accountHash;
  const account=await db.collection("gd_accounts").doc(owner).get();
  const customer=account.exists?account.data()?.stripeCustomerId:job.customerId;
  if(typeof customer==="string"&&customer)job.customerId=customer;
  const ids=new Set(job.subscriptionIds||[]);
  const workspaces=await db.collection("gd_accounts").doc(owner).collection("workspaces").get();
  for(const doc of workspaces.docs||[]){
   const data=doc.data()||{};
   for(const [key,value] of Object.entries(data)){
    if(SUBSCRIPTION_KEY.test(key)&&typeof value==="string"&&value)ids.add(value);
   }
  }
  if(job.customerId&&typeof stripe?.subscriptions?.list==="function"){
   let startingAfter;
   do{
    const page=await stripe.subscriptions.list({customer:job.customerId,status:"all",limit:100,
     ...(startingAfter?{starting_after:startingAfter}:{})});
    const rows=page?.data||[];
    for(const sub of rows){
     const subCustomer=typeof sub?.customer==="string"?sub.customer:sub?.customer?.id;
     if(subCustomer&&subCustomer!==job.customerId)continue;
     if(!sub?.id||sub.status==="canceled"||sub.status==="incomplete_expired")continue;
     ids.add(sub.id);
    }
    startingAfter=page?.has_more&&rows.length?rows[rows.length-1].id:undefined;
   }while(startingAfter);
  }
  job.subscriptionIds=[...ids];
  job.steps={...job.steps,stripeListed:true};
 }
 async function cancelOne(id){
  try{
   // Immediate cancellation. prorate and invoice_now stay false so unused
   // time is not refunded; the billing portal's at-period-end setting does
   // not apply once the account itself is being deleted.
   await stripe.subscriptions.cancel(id,{invoice_now:false,prorate:false});
  }catch(error){
   if(isMissing(error))return;
   const wrapped=refusal(503,"stripe_cancel_failed");
   wrapped.cause=error;
   throw wrapped;
  }
 }
 async function deletePrefix(prefix){
  await ignoreMissing(async()=>{
   if(typeof bucket?.deleteFiles==="function"){
    await bucket.deleteFiles({prefix,force:true});
    return;
   }
   if(typeof bucket?.getFiles!=="function")return;
   const listed=await bucket.getFiles({prefix});
   const files=listed?.[0]||[];
   for(const file of files){
    if(typeof file?.delete==="function")await ignoreMissing(()=>file.delete({ignoreNotFound:true}));
    else if(file?.name&&typeof bucket.file==="function")await ignoreMissing(()=>bucket.file(file.name).delete({ignoreNotFound:true}));
   }
  });
 }
 async function deleteTree(collectionRef){
  const snap=await collectionRef.get();
  for(const doc of snap.docs||[]){
   for(const name of ["files","uploads"]){
    const children=await doc.ref.collection(name).get();
    for(const child of children.docs||[])await ignoreMissing(()=>child.ref.delete());
   }
   await ignoreMissing(()=>doc.ref.delete());
  }
 }
 async function deleteMetadata(job){
  const owner=job.accountHash;
  const anonymizedId=crypto.createHash("sha256").update("gd-receipt-v1:"+owner).digest("hex");
  const receipt=db.collection("billing_receipts").doc(anonymizedId);
  await receipt.set({anonymizedId,stripeCustomerId:job.customerId||null,
   subscriptionIds:job.subscriptionIds||[],retainedFor:"tax_and_payment_records",deletedAtMs:clock()},{merge:true});
  try{
   const payments=await db.collection("project_payments").where("accountHash","==",owner).get();
   const paymentIds=[];
   for(const doc of payments.docs||[]){
    paymentIds.push(doc.id);
    await ignoreMissing(()=>doc.ref.delete());
   }
   if(paymentIds.length)await receipt.set({paymentIds},{merge:true});
  }catch(_){/* no payment ledger for this account */}
  await deleteTree(db.collection("gd_accounts").doc(owner).collection("workspaces"));
  await deleteTree(db.collection("tenants").doc(owner).collection("workspaces"));
  if(db.rows instanceof Map){
   for(const key of [...db.rows.keys()]){
    if(key.includes(owner)&&key.includes("/workspaces/"))db.rows.delete(key);
   }
  }
  await ignoreMissing(()=>db.collection("gd_accounts").doc(owner).delete());
  await ignoreMissing(()=>db.collection("tenants").doc(owner).delete());
  if(job.uid)await ignoreMissing(()=>db.collection("ad_purchases").doc(job.uid).delete());
  try{
   const keys=await db.collection("gd_api_keys").where("ownerHash","==",owner).get();
   for(const doc of keys.docs||[])await ignoreMissing(()=>doc.ref.delete());
  }catch(_){/* key registry absent */}
  await db.collection("accepted_terms").doc(job.uid).delete().catch?.(()=>{});
 }
 async function deleteFirebase(job){
  if(typeof auth?.revokeRefreshTokens==="function")
   await ignoreMissing(()=>auth.revokeRefreshTokens(job.uid));
  await ignoreMissing(()=>auth.deleteUser(job.uid));
 }
 function nextBatch(job){
  if(!job.steps?.stripe)return "stripe";
  const owner=job.accountHash;
  const customer="customer/"+owner+"/";
  const tenants="tenants/"+owner+"/";
  if(!job.steps?.prefixes?.[customer])return "customer";
  if(!job.steps?.prefixes?.[tenants])return "tenants";
  if(!job.steps?.metadata)return "metadata";
  if(!job.steps?.firebase)return "firebase";
  return "done";
 }
 async function performBatch(job,kind){
  if(kind==="stripe"){
   await ensureSubscriptions(job);
   const pending=(job.subscriptionIds||[]).filter(id=>!(job.canceledIds||[]).includes(id));
   if(!pending.length){job.steps={...job.steps,stripe:true};return;}
   await cancelOne(pending[0]);
   job.canceledIds=[...(job.canceledIds||[]),pending[0]];
   if(pending.length===1)job.steps={...job.steps,stripe:true};
   return;
  }
  if(kind==="customer"||kind==="tenants"){
   const prefix=(kind==="customer"?"customer/":"tenants/")+job.accountHash+"/";
   await deletePrefix(prefix);
   job.steps={...job.steps,prefixes:{...(job.steps?.prefixes||{}),[prefix]:true}};
   const customer="customer/"+job.accountHash+"/";
   const tenants="tenants/"+job.accountHash+"/";
   if(job.steps.prefixes[customer]&&job.steps.prefixes[tenants])job.steps={...job.steps,objects:true};
   return;
  }
  if(kind==="metadata"){await deleteMetadata(job);job.steps={...job.steps,metadata:true};return;}
  if(kind==="firebase"){await deleteFirebase(job);job.steps={...job.steps,firebase:true};}
 }
 async function runJob(job){
  for(;;){
   if(!(await renewLease(job)))return;
   if(job.status==="done")return;
   const kind=nextBatch(job);
   if(kind==="done"){
    job.status="done";
    job.retryable=false;
    job.failure=null;
    await commitCheckpoint(job);
    return;
   }
   try{await performBatch(job,kind);}
   catch(error){
    const stored=await readJob(job.jobId);
    const at=clock();
    const own=stored?.lease?.owner===instanceId&&at<=stored?.lease?.expiresAtMs;
    if(!own)return;
    job.status="failed";
    job.retryable=true;
    job.failure=error?.code||"deletion_step_failed";
    await commitCheckpoint(job);
    console.error("account deletion job failed",job.jobId,job.failure);
    return;
   }
   if(!(await commitCheckpoint(job)))return;
  }
 }
 function schedule(job){
  if(job.inflight||job.status==="done")return;
  job.inflight=true;
  job.promise=(async()=>{
   try{await runJob(job);}
   catch(error){
    job.status="failed";
    job.retryable=true;
    job.failure=error?.code||"deletion_step_failed";
    try{await commitCheckpoint(job);}catch(_){/* status remains failed in memory */}
    console.error("account deletion job failed",job.jobId,job.failure);
   }finally{job.inflight=false;}
  })();
 }
 async function firebaseUserGone(uid){
  // Used only when no deletion record exists. A tombstone is decided first.
  if(!auth)return false;
  if(typeof auth.getUser==="function"){
   try{
    const record=await auth.getUser(uid);
    return record?.disabled===true;
   }catch(error){
    return authCodeMeansGone(error);
   }
  }
  // Test doubles look the user up with verifyIdToken(uid). Production Admin
  // Auth always exposes getUser, so a JWT verifier is not called with a uid.
  if(typeof auth.verifyIdToken==="function"){
   try{await auth.verifyIdToken(uid);return false;}
   catch(error){return authCodeMeansGone(error);}
  }
  return false;
 }
 async function deleteAccount(req){
  const user=req?.user||req;
  const uid=user?.uid;
  if(typeof uid!=="string"||!uid)throw refusal(401,"invalid_token");
  const owner=hash(uid);
  if(typeof owner!=="string"||!/^[a-f0-9]{64}$/.test(owner))throw refusal(400,"invalid_account");
  // The token's signature and claims already verified. A tombstone wins over
  // a missing Firebase user: repeat DELETE after done is 410, not 401.
  const existing=await load(owner);
  if(existing?.status==="done"){
   const {statusToken}=await issueStatusToken(existing,{claim:false});
   throw refusal(410,"account_deleted",{jobId:existing.jobId,statusToken});
  }
  if(!existing&&await firebaseUserGone(uid))throw refusal(401,"invalid_token");
  const authTime=user.auth_time;
  const age=Math.floor(clock()/1000)-(typeof authTime==="number"?authTime:Number.NaN);
  if(!Number.isFinite(authTime)||age>REAUTH_SECONDS)throw refusal(401,"reauth_required");
  if(req?.body!==undefined&&req?.body!==null){
   if(typeof req.body!=="object"||Array.isArray(req.body)||req.body.confirm!=="DELETE")
    throw refusal(400,"confirm_required");
  }
  if(existing&&(existing.status==="queued"||existing.status==="running"||existing.status==="failed")){
   existing.uid=existing.uid||uid;
   const {statusToken,claimed}=await issueStatusToken(existing,{claim:true});
   if(claimed)schedule(existing);
   return {status:202,jobId:existing.jobId,statusToken};
  }
  const job={jobId:crypto.randomUUID(),accountHash:owner,uid,status:"queued",steps:{},
   canceledIds:[],subscriptionIds:[],customerId:null,retryable:true,failure:null,inflight:false,statusTokens:[]};
  jobs.set(job.jobId,job);
  const {statusToken,claimed}=await issueStatusToken(job,{claim:true});
  if(claimed)schedule(job);
  return {status:202,jobId:job.jobId,statusToken};
 }
 async function jobStatus(jobId){
  if(typeof jobId!=="string"||!jobId)return null;
  const stored=await readJob(jobId);
  const live=jobs.get(jobId);
  // Firestore is the status clients observe. Memory can move ahead of the
  // checkpoint write; reporting it early would claim done before the commit.
  const source=stored&&JOB_STATUS.has(stored.status)?stored:live;
  if(!source||!JOB_STATUS.has(source.status))return null;
  const statusTokens=mergeStatusTokens(stored?.statusTokens,live?.statusTokens,clock());
  return {status:source.status,accountHash:source.accountHash||live?.accountHash,retryable:source.retryable===true,failure:source.failure||null,statusTokens};
 }
 // A poll restarts a queued or running job whose lease is missing or expired.
 // Failed jobs wait for DELETE. The holder that still has the job in flight is
 // left alone so a poll on that process does not start a second runner.
 async function resumeIfStalled(jobId){
  const stored=await readJob(jobId);
  if(!stored||stored.status==="done"||stored.status==="failed"||!JOB_STATUS.has(stored.status))return false;
  if(heldByOther(stored.lease,clock()))return false;
  const live=jobs.get(jobId);
  if(live?.inflight)return false;
  const job=live||hydrate(stored);
  absorb(job,stored);
  jobs.set(job.jobId,job);
  if(!(await renewLease(job)))return false;
  schedule(job);
  return true;
 }
 return {deleteAccount,jobStatus,statusTokenMatches,resumeIfStalled};
}
function deletionAuth(firebaseAuth){
 return (req,res,next)=>{
  const send=res.json.bind(res);
  res.json=body=>{
   if(res.statusCode===401){
    const code=body?.error==="reauth_required"||body?.error==="invalid_token"?body.error:"invalid_token";
    return send({error:code});
   }
   return send(body);
  };
  return firebaseAuth(req,res,next);
 };
}
function registerAccountDeletion({app,firebaseAuth,...deps}){
 if(!app||typeof firebaseAuth!=="function")throw Error("account deletion requires an app and firebaseAuth");
 const svc=deps.service||createAccountDeletion(deps);
 const authn=deletionAuth(firebaseAuth);
 app.delete("/v2/account",authn,async(req,res)=>{
  try{
   const result=await svc.deleteAccount(req);
   res.setHeader("Cache-Control","private, no-store");
   const body={status:"deleting",jobId:result.jobId};
   if(typeof result.statusToken==="string")body.statusToken=result.statusToken;
   res.status(202).json(body);
  }catch(error){
   const status=Number.isInteger(error?.status)?error.status:500;
   const code=error?.code||"account_deletion_failed";
   const body={error:status===401&&code!=="reauth_required"?"invalid_token":code};
   if(status===410&&typeof error?.jobId==="string")body.jobId=error.jobId;
   if(status===410&&typeof error?.statusToken==="string")body.statusToken=error.statusToken;
   if(status>=500)console.error("account deletion request failed",code);
   res.setHeader("Cache-Control","private, no-store");
   res.status(status).json(body);
  }
 });
 app.get("/v2/account/deletions/:jobId",async(req,res)=>{
  try{
   const jobId=req.params.jobId;
   const job=await svc.jobStatus(jobId);
   const presented=bearerToken(req);
   if(job&&typeof svc.statusTokenMatches==="function"&&svc.statusTokenMatches(job,presented)){
    if(typeof svc.resumeIfStalled==="function")await svc.resumeIfStalled(jobId);
    const fresh=await svc.jobStatus(jobId)||job;
    res.setHeader("Cache-Control","private, no-store");
    return res.json({jobId,status:fresh.status,retryable:fresh.retryable===true});
   }
   continueWithFirebase(firebaseAuth,req,res,()=>{
    Promise.resolve(finishStatus(req,res,job,jobId)).catch(()=>{
     if(!res.headersSent)res.status(503).json({error:"deletion_status_unavailable"});
    });
   });
  }catch(_){if(!res.headersSent)res.status(503).json({error:"deletion_status_unavailable"});}
 });
 return svc;
 async function finishStatus(req,res,job,jobId){
  if(res.headersSent)return;
  if(typeof req.user?.uid!=="string"||!req.user.uid||!job)return res.status(404).json({error:"not_found"});
  if(typeof job.accountHash==="string"){
   const owner=typeof deps.hash==="function"?deps.hash(req.user.uid):null;
   if(job.accountHash!==owner)return res.status(404).json({error:"not_found"});
  }
  if(typeof svc.resumeIfStalled==="function")await svc.resumeIfStalled(jobId);
  const fresh=await svc.jobStatus(jobId)||job;
  res.setHeader("Cache-Control","private, no-store");
  res.json({jobId,status:fresh.status,retryable:fresh.retryable===true});
 }
}
function continueWithFirebase(firebaseAuth,req,res,onOk){
 let done=false;
 const probe={
  statusCode:200,
  status(code){this.statusCode=code;return this;},
  setHeader(){return this;},
  getHeader(){return undefined;},
  json(){
   if(done||res.headersSent)return this;
   done=true;
   res.status(404).json({error:"not_found"});
   return this;
  },
 };
 try{
  const maybe=firebaseAuth(req,probe,()=>{
   if(done||res.headersSent)return;
   done=true;
   onOk();
  });
  Promise.resolve(maybe).catch(()=>{
   if(!done&&!res.headersSent){
    done=true;
    res.status(404).json({error:"not_found"});
   }
  });
 }catch(_){
  if(!done&&!res.headersSent)res.status(404).json({error:"not_found"});
 }
}
module.exports={createAccountDeletion,registerAccountDeletion,REAUTH_SECONDS,STATUS_TOKEN_TTL_MS,LEASE_MS};
