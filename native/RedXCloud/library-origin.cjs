'use strict';
// Client-reported catalog hints. These never authorize execution or alter an
// immutable encrypted manifest, crypto context, archive key or object id.
const {CloudError}=require('./redx-state.cjs');
const platforms=new Set(['macos','windows','linux','android','ios','unknown']);
const architectures=new Set(['arm64','x86_64','x86','arm','unknown']);
const apps=new Set(['macos','windows','linux','android','ios']);
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
function validateOrigin(value){
 if(value==null)return null;
 if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='architecture,deviceId,platform,schema'||
  value.schema!==1||!platforms.has(value.platform)||!architectures.has(value.architecture)||typeof value.deviceId!=='string'||!/^[a-f0-9]{32}$/.test(value.deviceId))
  throw new CloudError('library_origin_invalid',400);
 return {schema:1,platform:value.platform,architecture:value.architecture,deviceId:value.deviceId};
}
function applicationPlatform(name,kind,declared=null){
 if(declared!==null&&!apps.has(declared))throw new CloudError('library_application_platform_invalid',400);
 if(kind!=='file'&&kind!=='app')return null;
 let inferred=null;const suffix=typeof name==='string'?(name.toLowerCase().match(/\.[^.]+$/)||[])[0]:null;
 if(kind==='file'||kind==='app'){
  if(['.exe','.msi','.msix','.appx','.msixbundle','.appxbundle'].includes(suffix))inferred='windows';
  else if(['.appimage','.deb','.rpm'].includes(suffix))inferred='linux';
  else if(suffix==='.apk')inferred='android';else if(suffix==='.ipa')inferred='ios';else if(kind==='app')inferred='macos';
 }
 if(inferred&&declared&&inferred!==declared)throw new CloudError('library_application_platform_conflict',400);
 return inferred||declared;
}
function metadata(body,previous){
 const origin=own(body,'origin')?validateOrigin(body.origin):validateOrigin(previous?.origin);
 const declared=own(body,'applicationPlatform')?body.applicationPlatform:(previous?.applicationPlatform??null);
 const application=applicationPlatform(body.name,body.kind,declared);
 if(previous?.manifestId===body.manifestId){
  const beforeOrigin=validateOrigin(previous.origin),beforeApp=applicationPlatform(previous.name,previous.kind,previous.applicationPlatform??null);
  for(const field of ['name','kind','workspace','archiveBytes','archiveSha256'])if(previous[field]!==body[field])throw new CloudError('library_item_conflict',409);
  // An unchanged snapshot may be retried from another device or by an older
  // client. Retain its first origin, including an explicitly unknown legacy
  // origin, rather than retargeting provenance or failing the verified retry.
  return {origin:beforeOrigin,applicationPlatform:beforeApp};
 }
 return {origin,applicationPlatform:application};
}
function view(item){return {...item,origin:validateOrigin(item.origin),applicationPlatform:applicationPlatform(item.name,item.kind,item.applicationPlatform??null)};}
module.exports={validateOrigin,applicationPlatform,metadata,view};
