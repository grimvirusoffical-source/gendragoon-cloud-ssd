"use strict";
// Team roles, ownership transfer, team deletion, team workspace id uniqueness,
// and account deletion cleanup (memberships, colors, chat, ownership rule).
const test=require("node:test"),assert=require("node:assert/strict");
const {fixture,hash,idFor}=require("./test_helpers/teams_fixture");
const {deleteAccountTeams,ownedTeamsBlocking}=require("./teams_account");
const {createAccountDeletion}=require("./account_delete");
const {createTeamService}=require("./teams");
const PLANS={storageTier:"100GB",performanceTier:"boost",interval:"month"};

function bucketDouble(keys=[]){
 const objects=new Set(keys);
 return {objects,deleteFiles:async({prefix})=>{for(const k of [...objects])if(k.startsWith(prefix))objects.delete(k);}};
}
async function paidWorkspace(f,id,n=21){
 const ws=await f.request("/v2/teams/"+id+"/workspaces",{name:"Assets "+n,intentId:idFor(n),plans:PLANS});
 assert.equal(ws.status,201,JSON.stringify(ws.body));
 await f.paySession(ws.body.url.split("/").pop());
 return ws.body.workspace.id;
}
const memberIdOf=async(f,id,user)=>(await f.request("/v2/teams/"+id,undefined,user)).body.team.me.memberId;
const verify=(f,id)=>createTeamService({db:f.db,stamp:()=>0,hash}).verifyAudit(
 [...f.db.rows.entries()].filter(([k])=>k.startsWith("gd_teams/"+id+"/audit/")).sort().map(([,v])=>v));

test("team workspace ids are global: indexed for the storage routes, and a personal project can't reuse one",async t=>{
 const f=await fixture(t);const id=await f.activeTeam(1);
 const wid=await paidWorkspace(f,id);
 assert.deepEqual(f.db.rows.get("gd_team_workspace_index/"+wid),{teamId:id});
 const ws=(await f.request("/v2/teams/"+id+"/workspaces")).body.teamWorkspaces[0];
 assert.deepEqual(ws.storageRoutes,{v3:"/v3/cloud/"+wid,v2:"/v2/workspaces/"+wid+"/cloud"});
 assert.equal(ws.access,"write");assert.equal(ws.usedBytes,0);
 const other=await f.activeTeam(2);
 const clash=await f.request("/v2/teams/"+other+"/workspaces",{name:"Assets 21",intentId:wid,plans:PLANS});
 assert.equal(clash.status,409);assert.equal(clash.body.error,"INTENT_CONFLICT");
 const mine=await f.request("/v2/projects",{name:"Mine",intentId:wid,plans:PLANS});
 assert.equal(mine.status,409);assert.equal(mine.body.error,"INTENT_CONFLICT");
});

test("roles: the owner makes a member a viewer (read only); only the owner can, and it's audited",async t=>{
 const f=await fixture(t);const id=await f.activeTeam(1);await paidWorkspace(f,id);
 await f.join(id,"test-b","red-500");
 const b=await memberIdOf(f,id,"test-b");
 assert.equal((await f.request("/v2/teams/"+id+"/members/"+b+"/role",{role:"viewer"},"test-b")).body.error,"TEAM_OWNER_ONLY");
 assert.equal((await f.request("/v2/teams/"+id+"/members/"+b+"/role",{role:"owner"})).body.error,"INVALID_ROLE");
 const r=await f.request("/v2/teams/"+id+"/members/"+b+"/role",{role:"viewer"});
 assert.equal(r.status,200);assert.equal(r.body.role,"viewer");
 assert.equal((await f.request("/v2/teams/"+id+"/workspaces",undefined,"test-b")).body.teamWorkspaces[0].access,"read");
 const log=(await f.request("/v2/teams/"+id+"/audit")).body.entries;
 assert.equal(log.at(-1).action,"member.role");assert.equal(log.at(-1).reason,"viewer");assert.ok(verify(f,id));
});

