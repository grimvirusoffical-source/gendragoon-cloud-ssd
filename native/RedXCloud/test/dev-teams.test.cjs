'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {PassThrough,Readable}=require('node:stream');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createCloud}=require('../server.cjs');
const {CloudError,digest}=require('../redx-state.cjs');
const {DevTeamRecords}=require('../dev-team-store.cjs');
const {TTL,createDevTeams}=require('../dev-teams.cjs');
const {POLICY,RETENTION,QUEUE}=require('../dev-community.cjs');
async function scopedRedXFixture(t){
 const {spawn}=require('node:child_process'),net=require('node:net');
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gd-team-records-'))),listener=net.createServer();
 await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const child=spawn(path.join(process.env.REDX_INTEGRATION_ROOT,'tools/redxd'),['run','--data-dir',path.join(dir,'redx'),'--listen','127.0.0.1:'+port,'--bootstrap','console','--no-open'],{env:{...process.env,REDX_ENGINE_DURABILITY:'sync'},stdio:['ignore','pipe','pipe']});
 let logs='';const capture=b=>{logs=(logs+b.toString()).slice(-100000);};child.stdout.on('data',capture);child.stderr.on('data',capture);
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');for(let i=0;i<100&&child.exitCode===null;i++)await new Promise(r=>setTimeout(r,50));if(child.exitCode===null)child.kill('SIGKILL');}await fs.rm(dir,{recursive:true,force:true});});
 const url='http://127.0.0.1:'+port;let ready=false;
 for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error('Disposable RedX exited before readiness');try{if((await fetch(url+'/healthz',{signal:AbortSignal.timeout(800)})).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.ok(ready,'Disposable RedX reached readiness');const key=logs.match(/rx_live_[A-Za-z0-9]+/)?.[0];assert.ok(key,'Disposable bootstrap key captured in memory');
 async function request(route,body,extra={}){const response=await fetch(url+route,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json',...extra},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};}
 const db=await request('/v1/dbs',{name:'gendragoon_receivers'});assert.ok([200,201].includes(db.status));
 const scoped=await request('/v1/keys',{db:'gendragoon_receivers',scope:'write'},{'X-RedX-Confirm':'createKey'});assert.ok(scoped.body.key);
 return {redxURL:url,receiverKey:scoped.body.key};
}
const issuer='https://red-xai.com',wid='a'.repeat(32),otherWid='c'.repeat(32);
const account=name=>digest(JSON.stringify(['red-xai-receiver/v1',issuer,name]));
class Ledger{
 constructor(){this.map=new Map();}
 async get(owner){return this.map.has(owner)?structuredClone(this.map.get(owner)):null;}
 async ensure(owner,quota=100000){if(!this.map.has(owner))this.map.set(owner,{schema:2,owner,id:owner,revision:0,quota,used:0,workspaces:{},objects:{},reservations:{},library:{}});return this.get(owner);}
 async change(owner,fn){const row=await this.get(owner);fn(row);row.revision++;this.map.set(owner,row);return structuredClone(row);}
}
class Rows{
 constructor(){this.map=new Map();this.maxReturned=0;this.derive=new DevTeamRecords({});}
 async get(key){return this.map.has(key)?structuredClone(this.map.get(key)):null;}
 async getByKey(key){return structuredClone([...this.map.values()].find(r=>r.key===key)||null);}
 async replace(prior,value){const entry=[...this.map].find(([,r])=>r.key===prior.key);if(!entry||entry[1].revision!==prior.revision)throw new CloudError('concurrent_update',409);return this.write(entry[0],value,prior,prior);}
 async write(key,value,meta,prior=null){const old=this.map.get(key);if(old?.revision!==prior?.revision||Boolean(old)!==Boolean(prior))throw new CloudError('concurrent_update',409);const hash=this.derive.key(key),row={schema:1,key:hash,revision:old?old.revision+1:0,scope:meta.scope,kind:meta.kind,position:meta.position??this.derive.address(hash)+1,value:structuredClone(value)};this.map.set(key,row);return structuredClone(row);}
 async remove(row){const entry=[...this.map].find(([,r])=>r.key===row.key);if(!entry||entry[1].revision!==row.revision)throw new CloudError('concurrent_update',409);this.map.delete(entry[0]);}
 async list(scope,kind,{after=0,limit=50,activeAfter,expiredBefore}={}){const sorted=[...this.map.values()].filter(r=>r.scope===scope&&r.kind===kind&&r.position>after&&(activeAfter===undefined||r.value.expiresAtMs>activeAfter)&&(expiredBefore===undefined||r.value.expiresAtMs>0&&r.value.expiresAtMs<=expiredBefore)).sort((a,b)=>a.position-b.position),rows=sorted.slice(0,limit);this.maxReturned=Math.max(this.maxReturned,rows.length);return {rows:structuredClone(rows),after:sorted.length>limit?rows.at(-1).position:null};}
}
async function fixture(t,{rateLimits=false,records=new Rows()}={}){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'gd-dev-teams-')),store=new Ledger(),clock={value:Date.now()};
 await store.ensure(account('alice'));await store.change(account('alice'),s=>{s.workspaces[wid]={id:wid,name:'Private Alice note',active:true,readOnly:false,quotaBytes:100000,workers:1};s.workspaces[otherWid]={id:otherWid,name:'Separate Alice note',active:true,readOnly:false,quotaBytes:100000,workers:1};s.library['f'.repeat(18)]={key:'f'.repeat(18),workspace:wid,name:'NEVER-SHARE-PRIVATE-FILE',kind:'file'};});
 const tokens=new Map();
 const token=name=>{const v='rxca_'+crypto.createHash('sha256').update(name).digest('base64url');tokens.set(v,name);return v;};
 const cloud=await createCloud({root,issuer,authProvider:'redx-site-session',store,teamOptions:{records,now:()=>clock.value,rateLimits},fetchImpl:async(url,opts)=>{
  assert.equal(url,issuer+'/redxai-connect/userinfo');const sub=tokens.get(opts.headers.authorization.slice(7));return Response.json({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',sub,email:sub==='service-owner'?'support@infected-nation.com':sub+'@example.test',email_verified:true});
 }}),api=await cloud.listen();t.after(async()=>{await cloud.close();await fs.rm(root,{recursive:true,force:true});});
 async function call(who,route,method='GET',body){const r=await fetch(api+route,{method,headers:{authorization:'Bearer '+token(who),...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
 async function accept(who){return call(who,'/v1/receivers/me/dev-community','PUT',{version:POLICY.version,accepted:true});}
 async function profile(who,name=who){await accept(who);return call(who,'/v1/receivers/me/dev-profile','PUT',{username:name});}
 async function create(note=wid){await accept('alice');const r=await call('alice','/v1/receivers/me/workspaces/'+note+'/team','POST',{});assert.equal(r.status,201,JSON.stringify(r.body));return r.body;}
 async function invite(team){const r=await call('alice','/v1/receivers/teams/'+team+'/invites','POST',{});assert.equal(r.status,201,JSON.stringify(r.body));return r.body;}
 async function join(who,team){await profile(who);const i=await invite(team),r=await call(who,'/v1/receivers/teams/join','POST',{token:i.token});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
 return {root,store,records,clock,cloud,api,call,profile,accept,create,invite,join,token};
}
test('username is required, identity is server-bound, and invite secrets are stored only as hashes',async t=>{
 const f=await fixture(t),created=await f.create(),id=created.team.id;
 assert.equal(created.team.storageAccess,false);assert.equal(created.team.memberLimit,null);assert.equal(created.self.role,'owner');
 assert.equal((await f.call('alice',`/v1/receivers/teams/${id}/messages`)).status,409,'even the owner must choose a username before quick chat');
 const inv=await f.invite(id);let r=await f.call('bob','/v1/receivers/teams/join','POST',{token:inv.token});assert.equal(r.status,409);assert.equal(r.body.error,'username_required');
 assert.equal((await f.profile('bob')).status,200);assert.equal((await f.profile('eve','BOB')).status,409);
 r=await f.call('bob','/v1/receivers/teams/join','POST',{token:inv.token});assert.equal(r.status,200);assert.equal(r.body.self.role,'peer');
 assert.ok(!JSON.stringify([...f.records.map.values()]).includes(inv.token));
 r=await f.call('alice','/v1/receivers/teams/'+id+'/invites');assert.equal(r.body.invites[0].consumed,true);assert.ok(!JSON.stringify(r.body).includes('tokenHash'));assert.ok(!JSON.stringify(r.body).includes(account('bob')));
 assert.equal(await f.store.get(account('bob')),null,'joining must not provision a Receiver or storage entitlement');
 r=await f.call('bob','/v1/receivers/teams/'+id+'/messages','POST',{text:'hello',messageId:'1'.repeat(32),owner:account('alice')});assert.equal(r.status,400);
});
test('single-use invitations reject replay, expired/revoked links and foreign identities',async t=>{
 const f=await fixture(t),{team}=await f.create();await Promise.all([f.profile('bob'),f.profile('eve')]);
 const first=await f.invite(team.id),results=await Promise.all(['bob','eve'].map(who=>f.call(who,'/v1/receivers/teams/join','POST',{token:first.token})));
 assert.equal(results.filter(x=>x.status===200).length,1);assert.equal(results.filter(x=>x.status===404).length,1);
 const revoked=await f.invite(team.id);assert.equal((await f.call('alice',`/v1/receivers/teams/${team.id}/invites/${revoked.invite.id}`,'DELETE')).status,200);
 assert.equal((await f.call('eve','/v1/receivers/teams/join','POST',{token:revoked.token})).status,404);
 const expired=await f.invite(team.id);f.clock.value=expired.invite.expiresAtMs;
 assert.equal((await f.call('eve','/v1/receivers/teams/join','POST',{token:expired.token})).status,404);
 assert.equal((await f.call('eve','/v1/receivers/teams/join','POST',{token:first.token.slice(0,-1)+'!'})).status,404);
});
test('teams are scoped per MachineNote and peers receive no file, blob, library or invite-admin access',async t=>{
 const f=await fixture(t),a=await f.create(),b=await f.create(otherWid),member=await f.join('bob',a.team.id);
 assert.notEqual(a.team.id,b.team.id);assert.notEqual(a.self.peerId,b.self.peerId);
 for(const route of [`/v1/receivers/teams/${b.team.id}`,`/v1/receivers/teams/${b.team.id}/messages`,`/v1/receivers/teams/${b.team.id}/members`])assert.equal((await f.call('bob',route)).status,404);
 assert.equal((await f.call('bob',`/v1/receivers/teams/${a.team.id}/invites`,'POST',{})).status,403);
 for(const route of [`/v1/receivers/me/workspaces/${wid}/library`,`/v1/receivers/me/workspaces/${wid}/blobs/${'b'.repeat(32)}`,`/v1/receivers/me/library`]){const r=await f.call('bob',route);assert.equal(r.status,404);assert.ok(!JSON.stringify(r.body).includes('NEVER-SHARE'));}
 assert.equal((await f.call('bob',`/v1/receivers/me/workspaces/${wid}`,'DELETE')).status,404);
 assert.equal((await f.call('bob',`/v1/receivers/teams/${a.team.id}/members/${a.self.peerId}`,'DELETE')).status,403);
 assert.equal(member.team.storageAccess,false);
});
test('owner/admin controls revoke membership and queued signaling immediately, including after rejoin',async t=>{
 const f=await fixture(t),created=await f.create(),id=created.team.id;await f.profile('alice');const bob=await f.join('bob',id),eve=await f.join('eve',id);
 let r=await f.call('alice',`/v1/receivers/teams/${id}/members/${bob.self.peerId}`,'PATCH',{role:'admin'});assert.equal(r.status,200);
 r=await f.call('bob',`/v1/receivers/teams/${id}/members/${created.self.peerId}`,'DELETE');assert.equal(r.status,403);
 const packet={signalId:'2'.repeat(32),connectionId:'3'.repeat(32),to:eve.self.peerId,kind:'offer',payload:{type:'offer',sdp:'v=0\r\na=application\r\n'}};
 r=await f.call('bob',`/v1/receivers/teams/${id}/signals`,'POST',packet);assert.equal(r.status,201);
 assert.equal((await f.call('eve',`/v1/receivers/teams/${id}/signals`)).body.signals.length,1);
 assert.equal((await f.call('eve',`/v1/receivers/teams/${id}/members/${bob.self.peerId}`)).body.member.peerId,bob.self.peerId);
 assert.equal((await f.call('alice',`/v1/receivers/teams/${id}/members/${bob.self.peerId}`,'DELETE')).status,200);
 assert.equal((await f.call('bob',`/v1/receivers/teams/${id}/messages`)).status,404);
 assert.equal((await f.call('bob',`/v1/receivers/teams/${id}/signals`)).status,404);
 assert.equal((await f.call('eve',`/v1/receivers/teams/${id}/members/${bob.self.peerId}`)).status,404);
 assert.equal((await f.call('eve',`/v1/receivers/teams/${id}/signals`)).body.signals.length,0);
 const rejoined=await f.join('bob',id);assert.equal(rejoined.self.role,'peer');assert.equal((await f.call('eve',`/v1/receivers/teams/${id}/signals`)).body.signals.length,0);
});
test('chat and signaling are bounded text/RTC metadata with explicit transports and expiring presence',async t=>{
 const f=await fixture(t),created=await f.create(),id=created.team.id;await f.profile('alice');const bob=await f.join('bob',id);
 let r=await f.call('alice',`/v1/receivers/teams/${id}/messages`,'POST',{text:'development hello',messageId:'4'.repeat(32)});assert.equal(r.status,201);assert.equal(r.body.transport,'server-relay');
 const repeat=await f.call('alice',`/v1/receivers/teams/${id}/messages`,'POST',{text:'development hello',messageId:'4'.repeat(32)});assert.equal(repeat.body.resumed,true);
 assert.equal((await f.call('bob',`/v1/receivers/teams/${id}/messages`)).body.messages[0].text,'development hello');
 assert.equal((await f.call('bob',`/v1/receivers/teams/${id}/messages`,'POST',{text:'x'.repeat(2001),messageId:'5'.repeat(32)})).status,400);
 assert.equal((await f.call('bob',`/v1/receivers/teams/${id}/messages`,'POST',{text:'x',messageId:'5'.repeat(32),file:{name:'forbidden'}})).status,400);
 assert.equal((await f.call('bob',`/v1/receivers/teams/${id}/presence`,'PUT',{})).status,200);
 assert.equal((await f.call('alice',`/v1/receivers/teams/${id}/presence`)).body.peers[0].peerId,bob.self.peerId);
 const signal={signalId:'6'.repeat(32),connectionId:'7'.repeat(32),to:bob.self.peerId,kind:'ice',payload:{candidate:'candidate:1 1 udp 123 192.0.2.1 12345 typ host',sdpMid:'0',sdpMLineIndex:0,usernameFragment:'rtc'}};
 assert.equal((await f.call('alice',`/v1/receivers/teams/${id}/signals`,'POST',signal)).status,201);
 let signals=await f.call('bob',`/v1/receivers/teams/${id}/signals`);assert.equal(signals.body.signals[0].kind,'ice');assert.equal(signals.body.transport,'webrtc-signaling');
 f.clock.value+=TTL.signal+1;assert.equal((await f.call('bob',`/v1/receivers/teams/${id}/signals`)).body.signals.length,0);assert.equal((await f.call('alice',`/v1/receivers/teams/${id}/presence`)).body.peers.length,0);
 assert.equal([...f.records.map.values()].filter(r=>r.kind==='signal'||r.kind==='presence').length,0,'bounded TTL cleanup removes expired signaling/presence payloads');
});
test('unlimited distinct invitations and peers page beyond legacy limits without embedding account metadata',async t=>{
 const f=await fixture(t),created=await f.create(),id=created.team.id,before=await f.store.get(account('alice'));
 for(let n=0;n<75;n++)await f.join('developer'+n,id);
 const all=[],invites=[];let cursor=null;
 do{const r=await f.call('alice',`/v1/receivers/teams/${id}/members?limit=17`+(cursor?'&cursor='+cursor:''));assert.equal(r.status,200);all.push(...r.body.members);cursor=r.body.nextCursor;}while(cursor);
 cursor=null;do{const r=await f.call('alice',`/v1/receivers/teams/${id}/invites?limit=13`+(cursor?'&cursor='+cursor:''));assert.equal(r.status,200);invites.push(...r.body.invites);cursor=r.body.nextCursor;}while(cursor);
 assert.equal(all.length,76);assert.equal(new Set(all.map(m=>m.peerId)).size,76);assert.equal(invites.length,75);assert.ok(f.records.maxReturned<=50);
 assert.deepEqual(await f.store.get(account('alice')),before,'team activity must not modify storage/account billing ledger');
 let r=await f.call('alice',`/v1/receivers/teams/${id}/members?limit=0`);assert.equal(r.status,400);
 r=await f.call('alice',`/v1/receivers/teams/${id}/members?limit=51`);assert.equal(r.status,400);
 r=await f.call('alice',`/v1/receivers/teams/${id}/members?limit=1&limit=2`);assert.equal(r.status,400);
 const page=await f.call('alice',`/v1/receivers/teams/${id}/members?limit=1`);r=await f.call('alice',`/v1/receivers/teams/${id}/invites?cursor=${page.body.nextCursor}`);assert.equal(r.status,400);
});
test('rate limiting limits request bursts rather than team or invitation totals',async t=>{
 const f=await fixture(t,{rateLimits:true}),created=await f.create(),id=created.team.id;
 for(let i=0;i<30;i++)assert.equal((await f.call('alice',`/v1/receivers/teams/${id}/invites`,'POST',{})).status,201);
 assert.equal((await f.call('alice',`/v1/receivers/teams/${id}/invites`,'POST',{})).status,429);
 f.clock.value+=60001;assert.equal((await f.call('alice',`/v1/receivers/teams/${id}/invites`,'POST',{})).status,201);
});
async function finishesBeforeBody(work){
 let timer;
 try{return await Promise.race([work.then(value=>({finished:true,value})),new Promise(resolve=>{timer=setTimeout(()=>resolve({finished:false}),1000);})]);}
 finally{clearTimeout(timer);}
}
test('a stalled team mutation body does not lock reads and membership is rechecked after parsing',async t=>{
 const f=await fixture(t),created=await f.create(),id=created.team.id;await f.profile('alice');const bob=await f.join('bob',id);
 const api=createDevTeams({store:f.store,records:f.records,rateLimits:false}),slow=new PassThrough();slow.method='POST';slow.write('{"text":"held body');
 const pending=api.handle(slow,new URL(`http://fixture/v1/receivers/teams/${id}/messages`),{owner:account('bob')}).then(value=>({value}),error=>({error}));
 await new Promise(setImmediate);
 const req=Readable.from([]);req.method='GET';const reading=api.handle(req,new URL(`http://fixture/v1/receivers/teams/${id}`),{owner:account('alice')});
 const before=await finishesBeforeBody(reading);
 try{
  const removed=await f.call('alice',`/v1/receivers/teams/${id}/members/${bob.self.peerId}`,'DELETE');assert.equal(removed.status,200);
 }finally{slow.end('","messageId":"'+'8'.repeat(32)+'"}');}
 const posted=await pending;await reading;
 assert.equal(before.finished,true,'request streaming must not hold the team lock');assert.equal(before.value.status,200);
 assert.equal(posted.error?.status,404,'a member removed while sending JSON must not publish later');
 assert.equal([...f.records.map.values()].filter(row=>row.kind==='message').length,0);
});
test('a stalled username body does not hold the account profile lock',async t=>{
 const f=await fixture(t);await f.accept('alice');const api=createDevTeams({store:f.store,records:f.records,rateLimits:false}),identity={owner:account('alice')};
 const slow=new PassThrough();slow.method='PUT';slow.write('{"username":"');
 const pending=api.handle(slow,new URL('http://fixture/v1/receivers/me/dev-profile'),identity);
 await new Promise(setImmediate);
 const fast=Readable.from([Buffer.from(JSON.stringify({username:'fastfixture'}))]);fast.method='PUT';
 const saving=api.handle(fast,new URL('http://fixture/v1/receivers/me/dev-profile'),identity);
 const before=await finishesBeforeBody(saving);
 slow.end('slowfixture"}');await pending;await saving;
 assert.equal(before.finished,true,'a complete username request must not wait for another request body');assert.equal(before.value.status,200);
});
test('message and signal cursors resume at current end and fetch only later packets',async t=>{
 const f=await fixture(t),created=await f.create(),id=created.team.id;await f.profile('alice');const bob=await f.join('bob',id);
 let messages=await f.call('bob',`/v1/receivers/teams/${id}/messages`);assert.ok(messages.body.cursor);assert.equal(messages.body.nextCursor,null);
 const emptyCursor=messages.body.cursor;
 for(let n=1;n<=3;n++)assert.equal((await f.call('alice',`/v1/receivers/teams/${id}/messages`,'POST',{messageId:n.toString(16).padStart(32,'0'),text:'Message '+n})).status,201);
 messages=await f.call('bob',`/v1/receivers/teams/${id}/messages?limit=2&cursor=${emptyCursor}`);assert.equal(messages.body.messages.length,2);assert.ok(messages.body.nextCursor);
 messages=await f.call('bob',`/v1/receivers/teams/${id}/messages?cursor=${messages.body.nextCursor}`);assert.equal(messages.body.messages.length,1);assert.equal(messages.body.nextCursor,null);
 const end=messages.body.cursor;messages=await f.call('bob',`/v1/receivers/teams/${id}/messages?cursor=${end}`);assert.deepEqual(messages.body.messages,[]);assert.equal(messages.body.cursor,end);
 await f.call('alice',`/v1/receivers/teams/${id}/messages`,'POST',{messageId:'f'.repeat(32),text:'Later message'});
 messages=await f.call('bob',`/v1/receivers/teams/${id}/messages?cursor=${end}`);assert.deepEqual(messages.body.messages.map(m=>m.text),['Later message']);
 let signals=await f.call('bob',`/v1/receivers/teams/${id}/signals`);const start=signals.body.cursor;assert.ok(start);
 const packet={signalId:'e'.repeat(32),connectionId:'d'.repeat(32),to:bob.self.peerId,kind:'offer',payload:{type:'offer',sdp:'v=0\r\n'}};
 assert.equal((await f.call('alice',`/v1/receivers/teams/${id}/signals`,'POST',packet)).status,201);
 signals=await f.call('bob',`/v1/receivers/teams/${id}/signals?cursor=${start}`);assert.equal(signals.body.signals.length,1);const signalEnd=signals.body.cursor;
 signals=await f.call('bob',`/v1/receivers/teams/${id}/signals?cursor=${signalEnd}`);assert.equal(signals.body.signals.length,0);assert.equal(signals.body.cursor,signalEnd);
});
test('deleted MachineNotes revoke collaboration without exposing another account or creating storage',async t=>{
 const f=await fixture(t),created=await f.create(),id=created.team.id;await f.join('bob',id);
 await f.store.change(account('alice'),s=>{s.deletedWorkspaces={[wid]:{deletedMs:f.clock.value}};delete s.workspaces[wid];});
 assert.equal((await f.call('bob',`/v1/receivers/teams/${id}/messages`)).status,404);
 const list=await f.call('bob','/v1/receivers/me/dev-teams');assert.equal(list.status,200);assert.equal(list.body.teams.length,0);
 assert.equal(await f.store.get(account('bob')),null);
});
test('versioned rules require an explicit current acceptance before profile, team text, joining and chat',async t=>{
 const f=await fixture(t);let r=await f.call('alice','/v1/receivers/me/dev-community');assert.equal(r.body.accepted,false);assert.equal(r.body.policy.version,POLICY.version);
 assert.equal((await f.call('alice','/v1/receivers/me/dev-profile','PUT',{username:'alice'})).body.error,'community_acceptance_required');
 for(const request of [{version:'old',accepted:true},{version:POLICY.version,accepted:false},{version:POLICY.version,accepted:true,account:account('alice')}])assert.notEqual((await f.call('alice','/v1/receivers/me/dev-community','PUT',request)).status,200);
 assert.equal((await f.call('alice',`/v1/receivers/me/workspaces/${wid}/team`,'POST',{})).status,409);
 const created=await f.create(),id=created.team.id;await f.profile('alice');const bob=await f.join('bob',id);
 const key='profile:'+account('bob'),prior=await f.records.get(key);await f.records.write(key,{...prior.value,community:{version:'previous',acceptedMs:f.clock.value}},prior,prior);
 assert.equal((await f.call('bob',`/v1/receivers/teams/${id}/messages`,'POST',{text:'not accepted',messageId:'a'.repeat(32)})).body.error,'community_acceptance_required');
 assert.equal((await f.call('alice',`/v1/receivers/teams/${id}/members/${bob.self.peerId}`)).status,404);
 await f.accept('bob');await f.profile('bob','bob_updated');assert.equal((await f.call('bob','/v1/receivers/me/dev-community')).body.accepted,true);
 assert.equal((await f.call('alice',`/v1/receivers/teams/${id}/members/${bob.self.peerId}`)).status,200);
});
test('blocks are durable, bidirectional for relay/presence/signals and peer lease, scoped to their team',async t=>{
 const f=await fixture(t),a=await f.create(),b=await f.create(otherWid);await f.profile('alice');const bob=await f.join('bob',a.team.id),other=await f.join('bob',b.team.id),route=`/v1/receivers/teams/${a.team.id}`;
 await f.call('alice',route+'/messages','POST',{text:'before block',messageId:'a'.repeat(32)});
 await f.call('alice',route+'/presence','PUT',{});
 const signal={signalId:'b'.repeat(32),connectionId:'c'.repeat(32),to:bob.self.peerId,kind:'offer',payload:{type:'offer',sdp:'v=0\r\n'}};
 assert.equal((await f.call('alice',route+'/signals','POST',signal)).status,201);
 assert.equal((await f.call('bob',route+'/blocks/'+a.self.peerId,'PUT',{})).status,200);
 assert.equal((await f.call('bob',route+'/messages')).body.messages.length,0);assert.equal((await f.call('bob',route+'/signals')).body.signals.length,0);assert.equal((await f.call('bob',route+'/presence')).body.peers.length,0);
 for(const [who,peer]of [['alice',bob.self.peerId],['bob',a.self.peerId]])assert.equal((await f.call(who,route+'/members/'+peer)).status,404);
 assert.equal((await f.call('alice',route+'/signals','POST',{...signal,signalId:'d'.repeat(32)})).status,404);
 assert.equal((await f.call('alice',`/v1/receivers/teams/${b.team.id}/members/${other.self.peerId}`)).status,200);
 const rows=(await f.call('bob',route+'/members')).body.members;assert.equal(rows.find(x=>x.peerId===a.self.peerId).blockedByYou,true);
 const api=createDevTeams({store:f.store,records:f.records,now:()=>f.clock.value,rateLimits:false}),req=Readable.from([]);req.method='GET';const reopened=await api.handle(req,new URL('http://fixture'+route+'/members/'+a.self.peerId),{owner:account('bob')}).catch(e=>e);assert.equal(reopened.status,404,'a fresh process still denies the blocked lease');
 assert.equal((await f.call('bob',route+'/blocks/'+a.self.peerId,'DELETE')).status,200);assert.equal((await f.call('bob',route+'/blocks')).body.blocks.length,0);assert.equal((await f.call('alice',route+'/members/'+bob.self.peerId)).status,200);
});
test('reports validate relay evidence, isolate receipts, and preserve service escalation across owner review',async t=>{
 const f=await fixture(t),a=await f.create(),b=await f.create(otherWid),route=`/v1/receivers/teams/${a.team.id}`;await f.profile('alice');const bob=await f.join('bob',a.team.id),eve=await f.join('eve',a.team.id);await f.join('bob',b.team.id);
 const sent=await f.call('alice',route+'/messages','POST',{text:'canonical relay evidence',messageId:'a'.repeat(32)}),body={reportId:'b'.repeat(32),peerId:a.self.peerId,messageId:sent.body.id,reason:'harassment',details:'Synthetic fixture'};
 const result=await f.call('bob',route+'/reports','POST',body);assert.equal(result.status,201);assert.equal(result.body.report.escalated,true,'reports about the team owner always reach the service queue');const rid=result.body.report.id;
 assert.deepEqual((await f.call('bob',route+'/reports','POST',body)).body.report,result.body.report);
 assert.equal((await f.call('bob',route+'/reports')).status,403);assert.equal((await f.call('eve',route+'/reports/'+rid)).status,404);
 const own=(await f.call('bob',route+'/reports/'+rid)).body;assert.equal(own.report.id,rid);assert.equal(own.report.evidence,undefined);assert.equal(own.reviews,undefined);
 assert.equal((await f.call('bob',`/v1/receivers/teams/${b.team.id}/reports`,'POST',{...body,reportId:'c'.repeat(32),peerId:b.self.peerId})).status,404,'foreign relay IDs are rejected');
 assert.equal((await f.call('bob',route+'/reports','POST',{...body,reportId:'d'.repeat(32),peerId:eve.self.peerId})).status,404,'message author must match reported person');
 const decision={reviewId:'e'.repeat(32),status:'dismissed',action:'none',note:'Team review fixture'};assert.equal((await f.call('bob',route+'/reports/'+rid,'PATCH',decision)).status,403);
 assert.equal((await f.call('alice',route+'/reports/'+rid,'PATCH',decision)).status,201);
 assert.equal((await f.call('eve','/v1/receivers/me/dev-reports')).status,403);
 const service=(await f.call('service-owner','/v1/receivers/me/dev-reports')).body;assert.equal(service.reports[0].id,rid);assert.equal(service.reports[0].evidence.text,'canonical relay evidence');
 const sroute='/v1/receivers/me/dev-reports/'+rid;assert.equal((await f.call('service-owner',sroute,'PATCH',{...decision,reviewId:'f'.repeat(32),status:'reviewed',note:'Independent service review'})).status,201);
 const detail=(await f.call('service-owner',sroute)).body;assert.equal(detail.reviews.length,2);assert.deepEqual(detail.reviews.map(x=>x.reviewer),['team-owner','service-owner']);assert.equal(detail.report.evidence.text,'canonical relay evidence');
 assert.equal((await f.call('alice',route+'/reports/'+rid,'DELETE')).status,405);
 const immutable=await f.records.get('report-root:'+rid);assert.equal(immutable.revision,0);assert.equal(immutable.value.input.evidence.text,'canonical relay evidence');
 const disable={reviewId:'9'.repeat(32),status:'action_taken',action:'disable_team',note:'Synthetic service-only action'};
 assert.equal((await f.call('alice',route+'/reports/'+rid,'PATCH',disable)).status,403);assert.equal((await f.call('service-owner',sroute,'PATCH',disable)).status,201);
 assert.equal((await f.call('bob',route+'/messages')).status,404);assert.equal((await f.call('service-owner',sroute)).body.reviews.length,3,'service reviews survive disabling the team');
});
test('direct evidence is explicitly unverified and moderation actions revoke peers without granting file authority',async t=>{
 const f=await fixture(t),a=await f.create(),route=`/v1/receivers/teams/${a.team.id}`;await f.profile('alice');const bob=await f.join('bob',a.team.id),eve=await f.join('eve',a.team.id);
 let r=await f.call('eve',route+'/reports','POST',{reportId:'1'.repeat(32),peerId:bob.self.peerId,reason:'spam',directText:'Reporter-supplied fixture',escalate:true});assert.equal(r.status,201);const rid=r.body.report.id;
 const reports=(await f.call('alice',route+'/reports')).body;assert.equal(reports.reports[0].evidence.verified,false);assert.equal(reports.reports[0].evidence.kind,'reporter-provided-direct-text');
 assert.equal((await f.call('alice',route+'/members/'+bob.self.peerId,'PATCH',{role:'admin'})).status,200);
 assert.equal((await f.call('bob',route+'/reports')).status,403,'team admins do not receive report inventory');
 r=await f.call('alice',route+'/reports/'+rid,'PATCH',{reviewId:'2'.repeat(32),status:'action_taken',action:'remove_member',note:'Synthetic moderation'});assert.equal(r.status,201);
 assert.equal((await f.call('bob',route+'/signals')).status,404);assert.equal((await f.call('eve',route+'/members/'+bob.self.peerId)).status,404);
 assert.equal((await f.call('eve',`/v1/receivers/me/workspaces/${wid}/library`)).status,404);
 assert.equal((await f.call('eve',route+'/reports','POST',{reportId:'3'.repeat(32),peerId:a.self.peerId,reason:'spam',file:'/private/local-path'})).status,400);
});
test('relay moderation hides the canonical message and new references support historical authenticated reads',async t=>{
 const f=await fixture(t),a=await f.create(),route=`/v1/receivers/teams/${a.team.id}`;await f.profile('alice');const bob=await f.join('bob',a.team.id),sent=await f.call('bob',route+'/messages','POST',{text:'Synthetic message to hide',messageId:'4'.repeat(32)});
 const pointer=await f.records.get(`message-ref:${a.team.id}:${sent.body.id}`);await f.records.remove(pointer);
 await f.call('alice',route+'/messages');assert.ok(await f.records.get(`message-ref:${a.team.id}:${sent.body.id}`),'visible historical messages gain a server-resolved pointer');
 const reported=await f.call('alice',route+'/reports','POST',{reportId:'5'.repeat(32),peerId:bob.self.peerId,messageId:sent.body.id,reason:'spam'});
 assert.equal((await f.call('alice',route+'/reports/'+reported.body.report.id,'PATCH',{reviewId:'6'.repeat(32),status:'action_taken',action:'hide_message'})).status,201);
 const messages=(await f.call('alice',route+'/messages')).body.messages;assert.equal(messages[0].deleted,true);assert.equal(messages[0].text,'');
 const report=(await f.call('alice',route+'/reports/'+reported.body.report.id)).body;assert.equal(report.report.evidence.text,'Synthetic message to hide');
});
test('report pagination and bounded physical expiry cleanup retain unrelated active records',async t=>{
 const f=await fixture(t),a=await f.create(),route=`/v1/receivers/teams/${a.team.id}`;await f.profile('alice');const bob=await f.join('bob',a.team.id);const ids=[];
 for(let n=0;n<12;n++){const r=await f.call('bob',route+'/reports','POST',{reportId:n.toString(16).padStart(32,'0'),peerId:a.self.peerId,reason:'spam'});assert.equal(r.status,201);ids.push(r.body.report.id);}
 let cursor=null,all=[];do{const r=await f.call('alice',route+'/reports?limit=3'+(cursor?'&cursor='+cursor:''));assert.equal(r.status,200);all.push(...r.body.reports);cursor=r.body.nextCursor;}while(cursor);assert.equal(all.length,12);
 for(let n=0;n<24;n++)assert.equal((await f.call('alice',route+'/reports/'+ids[0],'PATCH',{reviewId:n.toString(16).padStart(32,'0'),status:'reviewed',action:'none'})).status,201);
 f.clock.value+=RETENTION+1;
 await f.call('service-owner','/v1/receivers/me/dev-reports');assert.ok([...f.records.map.values()].some(x=>x.kind==='report'),'one cleanup is bounded');
 for(let n=0;n<5;n++)await f.call('service-owner','/v1/receivers/me/dev-reports');
 assert.equal([...f.records.map.values()].filter(x=>['report','report_index','report_state','report_review'].includes(x.kind)).length,0,'expired evidence, history, state and indexes are physically removed');
 assert.ok(await f.records.get('team:'+a.team.id));assert.ok(await f.records.get('profile:'+account('bob')));
});
test('interrupted report creation retains its cleanup index and repairs the same immutable input',async t=>{
 const records=new Rows(),write=records.write.bind(records);let fail=true;records.write=async(key,value,meta,prior)=>{if(fail&&meta.kind==='report'){fail=false;throw new CloudError('metadata_unavailable',503);}return write(key,value,meta,prior);};
 const f=await fixture(t,{records}),a=await f.create(),route=`/v1/receivers/teams/${a.team.id}/reports`;await f.profile('alice');await f.join('bob',a.team.id);
 const body={reportId:'8'.repeat(32),peerId:a.self.peerId,reason:'spam',directText:'Synthetic explicit unverified text'};
 assert.equal((await f.call('bob',route,'POST',body)).status,503);assert.equal([...records.map.values()].filter(r=>r.kind==='report').length,0);const index=[...records.map.values()].find(r=>r.kind==='report_index');assert.ok(index);assert(!JSON.stringify(index.value).includes(body.directText),'the index retains a hash, not unindexed private text');
 f.clock.value+=10000;assert.equal((await f.call('bob',route,'POST',{...body,reason:'fraud'})).status,409);const repaired=await f.call('bob',route,'POST',body);assert.equal(repaired.status,201);assert.equal(repaired.body.report.submittedMs,index.value.submittedMs);assert.equal(repaired.body.report.expiresAtMs,index.value.expiresAtMs);
 assert.equal((await f.call('service-owner','/v1/receivers/me/dev-reports')).body.reports.length,1);
});
test('deleted target barriers prevent post-scan safety metadata recreation and rate limits bound reports',async t=>{
 const f=await fixture(t),a=await f.create(),route=`/v1/receivers/teams/${a.team.id}`;await f.profile('alice');const bob=await f.join('bob',a.team.id);await f.store.ensure(account('bob'));await f.store.change(account('bob'),s=>{s.accountDeletion={status:'running'};});
 for(const [tail,method,b]of [['reports','POST',{reportId:'7'.repeat(32),peerId:bob.self.peerId,reason:'spam'}],['blocks/'+bob.self.peerId,'PUT',{}]])assert.equal((await f.call('alice',route+'/'+tail,method,b)).status,404);
 const g=await fixture(t,{rateLimits:true}),c=await g.create(),peer=await g.join('bob',c.team.id),r=`/v1/receivers/teams/${c.team.id}/reports`;
 for(let n=0;n<10;n++)assert.equal((await g.call('bob',r,'POST',{reportId:n.toString(16).padStart(32,'0'),peerId:c.self.peerId,reason:'spam'})).status,201);
 assert.equal((await g.call('bob',r,'POST',{reportId:'f'.repeat(32),peerId:c.self.peerId,reason:'spam'})).status,429);assert.ok(peer.self.peerId);
});
test('actual scoped RedX records persist independent teams, bounded pages and CAS invite claims',
 {skip:!process.env.REDX_INTEGRATION_ROOT,timeout:30000},async t=>{
 const {RedXState}=require('../redx-state.cjs');const stack=await scopedRedXFixture(t);
 const store=new RedXState({url:stack.redxURL,key:stack.receiverKey,db:'gendragoon_receivers',local:true}),rows=new DevTeamRecords(store);
 const scope='d'.repeat(32);for(let n=0;n<6;n++)await rows.write('fixture:'+n,{index:n},{scope,kind:'invite'});
 assert.deepEqual(await rows.list(scope,'presence'),{rows:[],after:null},'valid empty BoxQL projections are an empty page');
 const page=await rows.list(scope,'invite',{limit:2});assert.equal(page.rows.length,2);assert.ok(page.after);const next=await rows.list(scope,'invite',{limit:2,after:page.after});assert.equal(next.rows.length,2);assert.ok(next.rows[0].position>page.after);
 const old=await rows.get('fixture:0'),results=await Promise.allSettled([rows.write('fixture:0',{claimed:'a'},{scope,kind:'invite'},old),rows.write('fixture:0',{claimed:'b'},{scope,kind:'invite'},old)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.status,409);
 const claimed=await rows.get('fixture:0');
 const retained=await rows.list(scope,'invite',{limit:10});
 assert.ok(retained.rows.some(row=>row.key===claimed.key),'updated rows retain their scope, kind and position indexes');
 await rows.write('fixture:0',{claimed:claimed.value.claimed,revoked:true},{scope,kind:'invite'},claimed);
 const revoked=await rows.get('fixture:0');assert.equal(revoked.value.revoked,true);
 await rows.remove(revoked);assert.equal(await rows.get('fixture:0'),null);
 await rows.write('expiring',{expiresAtMs:123},{scope,kind:'signal'},null);
 const expired=await rows.list(scope,'signal',{expiredBefore:124,limit:10});assert.equal(expired.rows.length,1);await rows.remove(expired.rows[0]);assert.equal(await rows.get('expiring'),null);
 const f=await fixture(t,{records:rows}),created=await f.create(),route=`/v1/receivers/teams/${created.team.id}`;await f.profile('alice');const bob=await f.join('bob',created.team.id);
 const sent=await f.call('bob',route+'/messages','POST',{messageId:'a'.repeat(32),text:'Actual scoped RedX moderation fixture'});assert.equal(sent.status,201,JSON.stringify(sent.body));
 const report=await f.call('alice',route+'/reports','POST',{reportId:'b'.repeat(32),peerId:bob.self.peerId,messageId:sent.body.id,reason:'spam'});assert.equal(report.status,201);
 const review=await f.call('alice',route+'/reports/'+report.body.report.id,'PATCH',{reviewId:'c'.repeat(32),status:'action_taken',action:'hide_message'});assert.equal(review.status,201);
 assert.equal((await f.call('bob',route+'/messages')).body.messages[0].deleted,true,'hashed-key CAS modifies the canonical row without losing indexes');
 assert.equal((await f.call('alice',route+'/blocks/'+bob.self.peerId,'PUT',{})).status,200);assert.equal((await f.call('bob',route+'/members/'+created.self.peerId)).status,404);
 assert.equal((await f.call('service-owner','/v1/receivers/me/dev-reports')).body.reports[0].id,report.body.report.id);
 f.clock.value+=RETENTION+1;await f.call('service-owner','/v1/receivers/me/dev-reports');assert.equal(await rows.get('report-root:'+report.body.report.id),null,'actual DB physically deletes expired root/history/state/index');
});
module.exports={Rows,Ledger};
