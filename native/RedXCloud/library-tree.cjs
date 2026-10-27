'use strict';
const crypto=require('node:crypto');
const {CloudError}=require('./redx-state.cjs');
const KEY=/^[a-f0-9]{18}$/;
const parentOf=item=>item.parentKey||null;
const labelOf=item=>item.displayName||item.name;
function name(value){
 if(typeof value!=='string')throw new CloudError('library_name_invalid',400);
 const result=value.normalize('NFC').trim();
 if(!result||result.length>255||['.','..'].includes(result)||/[\x00-\x1f\x7f/\\]/.test(result))throw new CloudError('library_name_invalid',400);
 return result;
}
const folded=value=>value.normalize('NFKC').toLocaleLowerCase('en-US');
function parent(library,workspace,key){
 if(key===null||key===undefined)return null;
 if(typeof key!=='string'||!KEY.test(key))throw new CloudError('library_parent_invalid',400);
 const item=library[key];
 if(!item||item.workspace!==workspace)throw new CloudError('library_parent_not_found',404);
 if(item.kind!=='folder'||item.virtualFolder!==true)throw new CloudError('library_parent_not_container',409);
 return key;
}
function collision(library,workspace,parentKey,displayName,except=null){
 return Object.values(library).some(item=>item.workspace===workspace&&item.key!==except&&parentOf(item)===parentKey&&folded(labelOf(item))===folded(displayName));
}
function revision(state,workspace){return state.libraryRevisions?.[workspace]||0;}
function bump(state,workspace){state.libraryRevisions||={};state.libraryRevisions[workspace]=revision(state,workspace)+1;}
function apply(state,workspace,body){
 if(!body||typeof body!=='object'||Array.isArray(body))throw new CloudError('library_operation_invalid',400);
 const op=body.operation;
 if(!['create-folder','rename','move','copy','delete'].includes(op))throw new CloudError('library_operation_invalid',400);
 if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)throw new CloudError('library_revision_required',400);
 if(revision(state,workspace)!==body.expectedRevision)throw new CloudError('library_revision_conflict',409);
 state.library||={};const library=state.library;
 const keys=body.keys===undefined?[]:body.keys;
 if(!Array.isArray(keys)||keys.length>100||keys.some(k=>typeof k!=='string'||!KEY.test(k))||new Set(keys).size!==keys.length||
   (op==='create-folder'?keys.length!==0:keys.length===0))throw new CloudError('library_selection_invalid',400);
 for(const key of keys)if(!library[key]||library[key].workspace!==workspace)throw new CloudError('library_item_not_found',404);
 const target=['create-folder','move','copy'].includes(op)?parent(library,workspace,body.parentKey):null;
 const selected=new Set(keys);
 function ancestorSelected(key){const seen=new Set();for(let p=parentOf(library[key]);p;p=parentOf(library[p])){
  if(seen.has(p)||!library[p]||library[p].workspace!==workspace)throw new CloudError('library_tree_corrupt',503);seen.add(p);if(selected.has(p))return true;
 }return false;}
 const roots=keys.filter(key=>!ancestorSelected(key));
 const changed=[],deleted=[],allocated=new Set();const now=Date.now();
 function freshKey(){for(let i=0;i<16;i++){const k=crypto.randomBytes(9).toString('hex');if(!library[k]&&!allocated.has(k)){allocated.add(k);return k;}}throw new CloudError('library_key_unavailable',503);}
 function descendants(key){const result=[],pending=[key],seen=new Set();while(pending.length){const current=pending.pop();
  if(seen.has(current)||seen.size>=1000)throw new CloudError('library_tree_corrupt',503);seen.add(current);result.push(current);
  for(const item of Object.values(library))if(item.workspace===workspace&&parentOf(item)===current)pending.push(item.key);
 }return result;}
 if(op==='create-folder'){
  const displayName=name(body.name);if(collision(library,workspace,target,displayName))throw new CloudError('library_name_collision',409);
  const key=freshKey();library[key]={key,name:displayName,displayName,kind:'folder',workspace,parentKey:target,virtualFolder:true,
   generation:1,archiveBytes:0,createdMs:now,updatedMs:now};changed.push(key);
 }else if(op==='rename'){
  if(keys.length!==1)throw new CloudError('library_selection_invalid',400);
  const item=library[keys[0]],displayName=name(body.name);
  if(collision(library,workspace,parentOf(item),displayName,item.key))throw new CloudError('library_name_collision',409);
  item.displayName=displayName;item.updatedMs=now;changed.push(item.key);
 }else if(op==='move'){
  for(const key of roots){if(target&&descendants(key).includes(target))throw new CloudError('library_cycle',409);}
  for(const key of roots){const item=library[key];item.parentKey=target;item.updatedMs=now;changed.push(key);}
  for(const key of roots){const item=library[key];if(collision(library,workspace,target,labelOf(item),key))throw new CloudError('library_name_collision',409);}
 }else if(op==='copy'){
  for(const key of roots)if(target&&descendants(key).includes(target))throw new CloudError('library_cycle',409);
  for(const source of roots){const subtree=descendants(source),mapping=new Map(subtree.map(key=>[key,freshKey()]));
   const original=library[source];let displayName=body.name!==undefined?(roots.length===1?name(body.name):(()=>{throw new CloudError('library_selection_invalid',400);})()):labelOf(original);
   const dot=displayName.lastIndexOf('.'),stem=dot>0?displayName.slice(0,dot):displayName,extensionName=dot>0?displayName.slice(dot):'';
   for(let n=1;collision(library,workspace,target,displayName);n++){if(n>1000)throw new CloudError('library_name_collision',409);displayName=name(stem+' copy'+(n===1?'':' '+n)+extensionName);}
   for(const key of subtree){const item=library[key],newKey=mapping.get(key);library[newKey]={...structuredClone(item),key:newKey,
     archiveKey:item.archiveKey||item.key,parentKey:key===source?target:mapping.get(parentOf(item)),displayName:key===source?displayName:labelOf(item),createdMs:now,updatedMs:now};changed.push(newKey);}
  }
 }else{
  for(const source of roots)for(const key of descendants(source)){if(library[key]){delete library[key];deleted.push(key);}}
 }
 if(Object.keys(library).length>1000)throw new CloudError('library_item_limit',507);
 bump(state,workspace);
 return {operation:op,changedKeys:changed,deletedKeys:deleted,freedBytes:0,retainedArchiveData:op==='delete'};
}
module.exports={apply,revision,bump,parent,collision,name,labelOf};
