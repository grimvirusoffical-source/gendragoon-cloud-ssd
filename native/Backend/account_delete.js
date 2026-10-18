"use strict";
// In-app account deletion (Apple App Store guideline 5.1.1(v)).
// One resumable job per accountHash. Stripe subscriptions are cancelled
// immediately with no proration invoice. Managed objects are removed.
// Customer-owned (BYO) buckets are never called; only our record of them is
// dropped. Firebase refresh tokens are revoked and the user is deleted last.
const crypto=require("node:crypto");
const REAUTH_SECONDS=5*60;
const JOB_STATUS=new Set(["queued","running","done","failed"]);
const SUBSCRIPTION_KEY=/SubscriptionId$/;

function refusal(status,code){
 const error=new Error(code);
 error.status=status;
 error.code=code;
 return error;
}
function plainJob(job){
 const data={jobId:job.jobId,accountHash:job.accountHash,status:job.status,
  steps:{...job.steps},canceledIds:[...(job.canceledIds||[])],
  subscriptionIds:[...(job.subscriptionIds||[])],customerId:job.customerId||null,
  retryable:job.retryable===true,failure:job.failure||null};
 if(job.status!=="done")data.uid=job.uid;
 return data;
}
function createAccountDeletion({db,stripe,bucket,auth,byoProviders,hash,now}){
 // byoProviders is accepted so callers can pass the registry. Deletion must
 // never invoke it: customer-owned storage stays untouched.
 void byoProviders;
 const jobs=new Map();
 const clock=()=>typeof now==="function"?now():Date.now();
 function accountRef(owner){return db.collection("account_deletions").doc(owner)}
 function jobRef(jobId){return db.collection("deletion_jobs").doc(jobId)}
 async function save(job){
  const data=plainJob(job);
  await Promise.all([
   jobRef(job.jobId).set(data),
   accountRef(job.accountHash).set(data),
  ]);
 }
 function remembered(owner){
  for(const job of jobs.values())if(job.accountHash===owner)return job;
  return null;
 }
 async function load(owner){
  const live=remembered(owner);
  if(live)return live;
  const snap=await accountRef(owner).get();
  if(!snap.exists)return null;
  const data=snap.data();
  if(!data?.jobId||!JOB_STATUS.has(data.status))return null;
  const job={...data,steps:data.steps||{},canceledIds:data.canceledIds||[],subscriptionIds:data.subscriptionIds||[],inflight:false};
  jobs.set(job.jobId,job);
  return job;
 }
 async function cancelStripe(job){
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
  const done=new Set(job.canceledIds||[]);
  for(const id of ids){
   if(done.has(id))continue;
   try{
    // Immediate cancellation. prorate and invoice_now stay false so unused
    // time is not refunded; the billing portal's at-period-end setting does
    // not apply once the account itself is being deleted.
    await stripe.subscriptions.cancel(id,{invoice_now:false,prorate:false});
   }catch(error){
    if(error?.code==="resource_missing"){done.add(id);continue;}
    job.canceledIds=[...done];
    const wrapped=refusal(503,"stripe_cancel_failed");
    wrapped.cause=error;
    throw wrapped;
   }
   done.add(id);
   job.canceledIds=[...done];
  }
 }
 async function deletePrefix(prefix){
  if(typeof bucket?.deleteFiles==="function"){
   await bucket.deleteFiles({prefix,force:true});
   return;
  }
  if(typeof bucket?.getFiles!=="function")return;
  const listed=await bucket.getFiles({prefix});
  const files=listed?.[0]||[];
  for(const file of files){
   if(typeof file?.delete==="function")await file.delete({ignoreNotFound:true});
   else if(file?.name&&typeof bucket.file==="function")await bucket.file(file.name).delete({ignoreNotFound:true});
  }
 }
 async function deleteTree(collectionRef){
  const snap=await collectionRef.get();
  for(const doc of snap.docs||[]){
   for(const name of ["files","uploads"]){
    const children=await doc.ref.collection(name).get();
    for(const child of children.docs||[])await child.ref.delete();
   }
   await doc.ref.delete();
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
    await doc.ref.delete();
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
  await db.collection("gd_accounts").doc(owner).delete();
  await db.collection("tenants").doc(owner).delete();
  if(job.uid)await db.collection("ad_purchases").doc(job.uid).delete();
  try{
   const keys=await db.collection("gd_api_keys").where("ownerHash","==",owner).get();
   for(const doc of keys.docs||[])await doc.ref.delete();
  }catch(_){/* key registry absent */}
  await db.collection("accepted_terms").doc(job.uid).delete().catch?.(()=>{});
 }
 async function deleteFirebase(job){
  if(typeof auth?.revokeRefreshTokens==="function"){
   try{await auth.revokeRefreshTokens(job.uid);}
   catch(error){if(error?.code!=="auth/user-not-found")throw error;}
  }
  try{await auth.deleteUser(job.uid);}
  catch(error){if(error?.code!=="auth/user-not-found")throw error;}
 }
 async function runJob(job){
  job.status="running";
  job.failure=null;
  await save(job);
  if(!job.steps.stripe){await cancelStripe(job);job.steps.stripe=true;await save(job);}
  if(!job.steps.objects){
   const owner=job.accountHash;
   await deletePrefix("customer/"+owner+"/");
   await deletePrefix("tenants/"+owner+"/");
   job.steps.objects=true;await save(job);
  }
  if(!job.steps.metadata){await deleteMetadata(job);job.steps.metadata=true;await save(job);}
  if(!job.steps.firebase){await deleteFirebase(job);job.steps.firebase=true;await save(job);}
  job.status="done";
  job.retryable=false;
  await save(job);
 }
 function schedule(job){
  if(job.inflight||job.status==="done")return;
  job.inflight=true;
  if(job.status!=="running")job.status="queued";
  job.promise=(async()=>{
   try{await runJob(job);}
   catch(error){
    job.status="failed";
    job.retryable=true;
    job.failure=error?.code||"deletion_step_failed";
    try{await save(job);}catch(_){/* status remains failed in memory */}
    console.error("account deletion job failed",job.jobId,job.failure);
   }finally{job.inflight=false;}
  })();
 }
 async function deleteAccount(req){
  const user=req?.user||req;
  const uid=user?.uid;
  if(typeof uid!=="string"||!uid)throw refusal(401,"reauth_required");
  const authTime=user.auth_time;
  const age=Math.floor(clock()/1000)-(typeof authTime==="number"?authTime:Number.NaN);
  if(!Number.isFinite(authTime)||age>REAUTH_SECONDS)throw refusal(401,"reauth_required");
  if(req?.body!==undefined&&req?.body!==null){
   if(typeof req.body!=="object"||Array.isArray(req.body)||req.body.confirm!=="DELETE")
    throw refusal(400,"confirm_required");
  }
  const owner=hash(uid);
  if(typeof owner!=="string"||!/^[a-f0-9]{64}$/.test(owner))throw refusal(400,"invalid_account");
  const existing=await load(owner);
  if(existing?.status==="done")throw refusal(401,"reauth_required");
  if(existing&&(existing.status==="queued"||existing.status==="running"||existing.status==="failed")){
   existing.uid=existing.uid||uid;
   schedule(existing);
   return {status:202,jobId:existing.jobId};
  }
  const job={jobId:crypto.randomUUID(),accountHash:owner,uid,status:"queued",steps:{},
   canceledIds:[],subscriptionIds:[],customerId:null,retryable:true,failure:null,inflight:false};
  jobs.set(job.jobId,job);
  schedule(job);
  return {status:202,jobId:job.jobId};
 }
 async function jobStatus(jobId){
  if(typeof jobId!=="string"||!jobId)return null;
  const live=jobs.get(jobId);
  if(live)return {status:live.status,retryable:live.retryable===true,failure:live.failure||null};
  const snap=await jobRef(jobId).get();
  if(!snap.exists)return null;
  const data=snap.data();
  if(!JOB_STATUS.has(data?.status))return null;
  return {status:data.status,retryable:data.retryable===true,failure:data.failure||null};
 }
 return {deleteAccount,jobStatus};
}
function registerAccountDeletion({app,firebaseAuth,...deps}){
 if(!app||typeof firebaseAuth!=="function")throw Error("account deletion requires an app and firebaseAuth");
 const svc=deps.service||createAccountDeletion(deps);
 app.delete("/v2/account",firebaseAuth,async(req,res)=>{
  try{
   const result=await svc.deleteAccount(req);
   res.status(202).json({status:"deleting",jobId:result.jobId});
  }catch(error){
   const status=Number.isInteger(error?.status)?error.status:500;
   res.status(status).json({error:error?.code||"account_deletion_failed"});
  }
 });
 app.get("/v2/account/deletion/:jobId",async(req,res)=>{
  try{
   const job=await svc.jobStatus(req.params.jobId);
   if(!job)return res.status(404).json({error:"not_found"});
   res.setHeader("Cache-Control","private, no-store");
   res.json({jobId:req.params.jobId,status:job.status,retryable:job.retryable===true});
  }catch(_){res.status(503).json({error:"deletion_status_unavailable"});}
 });
 return svc;
}
module.exports={createAccountDeletion,registerAccountDeletion,REAUTH_SECONDS};
