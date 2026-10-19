"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {TEAM_TIERS,MEMBER_COLORS,OWNER_SHADES,catalog}=require("./teams");
const {fixture,hash,idFor}=require("./test_helpers/teams_fixture");

test("tiers: Team 5 / $9.99, Team Plus 15 / $24.99, Business 50 / $69.99, yearly 10x, Enterprise is contact-only",async t=>{
 assert.deepEqual(Object.values(TEAM_TIERS).map(x=>[x.id,x.members,x.monthlyCents,x.yearlyCents]),
   [["team",5,999,9990],["team_plus",15,2499,24990],["business",50,6999,69990]]);
 const shared=require("../../commercial/pricing.json").teams;
 assert.deepEqual(shared.tiers.map(x=>[x.id,x.members,x.monthlyCents,x.yearlyCents]),Object.values(TEAM_TIERS).map(x=>[x.id,x.members,x.monthlyCents,x.yearlyCents]));
 assert.equal(shared.enterprise.contact,true);
 const f=await fixture(t);
 const pricing=await f.request("/v2/pricing");
 assert.equal(pricing.body.teams.tiers.length,3);assert.equal(pricing.body.teams.enterprise.contact,true);
 assert.deepEqual(pricing.body.teams.perWorkspace.required,["storage","performance"]);
 const ent=await f.request("/v2/teams",{name:"Big",intentId:idFor(1),tier:"enterprise"});
 assert.equal(ent.status,400);assert.equal(ent.body.error,"ENTERPRISE_CONTACT");
});

test("creating a team opens the team subscription checkout; the subscription activates only from a signed webhook",async t=>{
 const f=await fixture(t);
 const r=await f.team(1);
 assert.equal(r.body.team.role,"owner");assert.equal(r.body.team.subscriptionActive,false);assert.equal(r.body.totalCents,999);
 assert.deepEqual(f.calls[0].args.line_items,[{price:"price_team",quantity:1}]);
 assert.equal(f.calls[0].args.metadata.kind,"team_subscription");
 assert.equal(r.body.team.me.displayName,"Josh's MacBook Pro","the chat name defaults to the device name");
 assert.equal(r.body.team.me.color,"purple-500");
 const id=r.body.team.id;
 assert.equal((await f.request("/v2/teams/"+id+"/invites",{})).body.error,"TEAM_SUBSCRIPTION_REQUIRED");
 const wrong=await f.paySession(r.body.url.split("/").pop(),"active",["price_team","price_boost"]);assert.equal(wrong.status,200);
 assert.equal((await f.request("/v2/teams/"+id)).body.team.subscriptionStatus,"mismatch");
 f.subs.clear();await f.paySession(r.body.url.split("/").pop());
 const v=await f.request("/v2/teams/"+id);assert.equal(v.body.team.subscriptionActive,true);
 assert.equal((await f.request("/v2/teams")).body.teams.length,1);
 assert.equal((await f.request("/v2/teams",undefined,"test-b")).body.teams.length,0);
});

