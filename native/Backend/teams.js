"use strict";
/* Teams: shared team workspaces, invites, chat, and owner moderation.
   Server-enforced rules (see docs/API-teams.md):
   - Personal workspaces are never visible to a team unless their owner shares them.
   - Every team workspace needs a storage plan + a performance plan (custom storage:
     performance only) on top of an active team subscription.
   - Member colors are unique per team; purple shades are reserved for the team owner.
   - Team moderation follows OWNER_MODERATION.md: a reason is required and shown,
     durations are forever or until a time, automatic actions are temporary only,
     and every action is written to a hash-chained audit log. */
const crypto=require("node:crypto");
const {STORAGE,validateWorkspaceName}=require("./catalog");
const {ProjectError,validatePlans,planPriceKeys,plansMonthlyCents}=require("./projects");

// Approved by Josh 2026-10-19. Yearly = 10x monthly. Per-workspace plans are on top.
const TEAM_TIERS=Object.freeze({
 team:Object.freeze({id:"team",name:"Team",members:5,monthlyCents:999,yearlyCents:9990}),
 team_plus:Object.freeze({id:"team_plus",name:"Team Plus",members:15,monthlyCents:2499,yearlyCents:24990}),
 business:Object.freeze({id:"business",name:"Business",members:50,monthlyCents:6999,yearlyCents:69990}),
});
const ENTERPRISE=Object.freeze({id:"enterprise",name:"Enterprise",contact:true});
const ENTITLED=new Set(["active","trialing","past_due"]);
const INTENT=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// Member palette: 13 hues x 4 shades = 52 choices, so even a 50-member Business
// team always has an untaken color. No purple, violet, fuchsia or indigo.
const HUES={red:["#fca5a5","#f87171","#ef4444","#dc2626"],orange:["#fdba74","#fb923c","#f97316","#ea580c"],
 amber:["#fcd34d","#fbbf24","#f59e0b","#d97706"],yellow:["#fde047","#facc15","#eab308","#ca8a04"],
 lime:["#bef264","#a3e635","#84cc16","#65a30d"],green:["#86efac","#4ade80","#22c55e","#16a34a"],
 emerald:["#6ee7b7","#34d399","#10b981","#059669"],teal:["#5eead4","#2dd4bf","#14b8a6","#0d9488"],
 cyan:["#67e8f9","#22d3ee","#06b6d4","#0891b2"],sky:["#7dd3fc","#38bdf8","#0ea5e9","#0284c7"],
 blue:["#93c5fd","#60a5fa","#3b82f6","#2563eb"],pink:["#f9a8d4","#f472b6","#ec4899","#db2777"],
 rose:["#fda4af","#fb7185","#f43f5e","#e11d48"]};
const SHADES=[300,400,500,600];
const MEMBER_COLORS=Object.freeze(Object.entries(HUES).flatMap(([hue,hex])=>hex.map((h,i)=>Object.freeze({id:hue+"-"+SHADES[i],hue,hex:h}))));
const OWNER_SHADES=Object.freeze([["purple-300","#d8b4fe"],["purple-400","#c084fc"],["purple-500","#a855f7"],
 ["purple-600","#9333ea"],["purple-700","#7e22ce"],["violet-500","#8b5cf6"]].map(([id,hex])=>Object.freeze({id,hue:"purple",hex})));
const MEMBER_COLOR_IDS=new Set(MEMBER_COLORS.map(c=>c.id)),OWNER_SHADE_IDS=new Set(OWNER_SHADES.map(c=>c.id));
const colorHex=id=>(MEMBER_COLORS.find(c=>c.id===id)||OWNER_SHADES.find(c=>c.id===id)||{}).hex||null;

const MESSAGE_MAX=2000,REASON_MAX=500,NAME_MAX=40;
const RATE_WINDOW_MS=10_000,RATE_MAX=8,AUTO_MUTE_MS=5*60_000;
const REPORT_CATEGORIES=new Set(["spam","abuse","harassment","illegal","other"]);

function cleanText(raw,max){
 if(typeof raw!=="string")return "";
 return raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,"").trim().slice(0,max);
}
function cleanName(raw){return cleanText(typeof raw==="string"?raw.replace(/\s+/g," "):raw,NAME_MAX);}
function displayNameFrom(body){return cleanName(body?.displayName)||cleanName(body?.deviceName)||"Member";}
function teamTier(tier){
 if(tier==="enterprise")throw new ProjectError(400,"Enterprise teams are set up with sales. Contact us for Enterprise.","ENTERPRISE_CONTACT");
 if(typeof tier!=="string"||!Object.hasOwn(TEAM_TIERS,tier))throw new ProjectError(400,"Choose Team, Team Plus or Business","INVALID_TEAM_TIER");
 return TEAM_TIERS[tier];
}
function interval(raw){
 const v=raw||"month";
 if(!["month","year"].includes(v))throw new ProjectError(400,"Choose monthly or yearly billing","INVALID_SELECTION");
 return v;
}
function teamPriceKey(tier,iv){return "team|"+tier+"|"+iv;}
function teamCents(tier,iv){return iv==="year"?TEAM_TIERS[tier].yearlyCents:TEAM_TIERS[tier].monthlyCents;}
function duration(raw,now){
 // Owner moderation durations: forever (null) or until an absolute time in the future.
 if(raw===null||raw===undefined||raw==="forever")return null;
 const ms=Number(raw);
 if(!Number.isSafeInteger(ms)||ms<=now)throw new ProjectError(400,"Choose forever or a time in the future","INVALID_DURATION");
 return ms;
}
function requireReason(raw){
 const reason=cleanText(raw,REASON_MAX);
 if(!reason)throw new ProjectError(400,"A reason is required. It is shown to the member.","REASON_REQUIRED");
 return reason;
}
function memberIdFor(teamId,accountHash){return crypto.createHash("sha256").update("gd-team-member:"+teamId+":"+accountHash).digest("hex").slice(0,20);}
function codeHash(code){return crypto.createHash("sha256").update("gd-team-invite:"+String(code).toUpperCase().replace(/[^A-Z0-9]/g,"")).digest("hex");}
function newCode(){
 const alphabet="23456789ABCDEFGHJKLMNPQRSTUVWXYZ",bytes=crypto.randomBytes(12);
 const raw=[...bytes].map(b=>alphabet[b%32]).join("");
 return raw.slice(0,4)+"-"+raw.slice(4,8)+"-"+raw.slice(8,12);
}