test("transfer: new owner gets purple and owner powers, old owner keeps a member color; billing stays with the payer until it lapses, then the new owner checks out",async t=>{
 const f=await fixture(t);const id=await f.activeTeam(1);const wid=await paidWorkspace(f,id);
 await f.join(id,"test-b","red-500");
 const b=await memberIdOf(f,id,"test-b");
 assert.equal((await f.request("/v2/teams/"+id+"/transfer",{memberId:b,color:"purple-400"})).body.error,"COLOR_RESERVED");
 const r=await f.request("/v2/teams/"+id+"/transfer",{memberId:b,color:"red-500",ownerShade:"purple-700"});
 assert.equal(r.status,200,JSON.stringify(r.body));
 const view=(await f.request("/v2/teams/"+id,undefined,"test-b")).body.team;
 assert.equal(view.role,"owner");assert.equal(view.me.color,"purple-700");
 const old=(await f.request("/v2/teams/"+id)).body.team.me;
 assert.equal(old.role,"member");assert.equal(old.color,"red-500","old owner can take the new owner's freed color");
 const team=f.db.rows.get("gd_teams/"+id);
 assert.equal(team.ownerHash,hash("test-b"));assert.equal(team.payerHash,hash("test-a"));
 assert.equal((await f.request("/v2/teams/"+id+"/invites",{},"test-a")).body.error,"TEAM_OWNER_ONLY");
 assert.equal((await f.request("/v2/teams/"+id+"/invites",{},"test-b")).status,201);
 // The payer's subscription keeps reconciling after the transfer.
 const teamSub=team.subscriptionId;
 const sub=f.subs.get(teamSub);
 sub.status="past_due";
 assert.equal((await f.webhook("customer.subscription.updated",{...sub})).status,200);
 assert.equal(f.db.rows.get("gd_teams/"+id).subscriptionStatus,"past_due");
 // The payer cancels; the new owner checks out on their own customer and takes over.
 sub.status="canceled";
 await f.webhook("customer.subscription.deleted",{...sub});
 assert.equal(f.db.rows.get("gd_teams/"+id).subscriptionStatus,"canceled");
 const co=await f.request("/v2/teams/"+id+"/checkout",{},"test-b");
 assert.equal(co.status,200,JSON.stringify(co.body));
 assert.equal(f.calls.at(-1).args.metadata.accountHash,hash("test-b"));
 await f.paySession(co.body.url.split("/").pop());
 const after=f.db.rows.get("gd_teams/"+id);
 assert.equal(after.subscriptionStatus,"active");assert.equal(after.payerHash,hash("test-b"));assert.notEqual(after.subscriptionId,teamSub);
 // A stray event for the old subscription can't flip it back.
 sub.status="active";
 await f.webhook("customer.subscription.updated",{...sub});
 assert.equal(f.db.rows.get("gd_teams/"+id).subscriptionId,after.subscriptionId);
 // Team workspace plans: the payer keeps paying; on lapse the new owner can take over.
 const w=f.db.rows.get("gd_teams/"+id+"/workspaces/"+wid);
 assert.equal(w.payerHash,hash("test-a"));assert.equal(w.plansEverPaid,true);
});

test("delete team: owner types the name; subscriptions are cancelled, files and records removed, members lose the team",async t=>{
 const bucket=bucketDouble();
 const f=await fixture(t,{bucket});const id=await f.activeTeam(1);const wid=await paidWorkspace(f,id);
 bucket.objects.add("customer/teams/"+id+"/"+wid+"/files/x");bucket.objects.add("customer/"+hash("test-a")+"/managed/keep");
 await f.join(id,"test-b","red-500");
 await f.request("/v2/teams/"+id+"/chat",{text:"bye"},"test-b");
 assert.equal((await f.request("/v2/teams/"+id+"/delete",{confirmName:"Studio 1"},"test-b")).body.error,"TEAM_OWNER_ONLY");
 assert.equal((await f.request("/v2/teams/"+id+"/delete",{confirmName:"studio"})).body.error,"CONFIRM_NAME_REQUIRED");
 const team=f.db.rows.get("gd_teams/"+id),ws=f.db.rows.get("gd_teams/"+id+"/workspaces/"+wid);
 const r=await f.request("/v2/teams/"+id+"/delete",{confirmName:"Studio 1"});
 assert.equal(r.status,200,JSON.stringify(r.body));
 assert.deepEqual(f.canceled.sort(),[team.subscriptionId,ws.plansSubscriptionId].sort());
 assert.deepEqual([...bucket.objects],["customer/"+hash("test-a")+"/managed/keep"],"only the team prefix is removed");
 assert.deepEqual([...f.db.rows.keys()].filter(k=>k.includes(id)||k.includes(wid)),[]);
 assert.equal((await f.request("/v2/teams/"+id,undefined,"test-b")).status,404);
 assert.deepEqual((await f.request("/v2/teams",undefined,"test-b")).body.teams,[]);
});

