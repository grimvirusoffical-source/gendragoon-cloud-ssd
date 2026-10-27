'use strict';
// Current RedX MachineNotes deletion. Receipts contain no bearer or refresh
// credentials. A verified caller can resume durable work after a process exit.
const crypto=require('node:crypto');
const {CloudError,digest}=require('./redx-state.cjs');
const ID=/^[a-f0-9]{32}$/,HASH=/^[a-f0-9]{64}$/;
const PHASES=['billing','workspaces','metadata','storage','complete'];
const PATH='/v1/receivers/me/account-deletion';
function confirmation(body){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['confirmation','idempotencyKey'].includes(k)))throw new CloudError('account_deletion_request_invalid',400);
 if(body.confirmation!=='DELETE GENDRAGOON')throw new CloudError('account_deletion_confirmation_required',409);
 if(!ID.test(body.idempotencyKey||''))throw new CloudError('idempotency_key_required',400);
 return digest(body.idempotencyKey);
}
function initialJob({id,keyHash,requestedAtMs}){
 if(!ID.test(id||'')||!HASH.test(keyHash||'')||!Number.isSafeInteger(requestedAtMs)||requestedAtMs<1)throw new CloudError('account_deletion_request_invalid',400);
 return {schema:1,id,keyHash,status:'queued',phase:'billing',requestedAtMs,updatedAtMs:requestedAtMs,billingDone:false,workspacesDone:[],metadata:{stage:'integrations',after:-1},counts:{workspacesRemoved:0,metadataRemoved:0}};
}
function receipt(job){
 if(!job)return {schema:1,deletion:null};
 if(!ID.test(job.id||'')||!PHASES.includes(job.phase)||!['queued','running','failed','completed'].includes(job.status))throw new CloudError('account_deletion_state_invalid',503);
 return {schema:1,deletion:{id:job.id,status:job.status,phase:job.phase,requestedAt:new Date(job.requestedAtMs).toISOString(),updatedAt:new Date(job.updatedAtMs).toISOString(),
  ...(job.completedAtMs?{completedAt:new Date(job.completedAtMs).toISOString()}:{}),retryable:job.status==='failed',
  ...(job.status==='failed'?{error:job.error||'account_deletion_retry_required'}:{}),counts:{...job.counts},
  cloudDataDeleted:job.status==='completed',externalIdentityDeleted:false,externalBYODataDeleted:false,localOriginalsDeleted:false}};
}
function signedHeaders(key,owner,action,at=Date.now()){
 if(!key)throw new CloudError('account_deletion_unavailable',503);
 const stamp=String(at),proof=crypto.createHmac('sha256',key).update(['gendragoon-account-delete/v1',owner,action,stamp].join('/')).digest('hex');
 return {'x-control-account-delete':proof,'x-control-account-delete-time':stamp};
}
function verifyInternal(req,key,owner,action,at=Date.now()){
 if(!key)return false;
 const proof=req.headers['x-control-account-delete'],stamp=req.headers['x-control-account-delete-time'];
 if(typeof proof!=='string'||!HASH.test(proof)||typeof stamp!=='string'||!/^\d{13}$/.test(stamp)||Math.abs(at-Number(stamp))>300000)return false;
 return crypto.timingSafeEqual(Buffer.from(proof,'hex'),Buffer.from(signedHeaders(key,owner,action,Number(stamp))['x-control-account-delete'],'hex'));
}
function createDeletionClient({url,key,fetchImpl=fetch}){
 const parsed=new URL(url);
 if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw Error('Account deletion must use authenticated IPv4 loopback');
 return async(identity,action,body)=>{
  const r=await fetchImpl(parsed.origin+PATH+'/'+action,{method:'POST',redirect:'error',headers:{authorization:identity.bearer,'content-type':'application/json',...signedHeaders(key,identity.owner,action)},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const text=await r.text();if(text.length>32768)throw new CloudError('account_deletion_unavailable',503);
  let value;try{value=JSON.parse(text);}catch{throw new CloudError('account_deletion_unavailable',503);}
  if(!r.ok)throw new CloudError(['account_deletion_busy','idempotency_conflict'].includes(value.error)?value.error:'account_deletion_retry_required',r.status===409?409:503);
  return value;
 };
}
function createAccountDeletion({store,receiver,settleBilling,removeWorkspace,now=Date.now,autoRun=true,pageBudget=100}){
 const flights=new Map();
 async function patch(owner,id,fn){return store.change(owner,s=>{if(s.accountDeletion?.id!==id)throw new CloudError('account_deletion_state_invalid',503);fn(s.accountDeletion);s.accountDeletion.updatedAtMs=now();});}
 async function process(identity){
  const owner=identity.owner;let state=await store.get(owner),job=state?.accountDeletion;
  if(!job||job.status==='completed')return;
  const id=job.id;
  try{
   await patch(owner,id,j=>{j.status='running';delete j.error;});
   if(!job.billingDone){await settleBilling(identity,state.control||null);await patch(owner,id,j=>{j.billingDone=true;j.phase='workspaces';});}
   state=await store.get(owner);job=state.accountDeletion;
   const workspaces=[...new Set([...Object.keys(state.workspaces||{}),...Object.keys(state.control?.projects||{})])];
   if(workspaces.length>100||workspaces.some(w=>!ID.test(w)))throw new CloudError('account_deletion_state_invalid',503);
   for(const workspace of workspaces){
    if(job.workspacesDone.includes(workspace))continue;
    await removeWorkspace(identity,workspace);
    state=await patch(owner,id,j=>{if(!j.workspacesDone.includes(workspace)){j.workspacesDone.push(workspace);j.counts.workspacesRemoved++;}j.phase='workspaces';});job=state.accountDeletion;
   }
   await patch(owner,id,j=>{j.phase='metadata';});
   for(let n=0;n<pageBudget;n++){
    const result=await receiver(identity,'metadata',{id});
    if(result.done)break;
    if(n===pageBudget-1){await patch(owner,id,j=>{j.status='queued';});return;}
   }
   await patch(owner,id,j=>{j.phase='storage';});
   await receiver(identity,'finish',{id});
   const completed=(await store.get(owner))?.accountDeletion;
   if(completed?.status!=='completed'||completed.id!==id)throw new CloudError('account_deletion_state_invalid',503);
  }catch(error){
   const current=(await store.get(owner))?.accountDeletion;
   if(current?.id===id&&current.status!=='completed')await patch(owner,id,j=>{j.status='failed';j.error=error.code==='billing_review_required'?'billing_review_required':'account_deletion_retry_required';}).catch(()=>{});
  }
 }
 function resume(identity){
  if(!autoRun||flights.has(identity.owner))return;
  const flight=Promise.resolve().then(()=>process(identity)).catch(()=>{}).finally(()=>{if(flights.get(identity.owner)===flight)flights.delete(identity.owner);});
  flights.set(identity.owner,flight);
 }
 async function request(identity,body){
  const keyHash=confirmation(body),existing=(await store.get(identity.owner))?.accountDeletion;
  if(existing&&existing.keyHash!==keyHash)throw new CloudError('idempotency_conflict',409);
  if(!existing)await receiver(identity,'prepare',{id:crypto.randomBytes(16).toString('hex'),keyHash,requestedAtMs:now()});
  const current=(await store.get(identity.owner))?.accountDeletion;
  if(!current||current.keyHash!==keyHash)throw new CloudError('account_deletion_state_invalid',503);
  resume(identity);return receipt(current);
 }
 async function status(identity){const value=receipt((await store.get(identity.owner))?.accountDeletion);if(value.deletion&&value.deletion.status!=='completed')resume(identity);return value;}
 return {request,status,resume,process,async drain(){await Promise.allSettled([...flights.values()]);}};
}
// Billing IDs are read only from the owned ledger, then independently bound to
// GenDragoon customer/owner/project metadata before any provider mutation.
async function settleAccountBilling(stripe,identity,control){
 if(!control)return;
 const projects=Object.values(control.projects||{}),sessions=[...projects.flatMap(p=>[p.checkoutSessionId,p.workspaceCheckoutSessionId].filter(Boolean)),control.adsCheckoutSessionId].filter(Boolean);
 const subscriptions=new Map();
 for(const p of projects)for(const id of [p.subscriptionId,p.workspaceSubscriptionId].filter(Boolean))subscriptions.set(id,p.id);
 if(!subscriptions.size&&!sessions.length&&!control.stripeCustomerId)return;
 if(!stripe)throw new CloudError('billing_unavailable',503);
 const customer=control.stripeCustomerId;
 const bound=(value,project)=>value&&value.metadata?.service==='GenDragoonSSD'&&value.metadata.redxOwner===identity.owner&&(!project||value.metadata.projectId===project)&&
  (typeof value.customer==='string'?value.customer:value.customer?.id)===customer;
 for(const id of [...new Set(sessions)]){
  let session=await stripe.checkout.sessions.retrieve(id);
  if(!bound(session)||session.metadata.projectId&&!projects.some(p=>p.id===session.metadata.projectId))throw new CloudError('billing_review_required',409);
  if(session.status==='open'){
   try{await stripe.checkout.sessions.expire(id);}catch{session=await stripe.checkout.sessions.retrieve(id);if(session.status==='open')throw new CloudError('billing_unavailable',503);}
   session=await stripe.checkout.sessions.retrieve(id);
  }
  if(!bound(session)||!['expired','complete'].includes(session.status))throw new CloudError('billing_unavailable',503);
  const subscription=typeof session.subscription==='string'?session.subscription:session.subscription?.id;
  if(session.status==='complete'&&(session.mode==='subscription'||['workspace_plans','workspace_fee'].includes(session.metadata.kind))&&!subscription)throw new CloudError('billing_unavailable',503);
  if(subscription)subscriptions.set(subscription,session.metadata.projectId);
 }
 for(const [id,project]of subscriptions){
  let subscription=await stripe.subscriptions.retrieve(id);
  if(!bound(subscription,project))throw new CloudError('billing_review_required',409);
  if(!['canceled','incomplete_expired'].includes(subscription.status))await stripe.subscriptions.cancel(id,{prorate:false,invoice_now:false});
  subscription=await stripe.subscriptions.retrieve(id);
  if(!bound(subscription,project)||!['canceled','incomplete_expired'].includes(subscription.status))throw new CloudError('billing_unavailable',503);
 }
 // Stripe remains the processor of historical invoices/payment records. We
 // remove the app ledger's customer pointer only when the account is finalized.
}
module.exports={PATH,PHASES,confirmation,initialJob,receipt,signedHeaders,verifyInternal,createDeletionClient,createAccountDeletion,settleAccountBilling};
