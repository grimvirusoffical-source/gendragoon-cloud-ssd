'use strict';
// Collaboration records are independent of Receiver storage entitlements. A row
// per invite/member/message avoids a business member cap or an account-ledger
// size limit. All operations use the existing scoped GenDragoon RedX database.
const crypto=require('node:crypto');
const {CloudError}=require('./redx-state.cjs');
const FILE='dev-teams.red-xai.db',TABLE='DevEntry',MAX_RECORD=16*1024;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function decode(value){for(let i=0;i<3&&typeof value==='string';i++)value=JSON.parse(value);return value;}
class DevTeamRecords{
 constructor(receiver){this.receiver=receiver;}
 key(logical){return hash('gendragoon-dev-team-record/v1\0'+logical);}
 address(key){return Number.parseInt(key.slice(0,13),16);}
 validate(row,key){
  if(!row||row.schema!==1||typeof row.key!=='string'||!/^[a-f0-9]{64}$/.test(row.key)||row.key!==key||!Number.isSafeInteger(row.revision)||row.revision<0||
    typeof row.scope!=='string'||! /^[a-f0-9]{32,64}$/.test(row.scope)||typeof row.kind!=='string'||
    !Number.isSafeInteger(row.position)||row.position<1||!row.value||typeof row.value!=='object'||Array.isArray(row.value))
    throw new CloudError('team_metadata_invalid',503);
  return row;
 }
 async get(logical){
  const key=this.key(logical),id=this.address(key);
  try{const result=await this.receiver.call('GET','path/'+encodeURIComponent(`${FILE}:${TABLE}[ID=${id}].State`));return this.validate(decode(result.value),key);}
  catch(e){if(e.status===404)return null;throw e;}
 }
 async write(logical,value,{scope,kind,position},prior=null){
  const key=this.key(logical),id=this.address(key);
  if(!/^[a-f0-9]{32,64}$/.test(scope)||! /^[a-z_]{2,24}$/.test(kind))throw new CloudError('team_metadata_invalid',503);
  const row=this.validate({schema:1,key,revision:prior?prior.revision+1:0,scope,kind,position:position??id+1,value},key);
  const state=JSON.stringify(row);if(Buffer.byteLength(state)>MAX_RECORD)throw new CloudError('team_record_too_large',413);
  if(prior){
   if(prior.key!==key||prior.scope!==scope||prior.kind!==kind)throw new CloudError('team_metadata_invalid',503);
   // RedX Set replaces the row. Retain every indexed/addressing column so
   // claimed invitations and updated members remain queryable and mutable.
   await this.receiver.call('POST','bx',{q:`{Tx[]} = [ {Require[]} = "${FILE}":${TABLE}[ID=$id, K=$key, Revision=$previous], {Set[]} = "${FILE}":${TABLE}[ID=$id] = [ {K[]} = $key, {Scope[]} = $scope, {Kind[]} = $kind, {Position[]} = $position, {Revision[]} = $next, {ExpiresAtMs[]} = $expires, {State[]} = $state ] ]`,params:{id,key,scope,kind,position:row.position,previous:prior.revision,next:row.revision,expires:value.expiresAtMs||0,state}});
  }else await this.receiver.call('POST','bx',{q:`{Add[]} = "${FILE}":${TABLE}[ID=$id] = [ {K[]} = $key, {Scope[]} = $scope, {Kind[]} = $kind, {Position[]} = $position, {Revision[]} = 0, {ExpiresAtMs[]} = $expires, {State[]} = $state ]`,params:{id,key,scope,kind,position:row.position,expires:value.expiresAtMs||0,state}});
  return row;
 }
 async remove(row){
  this.validate(row,row?.key);const id=this.address(row.key);
  await this.receiver.call('POST','bx',{q:`{Tx[]} = [ {Require[]} = "${FILE}":${TABLE}[ID=$id, K=$key, Revision=$previous], {Delete[]} = "${FILE}":${TABLE}[ID=$id] ]`,params:{id,key:row.key,previous:row.revision}});
 }
 async list(scope,kind,{after=0,limit=50,activeAfter,expiredBefore}={}){
  if(!/^[a-f0-9]{32,64}$/.test(scope)||! /^[a-z_]{2,24}$/.test(kind)||!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw new CloudError('invalid_pagination',400);
  for(const value of [activeAfter,expiredBefore])if(value!==undefined&&(!Number.isSafeInteger(value)||value<0))throw new CloudError('invalid_pagination',400);
  const expiration=activeAfter!==undefined?', ExpiresAtMs > $active':expiredBefore!==undefined?', ExpiresAtMs > 0, ExpiresAtMs <= $expired':'';
  const result=await this.receiver.call('POST','bx',{q:`{Get[]} = "${FILE}":${TABLE}[Scope=$scope, Kind=$kind, Position > $after${expiration}] -> [ID, Position, State], Sort = Position, Limit = $limit`,params:{scope,kind,after,limit:limit+1,...(activeAfter!==undefined?{active:activeAfter}:{}),...(expiredBefore!==undefined?{expired:expiredBefore}:{})}});
  if(JSON.stringify(result.columns)!=='["ID","Position","State"]'||!Array.isArray(result.rows)||result.rows.length>limit+1)throw new CloudError('team_metadata_invalid',503);
  let previous=after;
  const rows=result.rows.map(tuple=>{
   if(!Array.isArray(tuple)||tuple.length!==3||!Number.isSafeInteger(tuple[0])||!Number.isSafeInteger(tuple[1])||tuple[1]<=previous)throw new CloudError('team_metadata_invalid',503);
   const row=decode(tuple[2]);this.validate(row,row?.key);
   if(row.scope!==scope||row.kind!==kind||row.position!==tuple[1]||this.address(row.key)!==tuple[0])throw new CloudError('team_metadata_invalid',503);
   previous=row.position;return row;
  });
  return {rows:rows.slice(0,limit),after:rows.length>limit?rows[limit-1].position:null};
 }
}
module.exports={DevTeamRecords,MAX_RECORD};