test("account deletion: an owner whose team has other members is refused (409) before anything is deleted",async t=>{
 const f=await fixture(t);const id=await f.activeTeam(1);
 await f.join(id,"test-b","red-500");
 assert.deepEqual(await ownedTeamsBlocking(f.db,hash("test-a")),[{teamId:id,name:"Studio 1",otherMembers:1}]);
 const now=Date.now();
 const svc=createAccountDeletion({db:f.db,stripe:{},bucket:{},auth:{getUser:async()=>({disabled:false})},hash,now:()=>now,notifier:async()=>{}});
 await assert.rejects(svc.deleteAccount({user:{uid:"test-a",auth_time:Math.floor(now/1000)-10},body:{confirm:"DELETE"}}),
  e=>e.status===409&&e.code==="team_owner_must_transfer"&&e.teams[0].teamId===id);
 assert.ok(f.db.rows.get("gd_teams/"+id));assert.equal(f.db.rows.has("account_deletions/"+hash("test-a")),false);
 await assert.rejects(deleteAccountTeams(f.db,hash("test-a")),e=>e.code==="team_owner_must_transfer","the job step re-checks");
 // After a transfer the old owner can be deleted.
 const b=await memberIdOf(f,id,"test-b");
 await f.request("/v2/teams/"+id+"/transfer",{memberId:b,color:"blue-500"});
 assert.deepEqual(await ownedTeamsBlocking(f.db,hash("test-a")),[]);
});

test("account deletion: a member's membership, color, shares and chat messages are removed; audit still verifies",async t=>{
 const f=await fixture(t);const id=await f.activeTeam(1);
 await f.join(id,"test-b","red-500");await f.join(id,"test-c","blue-500");
 const pw=await f.personal("test-b",1);
 await f.request("/v2/teams/"+id+"/shares",{workspaceId:pw},"test-b");
 await f.request("/v2/teams/"+id+"/chat",{text:"my secret plan"},"test-b");
 await f.request("/v2/teams/"+id+"/chat",{text:"reply"},"test-c");
 await f.request("/v2/teams/"+id+"/chat",{card:{scope:"personal",workspaceId:pw}},"test-b");
 const before=f.db.rows.get("gd_teams/"+id).memberCount;
 const r=await deleteAccountTeams(f.db,hash("test-b"));
 assert.deepEqual(r,{deletedTeams:[],leftTeams:[id]});
 const keys=[...f.db.rows.keys()];
 assert.equal(keys.some(k=>k.endsWith("/members/"+hash("test-b"))),false,"member record deleted");
 assert.equal(f.db.rows.has("gd_teams/"+id+"/colors/red-500"),false,"color freed");
 assert.equal(f.db.rows.has("gd_accounts/"+hash("test-b")+"/teams/"+id),false);
 assert.equal(f.db.rows.get("gd_teams/"+id).memberCount,before-1);
 assert.equal((await f.request("/v2/teams/"+id+"/workspaces",undefined,"test-c")).body.sharedWorkspaces.length,0);
 const msgs=(await f.request("/v2/teams/"+id+"/chat",undefined,"test-c")).body.messages;
 assert.equal(msgs.length,3,"seq numbers stay so polling clients don't skip");
 const gone=msgs.filter(m=>m.kind==="removed");
 assert.equal(gone.length,2);
 for(const m of gone){assert.equal(m.displayName,"Deleted member");assert.equal(m.text,"");assert.equal(m.card,null);assert.equal(m.removed.by,"account");assert.equal(m.memberId,null);}
 assert.equal(msgs.find(m=>m.kind==="text").text,"reply");
 assert.doesNotMatch(JSON.stringify([...f.db.rows.entries()].filter(([k])=>k.includes("/messages/"))),new RegExp(hash("test-b")+"|my secret plan"));
 // Another member can now take the freed color.
 assert.equal((await f.request("/v2/teams/"+id+"/me",{color:"red-500"},"test-c","PATCH")).status,200);
 const log=(await f.request("/v2/teams/"+id+"/audit")).body.entries;
 assert.ok(log.some(e=>e.action==="member.account_deleted"));assert.ok(verify(f,id),"hash chain intact");
 assert.deepEqual(await deleteAccountTeams(f.db,hash("test-b")),{deletedTeams:[],leftTeams:[]},"idempotent");
});

