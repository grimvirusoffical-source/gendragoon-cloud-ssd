"use strict";
/* Teams cleanup for account deletion, and full team deletion.
   Ownership rule (docs/API-teams.md "Account deletion"):
   - An owner whose team still has other active members cannot delete their
     account until they transfer ownership (POST /v2/teams/:id/transfer) or
     delete the team (POST /v2/teams/:id/delete). Deletion refuses with 409
     team_owner_must_transfer and lists those teams. Nothing is deleted first.
   - A team whose only active member is the owner is deleted with the account
     (team docs, chat, invites, team workspace files under customer/teams/<id>/).
   - Every other team the account ever touched is cleaned, whether the user is
     still active there or left, was kicked or was banned. Teams are found via
     gd_accounts/<hash>/teams (active), gd_accounts/<hash>/team_history (never
     removed by leave/kick/ban) and collection-group queries on members,
     messages and shares by account hash. The member record (any status) is
     deleted, the color freed and the count lowered if active, shares removed,
     and every chat message the user wrote is emptied and shown as "Deleted
     member". A ban still in force leaves only a pseudonymous tombstone in
     gd_teams/<id>/bans/<memberId> (reason, end). The hash-chained audit log is
     kept (it only holds per-team pseudonymous ids) and gets a
     member.account_deleted entry.
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
  if(typeof hash==="string")for(const sub of ["teams","team_history"])await db.collection("gd_accounts").doc(hash).collection(sub).doc(teamId).delete();
  await m.ref.delete();
 }
 for(const sub of ["colors","messages","shares","audit","bans"])for(const c of await docsOf(ref.collection(sub)))await c.ref.delete();
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
 const memberId=require("./teams").memberIdFor(teamId,owner);
 // No error swallowing here: a failed read must fail the step (the job retries), not skip data.
 const shares=(await ref.collection("shares").where("ownerHash","==",owner).get()).docs;
 const msgs=(await ref.collection("messages").where("authorHash","==",owner).get()).docs;
 await db.runTransaction(async tx=>{
  const [t,m]=await Promise.all([tx.get(ref),tx.get(ref.collection("members").doc(owner))]);
  if(!t.exists)return;
  const team=t.data(),me=m.exists?m.data():null,active=me?.status==="active";
  const lock=active&&me.color?await tx.get(ref.collection("colors").doc(me.color)):null;
  const patch={};
  if(me){
   // Active, left, kicked and banned records all go: the doc id and accountHash are the account.
   tx.delete(m.ref);
   if(lock?.exists&&lock.data().memberId===me.memberId)tx.delete(lock.ref);
   if(active)patch.memberCount=Math.max(1,(team.memberCount||1)-1);
   // A ban still in force keeps a pseudonymous tombstone (per-team member id, reason, end) for the owner's records.
   if(me.status==="banned"&&(me.bannedUntilMs===null||me.bannedUntilMs>now()))
    tx.set(ref.collection("bans").doc(me.memberId),{memberId:me.memberId,reason:me.banReason||null,
     untilMs:me.bannedUntilMs===undefined?null:me.bannedUntilMs,accountDeleted:true,atMs:now()});
  }
  if(me||msgs.length||shares.length){
   const a=auditEntry(team,{action:"member.account_deleted",actor:me?.memberId||memberId,source:"account_deletion"},now());
   tx.set(ref.collection("audit").doc(String(a.seq).padStart(10,"0")),a.doc);
   patch.auditSeq=a.seq;patch.auditHead=a.doc.hash;
  }
  if(team.payerHash===owner&&team.ownerHash!==owner)
   Object.assign(patch,{subscriptionStatus:"canceled",subscriptionId:null,checkoutSessionId:null,payerHash:null});
  for(const x of shares)tx.delete(x.ref);
  // Messages: content removed, author unlinkable. The seq stays so polling clients don't skip.
  for(const x of msgs)tx.update(x.ref,{text:"",card:null,authorHash:null,memberId:null,displayName:DELETED_NAME,color:null,
   deleted:true,deletedBy:"account_deletion",deleteReason:DELETED_REASON});
  if(Object.keys(patch).length)tx.update(ref,patch);
 });
 for(const w of await docsOf(ref.collection("workspaces").where("payerHash","==",owner)))
  await w.ref.update({plansStatus:"canceled",plansSubscriptionId:null,plansCheckoutSessionId:null,payerHash:null,
   plansEverPaid:w.data().plansEverPaid===true||!!w.data().plansSubscriptionId});
}

// gd_teams/<teamId>/<collection>/<doc>
function teamIdFromPath(path){
 const parts=String(path||"").split("/");
 return parts.length===4&&parts[0]==="gd_teams"?parts[1]:null;
}
/** Every team this account touched, including ones it left or was removed from. */
async function teamsTouchedBy(db,owner){
 const account=db.collection("gd_accounts").doc(owner);
 const ids=new Set();
 for(const d of await docsOf(account.collection("teams")))ids.add(d.id);
 for(const d of await docsOf(account.collection("team_history")))ids.add(d.id);
 for(const d of await docsOf(teamsCol(db).where("payerHash","==",owner)))ids.add(d.id);
 // Collection-group queries also find records written before team_history existed.
 // Errors here (e.g. a missing index) fail the step so the job retries instead of skipping data.
 if(typeof db.collectionGroup==="function"){
  for(const [group,field] of [["members","accountHash"],["messages","authorHash"],["shares","ownerHash"]]){
   const snap=await db.collectionGroup(group).where(field,"==",owner).get();
   for(const d of snap.docs||[]){const id=teamIdFromPath(d.ref?.path);if(id)ids.add(id);}
  }
 }
 return ids;
}

/** Run during account deletion, before Stripe cancellation and object removal. Idempotent. */
async function deleteAccountTeams(db,owner,{bucket,now=()=>Date.now()}={}){
 const blocking=await ownedTeamsBlocking(db,owner);
 if(blocking.length)throw refusal(409,"team_owner_must_transfer",{teams:blocking,permanent:false});
 const ids=await teamsTouchedBy(db,owner);
 const result={deletedTeams:[],leftTeams:[]};
 for(const id of ids){
  const t=await teamsCol(db).doc(id).get();
  if(t.exists&&t.data().ownerHash===owner){await deleteTeamData(db,bucket,id);result.deletedTeams.push(id);}
  else if(t.exists){await removeDeletedMember(db,id,owner,now);result.leftTeams.push(id);}
  await db.collection("gd_accounts").doc(owner).collection("teams").doc(id).delete();
  await db.collection("gd_accounts").doc(owner).collection("team_history").doc(id).delete();
 }
 return result;
}
module.exports={deleteAccountTeams,ownedTeamsBlocking,deleteTeamData,DELETED_NAME,DELETED_REASON};
