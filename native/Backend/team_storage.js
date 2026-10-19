"use strict";
/* File storage for team workspaces on the same routes as personal workspaces
   (/v3/cloud/:id, /v2/workspaces/:id/cloud, /v2/workspaces/:id/storage-urls).
   A workspace id is resolved as the caller's personal workspace first; only if
   none exists is it looked up in gd_team_workspace_index and allowed for an
   active team member. Roles: owner and member read, write and delete; viewer
   reads only. The team ACL is re-checked on every request and inside every
   quota transaction (through scope()). */
const {STORAGE}=require("./catalog");
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ENTITLED=new Set(["active","trialing","past_due"]);
const WRITE_ROLES=new Set(["owner","member"]);

function problem(status,message,code){return Object.assign(Error(message),{status,code});}
function teamPrefix(teamId,wid){return "customer/teams/"+teamId+"/"+wid;}
function plansOk(w){return w.plansComplimentary===true||ENTITLED.has(w.plansStatus);}
function teamOk(t){return t.ownerComplimentary===true||ENTITLED.has(t.subscriptionStatus);}

/** Pure: what this member may do with this team workspace right now, or null for no access. */
function teamScope({team,workspace,member,wid,teamId}){
 if(!team||!workspace||!member||member.status!=="active")return null;
 if(workspace.teamId!==teamId||workspace.deleted===true)return null;
 if(workspace.customStorage===true)return {external:true};
 const tier=workspace.requiredPlans?.storageTier;
 if(!Object.hasOwn(STORAGE,tier||""))return null;
 const paid=plansOk(workspace)&&teamOk(team);
 // Never paid: no storage exists yet. Paid then lapsed: readable, writes locked (like personal lapse).
 if(!paid&&!workspace.plansSubscriptionId&&workspace.plansEverPaid!==true&&workspace.plansComplimentary!==true)return null;
 const role=member.role==="owner"?"owner":member.role==="viewer"?"viewer":"member";
 const lock=paid?null:{error:"workspace_lock",reason:"lapsed",overBy:0,unpaidWorkspaceIds:[wid],
   message:teamOk(team)?"This team workspace's plans need payment.":"This team's subscription needs payment."};
 return {prefix:teamPrefix(teamId,wid),limit:STORAGE[tier].gb*1e9,role,canWrite:WRITE_ROLES.has(role),
   uploadsBlocked:!paid,lock,
   workers:paid?workspace.requiredPlans.performanceTier:null};
}
/** The record the transfer governor and profile read (worker cap from the paid performance plan). */
function governorView(workspace,scope){
 if(!scope||scope.uploadsBlocked)return {kind:"free",provisioned:true,projectStatus:"active",name:workspace?.name};
 return {kind:"paid",name:workspace.name,projectBillingVersion:3,plansStatus:"active",projectStatus:"active",provisioned:true,
  storageActive:true,storageTier:workspace.requiredPlans.storageTier,storageMode:"standard",
  performanceActive:true,performanceTier:workspace.requiredPlans.performanceTier,requiredPlans:workspace.requiredPlans,
  usedBytes:workspace.usedBytes||0,reservedBytes:workspace.reservedBytes||0};
}
async function platformBlocked(db,accountHash){
 const snap=await db.collection("account_state").doc(accountHash).get();
 const s=snap.exists?snap.data():null;
 return !!s&&["suspended","terminated","pending_deletion"].includes(s.state);
}
/** Resolve a team workspace for a caller. Returns null when the id isn't a team workspace the caller can see. */
async function resolveTeamWorkspace(db,accountHash,wid,{method="GET"}={}){
 if(typeof wid!=="string"||!UUID.test(wid))return null;
 const idx=await db.collection("gd_team_workspace_index").doc(wid).get();
 if(!idx.exists)return null;
 const teamId=idx.data().teamId;
 if(typeof teamId!=="string"||!UUID.test(teamId))return null;
 const teamRef=db.collection("gd_teams").doc(teamId);
 const ref=teamRef.collection("workspaces").doc(wid);
 const [t,w,m]=await Promise.all([teamRef.get(),ref.get(),teamRef.collection("members").doc(accountHash).get()]);
 const team=t.exists?t.data():null,workspace=w.exists?w.data():null,member=m.exists?m.data():null;
 // Non-members can't tell a team workspace exists: same 404 as a missing workspace.
 if(!team||!workspace||!member||member.status!=="active")return null;
 if(await platformBlocked(db,accountHash))throw problem(403,"This account is suspended","account_restricted");
 const scope=teamScope({team,workspace,member,wid,teamId});
 if(!scope)throw problem(403,"Active provisioned storage required","TEAM_STORAGE_INACTIVE");
 if(scope.external)throw problem(409,"This team workspace uses custom storage","byo_external");
 const write=!["GET","HEAD"].includes(method);
 if(write&&!scope.canWrite)throw problem(403,"Viewers can read team files but not change them","TEAM_ROLE_READ_ONLY");
 const rescope=data=>teamScope({team,workspace:data,member,wid,teamId});
 return {teamId,ref,workspace,team,member,scope,rescope,view:governorView(workspace,scope),governorKey:"team-"+teamId+"-"+wid};
}
module.exports={resolveTeamWorkspace,teamScope,governorView,teamPrefix,WRITE_ROLES};
