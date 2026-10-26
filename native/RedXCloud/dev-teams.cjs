'use strict';
// Dev peers collaborate through metadata only. Membership is never a storage
// authorization input, and this module never returns file routes or key material.
const crypto=require('node:crypto');
const {CloudError,digest}=require('./redx-state.cjs');
const {DevTeamRecords}=require('./dev-team-store.cjs');
const ID=/^[a-f0-9]{32}$/,ACCOUNT=/^[a-f0-9]{64}$/;
const TTL={presence:45000,signal:120000,message:7*86400000};
const matches=pathname=>pathname==='/v1/receivers/me/dev-profile'||pathname==='/v1/receivers/me/dev-teams'||
 /^\/v1\/receivers\/me\/workspaces\/[a-f0-9]{32}\/team$/.test(pathname)||pathname.startsWith('/v1/receivers/teams/');
function fields(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw new CloudError('team_request_invalid',400);return value;}
function text(value,max){if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value))throw new CloudError('team_text_invalid',400);return value.trim();}
async function body(req){let bytes=0,parts=[];for await(const part of req){bytes+=part.length;if(bytes>16*1024)throw new CloudError('body_too_large',413);parts.push(part);}try{const value=JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw new CloudError('team_request_invalid',400);return value;}catch(e){if(e instanceof CloudError)throw e;throw new CloudError('bad_json',400);}}
const peerID=(team,account)=>digest(JSON.stringify(['gendragoon-dev-peer/v1',team,account])).slice(0,32);
const teamID=(account,workspace)=>digest(JSON.stringify(['gendragoon-dev-team/v1',account,workspace])).slice(0,32);
const memberKey=(team,peer)=>`member:${team}:${peer}`;
const profileKey=account=>'profile:'+account;
function createDevTeams({store,records=new DevTeamRecords(store),now=()=>Date.now(),rateLimits=true}={}){
 const locks=new Map(),rates=new Map();let rateSweep=0;
 async function serial(key,fn){const prior=locks.get(key)||Promise.resolve();let release;const gate=new Promise(r=>{release=r;}),tail=prior.catch(()=>{}).then(()=>gate);locks.set(key,tail);await prior.catch(()=>{});try{return await fn();}finally{release();if(locks.get(key)===tail)locks.delete(key);}}
 function rate(identity,operation,limit=60,window=60000){
  if(!rateLimits)return;
  const at=now(),key=identity.owner+':'+operation,prior=rates.get(key);
  if(++rateSweep%128===0||rates.size>=20000)for(const [k,v]of rates)if(v.until<=at)rates.delete(k);
  if(!prior&&rates.size>=20000)throw new CloudError('team_service_busy',503);
  const value=prior&&prior.until>at?prior:{until:at+window,count:0};
  if(value.count>=limit)throw new CloudError('team_rate_limited',429);
  value.count++;rates.set(key,value);
 }
 const put=(key,value,scope,kind,prior=null,position)=>records.write(key,value,{scope,kind,position:prior?.position??position},prior);
 async function profile(account,required=false){const row=await records.get(profileKey(account));if(required&&!row?.value.username)throw new CloudError('username_required',409);return row?.value||null;}
 async function workspace(account,id){const state=await store.get(account);if(!state||state.deletedWorkspaces?.[id]||state.workspaceDeletions?.[id])throw new CloudError('team_not_found',404);const item=state.workspaces?.[id]||state.control?.projects?.[id];if(!item)throw new CloudError('team_not_found',404);return item;}
 async function team(id){if(!ID.test(id||''))throw new CloudError('team_not_found',404);const row=await records.get('team:'+id);if(!row||row.value.status!=='active')throw new CloudError('team_not_found',404);await workspace(row.value.owner,row.value.workspaceId);return row;}
 async function membership(identity,id,role){
  const t=await team(id),p=peerID(id,identity.owner),m=await records.get(memberKey(id,p));
  if(!m||m.value.status!=='active'||m.value.account!==identity.owner)throw new CloudError('team_not_found',404);
  if(role==='owner'&&t.value.owner!==identity.owner||role==='admin'&&!['owner','admin'].includes(m.value.role))throw new CloudError('team_owner_required',403);
  return {t,m,peer:p};
 }
 function cursor(scope,kind,after){return Buffer.from(JSON.stringify({scope,kind,after})).toString('base64url');}
 function pagination(u,scope,kind){
  const keys=[...u.searchParams.keys()];if(keys.some(k=>!['limit','cursor'].includes(k))||new Set(keys).size!==keys.length)throw new CloudError('invalid_pagination',400);
  const raw=u.searchParams.get('limit')||'50';if(!/^[1-9][0-9]?$/.test(raw)||Number(raw)>50)throw new CloudError('invalid_pagination',400);
  let after=0;const c=u.searchParams.get('cursor');if(c){try{if(!/^[A-Za-z0-9_-]{1,300}$/.test(c))throw 0;const v=JSON.parse(Buffer.from(c,'base64url'));if(v.scope!==scope||v.kind!==kind||!Number.isSafeInteger(v.after)||v.after<0)throw 0;after=v.after;}catch{throw new CloudError('invalid_pagination',400);}}
  return {after,limit:Number(raw)};
 }
 async function prune(scope,kind){
  if(!TTL[kind]||typeof records.remove!=='function')return;
  const expired=await records.list(scope,kind,{limit:20,expiredBefore:now()});
  await Promise.all(expired.rows.map(async row=>{if(row.value.expiresAtMs<=now())try{await records.remove(row);}catch(e){if(e.status!==409&&e.status!==404)throw e;}}));
 }
 async function page(u,scope,kind,filter=()=>true){const p=pagination(u,scope,kind);await prune(scope,kind);const result=await records.list(scope,kind,{...p,...(TTL[kind]?{activeAfter:now()}:{})});return {rows:result.rows.filter(r=>filter(r.value)),cursor:cursor(scope,kind,result.rows.at(-1)?.position??p.after),nextCursor:result.after===null?null:cursor(scope,kind,result.after)};}
 async function publicMember(row){const p=await profile(row.value.account);return {peerId:row.value.peerId,username:p?.username||null,role:row.value.role,joinedMs:row.value.joinedMs};}
 async function view(t,m){return {id:t.value.id,name:t.value.name,machineNoteId:t.value.workspaceId,role:m.value.role,memberLimit:null,invitationLimit:null,capabilities:['chat','presence','webrtc-signaling'],storageAccess:false,me:await publicMember(m)};}
 async function teamResponse(t,m){const result=await view(t,m);return {team:result,self:result.me};}
 async function index(account,t,m){const key=`mine:${account}:${t.value.id}`,prior=await records.get(key);await put(key,{teamId:t.value.id,peerId:m.value.peerId},account,'mine',prior);}
 async function create(identity,wid,b){
  fields(b,['name']);const note=await workspace(identity.owner,wid),id=teamID(identity.owner,wid);
  return serial(id,async()=>{
   let t=await records.get('team:'+id);
   if(t&&t.value.owner!==identity.owner)throw new CloudError('team_not_found',404);
   if(!t)t=await put('team:'+id,{id,owner:identity.owner,workspaceId:wid,name:text(b.name||note.name||'Dev team',80),status:'active',messageSeq:0,signalSeq:0,createdMs:now()},id,'team');
   else if(t.value.status!=='active')throw new CloudError('team_disabled',409);
   const p=peerID(id,identity.owner);let m=await records.get(memberKey(id,p));
   if(!m)m=await put(memberKey(id,p),{peerId:p,account:identity.owner,role:'owner',status:'active',generation:crypto.randomBytes(16).toString('hex'),joinedMs:now()},id,'member');
   await index(identity.owner,t,m);return {status:201,body:await teamResponse(t,m)};
  });
 }
 async function join(identity,b){
  fields(b,['token']);await profile(identity.owner,true);rate(identity,'join',10);
  const token=typeof b.token==='string'?b.token:'',match=/^gdt1_([a-f0-9]{32})_([a-f0-9]{32})_([A-Za-z0-9_-]{43})$/.exec(token);
  if(!match)throw new CloudError('team_invite_invalid',404);
  return serial(match[1],async()=>{
   const t=await team(match[1]),key=`invite:${match[1]}:${match[2]}`;let invite=await records.get(key);
   const i=invite?.value;
   if(!i||i.revoked||i.expiresAtMs<=now()||typeof i.tokenHash!=='string'||!/^[a-f0-9]{64}$/.test(i.tokenHash)||!crypto.timingSafeEqual(Buffer.from(i.tokenHash,'hex'),Buffer.from(digest(token),'hex'))||i.claimedBy&&i.claimedBy!==identity.owner)throw new CloudError('team_invite_invalid',404);
   const peer=peerID(t.value.id,identity.owner),mk=memberKey(t.value.id,peer);let m=await records.get(mk);
   if(i.claimedBy&&m&&!(m.value.status==='active'&&m.value.inviteId===i.id))throw new CloudError('team_invite_invalid',404);
   if(m?.value.status==='active'){await index(identity.owner,t,m);return {status:200,body:{...await teamResponse(t,m),alreadyMember:true}};}
   // Claim first: a crash cannot let another account consume this single-use
   // invitation. Only this claimant can repair an unfinished member creation.
   if(!i.claimedBy)invite=await put(key,{...i,claimedBy:identity.owner,claimedMs:now()},t.value.id,'invite',invite);
   m=await put(mk,{peerId:peer,account:identity.owner,role:'peer',status:'active',generation:crypto.randomBytes(16).toString('hex'),inviteId:i.id,joinedMs:now()},t.value.id,'member',m);
   await index(identity.owner,t,m);return {status:200,body:{...await teamResponse(t,m),alreadyMember:false}};
  });
 }
 async function sequence(t,field){const changed=await put('team:'+t.value.id,{...t.value,[field]:(t.value[field]||0)+1},t.value.id,'team',t);return {row:changed,number:changed.value[field]};}
 async function dispatch(req,u,identity){
  if(identity.apiKey||!ACCOUNT.test(identity.owner||''))throw new CloudError('team_session_required',403);
  const method=req.method,path=u.pathname;
  rate(identity,'all',240);
  if(path==='/v1/receivers/me/dev-profile'){
   if(u.search)throw new CloudError('invalid_pagination',400);
   if(method==='GET'){const p=await profile(identity.owner);return {status:200,body:{profile:p,usernameRequired:!p?.username}};}
   if(method==='PUT'){
    rate(identity,'profile',10);const b=fields(await body(req),['username']);
    return serial('profile:'+identity.owner,async()=>{
    if(typeof b.username!=='string'||!/^[A-Za-z][A-Za-z0-9_.-]{2,31}$/.test(b.username))throw new CloudError('username_invalid',400);
    const normalized=b.username.toLowerCase(),claimKey='username:'+normalized;let claim=await records.get(claimKey);
    if(claim&&claim.value.account!==identity.owner)throw new CloudError('username_taken',409);
    if(!claim)await put(claimKey,{account:identity.owner},digest(normalized),'username');
    const prior=await records.get(profileKey(identity.owner));const p={username:b.username,updatedMs:now()};
    await put(profileKey(identity.owner),p,identity.owner,'profile',prior);
    return {status:200,body:{profile:p,usernameRequired:false}};
    });
   }
   throw new CloudError('method_not_allowed',405);
  }
  if(path==='/v1/receivers/me/dev-teams'&&method==='GET'){
   const p=await page(u,identity.owner,'mine'),teams=[];
   for(const row of p.rows){try{const m=await membership(identity,row.value.teamId);teams.push(await view(m.t,m.m));}catch(e){if(e.status!==404)throw e;}}
   return {status:200,body:{teams,cursor:p.cursor,nextCursor:p.nextCursor}};
  }
  let m=/^\/v1\/receivers\/me\/workspaces\/([a-f0-9]{32})\/team$/.exec(path);
  if(m&&method==='POST'){if(u.search)throw new CloudError('invalid_pagination',400);rate(identity,'create',20);return create(identity,m[1],await body(req));}
  if(path==='/v1/receivers/teams/join'&&method==='POST'){if(u.search)throw new CloudError('invalid_pagination',400);return join(identity,await body(req));}
  m=/^\/v1\/receivers\/teams\/([a-f0-9]{32})(?:\/(members|invites|messages|presence|signals|membership)(?:\/([a-f0-9]{32}))?)?$/.exec(path);
  if(!m)throw new CloudError('team_not_found',404);
  const [,id,resource,target]=m;
  // A peer controls how quickly its request body arrives. Read the bounded
  // metadata before taking the team lock, then recheck membership and roles
  // inside the serialized operation before applying any mutation.
  const mutationBody=['POST','PUT','PATCH'].includes(method)?await body(req):null;
  return serial(id,async()=>{
   const auth=await membership(identity,id),{t}=auth;
   if(!resource){
    if(u.search)throw new CloudError('invalid_pagination',400);
    if(method==='GET')return {status:200,body:await teamResponse(t,auth.m)};
    if(method==='PATCH'||method==='DELETE'){
     await membership(identity,id,'owner');const b=method==='PATCH'?fields(mutationBody,['name']):{};
     const changed=await put('team:'+id,{...t.value,...(method==='DELETE'?{status:'disabled'}:{name:text(b.name,80)})},id,'team',t);
     return {status:200,body:method==='DELETE'?{disabled:true}:await teamResponse(changed,auth.m)};
    }
   }
   if(resource==='members'){
    if(!target&&method==='GET'){const p=await page(u,id,'member',v=>v.status==='active');return {status:200,body:{members:await Promise.all(p.rows.map(publicMember)),cursor:p.cursor,nextCursor:p.nextCursor,memberLimit:null}};}
    if(target&&method==='GET'){
     if(u.search)throw new CloudError('invalid_pagination',400);const row=await records.get(memberKey(id,target));
     if(!row||row.value.status!=='active')throw new CloudError('team_member_not_found',404);
     return {status:200,body:{member:await publicMember(row)}};
    }
    if(target&&(method==='DELETE'||method==='PATCH')){
     if(u.search)throw new CloudError('invalid_pagination',400);await membership(identity,id,method==='PATCH'?'owner':'admin');
     const row=await records.get(memberKey(id,target));if(!row||row.value.status!=='active')throw new CloudError('team_member_not_found',404);
     if(row.value.role==='owner'||auth.m.value.role==='admin'&&row.value.role==='admin')throw new CloudError('team_owner_required',403);
     const b=method==='PATCH'?fields(mutationBody,['role']):{};
     if(method==='PATCH'&&!['admin','peer'].includes(b.role))throw new CloudError('team_role_invalid',400);
     await put(memberKey(id,target),{...row.value,...(method==='DELETE'?{status:'removed',removedMs:now()}:{role:b.role})},id,'member',row);
     return {status:200,body:method==='DELETE'?{removed:true}:{updated:true}};
    }
   }
   if(resource==='membership'&&!target&&method==='DELETE'){
    if(u.search)throw new CloudError('invalid_pagination',400);if(auth.m.value.role==='owner')throw new CloudError('team_owner_cannot_leave',409);
    await put(memberKey(id,auth.peer),{...auth.m.value,status:'left',removedMs:now()},id,'member',auth.m);return {status:200,body:{left:true}};
   }
   if(resource==='invites'){
    await membership(identity,id,'admin');
    const publicInvite=v=>({id:v.id,expiresAtMs:v.expiresAtMs,createdMs:v.createdMs,revoked:v.revoked,consumed:Boolean(v.claimedBy),maxUses:1});
    if(!target&&method==='GET'){const p=await page(u,id,'invite');return {status:200,body:{invites:p.rows.map(r=>publicInvite(r.value)),cursor:p.cursor,nextCursor:p.nextCursor,invitationLimit:null}};}
    if(!target&&method==='POST'){
     if(u.search)throw new CloudError('invalid_pagination',400);rate(identity,'invite',30);const b=fields(mutationBody,['expiresInHours']);const hours=b.expiresInHours??72;
     if(!Number.isSafeInteger(hours)||hours<1||hours>720)throw new CloudError('team_invite_expiry_invalid',400);
     const iid=crypto.randomBytes(16).toString('hex'),token=`gdt1_${id}_${iid}_${crypto.randomBytes(32).toString('base64url')}`;
     const invite={id:iid,tokenHash:digest(token),createdMs:now(),expiresAtMs:now()+hours*3600000,revoked:false,claimedBy:null};
     await put(`invite:${id}:${iid}`,invite,id,'invite');return {status:201,body:{invite:publicInvite(invite),token}};
    }
    if(target&&method==='DELETE'){
     if(u.search)throw new CloudError('invalid_pagination',400);const key=`invite:${id}:${target}`,row=await records.get(key);if(!row)throw new CloudError('team_invite_invalid',404);
     await put(key,{...row.value,revoked:true},id,'invite',row);return {status:200,body:{revoked:true}};
    }
   }
   if(resource==='presence'&&!target){
    await profile(identity.owner,true);
    if(method==='PUT'){
     if(u.search)throw new CloudError('invalid_pagination',400);rate(identity,'presence',30);fields(mutationBody,[]);const key=`presence:${id}:${auth.peer}`,prior=await records.get(key);
     await put(key,{peerId:auth.peer,generation:auth.m.value.generation,seenMs:now(),expiresAtMs:now()+TTL.presence},id,'presence',prior);
     return {status:200,body:{expiresAtMs:now()+TTL.presence}};
    }
    if(method==='GET'){
     const p=await page(u,id,'presence',v=>v.expiresAtMs>now()),peers=[];
     for(const row of p.rows){const member=await records.get(memberKey(id,row.value.peerId));if(member?.value.status==='active'&&member.value.generation===row.value.generation)peers.push({peerId:row.value.peerId,seenMs:row.value.seenMs,expiresAtMs:row.value.expiresAtMs});}
     return {status:200,body:{peers,cursor:p.cursor,nextCursor:p.nextCursor}};
    }
   }
   if(resource==='messages'){
    await profile(identity.owner,true);
    if(!target&&method==='GET'){const p=await page(u,id,'message',v=>v.expiresAtMs>now());return {status:200,body:{transport:'server-relay',messages:p.rows.map(r=>({id:r.value.id,peerId:r.value.peerId,username:r.value.username,text:r.value.deleted?'':r.value.text,deleted:r.value.deleted===true,createdMs:r.value.createdMs})),cursor:p.cursor,nextCursor:p.nextCursor}};}
    if(!target&&method==='POST'){
     if(u.search)throw new CloudError('invalid_pagination',400);const p=await profile(identity.owner,true);rate(identity,'message',20,10000);const b=fields(mutationBody,['text','messageId']);
     if(!ID.test(b.messageId||''))throw new CloudError('team_message_id_required',400);const content=text(b.text,2000),key=`message:${id}:${auth.m.value.generation}:${b.messageId}`,prior=await records.get(key);
     if(prior){if(prior.value.text!==content)throw new CloudError('team_message_conflict',409);return {status:200,body:{id:prior.value.id,transport:'server-relay',resumed:true}};}
     const seq=await sequence(t,'messageSeq'),mid=digest(key).slice(0,32);
     await prune(id,'message');
     await put(key,{id:mid,peerId:auth.peer,username:p.username,text:content,createdMs:now(),expiresAtMs:now()+TTL.message},id,'message',null,seq.number);
     return {status:201,body:{id:mid,transport:'server-relay'}};
    }
   }
   if(resource==='signals'&&!target){
    await profile(identity.owner,true);const mailbox=digest('team-mailbox:'+id+':'+auth.peer);
    if(method==='GET'){
     const p=await page(u,mailbox,'signal',v=>v.expiresAtMs>now()),signals=[];
     for(const row of p.rows){const v=row.value,sender=await records.get(memberKey(id,v.from));if(v.toGeneration===auth.m.value.generation&&sender?.value.status==='active'&&sender.value.generation===v.fromGeneration)signals.push({id:v.id,from:v.from,connectionId:v.connectionId,kind:v.type,payload:v.payload,createdMs:v.createdMs,expiresAtMs:v.expiresAtMs});}
     return {status:200,body:{transport:'webrtc-signaling',signals,cursor:p.cursor,nextCursor:p.nextCursor}};
    }
    if(method==='POST'){
     if(u.search)throw new CloudError('invalid_pagination',400);rate(identity,'signal',120);const b=fields(mutationBody,['signalId','to','connectionId','kind','type','payload']);
     if(b.kind&&b.type&&b.kind!==b.type)throw new CloudError('team_signal_invalid',400);b.type=b.kind||b.type;
     if(!ID.test(b.signalId||'')||!ID.test(b.to||'')||!ID.test(b.connectionId||'')||!['offer','answer','ice'].includes(b.type))throw new CloudError('team_signal_invalid',400);
     const targetMember=await records.get(memberKey(id,b.to));if(!targetMember||targetMember.value.status!=='active'||b.to===auth.peer)throw new CloudError('team_peer_unavailable',404);
     if(b.type==='ice'){fields(b.payload,['candidate','sdpMid','sdpMLineIndex','usernameFragment']);if(!(b.payload.candidate===null||typeof b.payload.candidate==='string'&&b.payload.candidate.startsWith('candidate:')&&b.payload.candidate.length<=2000)||!(b.payload.sdpMid===null||typeof b.payload.sdpMid==='string'&&b.payload.sdpMid.length<=64)||!(b.payload.sdpMLineIndex===null||Number.isInteger(b.payload.sdpMLineIndex)&&b.payload.sdpMLineIndex>=0&&b.payload.sdpMLineIndex<=255)||b.payload.usernameFragment!==undefined&&b.payload.usernameFragment!==null&&!(typeof b.payload.usernameFragment==='string'&&b.payload.usernameFragment.length<=256))throw new CloudError('team_signal_invalid',400);}
     else{fields(b.payload,['type','sdp']);if(b.payload.type!==undefined&&b.payload.type!==b.type||typeof b.payload.sdp!=='string'||!b.payload.sdp.startsWith('v=0')||b.payload.sdp.length>8000||/[^\x09\x0a\x0d\x20-\x7e]/.test(b.payload.sdp))throw new CloudError('team_signal_invalid',400);}
     const key=`signal:${id}:${auth.m.value.generation}:${b.signalId}`,prior=await records.get(key);
     if(prior){if(prior.value.to!==b.to||prior.value.connectionId!==b.connectionId||!sameJSON(prior.value.payload,b.payload)||prior.value.type!==b.type)throw new CloudError('team_signal_conflict',409);return {status:200,body:{id:prior.value.id,transport:'webrtc-signaling',resumed:true}};}
     const seq=await sequence(t,'signalSeq'),sid=digest(key).slice(0,32),group=digest('team-mailbox:'+id+':'+b.to);
     await prune(group,'signal');
     await put(key,{id:sid,from:auth.peer,to:b.to,fromGeneration:auth.m.value.generation,toGeneration:targetMember.value.generation,connectionId:b.connectionId,type:b.type,payload:b.payload,createdMs:now(),expiresAtMs:now()+TTL.signal},group,'signal',null,seq.number);
     return {status:201,body:{id:sid,transport:'webrtc-signaling'}};
    }
   }
   throw new CloudError('method_not_allowed',405);
  });
 }
 return {matches,handle:dispatch,exclusive:serial};
}
function sameJSON(a,b){return JSON.stringify(a)===JSON.stringify(b);}
module.exports={createDevTeams,matches,peerID,teamID,TTL};
