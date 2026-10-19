"use strict";
/* Teams cleanup for account deletion, and full team deletion.
   Ownership rule (docs/API-teams.md "Account deletion"):
   - An owner whose team still has other active members cannot delete their
     account until they transfer ownership (POST /v2/teams/:id/transfer) or
     delete the team (POST /v2/teams/:id/delete). Deletion refuses with 409
     team_owner_must_transfer and lists those teams. Nothing is deleted first.
   - A team whose only active member is the owner is deleted with the account
     (team docs, chat, invites, team workspace files under customer/teams/<id>/).
   - Any other membership is removed: member record deleted, color freed,
     member count lowered, personal-workspace shares removed, and every chat
     message the user wrote is emptied and shown as "Deleted member". The
     hash-chained audit log is kept (it only holds per-team pseudonymous ids)
     and gets a member.account_deleted entry.
   - If the user still pays for a team or team workspace they no longer own
     (after a transfer), that record is marked canceled (Stripe cancels the
     subscription in the same deletion job) so the new owner can check out. */
const crypto=require("node:crypto");
const DELETED_NAME="Deleted member";
const DELETED_REASON="This member deleted their account";

function refusal(status,code,extra){return Object.assign(new Error(code),{status,code},extra||{});}
const teamsCol=db=>db.collection("gd_teams");
async function docsOf(query){try{return (await query.get()).docs||[];}catch(_){return [];}}

async function ownedTeamsBlocking(db,owner){
 const out=[];
 for(const d of await docsOf(db.collection("gd_accounts").doc(owner).collection("teams"))){
  const t=await teamsCol(db).doc(d.id).get();
  if(!t.exists||t.data().ownerHash!==owner)continue;
  const others=(await docsOf(teamsCol(db).doc(d.id).collection("members")))
   .map(x=>x.data()).filter(m=>m.status==="active"&&m.accountHash!==owner);
  if(others.length)out.push({teamId:d.id,name:t.data().name,otherMembers:others.length});
 }
 return out;
}

async function deleteTeamData(db,bucket,teamId){
 const ref=teamsCol(db).doc(teamId);
 if(bucket&&typeof bucket.deleteFiles==="function")await bucket.deleteFiles({prefix:"customer/teams/"+teamId+"/",force:true});
 for(const w of await docsOf(ref.collection("workspaces"))){
  for(const sub of ["files","uploads"])for(const c of await docsOf(w.ref.collection(sub)))await c.ref.delete();
  await db.collection("gd_team_workspace_index").doc(w.id).delete();
  await w.ref.delete();
 }
 for(const m of await docsOf(ref.collection("members"))){
  const hash=m.data().accountHash;
  if(typeof hash==="string")await db.collection("gd_accounts").doc(hash).collection("teams").doc(teamId).delete();
  await m.ref.delete();
 }
 for(const sub of ["colors","messages","shares","audit"])for(const c of await docsOf(ref.collection(sub)))await c.ref.delete();
 for(const i of await docsOf(db.collection("gd_team_invites").where("teamId","==",teamId)))await i.ref.delete();
 await ref.delete();
}

function auditEntry(team,entry,atMs){
 const seq=(team.auditSeq||0)+1,prev=team.auditHead||"0".repeat(64);
 const body={seq,prev,atMs,...entry};
 return {seq,doc:{...body,hash:crypto.createHash("sha256").update(prev+JSON.stringify(body)).digest("hex")}};
}

async function removeDeletedMember(db,teamId,owner,now){
 const ref=teamsCol(db).doc(teamId);
 const shares=await docsOf(ref.collection("shares").where("ownerHash","==",owner));
 const msgs=await docsOf(ref.collection("messages").where("authorHash","==",owner));
 await db.runTransaction(async tx=>{
  const [t,m]=await Promise.all([tx.get(ref),tx.get(ref.collection("members").doc(owner))]);
  if(!t.exists)return;
  const team=t.data(),me=m.exists?m.data():null;
  const lock=me?.color?await tx.get(ref.collection("colors").doc(me.color)):null;
  const patch={};
  if(me){
   tx.delete(m.ref);
   if(lock?.exists&&lock.data().memberId===me.memberId)tx.delete(lock.ref);
   if(me.status==="active")patch.memberCount=Math.max(1,(team.memberCount||1)-1);
   const a=auditEntry(team,{action:"member.account_deleted",actor:me.memberId,source:"account_deletion"},now());
   tx.set(ref.collection("audit").doc(String(a.seq).padStart(10,"0")),a.doc);
   patch.auditSeq=a.seq;patch.auditHead=a.doc.hash;
  }
  if(team.payerHash===owner&&team.ownerHash!==owner)
   Object.assign(patch,{subscriptionStatus:"canceled",subscriptionId:null,checkoutSessionId:null,payerHash:null});
  for(const s of shares)tx.delete(s.ref);
  // Messages: content removed, author unlinkable. The seq stays so polling clients don't skip.
  for(const x of msgs)tx.update(x.ref,{text:"",card:null,authorHash:null,memberId:null,displayName:DELETED_NAME,color:null,
   deleted:true,deletedBy:"account_deletion",deleteReason:DELETED_REASON});
  if(Object.keys(patch).length)tx.update(ref,patch);
 });
 for(const w of await docsOf(ref.collection("workspaces").where("payerHash","==",owner)))
  await w.ref.update({plansStatus:"canceled",plansSubscriptionId:null,plansCheckoutSessionId:null,payerHash:null,
   plansEverPaid:w.data().plansEverPaid===true||!!w.data().plansSubscriptionId});
}

/** Run during account deletion, before Stripe cancellation and object removal. Idempotent. */
async function deleteAccountTeams(db,owner,{bucket,now=()=>Date.now()}={}){
 const blocking=await ownedTeamsBlocking(db,owner);
 if(blocking.length)throw refusal(409,"team_owner_must_transfer",{teams:blocking,permanent:false});
 const ids=new Set((await docsOf(db.collection("gd_accounts").doc(owner).collection("teams"))).map(d=>d.id));
 for(const d of await docsOf(teamsCol(db).where("payerHash","==",owner)))ids.add(d.id);
 const result={deletedTeams:[],leftTeams:[]};
 for(const id of ids){
  const t=await teamsCol(db).doc(id).get();
  if(t.exists&&t.data().ownerHash===owner){await deleteTeamData(db,bucket,id);result.deletedTeams.push(id);}
  else if(t.exists){await removeDeletedMember(db,id,owner,now);result.leftTeams.push(id);}
  await db.collection("gd_accounts").doc(owner).collection("teams").doc(id).delete();
 }
 return result;
}
module.exports={deleteAccountTeams,ownedTeamsBlocking,deleteTeamData,DELETED_NAME,DELETED_REASON};