test("join by invite code or link, member limit, and non-members can't see a team",async t=>{
 const f=await fixture(t);const id=await f.activeTeam(1);
 assert.equal((await f.request("/v2/teams/"+id,undefined,"test-b")).status,404);
 const inv=await f.invite(id);
 assert.match(inv.link,/^https:\/\/billing\.example\/teams\/join#[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
 const viaLink=await f.request("/v2/teams/join",{code:inv.link,color:"red-500"},"test-b");
 assert.equal(viaLink.status,200,JSON.stringify(viaLink.body));assert.equal(viaLink.body.teamId,id);
 assert.equal((await f.request("/v2/teams/join",{code:"AAAA-BBBB-CCCC",color:"red-400"},"test-c")).body.error,"INVITE_INVALID");
 for(const [u,c] of [["test-c","blue-500"],["test-d","green-500"],["test-e","amber-500"]])assert.equal((await f.join(id,u,c)).status,200);
 const full=await f.join(id,"test-f","teal-500");assert.equal(full.status,409);assert.equal(full.body.error,"TEAM_FULL");
 const v=await f.request("/v2/teams/"+id,undefined,"test-b");
 assert.equal(v.body.team.memberCount,5);assert.equal(v.body.team.members.length,5);
 assert.ok(v.body.team.members.every(m=>!("accountHash" in m)),"members never see account hashes");
 const revoke=await f.request("/v2/teams/"+id+"/invites/"+inv.inviteId+"/revoke",{});assert.equal(revoke.status,200);
 assert.equal((await f.request("/v2/teams/join",{code:inv.code,color:"lime-500"},"test-f")).body.error,"INVITE_INVALID");
});

test("colors: at least 9 choices, unique per team, purple reserved for the owner who picks the shade",async t=>{
 assert.ok(MEMBER_COLORS.length>=49,"enough for a 50-member team");
 assert.ok(MEMBER_COLORS.every(c=>!/purple|violet|fuchsia|indigo/.test(c.hue)));
 assert.ok(OWNER_SHADES.length>=3&&OWNER_SHADES.every(c=>c.hue==="purple"));
 const f=await fixture(t);
 const bad=await f.request("/v2/teams",{name:"Studio Red",intentId:idFor(5),tier:"team",ownerShade:"red-500"});
 assert.equal(bad.status,400);assert.equal(bad.body.error,"INVALID_COLOR");
 const id=await f.activeTeam(1,{ownerShade:"purple-700"});
 assert.equal((await f.request("/v2/teams/"+id)).body.team.me.color,"purple-700");
 assert.equal((await f.request("/v2/teams/"+id+"/me",{color:"purple-300"},"test-a","PATCH")).body.color,"purple-300","owner changes shade");
 for(const c of ["purple-500","violet-500","purple"]){
   const r=await f.join(id,"test-b",c);assert.equal(r.status,400);assert.equal(r.body.error,"COLOR_RESERVED");
 }
 assert.equal((await f.join(id,"test-b","#ff0000")).body.error,"INVALID_COLOR");
 assert.equal((await f.join(id,"test-b","sky-500")).status,200);
 const taken=await f.join(id,"test-c","sky-500");assert.equal(taken.status,409);assert.equal(taken.body.error,"COLOR_TAKEN");
 const pv=await f.invite(id),preview=await f.request("/v2/teams/join/preview",{code:pv.link},"test-c");
 assert.equal(preview.status,200);assert.equal(preview.body.teamName,"Studio 1");
 assert.equal(preview.body.colors.memberColors.find(c=>c.id==="sky-500").taken,true,"the join screen can grey out taken colors");
 assert.ok(!JSON.stringify(preview.body).includes(hash("test-b")));
 assert.equal((await f.request("/v2/teams/join/preview",{code:"ZZZZ-ZZZZ-ZZZZ"},"test-c")).body.error,"INVITE_INVALID");
 const view=await f.request("/v2/teams/"+id,undefined,"test-c-not-member");assert.equal(view.status,401);
 assert.equal((await f.join(id,"test-c","rose-500")).status,200);
 assert.equal((await f.request("/v2/teams/"+id+"/me",{color:"sky-500"},"test-c","PATCH")).body.error,"COLOR_TAKEN");
 assert.equal((await f.request("/v2/teams/"+id+"/me",{color:"purple-400"},"test-c","PATCH")).body.error,"COLOR_RESERVED");
 const colors=(await f.request("/v2/teams/"+id,undefined,"test-c")).body.colors;
 assert.equal(colors.memberColors.find(c=>c.id==="sky-500").taken,true);
 assert.equal(colors.memberColors.find(c=>c.id==="rose-500").taken,false,"your own color is not shown as taken to you");
 // Leaving frees the color.
 assert.equal((await f.request("/v2/teams/"+id+"/leave",{},"test-b")).status,200);
 assert.equal((await f.request("/v2/teams/"+id+"/me",{color:"sky-500"},"test-c","PATCH")).body.color,"sky-500");
 // Concurrent joins with the same color: exactly one wins.
 const a=await f.invite(id),b=await f.invite(id);
 const both=await Promise.all([f.request("/v2/teams/join",{code:a.code,color:"lime-300"},"test-d"),f.request("/v2/teams/join",{code:b.code,color:"lime-300"},"test-e")]);
 assert.deepEqual(both.map(x=>x.status).sort(),[200,409]);
});

test("display name defaults to the device name and can be changed anytime",async t=>{
 const f=await fixture(t);const id=await f.activeTeam(1);
 await f.join(id,"test-b","red-500",{deviceName:"Pixel 9"});
 assert.equal((await f.request("/v2/teams/"+id,undefined,"test-b")).body.team.me.displayName,"Pixel 9");
 assert.equal((await f.request("/v2/teams/"+id+"/me",{displayName:"  Riley \u202e "},"test-b","PATCH")).body.displayName,"Riley");
 assert.equal((await f.request("/v2/teams/"+id+"/me",{displayName:"   "},"test-b","PATCH")).body.error,"INVALID_DISPLAY_NAME");
 await f.request("/v2/teams/"+id+"/chat",{text:"hi"},"test-b");
 assert.equal((await f.request("/v2/teams/"+id+"/chat")).body.messages[0].displayName,"Riley");
});

test("ACL: personal workspaces are never visible to a team unless their owner shares them",async t=>{
 const f=await fixture(t);const id=await f.activeTeam(1);await f.join(id,"test-b","red-500");
 const mine=await f.personal("test-b",1),other=await f.personal("test-b",2),owners=await f.personal("test-a",3);
 let list=await f.request("/v2/teams/"+id+"/workspaces");
 assert.deepEqual(list.body.sharedWorkspaces,[]);assert.deepEqual(list.body.teamWorkspaces,[]);
 assert.equal((await f.request("/v2/teams/"+id+"/shares",{workspaceId:mine},"test-a")).status,404,"the team owner can't share a member's workspace");
 assert.equal((await f.request("/v2/teams/"+id+"/shares",{workspaceId:mine},"test-c")).status,404,"non-members can't share into a team");
 assert.equal((await f.request("/v2/teams/"+id+"/shares",{workspaceId:mine},"test-b")).status,200);
 list=await f.request("/v2/teams/"+id+"/workspaces");
 assert.deepEqual(list.body.sharedWorkspaces.map(w=>w.id),[mine]);
 assert.ok(!JSON.stringify(list.body).includes(other)&&!JSON.stringify(list.body).includes("Private test-b 2"));
 assert.ok(!JSON.stringify(list.body).includes(owners),"the owner's own personal workspace isn't listed either");
 assert.equal((await f.request("/v2/teams/"+id+"/workspaces",undefined,"test-c")).status,404);
 assert.equal((await f.request("/v2/projects/"+mine,undefined,"test-a")).status,404,"sharing gives no access through the personal API");
 assert.equal((await f.request("/v2/teams/"+id+"/shares/"+mine,undefined,"test-b","DELETE")).status,200);
 assert.deepEqual((await f.request("/v2/teams/"+id+"/workspaces")).body.sharedWorkspaces,[]);
 // Kicking a member removes their shares.
 await f.request("/v2/teams/"+id+"/shares",{workspaceId:mine},"test-b");
 const memberId=(await f.request("/v2/teams/"+id,undefined,"test-b")).body.team.me.memberId;
 assert.equal((await f.request("/v2/teams/"+id+"/members/"+memberId+"/kick",{reason:"Left the project"})).status,200);
 assert.deepEqual((await f.request("/v2/teams/"+id+"/workspaces")).body.sharedWorkspaces,[]);
 assert.equal((await f.request("/v2/teams/"+id,undefined,"test-b")).status,404);
});

test("team workspaces need storage + performance plans (custom: performance only) plus the team subscription; no workspace fee",async t=>{
 const f=await fixture(t);
 const pending=(await f.team(2)).body.team.id;
 const noSub=await f.request("/v2/teams/"+pending+"/workspaces",{name:"Assets",intentId:idFor(20),plans:{storageTier:"100GB",performanceTier:"boost"}});
 assert.equal(noSub.status,402);assert.equal(noSub.body.error,"TEAM_SUBSCRIPTION_REQUIRED");
 const id=await f.activeTeam(1);
 const bare=await f.request("/v2/teams/"+id+"/workspaces",{name:"Assets",intentId:idFor(21)});
 assert.equal(bare.status,400);assert.equal(bare.body.error,"PLANS_REQUIRED","no free workspace for teams");
 assert.equal((await f.request("/v2/teams/"+id+"/workspaces",{name:"Assets",intentId:idFor(21),plans:{storageTier:"100GB"}})).body.error,"PLANS_REQUIRED");
 const before=f.calls.length;
 const ws=await f.request("/v2/teams/"+id+"/workspaces",{name:"Assets",intentId:idFor(21),plans:{storageTier:"100GB",performanceTier:"boost",interval:"month"}});
 assert.equal(ws.status,201,JSON.stringify(ws.body));assert.equal(ws.body.totalCents,1240);
 assert.deepEqual(f.calls[before].args.line_items,[{price:"price_100gb",quantity:1},{price:"price_boost",quantity:1}]);
 assert.equal(f.calls[before].args.metadata.kind,"team_workspace_plans");
 assert.ok(f.calls.every(c=>c.args.line_items.every(x=>!/project|wsfee|byofee|workspace/.test(x.price))));
 assert.equal(ws.body.workspace.projectStatus,"pending_payment");
 const custom=await f.request("/v2/teams/"+id+"/workspaces",{name:"Own S3",intentId:idFor(22),storage:"custom",plans:{}});
 assert.equal(custom.status,400);assert.equal(custom.body.error,"PERFORMANCE_PLAN_REQUIRED");
 assert.equal((await f.request("/v2/teams/"+id+"/workspaces",{name:"Own S3",intentId:idFor(22),storage:"custom",plans:{storageTier:"100GB",performanceTier:"lite"}})).body.error,"INVALID_SELECTION");
 const c=await f.request("/v2/teams/"+id+"/workspaces",{name:"Own S3",intentId:idFor(22),storage:"custom",plans:{performanceTier:"lite"}});
 assert.equal(c.status,201);assert.equal(c.body.totalCents,300);assert.deepEqual(f.calls.at(-1).args.line_items,[{price:"price_lite",quantity:1}]);
 assert.equal(c.body.workspace.needsCustomSetup,true);
 await f.join(id,"test-b","red-500");
 assert.equal((await f.request("/v2/teams/"+id+"/workspaces",{name:"X",intentId:idFor(23),plans:{storageTier:"100GB",performanceTier:"boost"}},"test-b")).body.error,"TEAM_OWNER_ONLY");
 await f.paySession(ws.body.url.split("/").pop());
 let list=(await f.request("/v2/teams/"+id+"/workspaces",undefined,"test-b")).body.teamWorkspaces;
 assert.equal(list.find(w=>w.id===idFor(21)).projectStatus,"active");assert.equal(list.find(w=>w.id===idFor(21)).quotaGB,100);
 // The team subscription lapses: the paid workspace waits for it.
 const teamSub=[...f.subs.values()].find(s=>s.metadata.kind==="team_subscription");teamSub.status="canceled";
 await f.webhook("customer.subscription.deleted",teamSub);
 list=(await f.request("/v2/teams/"+id+"/workspaces")).body.teamWorkspaces;
 assert.equal(list.find(w=>w.id===idFor(21)).projectStatus,"team_subscription_required");
 assert.equal((await f.request("/v2/teams/"+id+"/chat",{text:"still here?"})).body.error,"TEAM_SUBSCRIPTION_REQUIRED");
});

test("forged team webhooks are ignored: wrong customer, foreign team, extra items",async t=>{
 const f=await fixture(t);const r=await f.team(1);const id=r.body.team.id;
 const s=f.sessions.get(r.body.url.split("/").pop());
 const forged={id:"sub_forged",customer:"cus_testb",status:"active",metadata:{...s.metadata},items:{data:[{price:{id:"price_team"},quantity:1}]}};
 f.subs.set(forged.id,forged);await f.webhook("customer.subscription.updated",forged);
 assert.equal((await f.request("/v2/teams/"+id)).body.team.subscriptionActive,false);
 const foreign={...forged,id:"sub_foreign",customer:"cus_testb",metadata:{...s.metadata,accountHash:hash("test-b")}};
 f.subs.set(foreign.id,foreign);await f.webhook("customer.subscription.updated",foreign);
 assert.equal((await f.request("/v2/teams/"+id)).body.team.subscriptionActive,false);
});

test("chat: persisted, polling with after=seq, workspace cards via +, and personal cards only by explicit share",async t=>{
 const f=await fixture(t);const id=await f.activeTeam(1);await f.join(id,"test-b","red-500");
 const a=await f.request("/v2/teams/"+id+"/chat",{text:"hello <b>team</b>"});assert.equal(a.status,201);assert.equal(a.body.message.seq,1);
 await f.request("/v2/teams/"+id+"/chat",{text:"second"},"test-b");
 let poll=await f.request("/v2/teams/"+id+"/chat?after=1",undefined,"test-b");
 assert.deepEqual(poll.body.messages.map(m=>m.text),["second"]);assert.equal(poll.body.latestSeq,2);
 assert.equal(poll.body.messages[0].colorHex,"#ef4444");
 assert.equal((await f.request("/v2/teams/"+id+"/chat",undefined,"test-c")).status,404);
 assert.equal((await f.request("/v2/teams/"+id+"/chat",{text:"   "})).body.error,"EMPTY_MESSAGE");
 const mine=await f.personal("test-b",1);
 const noShare=await f.request("/v2/teams/"+id+"/chat",{card:{scope:"personal",workspaceId:mine}},"test-b");
 assert.equal(noShare.status,403);assert.equal(noShare.body.error,"SHARE_REQUIRED");
 assert.equal((await f.request("/v2/teams/"+id+"/chat",{card:{scope:"personal",workspaceId:mine}},"test-a")).status,404,"nobody else can post your workspace");
 const shared=await f.request("/v2/teams/"+id+"/chat",{card:{scope:"personal",workspaceId:mine,share:true}},"test-b");
 assert.equal(shared.status,201);assert.equal(shared.body.shared,true);assert.equal(shared.body.message.kind,"workspace_card");
 assert.deepEqual((await f.request("/v2/teams/"+id+"/workspaces")).body.sharedWorkspaces.map(w=>w.id),[mine]);
 await f.request("/v2/teams/"+id+"/shares/"+mine,undefined,"test-b","DELETE");
 const card=(await f.request("/v2/teams/"+id+"/chat?after=2")).body.messages[0].card;
 assert.equal(card.unavailable,true);assert.equal(card.name,undefined,"an unshared card no longer shows the name");
 const tw=await f.request("/v2/teams/"+id+"/workspaces",{name:"Assets",intentId:idFor(21),plans:{storageTier:"100GB",performanceTier:"boost"}});
 const teamCard=await f.request("/v2/teams/"+id+"/chat",{card:{scope:"team",workspaceId:tw.body.workspace.id}},"test-b");
 assert.equal(teamCard.status,201);assert.equal(teamCard.body.message.card.name,"Assets");
 assert.equal((await f.request("/v2/teams/"+id+"/chat",{card:{scope:"team",workspaceId:idFor(77)}},"test-b")).status,404);
 // Messages are stored in Firestore, so a new server instance would read them back.
 assert.ok([...f.db.rows.keys()].filter(k=>k.startsWith("gd_teams/"+id+"/messages/")).length>=4);
});

test("chat stream (SSE) delivers new messages and closes for a removed member",async t=>{
 process.env.GD_TEAM_STREAM_POLL_MS="30";t.after(()=>{delete process.env.GD_TEAM_STREAM_POLL_MS;});
 const f=await fixture(t);const id=await f.activeTeam(1);await f.join(id,"test-b","red-500");
 assert.equal((await fetch(f.origin+"/v2/teams/"+id+"/chat/stream",{headers:{Authorization:"Bearer test-c"}})).status,404);
 const ctl=new AbortController();t.after(()=>ctl.abort());
 const res=await fetch(f.origin+"/v2/teams/"+id+"/chat/stream?after=0",{headers:{Authorization:"Bearer test-b"},signal:ctl.signal});
 assert.equal(res.status,200);assert.match(res.headers.get("content-type"),/text\/event-stream/);
 const reader=res.body.getReader(),dec=new TextDecoder();let buf="";
 async function until(re){while(!re.test(buf)){const {value,done}=await reader.read();if(done)break;buf+=dec.decode(value);}return buf;}
 await f.request("/v2/teams/"+id+"/chat",{text:"live hello"});
 await until(/event: message\ndata: .*live hello/);
 assert.match(buf,/id: 1\n/);
 const memberId=(await f.request("/v2/teams/"+id,undefined,"test-b")).body.team.me.memberId;
 await f.request("/v2/teams/"+id+"/members/"+memberId+"/kick",{reason:"Spam"});
 await until(/event: removed/);
 ctl.abort();
});

test("owner moderation: reason required and shown, forever or until, mute/unmute/kick/ban, delete message, audit chain",async t=>{
 const f=await fixture(t);const id=await f.activeTeam(1);await f.join(id,"test-b","red-500");
 const memberId=(await f.request("/v2/teams/"+id,undefined,"test-b")).body.team.me.memberId;
 const ownerId=(await f.request("/v2/teams/"+id)).body.team.me.memberId;
 const url=a=>"/v2/teams/"+id+"/members/"+memberId+"/"+a;
 assert.equal((await f.request(url("mute"),{})).body.error,"REASON_REQUIRED");
 assert.equal((await f.request(url("mute"),{reason:"x",until:Date.now()-1000})).body.error,"INVALID_DURATION");
 assert.equal((await f.request(url("mute"),{reason:"Calm down"},"test-b")).body.error,"TEAM_OWNER_ONLY");
 assert.equal((await f.request("/v2/teams/"+id+"/members/"+ownerId+"/kick",{reason:"x"})).body.error,"TEAM_OWNER_PROTECTED");
 const until=Date.now()+3_600_000;
 assert.equal((await f.request(url("mute"),{reason:"Off-topic flood",until})).status,200);
 const muted=await f.request("/v2/teams/"+id+"/chat",{text:"hey"},"test-b");
 assert.equal(muted.status,403);assert.equal(muted.body.error,"TEAM_MUTED");assert.match(muted.body.message,/Off-topic flood/);
 assert.equal((await f.request("/v2/teams/"+id,undefined,"test-b")).body.team.me.muted.until,until);
 assert.equal((await f.request(url("unmute"),{})).status,200);
 const posted=await f.request("/v2/teams/"+id+"/chat",{text:"rude words"},"test-b");assert.equal(posted.status,201);
 const del=await f.request("/v2/teams/"+id+"/chat/"+posted.body.message.seq+"/delete",{reason:"Insults are not allowed"});
 assert.equal(del.status,200);
 const shown=(await f.request("/v2/teams/"+id+"/chat",undefined,"test-b")).body.messages.find(m=>m.seq===posted.body.message.seq);
 assert.equal(shown.kind,"removed");assert.equal(shown.text,"");assert.equal(shown.removed.reason,"Insults are not allowed");
 assert.equal((await f.request("/v2/teams/"+id+"/chat/"+posted.body.message.seq+"/delete",{reason:"x"},"test-b")).body.error,"TEAM_OWNER_ONLY");
 const rep=await f.request("/v2/teams/"+id+"/chat/1/report",{category:"spam",note:"<script>"},"test-b");assert.equal(rep.status,201);
 const report=[...f.db.rows.entries()].find(([k])=>k.startsWith("abuse_reports/"))[1];
 assert.equal(report.source,"team_chat");assert.equal(report.status,"open");assert.ok(/^[a-f0-9]{64}$/.test(report.subject.accountHash));
 assert.equal((await f.request(url("ban"),{reason:"Repeated abuse",until:null})).status,200);
 const back=await f.join(id,"test-b","red-500");assert.equal(back.status,403);assert.equal(back.body.error,"TEAM_BANNED");assert.match(back.body.message,/Repeated abuse/);
 const log=await f.request("/v2/teams/"+id+"/audit");
 assert.deepEqual(log.body.entries.map(e=>e.action),["team.create","member.join","member.mute","member.unmute","message.delete","member.ban"]);
 assert.ok(log.body.entries.every(e=>e.source==="owner"||e.source==="member"));
 assert.equal(log.body.entries.find(e=>e.action==="member.ban").reason,"Repeated abuse");
 const svc=require("./teams").createTeamService({db:f.db,stamp:()=>1,hash});
 const raw=[...f.db.rows.entries()].filter(([k])=>k.startsWith("gd_teams/"+id+"/audit/")).sort().map(([,v])=>v);
 assert.equal(svc.verifyAudit(raw),true);
 raw[2]={...raw[2],reason:"edited"};assert.equal(svc.verifyAudit(raw),false,"edits break the chain");
 assert.equal((await f.request("/v2/teams/"+id+"/audit",undefined,"test-c")).status,404);
});

test("automatic moderation is temporary only: a chat flood gets a 5 minute mute with a plain reason",async t=>{
 const f=await fixture(t);const id=await f.activeTeam(1);await f.join(id,"test-b","red-500");
 const statuses=[];
 for(let i=0;i<10;i++)statuses.push((await f.request("/v2/teams/"+id+"/chat",{text:"spam "+i},"test-b")).status);
 assert.deepEqual(statuses.slice(0,8),Array(8).fill(201));assert.equal(statuses[8],429);assert.equal(statuses[9],403);
 const me=(await f.request("/v2/teams/"+id,undefined,"test-b")).body.team.me;
 assert.ok(me.muted.until>Date.now()&&me.muted.until<=Date.now()+5*60_000+1000);assert.match(me.muted.reason,/too quickly/);
 const auto=(await f.request("/v2/teams/"+id+"/audit")).body.entries.find(e=>e.source==="auto");
 assert.equal(auto.action,"member.mute");assert.equal(auto.rule,"chat_rate");assert.ok(auto.untilMs,"never permanent");
});

test("platform moderation gate: a suspended account can't use teams; a restricted one can read but not post",async t=>{
 const f=await fixture(t);const id=await f.activeTeam(1);await f.join(id,"test-b","red-500");
 f.db.rows.set("account_state/"+hash("test-b"),{state:"restricted"});
 assert.equal((await f.request("/v2/teams/"+id+"/chat",undefined,"test-b")).status,200);
 const post=await f.request("/v2/teams/"+id+"/chat",{text:"x"},"test-b");assert.equal(post.status,403);assert.equal(post.body.error,"account_restricted");
 f.db.rows.set("account_state/"+hash("test-b"),{state:"suspended"});
 assert.equal((await f.request("/v2/teams/"+id,undefined,"test-b")).body.error,"account_restricted");
});

test("teams catalog lists 52 member colors and the owner purple shades",()=>{
 const c=catalog();assert.equal(c.colors.memberColors.length,52);assert.equal(c.colors.reservedHue,"purple");
 assert.equal(new Set(c.colors.memberColors.map(x=>x.hex)).size,52);
});