function createTeamService({db,stamp,hash,stripe,env={},prices={},ensureCustomer,bucket=null,now=()=>Date.now()}){
 const teams=db.collection("gd_teams");
 const teamRef=id=>teams.doc(id);
 const members=id=>teamRef(id).collection("members");
 const myTeams=owner=>db.collection("gd_accounts").doc(owner).collection("teams");
 const personalRef=(owner,id)=>db.collection("gd_accounts").doc(owner).collection("workspaces").doc(id);
 const rate=new Map();
 const safeTeamId=id=>typeof id==="string"&&UUID.test(id);
 const subEntitled=t=>t.ownerComplimentary===true||ENTITLED.has(t.subscriptionStatus);

 async function platformGate(owner,{writing=false}={}){
   // Hook for the platform moderation gate (OWNER_PAGE_PLAN 15.7): account_state
   // suspensions block team routes; a restriction blocks posting and creating.
   const snap=await db.collection("account_state").doc(owner).get();
   const s=snap.exists?snap.data():null;
   if(!s)return;
   if(["suspended","terminated","pending_deletion"].includes(s.state))throw new ProjectError(403,"This account is suspended","account_restricted");
   if(writing&&s.state==="restricted")throw new ProjectError(403,"This account is restricted and cannot post or create","account_restricted");
 }
 async function membership(req,id,{tx=null,writing=false}={}){
   if(!safeTeamId(id))throw new ProjectError(404,"Team not found","TEAM_NOT_FOUND");
   const owner=hash(req.user.uid);
   await platformGate(owner,{writing});
   const read=ref=>tx?tx.get(ref):ref.get();
   const [team,me]=await Promise.all([read(teamRef(id)),read(members(id).doc(owner))]);
   // A non-member cannot tell a team exists.
   if(!team.exists||!me.exists||me.data().status!=="active")throw new ProjectError(404,"Team not found","TEAM_NOT_FOUND");
   return {owner,team:team.data(),me:me.data(),isOwner:team.data().ownerHash===owner};
 }
 function requireOwner(m){if(!m.isOwner)throw new ProjectError(403,"Only the team owner can do this","TEAM_OWNER_ONLY");}
 function requireSubscription(t){
   if(!subEntitled(t))throw new ProjectError(402,"This team needs an active team subscription","TEAM_SUBSCRIPTION_REQUIRED");
 }
 function audit(tx,id,team,entry){
   const seq=(team.auditSeq||0)+1,prev=team.auditHead||"0".repeat(64);
   const body={seq,prev,atMs:now(),...entry};
   const digest=crypto.createHash("sha256").update(prev+JSON.stringify(body)).digest("hex");
   tx.set(teamRef(id).collection("audit").doc(String(seq).padStart(10,"0")),{...body,hash:digest});
   return {auditSeq:seq,auditHead:digest};
 }
 function publicMember(m){
   const muted=m.mutedUntilMs===null&&m.muted===true?{until:null}:(m.mutedUntilMs>now()?{until:m.mutedUntilMs}:null);
   return {memberId:m.memberId,displayName:m.displayName,color:m.color,colorHex:colorHex(m.color),role:m.role,
     muted:muted?{...muted,reason:m.muteReason||null}:null};
 }
 function publicTeam(id,t,m,list){
   return {id,name:t.name,tier:t.tier,interval:t.interval,memberLimit:TEAM_TIERS[t.tier].members,memberCount:t.memberCount||0,
     priceCents:teamCents(t.tier,t.interval),subscriptionStatus:t.ownerComplimentary?"owner":(t.subscriptionStatus||"pending"),
     subscriptionActive:subEntitled(t),role:m.role,me:publicMember(m),
     ...(list?{members:list.map(publicMember)}:{})};
 }
 function colorChoices(list,meId=null){
   const taken=new Set(list.filter(m=>m.memberId!==meId).map(m=>m.color));
   return {memberColors:MEMBER_COLORS.map(c=>({...c,taken:taken.has(c.id)})),ownerShades:OWNER_SHADES,reservedHue:"purple"};
 }
 function validColor(color,role){
   if(role==="owner"){
     if(!OWNER_SHADE_IDS.has(color))throw new ProjectError(400,"The team owner picks a purple shade","INVALID_COLOR");
     return color;
   }
   if(OWNER_SHADE_IDS.has(color)||/purple|violet|fuchsia|indigo/i.test(String(color)))throw new ProjectError(400,"Purple is reserved for the team owner. Pick another color.","COLOR_RESERVED");
   if(!MEMBER_COLOR_IDS.has(color))throw new ProjectError(400,"Pick one of the team colors","INVALID_COLOR");
   return color;
 }
 async function activeMembers(id,tx=null){
   const snap=await (tx?tx.get(members(id)):members(id).get());
   return snap.docs.map(d=>d.data()).filter(m=>m.status==="active");
 }

 async function list(req){
   const owner=hash(req.user.uid);await platformGate(owner);
   const idx=await myTeams(owner).get(),out=[];
   for(const d of idx.docs){
     const [t,m]=await Promise.all([teamRef(d.id).get(),members(d.id).doc(owner).get()]);
     if(t.exists&&m.exists&&m.data().status==="active")out.push(publicTeam(d.id,t.data(),m.data()));
   }
   return out;
 }
 async function create(req,body={}){
   const owner=hash(req.user.uid);await platformGate(owner,{writing:true});
   const intentId=body.intentId;
   if(typeof intentId!=="string"||!INTENT.test(intentId))throw new ProjectError(400,"A UUID creation intent is required","INVALID_INTENT");
   let name;try{name=validateWorkspaceName(body.name);}catch(_){throw new ProjectError(400,"Choose a valid team name","INVALID_TEAM_NAME");}
   const tier=teamTier(body.tier).id,iv=interval(body.interval);
   const color=validColor(body.ownerShade||"purple-500","owner");
   const id=intentId.toLowerCase(),memberId=memberIdFor(id,owner),complimentary=req.ownerBenefits===true;
   const created=await db.runTransaction(async tx=>{
     const prior=await tx.get(teamRef(id));
     if(prior.exists){
       if(prior.data().ownerHash!==owner||prior.data().name!==name)throw new ProjectError(409,"This creation intent belongs to another team","INTENT_CONFLICT");
       return {resumed:true};
     }
     const team={name,ownerHash:owner,payerHash:owner,tier,interval:iv,memberCount:1,subscriptionStatus:complimentary?"owner":"pending",
       ownerComplimentary:complimentary,chatSeq:0,auditSeq:0,auditHead:null,createdAt:stamp(),updatedAt:stamp()};
     const head=audit(tx,id,team,{action:"team.create",actor:memberId,source:"owner"});
     tx.create(teamRef(id),{...team,...head});
     tx.set(members(id).doc(owner),{memberId,accountHash:owner,role:"owner",status:"active",color,
       displayName:displayNameFrom(body),joinedAtMs:now()});
     tx.set(myTeams(owner).doc(id),{role:"owner",joinedAtMs:now()});
     return {resumed:false};
   });
   const m=await membership(req,id);
   let payment={};
   if(!subEntitled(m.team))payment=await checkout(req,id,{}).catch(e=>{if(e instanceof ProjectError&&e.status===503)return {checkoutError:e.code};throw e;});
   return {team:publicTeam(id,m.team,m.me,await activeMembers(id)),resumed:created.resumed,...payment};
 }
 async function view(req,id){
   const m=await membership(req,id),all=await activeMembers(id);
   return {team:publicTeam(id,m.team,m.me,all),colors:colorChoices(all,m.me.memberId)};
 }
 async function checkout(req,id,body={}){
   const m=await membership(req,id);requireOwner(m);
   if(m.team.ownerComplimentary)return {alreadyActivated:true,complimentary:true};
   if(m.team.subscriptionId&&ENTITLED.has(m.team.subscriptionStatus))
     return {alreadyActivated:true,message:"The team subscription is active. Use Manage Billing to change it."};
   const tier=body.tier?teamTier(body.tier).id:m.team.tier,iv=body.interval?interval(body.interval):m.team.interval;
   if(tier!==m.team.tier&&(m.team.memberCount||0)>TEAM_TIERS[tier].members)
     throw new ProjectError(409,"This team has more members than "+TEAM_TIERS[tier].name+" allows","TEAM_TOO_LARGE");
   if(env.STRIPE_CHECKOUT_ENABLED!=="true")throw new ProjectError(503,"Team checkout is not available yet","TEAM_CHECKOUT_UNAVAILABLE");
   const price=prices[teamPriceKey(tier,iv)];
   if(typeof price!=="string"||!/^price_[A-Za-z0-9]+$/.test(price))throw new ProjectError(503,"Team prices are not configured yet","TEAM_PRICE_UNCONFIGURED");
   const customer=await ensureCustomer(req),origin=new URL(env.PUBLIC_URL);
   if(origin.protocol!=="https:")throw new ProjectError(503,"HTTPS Checkout return address required");
   const prior=m.team.checkoutSessionId;
   if(prior&&tier===m.team.tier&&iv===m.team.interval){
     const s=await stripe.checkout.sessions.retrieve(prior);
     if(s.status==="open"&&s.url)return {url:s.url,teamId:id,totalCents:teamCents(tier,iv),resumed:true};
     if(s.status!=="expired")throw new ProjectError(409,"Your team payment is being verified. Refresh before retrying.","PAYMENT_PENDING");
   }else if(prior){
     const s=await stripe.checkout.sessions.retrieve(prior);
     if(s.status==="open")await stripe.checkout.sessions.expire(prior);
   }
   const metadata={kind:"team_subscription",accountHash:m.owner,teamId:id,tier,interval:iv};
   const session=await stripe.checkout.sessions.create({mode:"subscription",customer,client_reference_id:id,
     line_items:[{price,quantity:1}],metadata,subscription_data:{metadata},
     success_url:origin.origin+"/billing/success?session_id={CHECKOUT_SESSION_ID}",cancel_url:origin.origin+"/billing/cancel"},
     {idempotencyKey:"gd-team-"+m.owner+"-"+id+"-"+tier+"-"+iv+"-"+(prior||"first")});
   await teamRef(id).update({checkoutSessionId:session.id,tier,interval:iv,subscriptionStatus:"pending",updatedAt:stamp()});
   return {url:session.url,teamId:id,totalCents:teamCents(tier,iv)};
 }

 // Invites: link or code. Only the code hash is stored.
 async function invite(req,id,body={}){
   const m=await membership(req,id,{writing:true});requireOwner(m);requireSubscription(m.team);
   const hours=body.expiresInHours===undefined?72:Number(body.expiresInHours);
   if(!Number.isSafeInteger(hours)||hours<1||hours>720)throw new ProjectError(400,"Invites last 1 to 720 hours","INVALID_INVITE");
   const maxUses=body.maxUses===undefined?TEAM_TIERS[m.team.tier].members:Number(body.maxUses);
   if(!Number.isSafeInteger(maxUses)||maxUses<1||maxUses>TEAM_TIERS[m.team.tier].members)throw new ProjectError(400,"Invalid invite use limit","INVALID_INVITE");
   const code=newCode(),key=codeHash(code),expiresAtMs=now()+hours*3_600_000;
   await db.collection("gd_team_invites").doc(key).set({teamId:id,createdBy:m.me.memberId,expiresAtMs,maxUses,uses:0,revoked:false,createdAt:stamp()});
   const origin=env.PUBLIC_URL?new URL(env.PUBLIC_URL).origin:"";
   // The code sits in the fragment so it never reaches server or proxy logs.
   return {code,inviteId:key.slice(0,16),link:origin+"/teams/join#"+code,expiresAtMs,maxUses};
 }
 async function revokeInvite(req,id,inviteId){
   const m=await membership(req,id);requireOwner(m);
   const snap=await db.collection("gd_team_invites").where("teamId","==",id).get();
   const hit=snap.docs.find(d=>d.id.slice(0,16)===inviteId);
   if(!hit)throw new ProjectError(404,"Invite not found","INVITE_NOT_FOUND");
   await hit.ref.update({revoked:true});return {revoked:true};
 }
 async function join(req,body={}){
   const owner=hash(req.user.uid);await platformGate(owner,{writing:true});
   const attempts=(rate.get("join:"+owner)||[]).filter(t=>t>now()-60_000);
   if(attempts.length>=10)throw new ProjectError(429,"Too many join attempts. Wait a minute.","RATE_LIMITED");
   rate.set("join:"+owner,[...attempts,now()]);
   const code=String(body.code||"").trim(),key=codeHash(code.includes("#")?code.split("#").pop():code);
   const color=validColor(body.color,"member"),displayName=displayNameFrom(body);
   return db.runTransaction(async tx=>{
     const inv=await tx.get(db.collection("gd_team_invites").doc(key));
     const i=inv.exists?inv.data():null;
     if(!i||i.revoked||i.expiresAtMs<=now()||i.uses>=i.maxUses)throw new ProjectError(404,"This invite is not valid. Ask the team owner for a new one.","INVITE_INVALID");
     const id=i.teamId,[t,me]=await Promise.all([tx.get(teamRef(id)),tx.get(members(id).doc(owner))]);
     if(!t.exists)throw new ProjectError(404,"This invite is not valid. Ask the team owner for a new one.","INVITE_INVALID");
     const team=t.data(),prior=me.exists?me.data():null;
     if(prior?.status==="active")return {teamId:id,alreadyMember:true};
     if(prior?.status==="banned"&&(prior.bannedUntilMs===null||prior.bannedUntilMs>now()))
       throw new ProjectError(403,"You can't join this team"+(prior.banReason?": "+prior.banReason:""),"TEAM_BANNED");
     if(!subEntitled(team))throw new ProjectError(402,"This team's subscription is not active","TEAM_SUBSCRIPTION_REQUIRED");
     if((team.memberCount||0)>=TEAM_TIERS[team.tier].members)throw new ProjectError(409,"This team is full ("+TEAM_TIERS[team.tier].members+" members)","TEAM_FULL");
     const lock=await tx.get(teamRef(id).collection("colors").doc(color));
     if(lock.exists)throw new ProjectError(409,"That color is taken. Pick another one.","COLOR_TAKEN");
     const memberId=memberIdFor(id,owner);
     const head=audit(tx,id,team,{action:"member.join",actor:memberId,source:"member"});
     tx.set(teamRef(id).collection("colors").doc(color),{memberId});
     tx.set(members(id).doc(owner),{memberId,accountHash:owner,role:"member",status:"active",color,displayName,joinedAtMs:now(),
       muted:false,mutedUntilMs:0,muteReason:null,bannedUntilMs:0,banReason:null});
     tx.set(myTeams(owner).doc(id),{role:"member",joinedAtMs:now()});
     tx.update(teamRef(id),{memberCount:(team.memberCount||0)+1,updatedAt:stamp(),...head});
     tx.update(inv.ref,{uses:i.uses+1});
     return {teamId:id,alreadyMember:false};
   });
 }
 // Lets an invited person see the team name and which colors are taken before
 // joining. Same rate limit as join; an invalid code says nothing about any team.
 async function previewInvite(req,body={}){
   const owner=hash(req.user.uid);await platformGate(owner);
   const attempts=(rate.get("join:"+owner)||[]).filter(t=>t>now()-60_000);
   if(attempts.length>=10)throw new ProjectError(429,"Too many join attempts. Wait a minute.","RATE_LIMITED");
   rate.set("join:"+owner,[...attempts,now()]);
   const code=String(body.code||"").trim(),inv=await db.collection("gd_team_invites").doc(codeHash(code.includes("#")?code.split("#").pop():code)).get();
   const i=inv.exists?inv.data():null;
   if(!i||i.revoked||i.expiresAtMs<=now()||i.uses>=i.maxUses)throw new ProjectError(404,"This invite is not valid. Ask the team owner for a new one.","INVITE_INVALID");
   const t=await teamRef(i.teamId).get();
   if(!t.exists)throw new ProjectError(404,"This invite is not valid. Ask the team owner for a new one.","INVITE_INVALID");
   const all=await activeMembers(i.teamId);
   return {teamName:t.data().name,memberCount:t.data().memberCount||0,memberLimit:TEAM_TIERS[t.data().tier].members,colors:colorChoices(all)};
 }
 async function updateMe(req,id,body={}){
   return db.runTransaction(async tx=>{
     const m=await membership(req,id,{tx});
     const patch={},writes=[];
     if(body.color!==undefined&&body.color!==m.me.color){
       const color=validColor(body.color,m.me.role);
       if(m.me.role!=="owner"){
         const lock=await tx.get(teamRef(id).collection("colors").doc(color));
         if(lock.exists)throw new ProjectError(409,"That color is taken. Pick another one.","COLOR_TAKEN");
         writes.push(()=>{tx.delete(teamRef(id).collection("colors").doc(m.me.color));tx.set(teamRef(id).collection("colors").doc(color),{memberId:m.me.memberId});});
       }
       patch.color=color;
     }
     if(body.displayName!==undefined){
       const name=cleanName(body.displayName);
       if(!name)throw new ProjectError(400,"Display names need 1 to 40 characters","INVALID_DISPLAY_NAME");
       patch.displayName=name;
     }
     for(const w of writes)w();
     if(Object.keys(patch).length)tx.update(members(id).doc(m.owner),patch);
     return publicMember({...m.me,...patch});
   });
 }
 async function removeMember(tx,id,team,target,{status,reason=null,untilMs=0}){
   tx.update(members(id).doc(target.accountHash),{status,removedAtMs:now(),...(status==="banned"?{bannedUntilMs:untilMs,banReason:reason}:{})});
   tx.delete(teamRef(id).collection("colors").doc(target.color));
   tx.delete(myTeams(target.accountHash).doc(id));
   return {memberCount:Math.max(1,(team.memberCount||1)-1)};
 }
 async function leave(req,id){
   const m=await membership(req,id);
   if(m.isOwner)throw new ProjectError(409,"The owner can't leave their own team","TEAM_OWNER_CANNOT_LEAVE");
   const shares=await teamRef(id).collection("shares").where("ownerHash","==",m.owner).get();
   await db.runTransaction(async tx=>{
     const t=await tx.get(teamRef(id)),team=t.data();
     const counts=await removeMember(tx,id,team,m.me,{status:"left"});
     for(const s of shares.docs)tx.delete(s.ref);
     tx.update(teamRef(id),{...counts,...audit(tx,id,team,{action:"member.leave",actor:m.me.memberId,source:"member"})});
   });
   return {left:true};
 }

 // Team workspaces belong to the team. Each needs plans on top of the team subscription.
 function teamWorkspaceView(id,w){
   const plansOk=w.plansComplimentary===true||ENTITLED.has(w.plansStatus);
   return {id,teamId:w.teamId,name:w.name,scope:"team",billingModel:"plans",customStorage:w.customStorage===true,
     requiredPlans:w.requiredPlans,plansStatus:w.plansComplimentary?"owner":(w.plansStatus||"pending"),
     quotaGB:plansOk&&w.requiredPlans.storage==="managed"?STORAGE[w.requiredPlans.storageTier].gb:0,
     needsCustomSetup:w.customStorage===true&&w.customStorageConfigured!==true,
     usedBytes:w.usedBytes||0,
     // Files use the personal-workspace routes with this id: /v3/cloud/<id>, /v2/workspaces/<id>/cloud.
     storageRoutes:w.customStorage===true?null:{v3:"/v3/cloud/"+id,v2:"/v2/workspaces/"+id+"/cloud"}};
 }
 function workspaceStatus(team,w){
   const plansOk=w.plansComplimentary===true||ENTITLED.has(w.plansStatus);
   if(!plansOk)return "pending_payment";
   if(!subEntitled(team))return "team_subscription_required";
   return "active";
 }
 async function workspaces(req,id){
   const m=await membership(req,id);
   const [ws,shares]=await Promise.all([teamRef(id).collection("workspaces").get(),teamRef(id).collection("shares").get()]);
   const all=await activeMembers(id),byHash=new Map(all.map(x=>[x.accountHash,x]));
   const access=m.me.role==="viewer"?"read":"write";
   const team=ws.docs.map(d=>({...teamWorkspaceView(d.id,d.data()),projectStatus:workspaceStatus(m.team,d.data()),access}));
   const shared=[];
   for(const s of shares.docs){
     const share=s.data(),sharer=byHash.get(share.ownerHash);
     if(!sharer)continue;
     const p=await personalRef(share.ownerHash,share.workspaceId).get();
     // Re-check ownership on every read: a deleted or transferred workspace disappears.
     if(!p.exists||p.data().accountHash!==share.ownerHash||p.data().projectStatus==="archived")continue;
     shared.push({id:share.workspaceId,scope:"personal",name:p.data().name,sharedBy:{memberId:sharer.memberId,displayName:sharer.displayName},
       mine:share.ownerHash===m.owner,permission:"view"});
   }
   return {teamWorkspaces:team,sharedWorkspaces:shared,subscriptionActive:subEntitled(m.team)};
 }
 async function createWorkspace(req,id,body={}){
   const m=await membership(req,id,{writing:true});requireOwner(m);requireSubscription(m.team);
   let name;try{name=validateWorkspaceName(body.name);}catch(_){throw new ProjectError(400,"Choose a valid workspace name","INVALID_PROJECT_NAME");}
   if(typeof body.intentId!=="string"||!INTENT.test(body.intentId))throw new ProjectError(400,"A UUID checkout intent is required","INVALID_INTENT");
   const storage=body.storage||"managed";
   if(!["managed","custom"].includes(storage))throw new ProjectError(400,"Choose managed or custom storage","INVALID_SELECTION");
   // No free slot for teams: every team workspace needs its plans.
   const plans=validatePlans(body.plans||null,{custom:storage==="custom"});
   const wid=body.intentId.toLowerCase(),ref=teamRef(id).collection("workspaces").doc(wid);
   const complimentary=m.team.ownerComplimentary===true;
   const result=await db.runTransaction(async tx=>{
     const idxRef=db.collection("gd_team_workspace_index").doc(wid);
     const [prior,idx,mine]=await Promise.all([tx.get(ref),tx.get(idxRef),tx.get(personalRef(m.owner,wid))]);
     if(prior.exists){
       const p=prior.data();
       if(p.name!==name||Object.keys(plans).some(k=>p.requiredPlans[k]!==plans[k]))throw new ProjectError(409,"This creation intent belongs to another workspace","INTENT_CONFLICT");
       return {data:p,resumed:true};
     }
     // Workspace ids are global: the storage routes resolve /v3/cloud/<id> to exactly one workspace.
     if(idx.exists||mine.exists)throw new ProjectError(409,"This creation intent belongs to another workspace","INTENT_CONFLICT");
     tx.set(idxRef,{teamId:id});
     const data={teamId:id,name,createdBy:m.me.memberId,payerHash:m.owner,customStorage:storage==="custom",requiredPlans:plans,
       plansStatus:complimentary?"owner":"pending",plansComplimentary:complimentary,workspaceFeeCents:0,usedBytes:0,reservedBytes:0,createdAt:stamp(),updatedAt:stamp()};
     tx.create(ref,data);
     tx.update(teamRef(id),audit(tx,id,m.team,{action:"workspace.create",actor:m.me.memberId,target:wid,source:"owner"}));
     return {data,resumed:false};
   });
   let payment={};
   if(!complimentary)payment=await checkoutWorkspace(req,id,wid);
   return {workspace:{...teamWorkspaceView(wid,result.data),projectStatus:workspaceStatus(m.team,result.data)},resumed:result.resumed,...payment};
 }
 async function checkoutWorkspace(req,id,wid){
   const m=await membership(req,id);requireOwner(m);requireSubscription(m.team);
   const ref=teamRef(id).collection("workspaces").doc(wid),snap=UUID.test(wid||"")?await ref.get():{exists:false};
   if(!snap.exists)throw new ProjectError(404,"Workspace not found","PROJECT_NOT_FOUND");
   const w=snap.data();
   if(w.plansComplimentary)return {alreadyActivated:true,complimentary:true};
   if(w.plansSubscriptionId&&ENTITLED.has(w.plansStatus))return {alreadyActivated:true};
   if(env.STRIPE_CHECKOUT_ENABLED!=="true")throw new ProjectError(503,"Plan checkout is not available yet","PLANS_CHECKOUT_UNAVAILABLE");
   const ids=planPriceKeys(w.requiredPlans).map(k=>{const p=prices[k];
     if(typeof p!=="string"||!/^price_[A-Za-z0-9]+$/.test(p))throw new ProjectError(503,"Plan prices are not configured yet","PLANS_PRICE_UNCONFIGURED");return p;});
   const totalCents=plansMonthlyCents(w.requiredPlans)*(w.requiredPlans.interval==="year"?10:1);
   if(w.plansCheckoutSessionId){
     const s=await stripe.checkout.sessions.retrieve(w.plansCheckoutSessionId);
     if(s.status==="open"&&s.url)return {url:s.url,workspaceId:wid,totalCents,resumed:true};
     if(s.status!=="expired")throw new ProjectError(409,"Your workspace payment is being verified. Refresh before retrying.","PAYMENT_PENDING");
   }
   const customer=await ensureCustomer(req),origin=new URL(env.PUBLIC_URL);
   const metadata={kind:"team_workspace_plans",accountHash:m.owner,teamId:id,workspaceId:wid};
   const session=await stripe.checkout.sessions.create({mode:"subscription",customer,client_reference_id:wid,
     line_items:ids.map(price=>({price,quantity:1})),metadata,subscription_data:{metadata},
     success_url:origin.origin+"/billing/success?session_id={CHECKOUT_SESSION_ID}",cancel_url:origin.origin+"/billing/cancel"},
     {idempotencyKey:"gd-team-plans-"+id+"-"+wid+"-"+(w.plansCheckoutSessionId||"first")});
   await ref.update({plansCheckoutSessionId:session.id,updatedAt:stamp()});
   return {url:session.url,workspaceId:wid,totalCents};
 }
 async function reconcileSubscription(sub){
   const meta=sub?.metadata||{};
   if(!["team_subscription","team_workspace_plans"].includes(meta.kind))return false;
   if(!/^[a-f0-9]{64}$/.test(meta.accountHash||"")||!safeTeamId(meta.teamId))return false;
   const [account,t]=await Promise.all([db.collection("gd_accounts").doc(meta.accountHash).get(),teamRef(meta.teamId).get()]);
   const customer=typeof sub.customer==="string"?sub.customer:sub.customer?.id;
   if(!account.exists||account.data().stripeCustomerId!==customer||!t.exists)return false;
   // The payer may differ from the owner after a transfer; the current owner may take over billing once it lapsed.
   const tm=t.data(),fromOwner=tm.ownerHash===meta.accountHash;
   const items=sub.items?.data||[],status=String(sub.status||"");
   const exact=expected=>items.length===expected.length&&items.every(x=>x.quantity===undefined||x.quantity===1)&&
     expected.every(p=>typeof p==="string"&&items.filter(x=>x.price?.id===p).length===1);
   if(meta.kind==="team_subscription"){
     const team=tm,payer=team.payerHash===undefined?team.ownerHash:team.payerHash;
     if(!fromOwner&&payer!==meta.accountHash)return false;
     if(team.subscriptionId&&team.subscriptionId!==sub.id&&!(fromOwner&&!ENTITLED.has(team.subscriptionStatus)))return false;
     const price=items.length===1?items[0].price?.id:null;
     const tier=Object.keys(TEAM_TIERS).find(k=>["month","year"].some(iv=>prices[teamPriceKey(k,iv)]===price));
     const iv=tier&&["month","year"].find(v=>prices[teamPriceKey(tier,v)]===price);
     const ok=!!tier&&exact([price]);
     await teamRef(meta.teamId).update({subscriptionId:sub.id,subscriptionStatus:ok?status:"mismatch",payerHash:meta.accountHash,
       ...(ok?{tier,interval:iv}:{}),updatedAt:stamp()});
     return true;
   }
   if(!UUID.test(meta.workspaceId||""))return false;
   const ref=teamRef(meta.teamId).collection("workspaces").doc(meta.workspaceId),w=await ref.get();
   if(!w.exists)return false;
   const wd=w.data(),takeover=fromOwner&&!ENTITLED.has(wd.plansStatus);
   if(wd.payerHash!==meta.accountHash&&!takeover)return false;
   if(wd.plansSubscriptionId&&wd.plansSubscriptionId!==sub.id&&!takeover)return false;
   const ok=exact(planPriceKeys(wd.requiredPlans).map(k=>prices[k]));
   await ref.update({plansSubscriptionId:sub.id,plansStatus:ok?status:"mismatch",payerHash:meta.accountHash,
     ...(ok&&ENTITLED.has(status)?{plansEverPaid:true}:{}),updatedAt:stamp()});
   return true;
 }

 // Sharing a personal workspace is always an explicit act of its owner.
 async function share(req,id,workspaceId){
   const m=await membership(req,id,{writing:true});
   if(typeof workspaceId!=="string"||!UUID.test(workspaceId))throw new ProjectError(404,"Project not found","PROJECT_NOT_FOUND");
   const p=await personalRef(m.owner,workspaceId).get();
   if(!p.exists||p.data().accountHash!==m.owner)throw new ProjectError(404,"Project not found","PROJECT_NOT_FOUND");
   const key=memberIdFor(id,m.owner)+"-"+workspaceId;
   await db.runTransaction(async tx=>{
     const t=await tx.get(teamRef(id));
     tx.set(teamRef(id).collection("shares").doc(key),{ownerHash:m.owner,workspaceId,sharedAtMs:now(),permission:"view"});
     tx.update(teamRef(id),audit(tx,id,t.data(),{action:"workspace.share",actor:m.me.memberId,target:workspaceId,source:"member"}));
   });
   return {shared:true,workspaceId,name:p.data().name};
 }
 async function unshare(req,id,workspaceId){
   const m=await membership(req,id);
   const snap=await teamRef(id).collection("shares").where("workspaceId","==",String(workspaceId)).get();
   const mine=snap.docs.filter(d=>d.data().ownerHash===m.owner||m.isOwner);
   if(!mine.length)throw new ProjectError(404,"Share not found","SHARE_NOT_FOUND");
   for(const d of mine)await d.ref.delete();
   return {shared:false,workspaceId};
 }

 // Chat. Persisted in Firestore; polling with ?after=seq, or the SSE stream.
 async function card(m,id,raw,tx){
   const scope=raw?.scope,wid=raw?.workspaceId;
   if(!["team","personal"].includes(scope)||typeof wid!=="string"||!UUID.test(wid))throw new ProjectError(400,"Choose a workspace to share","INVALID_CARD");
   if(scope==="team"){
     const w=await tx.get(teamRef(id).collection("workspaces").doc(wid));
     if(!w.exists)throw new ProjectError(404,"Workspace not found","PROJECT_NOT_FOUND");
     return {card:{scope,workspaceId:wid,name:w.data().name},writes:[]};
   }
   const p=await tx.get(personalRef(m.owner,wid));
   // Only the owner can share a personal workspace, and only explicitly.
   if(!p.exists||p.data().accountHash!==m.owner)throw new ProjectError(404,"Project not found","PROJECT_NOT_FOUND");
   const key=memberIdFor(id,m.owner)+"-"+wid,s=await tx.get(teamRef(id).collection("shares").doc(key));
   if(!s.exists&&raw.share!==true)throw new ProjectError(403,"Share this workspace with the team first","SHARE_REQUIRED");
   return {card:{scope,workspaceId:wid,name:p.data().name},
     writes:s.exists?[]:[()=>tx.set(teamRef(id).collection("shares").doc(key),{ownerHash:m.owner,workspaceId:wid,sharedAtMs:now(),permission:"view"})],
     shared:!s.exists};
 }
 function isMuted(me){return me.muted===true&&(me.mutedUntilMs===null||me.mutedUntilMs>now());}
 async function post(req,id,body={}){
   return db.runTransaction(async tx=>{
     const m=await membership(req,id,{tx,writing:true});
     if(!subEntitled(m.team))throw new ProjectError(402,"Chat needs an active team subscription","TEAM_SUBSCRIPTION_REQUIRED");
     if(isMuted(m.me))throw new ProjectError(403,"You are muted in this team"+(m.me.muteReason?": "+m.me.muteReason:""),"TEAM_MUTED");
     const text=cleanText(body.text,MESSAGE_MAX);
     let extra=null;
     if(body.card)extra=await card(m,id,body.card,tx);
     if(!text&&!extra)throw new ProjectError(400,"Write a message or pick a workspace to share","EMPTY_MESSAGE");
     const key="chat:"+id+":"+m.owner,recent=(rate.get(key)||[]).filter(t=>t>now()-RATE_WINDOW_MS);
     if(recent.length>=RATE_MAX&&!m.isOwner){
       // Automatic moderation: temporary only, with a plain-words reason.
       const reason="Sending messages too quickly. You can post again in 5 minutes.";
       tx.update(members(id).doc(m.owner),{muted:true,mutedUntilMs:now()+AUTO_MUTE_MS,muteReason:reason});
       tx.update(teamRef(id),audit(tx,id,m.team,{action:"member.mute",actor:"auto",target:m.me.memberId,reason,untilMs:now()+AUTO_MUTE_MS,source:"auto",rule:"chat_rate"}));
       return {autoMuted:true,error:new ProjectError(429,reason,"TEAM_RATE_LIMITED")};
     }
     rate.set(key,[...recent,now()]);
     const seq=(m.team.chatSeq||0)+1;
     const message={seq,memberId:m.me.memberId,authorHash:m.owner,displayName:m.me.displayName,color:m.me.color,
       kind:extra?"workspace_card":"text",text,card:extra?.card||null,createdAtMs:now(),deleted:false};
     for(const w of extra?.writes||[])w();
     tx.set(teamRef(id).collection("messages").doc(String(seq).padStart(12,"0")),message);
     tx.update(teamRef(id),{chatSeq:seq,lastMessageAtMs:now()});
     return {message:messageView(message,new Set(),m.owner),shared:extra?.shared===true};
   }).then(r=>{if(r.error)throw r.error;return r;});
 }
 function messageView(x,revoked,viewer){
   const base={seq:x.seq,memberId:x.memberId,displayName:x.displayName,color:x.color,colorHex:colorHex(x.color),
     kind:x.kind,createdAtMs:x.createdAtMs,mine:x.authorHash===viewer};
   if(x.deleted)return {...base,kind:"removed",text:"",card:null,removed:{reason:x.deleteReason,by:x.deletedBy==="auto"?"auto":x.deletedBy==="account_deletion"?"account":"owner"}};
   let card=x.card;
   // A card for a personal workspace that is no longer shared must not leak its name.
   if(card?.scope==="personal"&&revoked.has(x.authorHash+"/"+card.workspaceId))card={scope:"personal",workspaceId:card.workspaceId,unavailable:true};
   return {...base,text:x.text,card};
 }
 async function readMessages(id,viewer,after=0,limit=50){
   const lim=Math.min(100,Math.max(1,Number(limit)||50)),from=Math.max(0,Number(after)||0);
   const [snap,shares,ws]=await Promise.all([
     teamRef(id).collection("messages").where("seq",">",from).orderBy("seq").limit(lim).get(),
     teamRef(id).collection("shares").get(),teamRef(id).collection("workspaces").get()]);
   const live=new Set(shares.docs.map(d=>d.data().ownerHash+"/"+d.data().workspaceId));
   const teamIds=new Set(ws.docs.map(d=>d.id));
   const revoked=new Set();
   const list=snap.docs.map(d=>d.data());
   for(const x of list)if(x.card?.scope==="personal"&&!live.has(x.authorHash+"/"+x.card.workspaceId))revoked.add(x.authorHash+"/"+x.card.workspaceId);
   return list.map(x=>{const v=messageView(x,revoked,viewer);
     if(v.card?.scope==="team"&&!teamIds.has(v.card.workspaceId))v.card={scope:"team",workspaceId:v.card.workspaceId,unavailable:true};return v;});
 }
 async function messages(req,id,query={}){
   const m=await membership(req,id);
   const list=await readMessages(id,m.owner,query.after,query.limit);
   return {messages:list,latestSeq:m.team.chatSeq||0,pollAfterMs:3000};
 }

 // Owner moderation hooks (OWNER_MODERATION.md applied to a team).
 async function targetMember(tx,id,memberId){
   const snap=await tx.get(members(id));
   const target=snap.docs.map(d=>d.data()).find(x=>x.memberId===memberId&&x.status==="active");
   if(!target)throw new ProjectError(404,"Member not found","MEMBER_NOT_FOUND");
   if(target.role==="owner")throw new ProjectError(409,"The team owner can't be moderated here","TEAM_OWNER_PROTECTED");
   return target;
 }
 async function moderate(req,id,action,targetId,body={}){
   const reason=action==="unmute"?cleanText(body.reason,REASON_MAX)||"Mute lifted":requireReason(body.reason);
   const untilMs=["mute","ban"].includes(action)?duration(body.until,now()):0;
   let shares=null;
   if(["kick","ban"].includes(action)){
     const all=await members(id).get(),t=all.docs.map(d=>d.data()).find(x=>x.memberId===targetId);
     if(t)shares=await teamRef(id).collection("shares").where("ownerHash","==",t.accountHash).get();
   }
   return db.runTransaction(async tx=>{
     const m=await membership(req,id,{tx});requireOwner(m);
     let patch={},target=null;
     if(action==="delete_message"){
       const ref=teamRef(id).collection("messages").doc(String(Number(targetId)).padStart(12,"0")),msg=await tx.get(ref);
       if(!msg.exists||!Number.isSafeInteger(Number(targetId)))throw new ProjectError(404,"Message not found","MESSAGE_NOT_FOUND");
       tx.update(ref,{deleted:true,deleteReason:reason,deletedBy:"owner",text:"",card:null});
     }else{
       target=await targetMember(tx,id,targetId);
       if(action==="mute")tx.update(members(id).doc(target.accountHash),{muted:true,mutedUntilMs:untilMs,muteReason:reason});
       else if(action==="unmute")tx.update(members(id).doc(target.accountHash),{muted:false,mutedUntilMs:0,muteReason:null});
       else if(action==="kick"||action==="ban"){
         patch=await removeMember(tx,id,m.team,target,{status:action==="ban"?"banned":"kicked",reason,untilMs});
         for(const s of shares?.docs||[])tx.delete(s.ref);
       }else throw new ProjectError(400,"Unknown moderation action","INVALID_ACTION");
     }
     const head=audit(tx,id,m.team,{action:action==="delete_message"?"message.delete":"member."+action,actor:m.me.memberId,
       target:String(targetId),reason,...(untilMs!==0?{untilMs}:{}),source:"owner"});
     tx.update(teamRef(id),{...patch,...head});
     return {ok:true,action,reason,until:untilMs===0?undefined:untilMs};
   });
 }
 async function report(req,id,seq,body={}){
   const m=await membership(req,id);
   const category=REPORT_CATEGORIES.has(body.category)?body.category:"other";
   const msg=await teamRef(id).collection("messages").doc(String(Number(seq)).padStart(12,"0")).get();
   if(!msg.exists)throw new ProjectError(404,"Message not found","MESSAGE_NOT_FOUND");
   // Goes to the platform owner's queue (abuse_reports, OWNER_PAGE_PLAN 15.4): hash ids only.
   const ref=db.collection("abuse_reports").doc();
   await ref.set({category,source:"team_chat",reporter:m.owner,subject:{accountHash:msg.data().authorHash,teamId:id,messageSeq:Number(seq)},
     note:cleanText(body.note,2048),status:"open",createdAtMs:now()});
   return {reported:true};
 }
 async function auditLog(req,id){
   const m=await membership(req,id);requireOwner(m);
   const snap=await teamRef(id).collection("audit").orderBy("seq").limit(500).get();
   return {entries:snap.docs.map(d=>{const {seq,prev,hash:h,action,actor,target,reason,untilMs,source,rule,atMs}=d.data();
     return {seq,prev,hash:h,action,actor,target:target||null,reason:reason||null,untilMs:untilMs===undefined?undefined:untilMs,source,rule:rule||null,atMs};})};
 }
 function verifyAudit(entries){
   let prev="0".repeat(64);
   for(const e of entries){
     const {hash:h,...body}=e;
     if(body.prev!==prev)return false;
     const digest=crypto.createHash("sha256").update(prev+JSON.stringify(body)).digest("hex");
     if(digest!==h)return false;prev=h;
   }
   return true;
 }
 // Roles: owner; member (read + write team files); viewer (read team files only). Owner sets them.
 async function setRole(req,id,memberId,body={}){
   const role=body.role;
   if(!["member","viewer"].includes(role))throw new ProjectError(400,"Choose member or viewer","INVALID_ROLE");
   return db.runTransaction(async tx=>{
     const m=await membership(req,id,{tx});requireOwner(m);
     const target=await targetMember(tx,id,memberId);
     if(target.role===role)return {memberId,role};
     tx.update(members(id).doc(target.accountHash),{role});
     tx.set(myTeams(target.accountHash).doc(id),{role,joinedAtMs:target.joinedAtMs||now()});
     tx.update(teamRef(id),audit(tx,id,m.team,{action:"member.role",actor:m.me.memberId,target:memberId,reason:role,source:"owner"}));
     return {memberId,role};
   });
 }
 // Ownership transfer. Billing stays with the current payer until it lapses or the
 // payer deletes their account; then the new owner checks out (reconcile allows the takeover).
 async function transfer(req,id,body={}){
   const ownerShade=validColor(body.ownerShade||"purple-500","owner");
   const myColor=validColor(body.color,"member");
   return db.runTransaction(async tx=>{
     const m=await membership(req,id,{tx,writing:true});requireOwner(m);
     const target=await targetMember(tx,id,body.memberId);
     const lock=await tx.get(teamRef(id).collection("colors").doc(myColor));
     if(lock.exists&&lock.data().memberId!==target.memberId)throw new ProjectError(409,"That color is taken. Pick another one.","COLOR_TAKEN");
     tx.delete(teamRef(id).collection("colors").doc(target.color));
     tx.set(teamRef(id).collection("colors").doc(myColor),{memberId:m.me.memberId});
     tx.update(members(id).doc(target.accountHash),{role:"owner",color:ownerShade,muted:false,mutedUntilMs:0,muteReason:null});
     tx.update(members(id).doc(m.owner),{role:"member",color:myColor});
     tx.set(myTeams(target.accountHash).doc(id),{role:"owner",joinedAtMs:target.joinedAtMs||now()});
     tx.set(myTeams(m.owner).doc(id),{role:"member",joinedAtMs:m.me.joinedAtMs||now()});
     tx.update(teamRef(id),{ownerHash:target.accountHash,payerHash:m.team.payerHash===undefined?m.owner:m.team.payerHash,ownerComplimentary:false,updatedAt:stamp(),
       ...audit(tx,id,m.team,{action:"team.transfer",actor:m.me.memberId,target:target.memberId,source:"owner"})});
     return {transferred:true,ownerMemberId:target.memberId};
   });
 }
 // Deletes the team, its chat, invites, team workspaces and their files. Cancels the
 // team subscription and team workspace plans. The owner types the team name to confirm.
 async function deleteTeam(req,id,body={}){
   const m=await membership(req,id);requireOwner(m);
   if(typeof body.confirmName!=="string"||body.confirmName.trim()!==m.team.name)
     throw new ProjectError(400,"Type the team name to confirm","CONFIRM_NAME_REQUIRED");
   if(!bucket)throw new ProjectError(503,"Team deletion is not available right now","TEAM_DELETE_UNAVAILABLE");
   const ws=await teamRef(id).collection("workspaces").get();
   const subs=[m.team.subscriptionId,...ws.docs.map(d=>d.data().plansSubscriptionId)].filter(x=>typeof x==="string"&&x);
   for(const sub of subs){
     try{await stripe.subscriptions.cancel(sub,{invoice_now:false,prorate:false});}
     catch(e){if(e?.code!=="resource_missing"&&e?.statusCode!==404)throw new ProjectError(503,"Couldn't cancel the team's billing. Try again.","TEAM_BILLING_CANCEL_FAILED");}
   }
   await require("./teams_account").deleteTeamData(db,bucket,id);
   return {deleted:true,canceledSubscriptions:subs.length};
 }
 return {list,create,view,checkout,invite,revokeInvite,join,previewInvite,updateMe,leave,workspaces,createWorkspace,checkoutWorkspace,
   reconcileSubscription,share,unshare,post,messages,readMessages,membership,moderate,report,auditLog,verifyAudit,setRole,transfer,deleteTeam};

}

