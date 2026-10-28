'use strict';
// Storage adapter for authenticated Receiver routes. Authorization and the
// single-writer operation lease must already have been acquired by server.cjs.
const {CloudError,digest}=require('./redx-state.cjs');
const MAX=8*1024*1024;
async function transfer({req,res,owner,workspace,id,state,store,media,lookup,validate,read,json,writable,removeLegacy,busy}){
 if(req.method==='GET'){
  if(state.deletions?.[id]?.workspace===workspace)throw new CloudError('not_found',404);
  const found=await lookup(owner,workspace,id);if(!found)throw new CloudError('not_found',404);
  res.writeHead(200,{'content-type':'image/png','content-length':found.bytes.length,'x-content-sha256':found.record.sha256,'cache-control':'no-store','x-content-type-options':'nosniff','content-disposition':`attachment; filename="${id}.png"`});
  return res.end(found.bytes);
 }
 if(!['PUT','DELETE'].includes(req.method))throw new CloudError('method_not_allowed',405);
 const key=owner+'/'+workspace+'/'+id;if(busy.has(key))throw new CloudError('upload_busy',409);busy.add(key);
 try{
  if(req.method==='DELETE'){
   let deletion=state.deletions?.[id];
   if(deletion&&deletion.workspace!==workspace)throw new CloudError('not_found',404);
   if(!deletion){
    const found=await lookup(owner,workspace,id);if(!found)throw new CloudError('not_found',404);
    deletion={workspace,bytes:found.record.bytes,sha256:found.record.sha256};
    await store.change(owner,s=>{s.deletions||={};if(s.deletions[id])throw new CloudError('busy_retry',409);s.deletions[id]=deletion;});
   }
   await media.remove(owner,workspace,id);
   await removeLegacy(owner,workspace,id,deletion);
   const after=await store.change(owner,s=>{
    const d=s.deletions?.[id];if(!d||d.workspace!==workspace||d.sha256!==deletion.sha256||s.used<d.bytes)throw new CloudError('quota_state_corrupt',503);
    s.used-=d.bytes;if(s.workspaces[workspace])s.workspaces[workspace].usedBytes=Math.max(0,(s.workspaces[workspace].usedBytes||0)-d.bytes);
    delete s.deletions[id];if(s.reservations)delete s.reservations[id];
   });
   return json(res,200,{ok:true,id,freedBytes:deletion.bytes,usedBytes:after.used});
  }
  const bytes=Number(req.headers['content-length']),sha256=req.headers['x-content-sha256'];
  if(req.headers['content-type']!=='image/png')throw new CloudError('png_required',415);
  if(!Number.isSafeInteger(bytes)||bytes<8||bytes>MAX||typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256))throw new CloudError('invalid_size_or_hash',400);
  writable(await store.get(owner),workspace);
  const prior=await lookup(owner,workspace,id);
  if(prior){
   if(prior.record.bytes!==bytes||prior.record.sha256!==sha256)throw new CloudError('immutable_object_conflict',409);
   await store.change(owner,s=>{const v=s.reservations?.[id];if(v&&v.workspace===workspace&&v.sha256===sha256)delete s.reservations[id];});
   req.resume();return json(res,200,{id,status:'ready',reused:true,bytes,sha256});
  }
  let reserved=false,storeAttempted=false;
  try{
   await store.change(owner,s=>{
    s.reservations||={};const old=s.reservations[id];
    if(old){if(old.workspace!==workspace||old.bytes!==bytes||old.sha256!==sha256)throw new CloudError('upload_busy',409);return;}
    const ws=writable(s,workspace),used=ws.usedBytes||0;
    if(s.used+bytes>s.quota||Number.isSafeInteger(ws.quotaBytes)&&used+bytes>ws.quotaBytes)throw new CloudError('quota_exceeded',507);
    s.used+=bytes;ws.usedBytes=used+bytes;s.reservations[id]={workspace,bytes,sha256};
   });reserved=true;
   const body=await read(req,bytes);if(body.length!==bytes||digest(body)!==sha256)throw new CloudError('upload_hash_mismatch',422);
   const encoding=await validate(body,id);
   storeAttempted=true;
   await media.put(owner,workspace,id,body,{schema:1,id,workspace,bytes,sha256,encoding});
   await store.change(owner,s=>{if(s.reservations?.[id]?.sha256===sha256)delete s.reservations[id];});
   return json(res,201,{id,status:'ready',bytes,sha256,storage:'red-xai-db'});
  }catch(error){
   // A timed-out HTTP write can still commit. Never refund its reservation
   // optimistically: the next same-ID/hash retry reconciles it exactly once.
   if(reserved&&!storeAttempted)await store.change(owner,s=>{
    const q=s.reservations?.[id];if(q&&q.workspace===workspace&&q.sha256===sha256){s.used-=q.bytes;if(s.workspaces[workspace])s.workspaces[workspace].usedBytes=Math.max(0,(s.workspaces[workspace].usedBytes||0)-q.bytes);delete s.reservations[id];}
   }).catch(()=>{});
   throw error;
  }
 }finally{busy.delete(key);}
}
module.exports={transfer};
