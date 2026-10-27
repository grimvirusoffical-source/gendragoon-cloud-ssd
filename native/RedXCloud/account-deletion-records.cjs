'use strict';
// Bounded scans are internal to the scoped GenDragoon database. They never
// return another account's row to a client. Every removal uses exact row CAS.
const {CloudError}=require('./redx-state.cjs');
const {DevTeamRecords}=require('./dev-team-store.cjs');
const {IntegrationMetadata}=require('./integrations.cjs');
const {peerID}=require('./dev-teams.cjs');
const STAGES=['integrations','teams','members','data','signals','roots','markers','verify-integrations','verify-dev','done'];
const ID=/^[a-f0-9]{32}$/,ACCOUNT=/^[a-f0-9]{64}$/;
// These fields are derived by the Team service, never accepted as an arbitrary
// client owner. Keep the list exact: unrelated records must not be erased by a
// coincidental targetAccount field.
const ACCOUNT_LINKED_TEAM_KINDS=new Set(['block','report','report_state','report_index','report_review','message_ref']);
function decode(value){for(let i=0;i<3&&typeof value==='string';i++)value=JSON.parse(value);return value;}
class AccountDeletionRecords{
 constructor(store,{exclusive=async(_key,fn)=>fn(),now=Date.now}={}){this.store=store;this.records=new DevTeamRecords(store);this.integrations=new IntegrationMetadata(store);this.exclusive=exclusive;this.now=now;}
 async scan(table,after){
  if(!Number.isSafeInteger(after)||after< -1)throw new CloudError('account_deletion_state_invalid',503);
  const integration=table==='Integration',file=integration?'integrations.red-xai.db':'dev-teams.red-xai.db',limit=integration?2:50;
  let result;
  try{result=await this.store.call('POST','bx',{q:`{Get[]} = "${file}":${table}[ID > $after] -> [ID, State], Sort = ID, Limit = ${limit+1}`,params:{after}});}
  catch(e){if(e.status===404)return {rows:[],after:null};throw e;}
  // Actual RedX omits projected columns when a filtered BoxQL scan is empty.
  // Only the exact empty-array pair is equivalent to an empty page.
  if(Array.isArray(result?.columns)&&result.columns.length===0&&Array.isArray(result.rows)&&result.rows.length===0)return {rows:[],after:null};
  if(JSON.stringify(result?.columns)!=='["ID","State"]'||!Array.isArray(result.rows)||result.rows.length>limit+1)throw new CloudError('account_deletion_metadata_invalid',503);
  let previous=after;
  const rows=result.rows.map(tuple=>{
   if(!Array.isArray(tuple)||tuple.length!==2||!Number.isSafeInteger(tuple[0])||tuple[0]<=previous)throw new CloudError('account_deletion_metadata_invalid',503);
   const value=decode(tuple[1]);
   if(integration){
    if(!value||!['owner','key','grant'].includes(value.kind)||typeof value.id!=='string'||!Number.isSafeInteger(value.revision)||!value.data||this.integrations.address(value.kind,value.id)!==tuple[0])throw new CloudError('account_deletion_metadata_invalid',503);
   }else{this.records.validate(value,value?.key);if(this.records.address(value.key)!==tuple[0])throw new CloudError('account_deletion_metadata_invalid',503);}
   previous=tuple[0];return {id:tuple[0],value};
  });
  return {rows:rows.slice(0,limit),after:rows.length>limit?rows[limit-1].id:null};
 }
 async removeIntegration(row){
  await this.store.call('POST','bx',{q:'{Tx[]} = [ {Require[]} = "integrations.red-xai.db":Integration[ID=$id, Revision=$previous, State=$expected], {Delete[]} = "integrations.red-xai.db":Integration[ID=$id] ]',params:{id:row.id,previous:row.value.revision,expected:JSON.stringify(row.value)}});
 }
 integrationOwned(row,owner){const v=row.value;return v.kind==='owner'&&v.id===owner||v.kind==='key'&&v.data.owner===owner||v.kind==='grant'&&v.data.grant?.identity?.owner===owner;}
 async marked(peer,owner,id){if(!ID.test(peer||''))return false;const r=await this.records.get('account-delete-peer:'+peer);return r?.scope===owner&&r.kind==='deletion_peer'&&r.value.deletionId===id;}
 async ownedTeam(scope,owner){if(!ID.test(scope))return false;return (await this.records.get('team:'+scope))?.value.owner===owner;}
 async directOwned(row,owner){
  const r=row.value,v=r.value;
  if(r.kind==='deletion_peer')return false;
  if(r.scope===owner||v.account===owner||v.claimedBy===owner)return true;
  if(ACCOUNT_LINKED_TEAM_KINDS.has(r.kind)&&(v.targetAccount===owner||v.owner===owner))return true;
  if(['message','presence'].includes(r.kind)&&ID.test(r.scope)&&v.peerId===peerID(r.scope,owner))return true;
  if(r.kind==='invite'&&await this.ownedTeam(r.scope,owner))return true;
  return false;
 }
 async page(owner,id,progress){
  if(!ACCOUNT.test(owner)||!ID.test(id)||!STAGES.includes(progress?.stage))throw new CloudError('account_deletion_state_invalid',503);
  if(progress.stage==='done')return {done:true,progress,removed:0};
  const stage=progress.stage,integration=['integrations','verify-integrations'].includes(stage);
  const page=await this.scan(integration?'Integration':'DevEntry',progress.after),verification=stage.startsWith('verify-');let removed=0;
  for(const row of page.rows){
   if(integration){if(this.integrationOwned(row,owner)){if(verification)throw new CloudError('account_deletion_verification_failed',503);await this.removeIntegration(row);removed++;}continue;}
   const r=row.value,v=r.value;
   if(stage==='teams'&&r.kind==='team'&&v.owner===owner){
    if(!ID.test(r.scope)||v.id!==r.scope)throw new CloudError('account_deletion_metadata_invalid',503);
    // Wait for the actual team mutation lock before closing it. All later
    // scans then include writes which were already in flight before closure.
    await this.exclusive(r.scope,async()=>{await this.records.write('team:'+r.scope,{...v,status:'deleting'},{scope:r.scope,kind:'team',position:r.position},r);});
   }else if(stage==='members'&&r.kind==='member'&&v.account===owner){
    if(!ID.test(r.scope)||!ID.test(v.peerId)||v.peerId!==peerID(r.scope,owner))throw new CloudError('account_deletion_metadata_invalid',503);
    await this.exclusive(r.scope,async()=>{
     const key='account-delete-peer:'+v.peerId,prior=await this.records.get(key);
     if(prior&&(prior.scope!==owner||prior.value.deletionId!==id))throw new CloudError('account_deletion_metadata_invalid',503);
     if(!prior)await this.records.write(key,{peerId:v.peerId,deletionId:id},{scope:owner,kind:'deletion_peer'});
     await this.records.remove(r);removed++;
    });
   }else if(stage==='data'&&r.kind!=='team'&&await this.directOwned(row,owner)){
    await this.records.remove(r);removed++;
   }else if(stage==='signals'&&r.kind==='signal'&&(await this.marked(v.from,owner,id)||await this.marked(v.to,owner,id))){
    await this.records.remove(r);removed++;
   }else if(stage==='roots'&&r.kind==='team'&&v.owner===owner){
    if(!ID.test(r.scope)||v.id!==r.scope)throw new CloudError('account_deletion_metadata_invalid',503);
    await this.exclusive(r.scope,async()=>{await this.records.write('team:'+r.scope,{id:r.scope,status:'deleted',accountDeleted:true,deletedMs:this.now()},{scope:r.scope,kind:'team',position:r.position},r);});
    removed++;
   }else if(stage==='markers'&&r.kind==='deletion_peer'&&r.scope===owner&&v.deletionId===id){
    await this.records.remove(r);removed++;
   }else if(stage==='verify-dev'&&(r.scope===owner||v.owner===owner||v.account===owner||v.claimedBy===owner||await this.directOwned(row,owner))){
    throw new CloudError('account_deletion_verification_failed',503);
   }
  }
  const next=page.after===null?{stage:STAGES[STAGES.indexOf(stage)+1],after:-1}:{stage,after:page.after};
  return {done:next.stage==='done',progress:next,removed};
 }
}
module.exports={AccountDeletionRecords,STAGES};
