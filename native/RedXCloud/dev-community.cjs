'use strict';
// Safety controls are collaboration metadata, never storage authorization.
const crypto=require('node:crypto');
const {CloudError,digest}=require('./redx-state.cjs');
const ID=/^[a-f0-9]{32}$/;
const POLICY=Object.freeze({version:'2026-10-26.1',title:'GenDragoon Teams community rules',rules:[
 'Use Teams for lawful development collaboration. Do not post or request child sexual abuse material, sexual exploitation, or sexual content involving minors.',
 'Do not threaten violence, promote terrorism, encourage self-harm, or share instructions to harm people.',
 'Do not harass, bully, stalk, or attack people based on protected characteristics. Do not share private personal information without permission.',
 'Do not post unlawful sexual content, non-consensual intimate content, fraud, malware, spam, or content that violates another person’s rights.',
 'Respect blocks and moderation decisions. Report abusive users or messages using the controls in Teams. Do not use another account to evade a restriction.'
 ],notice:'Reports are reviewed by the team owner and can be escalated to the verified GenDragoon service owner. Direct chat is peer-to-peer; a direct-message report submits only the text you explicitly review and choose to include.'});
const REASONS=['harassment','hate','sexual','child-safety','violence','fraud','spam','other'];
const RETENTION=30*86400000,QUEUE=digest('gendragoon-community-reports/v1');
function createCommunity({store,records,put,now,rate,fields,text,page,profile,memberKey,peerID,membership,serial}){
 const accepted=p=>p?.community?.version===POLICY.version&&Number.isSafeInteger(p.community.acceptedMs);
 async function requireAcceptance(account){if(!accepted(await profile(account)))throw new CloudError('community_acceptance_required',409);}
 async function community(identity,method,b){
  if(method==='GET')return {status:200,body:{policy:POLICY,accepted:accepted(await profile(identity.owner)),serviceOwner:identity.ownerAdmin===true}};
  if(method!=='PUT')throw new CloudError('method_not_allowed',405);
  fields(b,['version','accepted']);if(b.version!==POLICY.version||b.accepted!==true)throw new CloudError('community_acceptance_required',409);
  rate(identity,'community',10);
  return serial('profile:'+identity.owner,async()=>{const key='profile:'+identity.owner,prior=await records.get(key),community={version:POLICY.version,acceptedMs:now()};await put(key,{...prior?.value,community},identity.owner,'profile',prior);return {status:200,body:{policy:POLICY,accepted:true}};});
 }
 const blockKey=(team,from,to)=>`block:${team}:${peerID(team,from)}:${peerID(team,to)}`;
 const blockScope=(team,account)=>digest('team-blocks:'+team+':'+account);
 async function blocked(team,a,b){const rows=await Promise.all([records.get(blockKey(team,a,b)),records.get(blockKey(team,b,a))]);return rows.some(r=>r?.value.blocked===true);}
 async function available(auth,row){return row?.value.status==='active'&&accepted(await profile(auth.m.value.account))&&accepted(await profile(row.value.account))&&!await blocked(auth.t.value.id,auth.m.value.account,row.value.account);}
 async function decorate(auth,row,publicMember){const result=await publicMember(row);if(row.value.account!==auth.m.value.account){result.blockedByYou=(await records.get(blockKey(auth.t.value.id,auth.m.value.account,row.value.account)))?.value.blocked===true;result.directAvailable=await available(auth,row);}return result;}
 async function blocks(identity,auth,u,method,target,b){
  const team=auth.t.value.id,scope=blockScope(team,identity.owner);
  if(!target&&method==='GET'){const p=await page(u,scope,'block',v=>v.blocked);return {status:200,body:{blocks:p.rows.map(r=>({peerId:r.value.peerId,createdMs:r.value.createdMs})),cursor:p.cursor,nextCursor:p.nextCursor}};}
  if(!target||!['PUT','DELETE'].includes(method))throw new CloudError('method_not_allowed',405);
  if(u.search)throw new CloudError('invalid_pagination',400);if(method==='PUT')fields(b,[]);
  const key=`block:${team}:${auth.peer}:${target}`,prior=await records.get(key);
  if(method==='DELETE'){if(prior)await records.remove(prior);return {status:200,body:{peerId:target,blocked:false}};}
  const m=await records.get(memberKey(team,target));if(!m||m.value.status!=='active'||target===auth.peer||(await store.get(m.value.account))?.accountDeletion)throw new CloudError('team_member_not_found',404);
  rate(identity,'block',30);
  await put(key,{account:identity.owner,targetAccount:m.value.account,teamId:team,peerId:target,blocked:method==='PUT',createdMs:prior?.value.createdMs??now(),updatedMs:now()},scope,'block',prior);
  return {status:200,body:{peerId:target,blocked:method==='PUT'}};
 }
 // Root evidence is immutable. Reviews are separate append-only records; one
 // owner's dismissal cannot erase another review or a service escalation.
 const receipt=r=>({id:r.id,submittedMs:r.submittedMs,expiresAtMs:r.expiresAtMs,status:'submitted',escalated:r.escalated===true});
 async function ensureIndex(r){const key='report-index:'+r.id,prior=await records.get(key),inputHash=digest(JSON.stringify(r.input));
  if(prior){const v=prior.value;if(v.owner!==r.owner||v.account!==r.account||v.targetAccount!==r.targetAccount||v.teamId!==r.teamId||v.inputHash!==inputHash)throw new CloudError('team_report_conflict',409);return v;}
  return (await put(key,{id:r.id,owner:r.owner,account:r.account,targetAccount:r.targetAccount,teamId:r.teamId,inputHash,submittedMs:r.submittedMs,expiresAtMs:r.expiresAtMs},QUEUE,'report_index')).value;
 }
 async function resolveMessage(team,id,allowDeleted=false){const pointer=await records.get(`message-ref:${team}:${id}`);if(!pointer||typeof pointer.value.recordKey!=='string')throw new CloudError('team_message_not_found',404);const row=await records.getByKey(pointer.value.recordKey);if(!row||row.scope!==team||row.kind!=='message'||row.value.id!==id||!allowDeleted&&row.value.deleted||row.value.expiresAtMs<=now())throw new CloudError('team_message_not_found',404);return row;}
 async function rememberKey(team,row){const key=`message-ref:${team}:${row.value.id}`;if(!await records.get(key))await put(key,{recordKey:row.key,account:row.value.account,peerId:row.value.peerId,expiresAtMs:row.value.expiresAtMs},team,'message_ref');}
 async function cleanup(){
  if(typeof records.remove!=='function')return;
  const expired=await records.list(QUEUE,'report_index',{limit:5,expiredBefore:now()});
  for(const index of expired.rows)await serial(index.value.teamId,async()=>{const key='report-root:'+index.value.id,root=await records.get(key);const history=await records.list(index.value.id,'report_review',{limit:20});
   for(const event of history.rows)await records.remove(event);
   if(history.after!==null)return;
   const state=await records.get('report-state:'+index.value.id);if(state)await records.remove(state);
   if(root)await records.remove(root);await records.remove(index);
  });
 }
 async function submit(identity,auth,b){
  fields(b,['reportId','peerId','messageId','reason','details','directText','escalate']);rate(identity,'report',10,3600000);
  if(!ID.test(b.reportId||'')||!ID.test(b.peerId||'')||!REASONS.includes(b.reason)||b.escalate!==undefined&&typeof b.escalate!=='boolean')throw new CloudError('team_report_invalid',400);
  const target=await records.get(memberKey(auth.t.value.id,b.peerId));if(!target||target.value.status!=='active'||b.peerId===auth.peer||(await store.get(target.value.account))?.accountDeletion)throw new CloudError('team_member_not_found',404);
  const id=digest(JSON.stringify(['team-report/v1',auth.t.value.id,identity.owner,b.reportId])).slice(0,32),key='report-root:'+id,prior=await records.get(key);
  const details=b.details===undefined||b.details===''?'':text(b.details,1000);
  if(b.messageId!==undefined&&!ID.test(b.messageId)||b.directText!==undefined&&b.messageId!==undefined)throw new CloudError('team_report_invalid',400);
  let evidence={kind:'user'};
  if(b.messageId!==undefined){const m=await resolveMessage(auth.t.value.id,b.messageId);if(m.value.peerId!==b.peerId||await blocked(auth.t.value.id,identity.owner,target.value.account))throw new CloudError('team_message_not_found',404);evidence={kind:'server-relay',messageId:m.value.id,text:m.value.text,createdMs:m.value.createdMs};}
  if(b.directText!==undefined)evidence={kind:'reporter-provided-direct-text',verified:false,text:text(b.directText,4000)};
  const input={peerId:b.peerId,reason:b.reason,details,evidence,escalated:b.escalate===true||target.value.role==='owner'};
  if(prior){if(JSON.stringify(prior.value.input)!==JSON.stringify(input))throw new CloudError('team_report_conflict',409);await ensureIndex(prior.value);return {status:200,body:{report:receipt(prior.value),resumed:true}};}
  const r={id,owner:auth.t.value.owner,account:identity.owner,targetAccount:target.value.account,teamId:auth.t.value.id,reporterPeerId:auth.peer,targetPeerId:b.peerId,input,escalated:input.escalated,submittedMs:now(),expiresAtMs:now()+RETENTION};
  // The cleanup/review index is durable before evidence. A failed root write
  // leaves a discoverable index rather than unindexed private report text.
  const index=await ensureIndex(r);r.submittedMs=index.submittedMs;r.expiresAtMs=index.expiresAtMs;
  if(r.expiresAtMs<=now())throw new CloudError('team_report_conflict',409);
  await put(key,r,r.owner,'report');return {status:201,body:{report:receipt(r)}};
 }
 async function reportRoot(id){if(!ID.test(id||''))throw new CloudError('team_report_not_found',404);const row=await records.get('report-root:'+id);if(!row||row.value.expiresAtMs<=now())throw new CloudError('team_report_not_found',404);return row;}
 async function review(identity,root,b,service){
  fields(b,['reviewId','status','action','note']);rate(identity,'report-review',30);
  if(!ID.test(b.reviewId||'')||!['reviewed','dismissed','action_taken'].includes(b.status)||!['none','remove_member','hide_message','disable_team'].includes(b.action)||b.status==='action_taken'&&b.action==='none'||b.status!=='action_taken'&&b.action!=='none')throw new CloudError('team_review_invalid',400);
  if(b.action==='disable_team'&&!service)throw new CloudError('owner_access_required',403);
  const note=b.note===undefined||b.note===''?'':text(b.note,1000),r=root.value;
  for(const account of new Set([r.owner,r.account,r.targetAccount]))if((await store.get(account))?.accountDeletion)throw new CloudError('team_report_not_found',404);
  const key=`report-review:${r.id}:${service?'service':'team'}:${b.reviewId}`,old=await records.get(key);
  const input={status:b.status,action:b.action,note};if(old){if(JSON.stringify(old.value.input)!==JSON.stringify(input))throw new CloudError('team_review_conflict',409);return {status:200,body:{review:old.value,resumed:true}};}
  if(b.action==='remove_member'){const mk=memberKey(r.teamId,r.targetPeerId),target=await records.get(mk);if(target?.value.role==='owner')throw new CloudError('team_owner_cannot_remove',409);if(target?.value.status==='active')await put(mk,{...target.value,status:'removed',removedMs:now()},r.teamId,'member',target);}
  if(b.action==='hide_message'){if(r.input.evidence.kind!=='server-relay')throw new CloudError('team_review_invalid',400);const message=await resolveMessage(r.teamId,r.input.evidence.messageId,true);if(!message.value.deleted)await records.replace(message,{...message.value,deleted:true});}
  if(b.action==='disable_team'){const t=await records.get('team:'+r.teamId);if(!t||t.value.owner!==r.owner||!['active','disabled'].includes(t.value.status))throw new CloudError('team_not_found',404);if(t.value.status==='active')await put('team:'+r.teamId,{...t.value,status:'disabled'},r.teamId,'team',t);}
  const sk='report-state:'+r.id,state=await records.get(sk),seq=(state?.value.seq||0)+1;
  await put(sk,{seq,teamId:r.teamId,account:r.account,targetAccount:r.targetAccount,expiresAtMs:r.expiresAtMs},r.owner,'report_state',state);
  const event={id:crypto.randomBytes(16).toString('hex'),reportId:r.id,owner:r.owner,account:r.account,targetAccount:r.targetAccount,teamId:r.teamId,reviewer:service?'service-owner':'team-owner',input,reviewedMs:now(),expiresAtMs:r.expiresAtMs};await put(key,event,r.id,'report_review',null,seq);
  return {status:201,body:{review:event}};
 }
 async function detail(identity,u,row,service){const r=row.value,owner=r.owner===identity.owner;if(!owner&&!service){if(r.account!==identity.owner)throw new CloudError('team_report_not_found',404);if(u.search)throw new CloudError('invalid_pagination',400);return {status:200,body:{report:receipt(r)}};}
  const p=await page(u,r.id,'report_review');return {status:200,body:{report:{...receipt(r),teamId:r.teamId,reporterPeerId:r.reporterPeerId,targetPeerId:r.targetPeerId,...r.input},reviews:p.rows.map(x=>x.value),cursor:p.cursor,nextCursor:p.nextCursor}};
 }
 async function reports(identity,auth,u,method,target,b){
  if(!target&&method==='POST'){if(u.search)throw new CloudError('invalid_pagination',400);return submit(identity,auth,b);}
  if(!target&&method==='GET'){if(auth.t.value.owner!==identity.owner&&!identity.ownerAdmin)throw new CloudError('team_owner_required',403);const p=await page(u,auth.t.value.owner,'report',v=>v.teamId===auth.t.value.id&&v.expiresAtMs>now());return {status:200,body:{reports:p.rows.map(r=>({...receipt(r.value),teamId:r.value.teamId,reporterPeerId:r.value.reporterPeerId,targetPeerId:r.value.targetPeerId,...r.value.input})),cursor:p.cursor,nextCursor:p.nextCursor}};}
  const row=await reportRoot(target);if(row.value.teamId!==auth.t.value.id)throw new CloudError('team_report_not_found',404);
  if(method==='GET')return detail(identity,u,row,identity.ownerAdmin===true);
  if(method==='PATCH'){if(u.search)throw new CloudError('invalid_pagination',400);if(auth.t.value.owner!==identity.owner&&!identity.ownerAdmin)throw new CloudError('team_owner_required',403);return review(identity,row,b,identity.ownerAdmin===true);}
  throw new CloudError('method_not_allowed',405);
 }
 async function serviceReports(identity,u,method,target,b){if(!identity.ownerAdmin)throw new CloudError('owner_access_required',403);await cleanup();
  if(!target&&method==='GET'){const p=await page(u,QUEUE,'report_index',v=>v.expiresAtMs>now()),reports=[];for(const i of p.rows){const r=await records.get('report-root:'+i.value.id);if(r)reports.push({...receipt(r.value),teamId:r.value.teamId,reporterPeerId:r.value.reporterPeerId,targetPeerId:r.value.targetPeerId,...r.value.input});}return {status:200,body:{reports,cursor:p.cursor,nextCursor:p.nextCursor}};}
  const row=await reportRoot(target);return serial(row.value.teamId,async()=>{const fresh=await reportRoot(target);if(method==='GET')return detail(identity,u,fresh,true);if(method==='PATCH'){if(u.search)throw new CloudError('invalid_pagination',400);return review(identity,fresh,b,true);}throw new CloudError('method_not_allowed',405);});
 }
 return {community,requireAcceptance,accepted,blocked,available,decorate,blocks,reports,serviceReports,rememberKey,cleanup};
}
module.exports={createCommunity,POLICY,REASONS,RETENTION,QUEUE};