function catalog(){
 return {tiers:Object.values(TEAM_TIERS).map(t=>({...t})),enterprise:{...ENTERPRISE},yearlyMonthsCharged:10,
   perWorkspace:{required:["storage","performance"],customStorage:["performance"],freeWorkspace:false},
   colors:{memberColors:MEMBER_COLORS,ownerShades:OWNER_SHADES,reservedHue:"purple"}};
}

function registerTeams({app,auth,agreed,service}){
 const send=(res,error)=>{
   if(!(error instanceof ProjectError))return res.status(503).json({error:"TEAMS_UNAVAILABLE"});
   const body={error:error.code};if(error.message&&error.message!==error.code)body.message=error.message;
   return res.status(error.status).json(body);
 };
 const route=(fn,status=200)=>async(req,res)=>{try{res.setHeader("Cache-Control","no-store");res.status(status).json(await fn(req));}catch(e){send(res,e);}};
 const mw=[auth,agreed].filter(Boolean);
 app.get("/v2/teams/catalog",...mw,route(()=>catalog()));
 app.get("/v2/teams",...mw,route(async req=>({teams:await service.list(req)})));
 app.post("/v2/teams",...mw,async(req,res)=>{try{const r=await service.create(req,req.body||{});res.status(r.resumed?200:201).json(r);}catch(e){send(res,e);}});
 app.post("/v2/teams/join",...mw,route(req=>service.join(req,req.body||{})));
 app.post("/v2/teams/join/preview",...mw,route(req=>service.previewInvite(req,req.body||{})));
 app.get("/v2/teams/:id",...mw,route(req=>service.view(req,req.params.id)));
 app.post("/v2/teams/:id/checkout",...mw,route(req=>service.checkout(req,req.params.id,req.body||{})));
 app.post("/v2/teams/:id/invites",...mw,route(req=>service.invite(req,req.params.id,req.body||{}),201));
 app.post("/v2/teams/:id/invites/:inviteId/revoke",...mw,route(req=>service.revokeInvite(req,req.params.id,req.params.inviteId)));
 app.patch("/v2/teams/:id/me",...mw,route(req=>service.updateMe(req,req.params.id,req.body||{})));
 app.post("/v2/teams/:id/leave",...mw,route(req=>service.leave(req,req.params.id)));
 app.get("/v2/teams/:id/workspaces",...mw,route(req=>service.workspaces(req,req.params.id)));
 app.post("/v2/teams/:id/workspaces",...mw,route(req=>service.createWorkspace(req,req.params.id,req.body||{}),201));
 app.post("/v2/teams/:id/workspaces/:wid/checkout",...mw,route(req=>service.checkoutWorkspace(req,req.params.id,req.params.wid)));
 app.post("/v2/teams/:id/shares",...mw,route(req=>service.share(req,req.params.id,req.body?.workspaceId)));
 app.delete("/v2/teams/:id/shares/:wid",...mw,route(req=>service.unshare(req,req.params.id,req.params.wid)));
 app.get("/v2/teams/:id/chat",...mw,route(req=>service.messages(req,req.params.id,req.query||{})));
 app.post("/v2/teams/:id/chat",...mw,route(req=>service.post(req,req.params.id,req.body||{}),201));
 app.post("/v2/teams/:id/chat/:seq/report",...mw,route(req=>service.report(req,req.params.id,req.params.seq,req.body||{}),201));
 app.post("/v2/teams/:id/chat/:seq/delete",...mw,route(req=>service.moderate(req,req.params.id,"delete_message",req.params.seq,req.body||{})));
 for(const action of ["mute","unmute","kick","ban"])
   app.post("/v2/teams/:id/members/:memberId/"+action,...mw,route(req=>service.moderate(req,req.params.id,action,req.params.memberId,req.body||{})));
 app.get("/v2/teams/:id/audit",...mw,route(req=>service.auditLog(req,req.params.id)));
 app.post("/v2/teams/:id/members/:memberId/role",...mw,route(req=>service.setRole(req,req.params.id,req.params.memberId,req.body||{})));
 app.post("/v2/teams/:id/transfer",...mw,route(req=>service.transfer(req,req.params.id,req.body||{})));
 app.post("/v2/teams/:id/delete",...mw,route(req=>service.deleteTeam(req,req.params.id,req.body||{})));
 // Realtime: Server-Sent Events. The stream re-reads Firestore so it works on any
 // instance; clients that can't stream poll GET /chat?after=seq every 3 s instead.
 app.get("/v2/teams/:id/chat/stream",...mw,async(req,res)=>{
   let m;try{m=await service.membership(req,req.params.id);}catch(e){return send(res,e);}
   res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-store","Connection":"keep-alive","X-Accel-Buffering":"no"});
   let last=Math.max(0,Number(req.query?.after)||0),open=true,beats=0;
   const ends=Date.now()+5*60_000;
   req.on("close",()=>{open=false;});
   res.write("retry: 3000\n\n");
   while(open&&Date.now()<ends){
     try{
       await service.membership(req,req.params.id);
       const list=await service.readMessages(req.params.id,m.owner,last,100);
       for(const msg of list){res.write("id: "+msg.seq+"\nevent: message\ndata: "+JSON.stringify(msg)+"\n\n");last=msg.seq;}
       if(++beats%10===0)res.write(": keep-alive\n\n");
     }catch(_){res.write("event: removed\ndata: {}\n\n");break;}
     await new Promise(r=>setTimeout(r,Number(process.env.GD_TEAM_STREAM_POLL_MS||1500)));
   }
   res.end();
 });
}
module.exports={createTeamService,registerTeams,catalog,TEAM_TIERS,ENTERPRISE,MEMBER_COLORS,OWNER_SHADES,teamPriceKey,teamCents,memberIdFor,codeHash};
