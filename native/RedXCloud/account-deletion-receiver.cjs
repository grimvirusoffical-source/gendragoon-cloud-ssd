'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {CloudError}=require('./redx-state.cjs');
const {PATH,initialJob,verifyInternal,receipt}=require('./account-deletion.cjs');
const {AccountDeletionRecords}=require('./account-deletion-records.cjs');
const ID=/^[a-f0-9]{32}$/;
async function readBody(req){let length=0,parts=[];for await(const part of req){length+=part.length;if(length>4096)throw new CloudError('body_too_large',413);parts.push(part);}try{const value=JSON.parse(Buffer.concat(parts));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw new CloudError('bad_json',400);}}
function createReceiverDeletion({store,root,key,exclusive,isBusy=()=>false,now=Date.now,purger,purgeExternal=async()=>{}}){
 const deleting=new Set(),active=new Map(),locks=new Map();
 const records=purger||new AccountDeletionRecords(store,{exclusive,now});
 async function serial(owner,fn){const prior=locks.get(owner)||Promise.resolve();let release;const gate=new Promise(r=>release=r),tail=prior.catch(()=>{}).then(()=>gate);locks.set(owner,tail);await prior.catch(()=>{});try{return await fn();}finally{release();if(locks.get(owner)===tail)locks.delete(owner);}}
 function enter(owner){
  if(deleting.has(owner))throw new CloudError('account_deleted',410);
  active.set(owner,(active.get(owner)||0)+1);let released=false;
  return()=>{if(released)return;released=true;const count=active.get(owner)-1;if(count)active.set(owner,count);else active.delete(owner);};
 }
 const matches=pathname=>new RegExp('^'+PATH+'/(prepare|metadata|finish)$').test(pathname);
 async function handle(req,pathname,identity){
  const action=pathname.slice(PATH.length+1),owner=identity.owner;
  if(req.method!=='POST'||identity.apiKey||!verifyInternal(req,key,owner,action,now()))throw new CloudError('account_deletion_forbidden',403);
  // Never hold account/team locks while a remote caller streams a body.
  const body=await readBody(req);
  return serial(owner,async()=>{
   if(action==='prepare'){
    if(Object.keys(body).some(k=>!['id','keyHash','requestedAtMs'].includes(k)))throw new CloudError('account_deletion_request_invalid',400);
    const proposed=initialJob(body);
    let state=await store.get(owner);
    if(state?.accountDeletion){if(state.accountDeletion.keyHash!==proposed.keyHash)throw new CloudError('idempotency_conflict',409);deleting.add(owner);return receipt(state.accountDeletion);}
    if(active.has(owner)||isBusy(owner))throw new CloudError('account_deletion_busy',409);
    const ownerDirectory=path.join(root,owner);
    try{const st=await fs.lstat(ownerDirectory);if(!st.isDirectory()||st.isSymbolicLink()||await fs.realpath(ownerDirectory)!==ownerDirectory)throw new CloudError('stored_object_corrupt',503);}catch(error){if(error.code!=='ENOENT')throw error;}
    deleting.add(owner);
    try{
     if(!state)await store.ensure(owner,1);
     state=await store.change(owner,s=>{if(s.accountDeletion){if(s.accountDeletion.keyHash!==proposed.keyHash)throw new CloudError('idempotency_conflict',409);return;}s.accountDeletion=proposed;});
     return receipt(state.accountDeletion);
    }catch(error){if(!(await store.get(owner))?.accountDeletion)deleting.delete(owner);throw error;}
   }
   if(Object.keys(body).some(k=>k!=='id')||!ID.test(body.id||''))throw new CloudError('account_deletion_request_invalid',400);
   const state=await store.get(owner),job=state?.accountDeletion;
   if(!job||job.id!==body.id)throw new CloudError('account_deletion_not_found',404);
   deleting.add(owner);
   if(job.status==='completed')return action==='metadata'?{done:true}:receipt(job);
   if(!job.billingDone)throw new CloudError('account_deletion_billing_pending',409);
   if(Object.keys(state.workspaces||{}).length)throw new CloudError('account_deletion_storage_pending',409);
   if(action==='metadata'){
    const result=await records.page(owner,job.id,job.metadata);
    await store.change(owner,s=>{const j=s.accountDeletion;if(j?.id!==job.id||JSON.stringify(j.metadata)!==JSON.stringify(job.metadata))throw new CloudError('busy_retry',409);j.metadata=result.progress;j.counts.metadataRemoved+=result.removed;j.updatedAtMs=now();});
    return {done:result.done};
   }
   if(action!=='finish'||job.metadata?.stage!=='done')throw new CloudError('account_deletion_metadata_pending',409);
   const directory=path.join(root,owner);
   try{
    const st=await fs.lstat(directory);
    if(!st.isDirectory()||st.isSymbolicLink()||await fs.realpath(directory)!==directory)throw new CloudError('stored_object_corrupt',503);
    await fs.rm(directory,{recursive:true,force:true});
    const handle=await fs.open(root,'r');try{await handle.sync();}finally{await handle.close();}
   }catch(error){if(error.code!=='ENOENT')throw error;}
   try{await fs.lstat(directory);throw new CloudError('account_deletion_verification_failed',503);}catch(error){if(error.code!=='ENOENT')throw error;}
   await purgeExternal(identity);
   const completedAtMs=now();
   const finished=await store.change(owner,s=>{
    const j=s.accountDeletion;
    if(j?.id!==job.id||!j.billingDone||j.metadata?.stage!=='done'||Object.keys(s.workspaces||{}).length)throw new CloudError('account_deletion_verification_failed',503);
    const tombstone={schema:1,id:j.id,keyHash:j.keyHash,status:'completed',phase:'complete',requestedAtMs:j.requestedAtMs,updatedAtMs:completedAtMs,completedAtMs,counts:j.counts};
    for(const field of Object.keys(s))if(!['schema','owner','id','revision'].includes(field))delete s[field];
    s.quota=1;s.used=0;s.accountDeletion=tombstone;
   });
   return receipt(finished.accountDeletion);
  });
 }
 return {matches,handle,enter};
}
module.exports={createReceiverDeletion,readBody};
