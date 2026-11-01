'use strict';
// Pure GenDragoon device-registration policy. No process execution or login bypass.
const {CloudError,digest}=require('./redx-state.cjs');
const {actor}=require('./gdg-account-state.cjs');
const ID=/^[a-f0-9]{32}$/, HASH=/^[a-f0-9]{64}$/;
const platforms=new Set(['macos','windows','linux']);
function check(identity,workspace,state){
 actor(identity);
 if(identity.apiKey)throw new CloudError('account_session_required',403);
 if(!state||state.owner!==identity.owner||state.subject!==identity.subject||state.issuer!==identity.issuer)throw new CloudError('account_identity_mismatch',403);
 if(!ID.test(workspace||'')||!state?.GDGWS?.[workspace])throw new CloudError('not_found',404);
}
function summary(d){return {id:d.id,name:d.name,platform:d.platform,workspaceId:d.workspaceId,createdMs:d.createdMs,signed:true,qrFormat:d.qr.format,qrSha256:d.qr.sha256};}
function validateRequest(input){
 if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['id','name','platform','deviceFingerprint'].includes(k))||!ID.test(input.id||'')||!HASH.test(input.deviceFingerprint||'')||!platforms.has(input.platform))throw new CloudError('device_request_invalid',400);
 if(typeof input.name!=='string'||!input.name.trim()||input.name.length>80||/[\x00-\x1f\x7f]/.test(input.name))throw new CloudError('device_name_invalid',400);
 return {...input,name:input.name.trim()};
}
function validateImage(image){
 if(!image||Object.keys(image).some(k=>!['format','objectId','png','sha256'].includes(k))||!ID.test(image.objectId||'')||image.format!=='redsecretsxai-visual-v3'||typeof image.png!=='string'||image.png.length>175000||!HASH.test(image.sha256||''))throw new CloudError('device_receipt_invalid',503);
 const bytes=Buffer.from(image.png,'base64');
 if(bytes.toString('base64')!==image.png||bytes.length>128*1024||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||digest(bytes)!==image.sha256)throw new CloudError('device_receipt_invalid',503);
 return image;
}
function add(identity,workspace,state,input,image,now=Date.now()){
 check(identity,workspace,state);input=validateRequest(input);image=validateImage(image);
 const old=state.GDGSigned[input.id];
 if(old){if(old.workspaceId!==workspace||old.deviceFingerprint!==input.deviceFingerprint||old.platform!==input.platform)throw new CloudError('device_registration_conflict',409);return summary(old);}
 const sameWorkspace=Object.values(state.GDGSigned).filter(d=>d.workspaceId===workspace);
 if(sameWorkspace.some(d=>d.deviceFingerprint===input.deviceFingerprint))throw new CloudError('device_already_signed',409);
 if(sameWorkspace.length>=20)throw new CloudError('device_limit',409);
 const record={...input,workspaceId:workspace,createdMs:now,qr:{format:image.format,objectId:image.objectId,sha256:image.sha256}};state.GDGSigned[input.id]=record;return summary(record);
}
function remove(identity,workspace,state,id){
 check(identity,workspace,state);if(!ID.test(id||''))throw new CloudError('device_id_invalid',400);
 const old=state.GDGSigned[id];if(old&&old.workspaceId!==workspace)throw new CloudError('not_found',404);
 delete state.GDGSigned[id];return {workspace,deviceId:id,revoked:true,qrDeleted:true};
}
function image(identity,workspace,state,id){check(identity,workspace,state);const d=state.GDGSigned[id];if(!d||d.workspaceId!==workspace)throw new CloudError('not_found',404);return {workspace,id,...d.qr};}
function list(identity,workspace,state){check(identity,workspace,state);return {workspace,devices:Object.values(state.GDGSigned).filter(d=>d.workspaceId===workspace).map(summary)};}
module.exports={check,summary,validateRequest,validateImage,add,remove,image,list};
