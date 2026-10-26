'use strict';
// Disposable real HTTP Control/Receiver stack. Userinfo, billing and the scoped
// CAS database are private fixtures; there is no production or Stripe call.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {createCloud}=require('../server.cjs'),{createControl}=require('../control-server.cjs');
const {ControlState}=require('../control-state.cjs'),{CloudError,digest}=require('../redx-state.cjs');
const {DevTeamRecords}=require('../dev-team-store.cjs');
const {IntegrationMetadata}=require('../integrations.cjs');
const {AccountDeletionRecords}=require('../account-deletion-records.cjs');
const {initialJob,settleAccountBilling,signedHeaders,createDeletionClient,createAccountDeletion}=require('../account-deletion.cjs');
const {peerID}=require('../dev-teams.cjs');
const issuer='https://red-xai.com',key='disposable-account-deletion-service-key',wid='a'.repeat(32),bobWid='b'.repeat(32),idem='1'.repeat(32);
const account=subject=>digest(JSON.stringify(['red-xai-receiver/v1',issuer,subject]));
const token=subject=>'rxca_'+digest(subject).slice(0,43);
const alice=account('alice'),bob=account('bob');
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Disposable fixture did not reach its bounded checkpoint')),3000))]);}finally{clearTimeout(timer);}}
class Ledger{
 constructor(snapshot){this.accounts=new Map(snapshot?.accounts||[]);this.tables=new Map((snapshot?.tables||[]).map(([name,rows])=>[name,new Map(rows)]));this.tail=Promise.resolve();this.ensureCount=0;this.maxScan=0;this.failRemove=false;}
 async get(owner){return this.accounts.has(owner)?structuredClone(this.accounts.get(owner)):null;}
 async ensure(owner,quota){this.ensureCount++;if(!this.accounts.has(owner))this.accounts.set(owner,{schema:2,id:owner,owner,revision:0,quota,used:0,workspaces:{},objects:{},reservations:{},deletions:{},library:{}});return this.get(owner);}
 async change(owner,operation){const result=this.tail.then(async()=>{const row=await this.get(owner);if(!row)throw new CloudError('not_found',404);operation(row);row.revision++;this.accounts.set(owner,row);return structuredClone(row);});this.tail=result.catch(()=>{});return result;}
 snapshot(){return {accounts:[...this.accounts],tables:[...this.tables].map(([k,v])=>[k,[...v]])};}
 async call(method,route,payload){
  if(method==='GET'){
   const decoded=decodeURIComponent(route.slice(5)),m=/(DevEntry|Integration)\[ID=(\d+)\]\.State$/.exec(decoded);assert.ok(m,decoded);
   const row=this.tables.get(m[1])?.get(Number(m[2]));if(!row)throw new CloudError('not_found',404);
   return {value:JSON.stringify(row.State)};
  }
  assert.equal(method,'POST');assert.equal(route,'bx');const {q,params:p}=payload;
  const table=q.includes(':Integration[')?'Integration':'DevEntry';if(!this.tables.has(table))this.tables.set(table,new Map());const rows=this.tables.get(table);
  if(q.startsWith('{Get[]}')){
   const global=q.includes('Sort = ID');let result=[...rows].filter(([id,row])=>global?id>p.after:row.Scope===p.scope&&row.Kind===p.kind&&row.Position>p.after);
   if(p.active!==undefined)result=result.filter(([,r])=>r.ExpiresAtMs>p.active);
   if(p.expired!==undefined)result=result.filter(([,r])=>r.ExpiresAtMs>0&&r.ExpiresAtMs<=p.expired);
   result.sort((a,b)=>global?a[0]-b[0]:a[1].Position-b[1].Position);result=result.slice(0,global?Number(q.match(/Limit = (\d+)/)[1]):p.limit);this.maxScan=Math.max(this.maxScan,result.length);
   return {columns:global?['ID','State']:['ID','Position','State'],rows:result.map(([id,r])=>global?[id,r.State]:[id,r.Position,r.State])};
  }
  const old=rows.get(p.id);
  if(q.includes('{Require[]}')){if(!old||old.Revision!==p.previous||p.key&&old.K!==p.key||p.expected&&old.State!==p.expected)throw new CloudError('concurrent_update',409);}
  else if(old)throw new CloudError('concurrent_update',409);
  if(q.includes('{Delete[]}')){if(this.failRemove){this.failRemove=false;throw new CloudError('metadata_unavailable',503);}rows.delete(p.id);if(this.failAfterRemove){this.failAfterRemove=false;throw new CloudError('metadata_unavailable',503);}return {};}
  // RedX Set replaces the whole row: do not merge missing indexed columns.
  rows.set(p.id,{Revision:p.next??0,State:p.state,...(table==='DevEntry'?{K:p.key,Scope:p.scope,Kind:p.kind,Position:p.position,ExpiresAtMs:p.expires}: {})});return {};
 }
}
async function fixture(t,{autoRun=false,purger,ledger=new Ledger()}={}){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'gd-current-deletion-'));let control,controlURL;
 if(!await ledger.get(alice))for(const [owner,id,name]of [[alice,wid,'Alice private note'],[bob,bobWid,'Bob independent note']]){
  await ledger.ensure(owner,6_000_000_000_000);await ledger.change(owner,s=>{s.workspaces[id]={id,name,billingManaged:true,active:true,readOnly:false,quotaBytes:6_000_000_000_000,usedBytes:0,workers:20};s.control={schema:1,owner,revision:0,policyVersion:3,ownerBenefits:true,adFree:true,projects:{[id]:{id,name,owner:true,feeWaived:true,active:true,readOnly:false,quotaBytes:6_000_000_000_000,workers:20,status:'active',createdMs:1,storageTier:'6TB',performanceTier:'max',interval:'year'}}};});
 }
 const userinfo=authorization=>{const subject=['alice','bob','fresh-alice'].find(s=>'Bearer '+token(s)===authorization);if(!subject)return new Response('{}',{status:401});const sub=subject==='fresh-alice'?'alice':subject;return Response.json({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',sub,email:sub==='alice'?'support@infected-nation.com':'bob@example.test',email_verified:true});};
 let entitlements=0;
 const cloud=await createCloud({root,store:ledger,issuer,authProvider:'redx-site-session',productionReady:true,entitlementURL:'https://api.red-xai.com/gendragoon/v2/receiver-entitlements',redxKey:key,
  accountDeletionOptions:purger?{purger}:{},authorizeWorkspace:async(identity,id)=>({...((await ledger.get(identity.owner))?.workspaces?.[id]||{}),checkedAtMs:Date.now()}),
  fetchImpl:async(url,options)=>{if(url.endsWith('/userinfo'))return userinfo(options.headers.authorization);entitlements++;return fetch(controlURL+'/v2/receiver-entitlements',options);}});
 const receiverURL=await cloud.listen();
 const controlStore=new ControlState({url:'http://127.0.0.1:1',key,db:'disposable_receivers',local:true});controlStore.receiver=ledger;
 async function startControl(){control=await createControl({issuer,store:controlStore,receiverStore:ledger,receiverLocal:receiverURL,redxKey:key,fetchImpl:async(_url,options)=>userinfo(options.headers.authorization),accountDeletionAutoRun:autoRun});controlURL=await control.listen();}
 await startControl();
 t.after(async()=>{await control.close();await cloud.close();await fs.rm(root,{recursive:true,force:true});});
 const call=async(base,route,method='GET',body,who='alice',headers={})=>{const r=await fetch(base+route,{method,headers:{authorization:'Bearer '+token(who),...(body!==undefined?{'content-type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});return {status:r.status,body:await r.json()};};
 const begin=()=>call(controlURL,'/v2/account/deletion','POST',{confirmation:'DELETE GENDRAGOON',idempotencyKey:idem});
 return {root,ledger,cloud,receiverURL,get control(){return control;},get controlURL(){return controlURL;},controlStore,call,begin,userinfo,entitlementCount:()=>entitlements,
  identity:{owner:alice,sub:'alice',bearer:'Bearer '+token('alice')},async restartControl(){await control.close();await startControl();}};
}
test('current authenticated request, durable barrier, verified deletion and same-account receipt survive Control restart',async t=>{
 const f=await fixture(t),dir=path.join(f.root,alice,wid),otherDir=path.join(f.root,bob,bobWid);await fs.mkdir(dir,{recursive:true});await fs.mkdir(otherDir,{recursive:true});
 await fs.writeFile(path.join(dir,'private-fixture.png'),'encrypted-fixture');await fs.writeFile(path.join(otherDir,'keep.png'),'independent');await fs.writeFile(path.join(f.root,alice,'unindexed-orphan.png'),'owned orphan');
 await f.ledger.change(alice,s=>{s.used=17;s.workspaces[wid].usedBytes=17;s.library['c'.repeat(18)]={workspace:wid,name:'DELETE-MY-FILENAME'};});
 let r=await f.call(f.controlURL,'/v2/account/deletion');assert.equal(r.body.deletion,null);
 for(const value of [{},{confirmation:'WRONG',idempotencyKey:idem},{confirmation:'DELETE GENDRAGOON',idempotencyKey:'../other'},{confirmation:'DELETE GENDRAGOON',idempotencyKey:idem,owner:bob}])assert.ok((await f.call(f.controlURL,'/v2/account/deletion','POST',value)).status>=400);
 const before=f.entitlementCount();r=await f.begin();assert.equal(r.status,202);const id=r.body.deletion.id;assert.match(id,/^[a-f0-9]{32}$/);assert.equal(r.body.deletion.cloudDataDeleted,false);assert.equal(r.body.deletion.status,'queued');assert.equal(f.entitlementCount(),before,'prepare must not call locked control entitlements');
 assert.equal((await f.begin()).body.deletion.id,id);
 assert.equal((await f.call(f.controlURL,'/v2/account/deletion','POST',{confirmation:'DELETE GENDRAGOON',idempotencyKey:'2'.repeat(32)})).status,409);
 for(const [route,method]of [['/v1/receivers/me','PUT'],['/v1/receivers/me','GET'],['/v1/receivers/me/dev-profile','GET'],['/v1/integrations/keys','GET']])assert.equal((await f.call(f.receiverURL,route,method)).status,410,route);
 assert.equal((await f.call(f.controlURL,'/v2/account')).status,410);
 assert.equal((await f.call(f.controlURL,'/v2/account/deletion','GET',undefined,'bob')).body.deletion,null);
 await f.restartControl();await f.control.accountDeletion.process(f.identity);
 const ensures=f.ledger.ensureCount;r=await f.call(f.controlURL,'/v2/account/deletion','GET',undefined,'fresh-alice');
 assert.equal(r.body.deletion.id,id);assert.equal(r.body.deletion.status,'completed',JSON.stringify(r.body));assert.equal(r.body.deletion.cloudDataDeleted,true);assert.equal(r.body.deletion.externalIdentityDeleted,false);assert.equal(r.body.deletion.localOriginalsDeleted,false);assert.equal(r.body.deletion.externalBYODataDeleted,false);
 assert.ok(Number.isFinite(Date.parse(r.body.deletion.completedAt)));assert.equal(f.ledger.ensureCount,ensures);
 await assert.rejects(fs.stat(path.join(f.root,alice)),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(otherDir,'keep.png'),'utf8'),'independent');
 const tombstone=await f.ledger.get(alice);assert.deepEqual(Object.keys(tombstone).sort(),['schema','owner','id','revision','quota','used','accountDeletion'].sort());assert.ok(!JSON.stringify(tombstone).includes('DELETE-MY-FILENAME'));assert.ok(!JSON.stringify(tombstone).includes(token('alice')));
 assert.equal((await f.call(f.receiverURL,'/v1/receivers/me','PUT')).status,410);assert.equal((await f.call(f.controlURL,'/v2/projects','POST',{name:'must not recreate'})).status,410);
});
test('account activity prepare fails before billing or tombstone while a real upload body is in flight',async t=>{
 const f=await fixture(t),object='f'.repeat(32),length=4096;
 let unlock,started,held=false;const gate=new Promise(r=>unlock=r),entered=new Promise(r=>started=r),change=f.ledger.change.bind(f.ledger);
 f.ledger.change=async(owner,operation)=>{const state=await change(owner,operation);if(owner===alice&&!held&&Object.keys(state.reservations).length){held=true;started();await gate;}return state;};
 const upload=http.request(f.receiverURL+`/v1/receivers/me/workspaces/${wid}/blobs/${object}`,{method:'PUT',headers:{authorization:'Bearer '+token('alice'),'content-type':'image/png','content-length':length,'x-content-sha256':'0'.repeat(64)}});
 upload.on('error',()=>{});upload.write(Buffer.alloc(10));
 try{
  await bounded(entered);
  assert.ok(Object.keys((await f.ledger.get(alice)).reservations).length,'actual HTTP upload reached durable reservation');
  const r=await f.begin();assert.equal(r.status,409);assert.equal(r.body.error,'account_deletion_busy');assert.equal((await f.ledger.get(alice)).accountDeletion,undefined);
 }finally{upload.destroy();unlock();}
 for(let n=0;n<100&&Object.keys((await f.ledger.get(alice)).reservations).length;n++)await new Promise(r=>setTimeout(r,5));
 assert.equal((await f.begin()).status,202);
});
test('bounded confirmation body is parsed before account locks and public deletion/privacy resources need no account',async t=>{
 const f=await fixture(t);const pending=http.request(f.controlURL+'/v2/account/deletion',{method:'POST',headers:{authorization:'Bearer '+token('alice'),'content-type':'application/json'}});pending.on('error',()=>{});pending.write('{"confirmation":');
 const r=await f.call(f.controlURL,'/v2/account/deletion');assert.equal(r.body.deletion,null);
 assert.equal((await f.call(f.controlURL,'/v2/account')).status,200);
 pending.destroy();
 assert.equal((await f.call(f.controlURL,'/v2/account/deletion','POST',{confirmation:'DELETE GENDRAGOON',idempotencyKey:idem,large:'x'.repeat(5000)})).status,413);
 for(const url of ['/account-deletion','/gendragoon/account-deletion','/privacy','/privacy.html']){
  const response=await fetch(f.controlURL+url);assert.equal(response.status,200,url);assert.match(response.headers.get('content-type'),/text\/html/);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.match(response.headers.get('content-security-policy'),/default-src 'none'.*frame-ancestors 'none'/);const html=await response.text();assert.match(html,/GenDragoon/);assert.ok(!html.includes('<script'));
  if(url.includes('account-deletion')){assert.match(html,/mailto:support@infected-nation.com/);assert.match(html,/does not delete|does not certify/);assert.match(html,/href="privacy"/);}
  else assert.match(html,/href="account-deletion"/);
 }
});
test('signed internal deletion actions reject user-only, stale, forged and wrong-owner proofs',async t=>{
 const f=await fixture(t),route='/v1/receivers/me/account-deletion/prepare',body={id:'d'.repeat(32),keyHash:digest(idem),requestedAtMs:Date.now()};
 for(const headers of [{},signedHeaders(key,alice,'prepare',Date.now()-600000),signedHeaders('wrong',alice,'prepare'),signedHeaders(key,bob,'prepare')])assert.equal((await f.call(f.receiverURL,route,'POST',body,'alice',headers)).status,403);
 assert.equal((await f.ledger.get(alice)).accountDeletion,undefined);
 assert.throws(()=>createDeletionClient({url:'https://untrusted.invalid',key}));
});
async function metadataFixture(f){
 const request=(who,route,method='GET',body)=>f.call(f.receiverURL,route,method,body,who);
 for(const who of ['alice','bob'])assert.equal((await request(who,'/v1/receivers/me/dev-profile','PUT',{username:who==='alice'?'DeleteAlice':'KeepBob'})).status,200);
 const a=(await request('alice',`/v1/receivers/me/workspaces/${wid}/team`,'POST',{})).body.team;
 const b=(await request('bob',`/v1/receivers/me/workspaces/${bobWid}/team`,'POST',{})).body.team;
 const invite=async(who,id)=>(await request(who,`/v1/receivers/teams/${id}/invites`,'POST',{})).body;
 let i=await invite('alice',a.id);assert.equal((await request('bob','/v1/receivers/teams/join','POST',{token:i.token})).status,200);
 i=await invite('bob',b.id);const joined=(await request('alice','/v1/receivers/teams/join','POST',{token:i.token})).body;assert.equal(joined.self.peerId,peerID(b.id,alice));
 for(const [who,id,text,n]of [['alice',b.id,'ERASE ALICE MESSAGE',3],['bob',b.id,'KEEP BOB MESSAGE',4],['bob',a.id,'KEEP BOB INDEPENDENT RELAY COPY',5]])assert.equal((await request(who,`/v1/receivers/teams/${id}/messages`,'POST',{text,messageId:String(n).repeat(32)})).status,201);
 for(const [who,to,n]of [['alice',peerID(b.id,bob),6],['bob',peerID(b.id,alice),7]])assert.equal((await request(who,`/v1/receivers/teams/${b.id}/signals`,'POST',{signalId:String(n).repeat(32),to,connectionId:'8'.repeat(32),kind:'offer',payload:{type:'offer',sdp:'v=0\r\n'}})).status,201);
 const integrationKey=async who=>(await request(who,'/v1/integrations/keys','POST',{service:'quick-launcher',workspaceId:who==='alice'?wid:bobWid,scopes:['files:read'],name:who+' key'})).body;
 const aliceKey=await integrationKey('alice'),bobKey=await integrationKey('bob');assert.ok(aliceKey.apiKey&&bobKey.apiKey);
 const grants={};for(const who of ['alice','bob'])grants[who]=(await request(who,'/provider/v1/connect/grants','POST',{service:'quick-launcher',workspaceId:who==='alice'?wid:bobWid,scopes:['files:read'],name:who+' grant'})).body.grant;
 assert.equal((await request('alice','/v1/integrations/byo','POST',{name:'External kept bytes',origin:'https://byo.example.test',database:'private_files',pack:'backups'})).status,201);
 const records=new DevTeamRecords(f.ledger);
 for(let n=0;n<65;n++){const username='historicalalice'+n;await records.write('username:'+username,{account:alice},{scope:digest(username),kind:'username'});}
 return {a,b,aliceKey,bobKey,grants,request,records};
}
test('paged cleanup removes keys, grants, historical names, memberships and own relay data while preserving peers and BYO originals',async t=>{
 const f=await fixture(t),m=await metadataFixture(f),beforeBob=await f.ledger.get(bob);
 const independent=path.join(f.root,'external-byo-original.fixture');await fs.writeFile(independent,'BYO AND LOCAL ORIGINALS ARE NOT RECEIVER BYTES');
 const dir=path.join(f.root,alice,wid);await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'fixture.png'),'ciphertext');
 let r=await f.begin();assert.equal(r.status,202);
 assert.equal((await f.call(f.receiverURL,'/v1/receivers/me','GET',undefined,'alice',{authorization:'Bearer '+m.aliceKey.apiKey})).status,410,'issued key is denied as soon as deletion starts');
 const redeem=await fetch(f.receiverURL+'/provider/v1/connect/redeem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant:m.grants.alice})});assert.equal(redeem.status,410,'unredeemed grants cannot issue a new key during deletion');
 await f.control.accountDeletion.process(f.identity);r=await f.call(f.controlURL,'/v2/account/deletion');assert.equal(r.body.deletion.status,'completed',JSON.stringify(r.body));
 assert.ok(f.ledger.maxScan<=51&&f.ledger.maxScan>50,'cleanup really crosses a bounded page boundary');
 assert.deepEqual(await f.ledger.get(bob),beforeBob);assert.equal(await fs.readFile(independent,'utf8'),'BYO AND LOCAL ORIGINALS ARE NOT RECEIVER BYTES');
 const entries=[...f.ledger.tables.get('DevEntry').values()].map(r=>JSON.parse(r.State));
 assert.ok(!entries.some(r=>r.scope===alice||r.value.account===alice||r.value.owner===alice||r.value.claimedBy===alice));
 assert.ok(!JSON.stringify(entries).includes('ERASE ALICE MESSAGE'));assert.ok(JSON.stringify(entries).includes('KEEP BOB MESSAGE'));assert.ok(JSON.stringify(entries).includes('KEEP BOB INDEPENDENT RELAY COPY'));
 assert.equal((await m.records.get('team:'+m.a.id)).value.status,'deleted');assert.equal((await m.records.get('team:'+m.a.id)).value.owner,undefined);
 assert.equal((await m.records.get('team:'+m.b.id)).value.owner,bob);assert.equal((await m.records.get('profile:'+bob)).value.username,'KeepBob');
 assert.ok(!entries.some(r=>r.kind==='signal'&&(r.value.from===peerID(m.b.id,alice)||r.value.to===peerID(m.b.id,alice))));
 const integrations=new IntegrationMetadata(f.ledger);assert.equal(await integrations.ownerForKey(m.aliceKey.id),null);assert.equal(await integrations.grant(digest(m.grants.alice)),null);
 assert.equal(await integrations.ownerForKey(m.bobKey.id),bob);assert.ok(await integrations.grant(digest(m.grants.bob)));
 assert.equal((await m.request('bob',`/v1/receivers/teams/${m.b.id}/messages`)).status,200);
 assert.equal((await m.request('bob',`/v1/receivers/teams/${m.b.id}/signals`,'POST',{signalId:'9'.repeat(32),to:peerID(m.b.id,alice),connectionId:'8'.repeat(32),kind:'offer',payload:{type:'offer',sdp:'v=0'}})).status,404);
 assert.equal((await m.request('bob',`/v1/receivers/teams/${m.a.id}`)).status,404);
});
test('a failure after a metadata row was removed is durable, incomplete, and resumes from a disk snapshot without touching peers',async t=>{
 const f=await fixture(t),m=await metadataFixture(f);const first=await f.begin(),id=first.body.deletion.id;
 f.ledger.failAfterRemove=true;await f.control.accountDeletion.process(f.identity);
 let r=await f.call(f.controlURL,'/v2/account/deletion');assert.equal(r.body.deletion.status,'failed');assert.equal(r.body.deletion.retryable,true);assert.equal(r.body.deletion.cloudDataDeleted,false);assert.equal(r.body.deletion.error,'account_deletion_retry_required');
 const saved=path.join(f.root,'durable-cas-fixture.json');await fs.writeFile(saved,JSON.stringify(f.ledger.snapshot()));
 const recovered=new Ledger(JSON.parse(await fs.readFile(saved,'utf8'))),g=await fixture(t,{ledger:recovered});
 assert.equal((await g.begin()).body.deletion.id,id);await g.control.accountDeletion.process(g.identity);
 r=await g.call(g.controlURL,'/v2/account/deletion','GET',undefined,'fresh-alice');assert.equal(r.body.deletion.status,'completed',JSON.stringify(r.body));assert.equal(r.body.deletion.id,id);
 const records=new IntegrationMetadata(recovered);assert.equal(await records.ownerForKey(m.aliceKey.id),null);assert.equal(await records.ownerForKey(m.bobKey.id),bob);
});
test('automatic worker completes only after actual cleanup and a new same-account request reuses its receipt',async t=>{
 const f=await fixture(t,{autoRun:true});const r=await f.begin();assert.equal(r.status,202);assert.equal(r.body.deletion.cloudDataDeleted,false);
 await f.control.accountDeletion.drain();const complete=await f.begin();assert.equal(complete.status,200);assert.equal(complete.body.deletion.id,r.body.deletion.id);assert.equal(complete.body.deletion.status,'completed');
});
test('billing closes open Checkout, catches a concurrent completion, verifies cancellation and refuses foreign ownership',async()=>{
 const project=wid,customer='cus_disposable',metadata={service:'GenDragoonSSD',redxOwner:alice,projectId:project},identity={owner:alice};
 const sessions=new Map([['cs_open',{status:'open',customer,metadata}],['cs_race',{status:'open',customer,metadata}]]),subs=new Map([['sub_initial',{status:'active',customer,metadata}]]),canceled=[];
 const stripe={checkout:{sessions:{retrieve:async id=>structuredClone(sessions.get(id)),expire:async id=>{if(id==='cs_race'){sessions.set(id,{status:'complete',customer,metadata,subscription:'sub_late'});subs.set('sub_late',{status:'active',customer,metadata});throw Error('Checkout completed concurrently');}sessions.get(id).status='expired';}}},subscriptions:{retrieve:async id=>structuredClone(subs.get(id)),cancel:async(id,options)=>{assert.deepEqual(options,{prorate:false,invoice_now:false});canceled.push(id);subs.get(id).status='canceled';}}};
 const state={stripeCustomerId:customer,projects:{[project]:{id:project,subscriptionId:'sub_initial',checkoutSessionId:'cs_open',workspaceCheckoutSessionId:'cs_race'}}};
 await settleAccountBilling(stripe,identity,state);assert.deepEqual(canceled.sort(),['sub_initial','sub_late']);assert.equal(sessions.get('cs_open').status,'expired');await settleAccountBilling(stripe,identity,state);assert.equal(canceled.length,2,'retry must not cancel the same already-canceled subscription twice');
 await assert.rejects(settleAccountBilling(null,identity,state),e=>e.code==='billing_unavailable');
 subs.set('sub_foreign',{status:'active',customer,metadata:{...metadata,redxOwner:bob}});const foreign={stripeCustomerId:customer,projects:{[project]:{id:project,subscriptionId:'sub_foreign'}}};
 await assert.rejects(settleAccountBilling(stripe,identity,foreign),e=>e.code==='billing_review_required');assert.equal(subs.get('sub_foreign').status,'active');
 subs.set('sub_no_confirmation',{status:'active',customer,metadata});stripe.subscriptions.cancel=async()=>{};
 await assert.rejects(settleAccountBilling(stripe,identity,{stripeCustomerId:customer,projects:{[project]:{id:project,subscriptionId:'sub_no_confirmation'}}}),e=>e.code==='billing_unavailable');
 subs.set('sub_expired',{status:'incomplete_expired',customer,metadata});await settleAccountBilling(stripe,identity,{stripeCustomerId:customer,projects:{[project]:{id:project,subscriptionId:'sub_expired'}}});
 sessions.set('cs_missing_subscription',{status:'complete',mode:'subscription',customer,metadata});await assert.rejects(settleAccountBilling(stripe,identity,{stripeCustomerId:customer,projects:{[project]:{id:project,checkoutSessionId:'cs_missing_subscription'}}}),e=>e.code==='billing_unavailable');
});
test('a stalled anonymous pairing body holds no account deletion lease',async t=>{
 const f=await fixture(t);const pending=http.request(f.receiverURL+'/provider/v1/connect/redeem',{method:'POST',headers:{'content-type':'application/json'}});pending.on('error',()=>{});pending.write('{"grant":');
 try{assert.equal((await f.begin()).status,202);}finally{pending.destroy();}
});
test('public grant redemption holds only its verified owner lease until key issuance finishes',async t=>{
 for(const who of ['alice','bob']){
  const f=await fixture(t),grant=(await f.call(f.receiverURL,'/provider/v1/connect/grants','POST',{service:'quick-launcher',workspaceId:who==='alice'?wid:bobWid,scopes:['files:read'],name:'lease fixture'},who)).body.grant;
  let unlock,started;const gate=new Promise(r=>unlock=r),entered=new Promise(r=>started=r),call=f.ledger.call.bind(f.ledger);let held=false;
  f.ledger.call=async(method,route,value)=>{
   if(!held&&value?.params?.state){const record=JSON.parse(value.params.state);if(record.kind==='grant'&&record.data.grant?.usedAtMs){held=true;started();await gate;}}
   return call(method,route,value);
  };
  const redeem=fetch(f.receiverURL+'/provider/v1/connect/redeem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant}),signal:AbortSignal.timeout(5000)});
  try{
   await bounded(entered);const deletion=await f.begin();assert.equal(deletion.status,who==='alice'?409:202,who);if(who==='alice')assert.equal(deletion.body.error,'account_deletion_busy');
  }finally{unlock();}
  const response=await redeem;assert.equal(response.status,201,who);await response.json();
  if(who==='alice')assert.equal((await f.begin()).status,202);
 }
});
test('unsafe storage ancestor is refused before account billing/barrier and never follows an outside symlink',async t=>{
 const f=await fixture(t),outside=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'gd-deletion-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
 await fs.mkdir(path.join(outside,wid));const sentinel=path.join(outside,wid,'keep.fixture');await fs.writeFile(sentinel,'DO NOT DELETE EXTERNAL ORIGINAL');
 await fs.symlink(outside,path.join(f.root,alice),'dir');
 const r=await f.begin();assert.equal(r.status,503);assert.equal((await f.ledger.get(alice)).accountDeletion,undefined);assert.equal(await fs.readFile(sentinel,'utf8'),'DO NOT DELETE EXTERNAL ORIGINAL');
 // Even an independently signed per-workspace deletion cannot follow it.
 const crypto=require('node:crypto'),stamp=String(Date.now()),proof=crypto.createHmac('sha256',key).update(alice+'/'+wid+'/'+stamp).digest('hex');
 const response=await f.call(f.receiverURL,`/v1/receivers/me/workspaces/${wid}`,'DELETE',undefined,'alice',{'x-confirm-workspace':wid,'x-control-delete':proof,'x-control-delete-time':stamp});
 assert.equal(response.status,503);assert.equal(await fs.readFile(sentinel,'utf8'),'DO NOT DELETE EXTERNAL ORIGINAL');
});
test('a profile-only account can be deleted without creating a Control account or touching its peer host',async t=>{
 const f=await fixture(t);f.ledger.accounts.delete(alice);
 const records=new DevTeamRecords(f.ledger);await records.write('profile:'+alice,{username:'ProfileOnly'},{scope:alice,kind:'profile'});await records.write('username:profileonly',{account:alice},{scope:digest('profileonly'),kind:'username'});
 const beforeBob=await f.ledger.get(bob);const r=await f.begin();assert.equal(r.status,202);await f.control.accountDeletion.process(f.identity);
 const status=await f.call(f.controlURL,'/v2/account/deletion');assert.equal(status.body.deletion.status,'completed');assert.equal(await records.get('profile:'+alice),null);assert.equal(await records.get('username:profileonly'),null);assert.deepEqual(await f.ledger.get(bob),beforeBob);assert.equal((await f.ledger.get(alice)).control,undefined);
 await assert.rejects(f.controlStore.ensure(alice,{}),e=>e.code==='account_deleted');await assert.rejects(f.controlStore.change(alice,()=>{}),e=>e.code==='account_deleted');
});
test('a bounded worker yields durably between metadata pages and only final verified completion permits cleanup',async()=>{
 const ledger=new Ledger();await ledger.ensure(alice,1);await ledger.change(alice,s=>{s.accountDeletion=initialJob({id:'c'.repeat(32),keyHash:digest(idem),requestedAtMs:Date.now()});});
 let pages=0,finish=0;
 const receiver=async(identity,action)=>{
  assert.equal(identity.owner,alice);
  if(action==='metadata'){pages++;return {done:pages===3};}
  assert.equal(action,'finish');finish++;await ledger.change(alice,s=>{s.accountDeletion.status='completed';s.accountDeletion.phase='complete';s.accountDeletion.completedAtMs=Date.now();});return {};
 };
 const deletion=createAccountDeletion({store:ledger,receiver,settleBilling:async()=>{},removeWorkspace:async()=>assert.fail('No workspace exists'),pageBudget:1,autoRun:false});
 for(let n=0;n<2;n++){await deletion.process({owner:alice});const r=await deletion.status({owner:alice});assert.equal(r.deletion.status,'queued');assert.equal(r.deletion.phase,'metadata');assert.equal(r.deletion.cloudDataDeleted,false);assert.equal(finish,0);}
 await deletion.process({owner:alice});assert.equal((await deletion.status({owner:alice})).deletion.status,'completed');assert.equal(finish,1);
});
test('exact State CAS preserves a username re-claimed by another account after a concurrent removal',async()=>{
 const ledger=new Ledger(),records=new DevTeamRecords(ledger),logical='username:reclaimable',meta={scope:digest('reclaimable'),kind:'username'};
 const old=await records.write(logical,{account:alice},meta);await records.remove(old);
 const replacement=await records.write(logical,{account:bob},meta);assert.equal(replacement.revision,old.revision,'this is the revision-reset ABA case');
 await assert.rejects(records.remove(old),e=>e.code==='concurrent_update');assert.equal((await records.get(logical)).value.account,bob);
});
test('unavailable billing leaves an honest failed receipt and retains cloud bytes before any workspace deletion',async t=>{
 const f=await fixture(t),directory=path.join(f.root,alice,wid);await fs.mkdir(directory,{recursive:true});const payload=path.join(directory,'retained.fixture');await fs.writeFile(payload,'KEEP UNTIL BILLING IS VERIFIED');
 await f.ledger.change(alice,s=>{s.control.stripeCustomerId='cus_pending_fixture';s.control.projects[wid].subscriptionId='sub_pending_fixture';});
 const r=await f.begin();assert.equal(r.status,202);await f.control.accountDeletion.process(f.identity);
 const result=await f.call(f.controlURL,'/v2/account/deletion');assert.equal(result.body.deletion.id,r.body.deletion.id);assert.equal(result.body.deletion.status,'failed');assert.equal(result.body.deletion.phase,'billing');assert.equal(result.body.deletion.cloudDataDeleted,false);assert.equal(await fs.readFile(payload,'utf8'),'KEEP UNTIL BILLING IS VERIFIED');assert.ok((await f.ledger.get(alice)).workspaces[wid]);
});