test("account deletion: a sole-owner team goes with the account; a transferred team the user still pays for is marked canceled",async t=>{
 const bucket=bucketDouble();
 const f=await fixture(t,{bucket});
 const solo=await f.activeTeam(1);const soloWs=await paidWorkspace(f,solo,31);
 bucket.objects.add("customer/teams/"+solo+"/"+soloWs+"/files/a");
 const shared=await f.activeTeam(2);const sharedWs=await paidWorkspace(f,shared,32);
 await f.join(shared,"test-b","red-500");
 await f.request("/v2/teams/"+shared+"/transfer",{memberId:await memberIdOf(f,shared,"test-b"),color:"blue-500"});
 const r=await deleteAccountTeams(f.db,hash("test-a"),{bucket});
 assert.deepEqual(r,{deletedTeams:[solo],leftTeams:[shared]});
 assert.equal([...f.db.rows.keys()].some(k=>k.includes(solo)),false);assert.equal(bucket.objects.size,0);
 const t2=f.db.rows.get("gd_teams/"+shared);
 assert.equal(t2.subscriptionStatus,"canceled");assert.equal(t2.payerHash,null);assert.equal(t2.subscriptionId,null);
 const w2=f.db.rows.get("gd_teams/"+shared+"/workspaces/"+sharedWs);
 assert.equal(w2.plansStatus,"canceled");assert.equal(w2.payerHash,null);assert.equal(w2.plansEverPaid,true,"files stay readable for the team");
 // New owner re-subscribes both.
 const co=await f.request("/v2/teams/"+shared+"/checkout",{},"test-b");await f.paySession(co.body.url.split("/").pop());
 assert.equal(f.db.rows.get("gd_teams/"+shared).subscriptionStatus,"active");
 const wco=await f.request("/v2/teams/"+shared+"/workspaces/"+sharedWs+"/checkout",{},"test-b");
 assert.equal(wco.status,200,JSON.stringify(wco.body));await f.paySession(wco.body.url.split("/").pop());
 const w3=f.db.rows.get("gd_teams/"+shared+"/workspaces/"+sharedWs);
 assert.equal(w3.plansStatus,"active");assert.equal(w3.payerHash,hash("test-b"));
});

test("account deletion job: teams step runs first and the whole job finishes",async t=>{
 const bucket=bucketDouble();
 const f=await fixture(t,{bucket});const id=await f.activeTeam(1);
 await f.join(id,"test-c","red-500");
 await f.request("/v2/teams/"+id+"/chat",{text:"hello"},"test-c");
 const now=Date.now(),users=new Set(["test-c"]);
 const svc=createAccountDeletion({db:f.db,bucket,hash,now:()=>now,notifier:async()=>{},
  stripe:{subscriptions:{list:async()=>({data:[],has_more:false}),cancel:async()=>({})}},
  auth:{getUser:async u=>users.has(u)?{disabled:false}:Promise.reject(Object.assign(Error("gone"),{code:"auth/user-not-found"})),
   revokeRefreshTokens:async()=>{},deleteUser:async u=>{users.delete(u);}}});
 const job=await svc.deleteAccount({user:{uid:"test-c",auth_time:Math.floor(now/1000)-10},body:{confirm:"DELETE"}});
 assert.equal(job.status,202);
 const deadline=Date.now()+5000;let s;
 do{s=await svc.jobStatus(job.jobId);if(["done","failed"].includes(s?.status))break;await new Promise(r=>setTimeout(r,10));}while(Date.now()<deadline);
 assert.equal(s.status,"done",JSON.stringify(s));
 assert.equal(f.db.rows.has("gd_teams/"+id+"/members/"+hash("test-c")),false);
 assert.equal((await f.request("/v2/teams/"+id+"/chat")).body.messages[0].displayName,"Deleted member");
});
