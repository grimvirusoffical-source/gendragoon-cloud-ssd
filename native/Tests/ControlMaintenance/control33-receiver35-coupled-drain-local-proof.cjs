'use strict';
// Owned, disposable HTTP/inspector processes only. Historical bytes compile in
// memory; identity, Stripe, ledgers, carriers and storage are generated fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const crypto=require('node:crypto'),http=require('node:http'),net=require('node:net'),Module=require('node:module');
const {execFileSync,fork}=require('node:child_process'),{setTimeout:delay}=require('node:timers/promises');
const {connectInspector}=require('./adapter/server-inspector-client-36.cjs');
assert.equal(process.version,'v20.20.2','Require the exact live Node runtime');
const REPO=path.resolve(__dirname,'../../..'),ISSUER='https://coupled-fixture.invalid',NONCE='e'.repeat(32),WORKSPACE='a'.repeat(32),RETAINED='b'.repeat(32);
const CONTROL_COMMIT='f01e25b63ea87b2d0d0892bfd910683e2d94ff84',RECEIVER_COMMIT='98eb1020d0a16340675a38cb99a8b5667b73b4d6';
const HASHES=Object.freeze({
 'control-server.cjs':'176ebea80c72bb6ae73017d58829fdde50489164a1a26319fb49699424e391d2',
 'server.cjs':'9ae4ac7e6590adefa21980069048501c4c2e4de10e0e0eabc24c662de50ef5a6',
 'control-state.cjs':'92f187276d2c026e90fb7749abad07e1409196bce3b6ad5b26f9856c7dea133f',
 'redx-state.cjs':'6c1fa216357077bf6d9e4b1cb811a1e6c27271f25eb523b823d20f12bbce98d4',
 'library-tree.cjs':'90fa3b8f2b6eb2d2b9cf9e13f3ce0832a7ba4965c70a8cf6c1c8a7f1e3ba0507',
 'catalog.js':'115df0f9ab99705b5c9baf488f67ff8d26ef843016b0fde096c860ce102bfabe',
 'stripe_live_catalog.json':'c519a50d43baf1c51b2643a0d8c1161c3bdb5616eca368a920f9f38857c81c7f',
});
const source={};
for(const [name,hash] of Object.entries(HASHES)){
 const backend=['catalog.js','stripe_live_catalog.json'].includes(name),commit=['server.cjs','library-tree.cjs'].includes(name)?RECEIVER_COMMIT:CONTROL_COMMIT;
 source[name]=execFileSync('git',['-C',REPO,'show',commit+':native/'+(backend?'Backend/':'RedXCloud/')+name],{encoding:'utf8',maxBuffer:1024*1024});
 assert.equal(crypto.createHash('sha256').update(source[name]).digest('hex'),hash,'Historical source drift');
}
const owner=subject=>crypto.createHash('sha256').update(JSON.stringify(['red-xai-receiver/v1',ISSUER,subject])).digest('hex');
const bearer=subject=>'Bearer rxca_'+subject.padEnd(43,'x');
const subjectOf=header=>String(header).slice(12).replace(/x+$/,'');
const deleteKey='Disposable local HMAC material; never a credential.';
const proof=(subject,id=WORKSPACE)=>{const stamp=String(Date.now());return {authorization:bearer(subject),'x-confirm-workspace':id,'x-control-delete-time':stamp,'x-control-delete':crypto.createHmac('sha256',deleteKey).update(owner(subject)+'/'+id+'/'+stamp).digest('hex')};};
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};}
async function until(predicate,timeout=12000){const deadline=Date.now()+timeout;while(!await predicate()){assert(Date.now()<deadline,'Coupled fixture condition timed out');await delay(10);}}
async function listen(server){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return server.address().port;}
async function exists(file){try{await fs.lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function compile(name,temporary,loaded){
 if(name.endsWith('.json'))return JSON.parse(source[name]);
 const filename=path.join(temporary,name),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.join(REPO,'native/RedXCloud'));
 m.require=function(request){
  const aliases={'./control-state.cjs':'control-state.cjs','./redx-state.cjs':'redx-state.cjs','./library-tree.cjs':'library-tree.cjs','../Backend/catalog.js':'catalog.js','../Backend/stripe_live_catalog.json':'stripe_live_catalog.json'};
  if(Object.hasOwn(aliases,request)){assert(Object.hasOwn(loaded,aliases[request]));return loaded[aliases[request]];}
  if(request==='../Backend/accounts/oidc')return {createOidcVerifier(){throw Error('The fixture permits site-session identity only');}};
  return Module.prototype.require.call(this,request);
 };m._compile(source[name],filename);return m.exports;
}
async function ownedChild(){
 const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gd-coupled-drain-')));await fs.chmod(temporary,0o700);
 const loaded={};for(const name of ['redx-state.cjs','control-state.cjs','library-tree.cjs','catalog.js','stripe_live_catalog.json','control-server.cjs','server.cjs'])loaded[name]=compile(name,temporary,loaded);
 const preIdentity=deferred(),stripeHold=deferred(),dependencyIdentity=deferred(),dependencyStore=deferred();
 const events=[],identityCounts=new Map(),receiverReads=new Map(),receiverStates=new Map(),controlStates=new Map();
 let controlPort,receiverPort,stripeRetrieve=0,stripeCancel=0,receiverWrites=0,controlWrites=0,dependencyStoreEntered=0;
 const emit=event=>{events.push(event);if(process.connected)process.send({event});};
 const root=path.join(temporary,'storage'),lock=path.join(root,'.writer-lock');
 const emptyState=subject=>({schema:2,id:owner(subject),owner:owner(subject),revision:0,quota:1024*1024,used:0,objects:{},reservations:{},deletions:{},library:{},workspaces:{}});
 for(const subject of ['pre','deleter','queued'])receiverStates.set(owner(subject),emptyState(subject));
 const retainedBytes=Buffer.from('Generated retained carrier; no user data.'),retainedSidecar=Buffer.from('{"fixture":"retained"}');
 for(const subject of ['deleter','queued'])receiverStates.get(owner(subject)).workspaces[WORKSPACE]={id:WORKSPACE,name:'Disposable delete',usedBytes:0};
 const retainedState=receiverStates.get(owner('deleter'));retainedState.used=retainedBytes.length;retainedState.workspaces[RETAINED]={id:RETAINED,name:'Retained fixture',usedBytes:retainedBytes.length};
 const retainedLedger=structuredClone(retainedState.workspaces[RETAINED]);
 const receiverStore={
  async get(id){assert(receiverStates.has(id),'Unreviewed Receiver owner');receiverReads.set(id,(receiverReads.get(id)||0)+1);if(id!==owner('pre')){dependencyStoreEntered++;emit('dependency-store-entered');await dependencyStore.promise;}return structuredClone(receiverStates.get(id));},
  async change(id,update){assert(receiverStates.has(id));const value=structuredClone(receiverStates.get(id));update(value);value.revision++;receiverStates.set(id,value);receiverWrites++;return structuredClone(value);},
  async ensure(){throw Error('The fixture forbids new Receiver accounts');},
 };
 const identity=http.createServer(async(req,res)=>{
  const subject=subjectOf(req.headers.authorization);assert(['pre','deleter','queued','wrong'].includes(subject));
  const lane=req.url==='/receiver'?'receiver':'control',key=lane+':'+subject;identityCounts.set(key,(identityCounts.get(key)||0)+1);emit('identity-'+lane+'-'+subject);
  if(lane==='receiver'&&subject==='pre')await preIdentity.promise;
  if(lane==='receiver'&&subject==='deleter')await dependencyIdentity.promise;
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',sub:subject,email:'fixture@example.test',email_verified:true}));
 });
 const identityPort=await listen(identity);
 const receiver=await loaded['server.cjs'].createCloud({root,issuer:ISSUER,authProvider:'redx-site-session',store:receiverStore,workspaceDeleteKey:deleteKey,entitlementURL:'https://entitlements-fixture.invalid/v2/receiver-entitlements',fetchImpl:async(url,options)=>{
  assert.equal(options.redirect,'error');
  if(url===ISSUER+'/redxai-connect/userinfo')return fetch('http://127.0.0.1:'+identityPort+'/receiver',options);
  assert.equal(url,'https://entitlements-fixture.invalid/v2/receiver-entitlements');assert(Number.isInteger(controlPort));emit('real-control-entitlement-start');const response=await fetch('http://127.0.0.1:'+controlPort+'/v2/receiver-entitlements',options);assert.equal(response.status,200);emit('real-control-entitlement-complete');return response;
 }});
 const originalReceiverHandler=receiver.server.listeners('request')[0];
 receiverPort=Number(new URL(await receiver.listen(0)).port);
 const retainedDir=path.join(root,owner('deleter'),RETAINED);await fs.mkdir(retainedDir,{recursive:true,mode:0o700});
 const files=new Map([[path.join(retainedDir,'generated.png'),retainedBytes],[path.join(retainedDir,'generated.json'),retainedSidecar]]);for(const [file,bytes] of files)await fs.writeFile(file,bytes,{mode:0o600});
 const {STORAGE,PERFORMANCE}=loaded['catalog.js'],catalog=loaded['stripe_live_catalog.json'],tier=Object.keys(STORAGE)[0],priceId=catalog.priceIds['storage|standard|'+tier+'|month'];
 const prices=new Map();for(const term of ['month','year']){const factor=term==='year'?10:1;for(const [name,value] of Object.entries(STORAGE))prices.set(catalog.priceIds['storage|standard|'+name+'|'+term],{active:true,livemode:true,currency:'usd',unit_amount:value.standard*factor,recurring:{interval:term,interval_count:1}});for(const [name,value] of Object.entries(PERFORMANCE))prices.set(catalog.priceIds['performance|'+name+'|'+term],{active:true,livemode:true,currency:'usd',unit_amount:value.cents*factor,recurring:{interval:term,interval_count:1}});}prices.set(catalog.priceIds['one_time|remove_ads'],{active:true,livemode:true,currency:'usd',unit_amount:499});
 const project={id:WORKSPACE,name:'Disposable delete',createdMs:1,owner:false,feeWaived:true,storageTier:tier,performanceTier:'free',interval:'month',subscriptionId:'sub_fixture',active:true,readOnly:false,status:'active',quotaBytes:STORAGE[tier].gb*1e9,workers:1};
 controlStates.set(owner('pre'),{policyVersion:3,ownerBenefits:false,projects:{}});controlStates.set(owner('deleter'),{policyVersion:3,ownerBenefits:false,stripeCustomerId:'cus_fixture',projects:{[WORKSPACE]:project}});
 const controlStore={async get(id){assert(controlStates.has(id));return structuredClone(controlStates.get(id));},async change(id,update){assert(controlStates.has(id));const value=structuredClone(controlStates.get(id));update(value);controlStates.set(id,value);controlWrites++;return structuredClone(value);},async ensure(){throw Error('The fixture forbids new Control accounts');}};
 const stripe={prices:{async retrieve(id){assert(prices.has(id));return structuredClone(prices.get(id));}},subscriptions:{async retrieve(id){assert.equal(id,'sub_fixture');stripeRetrieve++;if(stripeRetrieve===2){emit('stripe-delete-held');await stripeHold.promise;}return {id,status:'active',customer:'cus_fixture',metadata:{service:'GenDragoonSSD',kind:'workspace_plans',redxOwner:owner('deleter'),projectId:WORKSPACE},items:{has_more:false,data:[{id:'si_fixture',quantity:1,price:{id:priceId}}]}};},async cancel(id){assert.equal(id,'sub_fixture');stripeCancel++;emit('fake-stripe-cancel');return {id,status:'canceled'};}}};
 const control=await loaded['control-server.cjs'].createControl({issuer:ISSUER,store:controlStore,receiverStore,stripe,redxKey:deleteKey,receiverLocal:'http://127.0.0.1:'+receiverPort,fetchImpl:(url,options)=>{assert.equal(url,ISSUER+'/redxai-connect/userinfo');assert.equal(options.redirect,'error');return fetch('http://127.0.0.1:'+identityPort+'/control',options);}});
 controlPort=Number(new URL(await control.listen(0)).port);
 const snapshot=async()=>({
  events:[...events],identityPre:identityCounts.get('receiver:pre')||0,identityDependency:identityCounts.get('receiver:deleter')||0,identityQueued:identityCounts.get('receiver:queued')||0,
  targetStoreReads:receiverReads.get(owner('deleter'))||0,queuedStoreReads:receiverReads.get(owner('queued'))||0,dependencyStoreEntered,stripeRetrieve,stripeCancel,receiverWrites,controlWrites,
  controlProjectDeleted:!controlStates.get(owner('deleter')).projects[WORKSPACE],receiverProjectDeleted:Boolean(receiverStates.get(owner('deleter')).deletedWorkspaces?.[WORKSPACE]),queuedProjectDeleted:Boolean(receiverStates.get(owner('queued')).deletedWorkspaces?.[WORKSPACE]),writerLockPresent:await exists(lock),receiverOriginalListenerUntouched:receiver.server.listeners('request').length===1&&receiver.server.listeners('request')[0]===originalReceiverHandler,
 });
 process.on('message',async message=>{try{
  let value=true;if(message.command==='release-pre')preIdentity.resolve();else if(message.command==='release-stripe')stripeHold.resolve();else if(message.command==='release-auth')dependencyIdentity.resolve();else if(message.command==='release-store')dependencyStore.resolve();else if(message.command==='snapshot')value=await snapshot();else if(message.command==='finish'){
   assert(await exists(lock),'Writer lock must survive actual drain');assert(!controlStates.get(owner('deleter')).projects[WORKSPACE]);assert(receiverStates.get(owner('deleter')).deletedWorkspaces[WORKSPACE]);assert(receiverStates.get(owner('queued')).deletedWorkspaces[WORKSPACE]);assert.equal(stripeCancel,1);
   assert.deepEqual(receiverStates.get(owner('deleter')).workspaces[RETAINED],retainedLedger);assert.equal(receiverStates.get(owner('deleter')).used,retainedBytes.length);for(const [file,bytes] of files)assert.deepEqual(await fs.readFile(file),bytes);
   const ledgerBefore=JSON.stringify([...receiverStates]),controlBefore=JSON.stringify([...controlStates]),writes=[receiverWrites,controlWrites];await receiver.close();await control.close();assert(!await exists(lock),'Only original graceful close may remove its lock');await new Promise(resolve=>identity.close(resolve));
   assert.equal(JSON.stringify([...receiverStates]),ledgerBefore);assert.equal(JSON.stringify([...controlStates]),controlBefore);assert.deepEqual([receiverWrites,controlWrites],writes);for(const [file,bytes] of files)assert.deepEqual(await fs.readFile(file),bytes);
   value={originalGracefulCloseRemovedOnlyOwnLock:true,retainedLedgerAndCarrierSidecarsUnchanged:true};await fs.rm(temporary,{recursive:true});
  }else if(message.command==='cleanup'){
   preIdentity.resolve();stripeHold.resolve();dependencyIdentity.resolve();dependencyStore.resolve();
  }else if(message.command==='cleanup-finish'){
   await receiver.close();await control.close();await new Promise(resolve=>identity.close(resolve));require('node:inspector').close();await fs.rm(temporary,{recursive:true});
  }else throw Error('Unknown fixture command');
  process.send({id:message.id,value});if(['finish','cleanup-finish'].includes(message.command))process.disconnect();
 }catch{if(process.connected)process.send({id:message.id,error:'owned_fixture_command_failed'});process.exitCode=1;}});
 if(process.argv.includes('--marker-collision'))Object.defineProperty(process,'__gendragoon36ReceiverAdmission',{value:Object.freeze({fixtureMarkerCollision:true}),configurable:false,writable:false});
 process.send({event:'ready',controlPort,receiverPort,inspectorPort:Number(new URL(require('node:inspector').url()).port)});
}
function request(port,{method='GET',route='/v1/receivers/me',headers={},body=null}={}){
 const pending=new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:route,method,agent:false,headers:{...headers,host:'127.0.0.1:'+port,'content-length':body?Buffer.byteLength(body):0}},res=>{const parts=[];let count=0;res.on('data',chunk=>{count+=chunk.length;if(count>65536)req.destroy(Error('Fixture response bound'));else parts.push(chunk);});res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(parts).toString()}));});req.setTimeout(25000,()=>req.destroy(Error('Fixture HTTP timeout')));req.on('error',reject);req.end(body);});
 // Attach a rejection observer immediately while the orchestrator waits for
 // counters; the original promise still rejects when its result is awaited.
 pending.catch(()=>{});return pending;
}
function rawDelete(port,headers){const socket=net.createConnection({host:'127.0.0.1',port});socket.on('error',()=>{});socket.on('data',()=>{});const write=()=>socket.write('DELETE /v1/receivers/me/workspaces/'+WORKSPACE+' HTTP/1.1\r\nHost: 127.0.0.1:'+port+'\r\n'+Object.entries(headers).map(([name,value])=>name+': '+value+'\r\n').join('')+'Content-Length: 0\r\nConnection: keep-alive\r\n\r\n');socket.once('connect',write);return {socket,write};}
async function markerRefusalProof(){
 const child=fork(__filename,['--owned-child','--marker-collision'],{execArgv:['--inspect=127.0.0.1:0'],stdio:['ignore','ignore','pipe','ipc']});let ready,reply,cleanup;child.stderr.resume();child.on('message',message=>{if(message.event==='ready')ready=message;if(message.id===1)reply=message;if(message.id===2)cleanup=message;});
 try{await until(()=>ready);await assert.rejects(connectInspector({port:ready.inspectorPort,pid:child.pid,role:'receiver',source:source['server.cjs'],servicePort:ready.receiverPort,operationNonce:NONCE}));child.send({id:1,command:'snapshot'});await until(()=>reply);assert(!reply.error&&reply.value.receiverOriginalListenerUntouched,'An unreviewed persistent marker must be refused before replacing the original listener');}
 finally{if(child.connected){child.send({id:2,command:'cleanup-finish'});await until(()=>cleanup);assert(!cleanup.error);await until(()=>child.exitCode!==null);assert.equal(child.exitCode,0);}}
}
async function parent(){
 await assert.rejects(connectInspector({port:0,pid:process.pid,role:'receiver',source:'unreviewed',servicePort:1,operationNonce:NONCE}),/source mismatch before connecting/);
 await assert.rejects(connectInspector({port:0,pid:process.pid,role:'receiver',source:source['server.cjs'],servicePort:1,operationNonce:'invalid'}),/Receiver operation nonce required/);
 await markerRefusalProof();
 const child=fork(__filename,['--owned-child'],{execArgv:['--inspect=127.0.0.1:0'],stdio:['ignore','ignore','pipe','ipc']});
 const events=[];let ready,next=0,stderrBytes=0;const calls=new Map(),sockets=[],pendingHTTP=[];let receiver,control,finished=false;
 child.stderr.on('data',bytes=>{stderrBytes+=bytes.length;});child.on('message',message=>{if(message.event){events.push(message.event);if(message.event==='ready')ready=message;}else if(calls.has(message.id)){const call=calls.get(message.id);calls.delete(message.id);clearTimeout(call.timer);if(message.error)call.reject(Error(message.error));else call.resolve(message.value);}});
 const command=name=>new Promise((resolve,reject)=>{assert(child.connected);const id=++next,timer=setTimeout(()=>{calls.delete(id);reject(Error('Owned fixture command timed out'));},10000);calls.set(id,{resolve,reject,timer});child.send({id,command:name});});
 const snapshot=()=>command('snapshot');
 try{
  await until(()=>ready);const receiverOptions={port:ready.inspectorPort,pid:child.pid,role:'receiver',source:source['server.cjs'],servicePort:ready.receiverPort,operationNonce:NONCE};
  const pre=request(ready.receiverPort,{headers:{authorization:bearer('pre')}});pendingHTTP.push(pre);await until(()=>events.includes('identity-receiver-pre'));
  const deleting=net.createConnection({host:'127.0.0.1',port:ready.controlPort});sockets.push(deleting);deleting.on('error',()=>{});deleting.on('data',()=>{});deleting.once('connect',()=>{const body=JSON.stringify({confirmName:'Disposable delete'});deleting.write('DELETE /v2/projects/'+WORKSPACE+' HTTP/1.1\r\nHost: 127.0.0.1:'+ready.controlPort+'\r\nAuthorization: '+bearer('deleter')+'\r\nContent-Type: application/json\r\nContent-Length: '+Buffer.byteLength(body)+'\r\nConnection: keep-alive\r\n\r\n'+body);});await until(()=>events.includes('stripe-delete-held'));
  receiver=await connectInspector(receiverOptions);await assert.rejects(receiver.install(),/Receiver requires staged admission/);const initial=await receiver.installStageOne();assert.equal(initial.stage,'dependency-open');assert.equal(initial.ready,false);assert(initial.requests>=1);assert.equal(initial.installationCount,1);await assert.rejects(receiver.installStageOne(),/already installed/);
  await assert.rejects(connectInspector({...receiverOptions,operationNonce:'f'.repeat(32)}));assert.equal((await receiver.status()).installationCount,1,'Wrong operation nonce must not reset the installed gate');
  await command('release-pre');assert.equal((await pre).status,200,'Preexisting Receiver identity must finish through real available Control');await until(async()=>{const state=await receiver.status();return state.earlyReady;});const early=await receiver.status();assert.equal(early.stage,'dependency-open');assert.equal(early.ready,false);assert.equal(early.closed,false);assert(events.includes('real-control-entitlement-complete'));assert.equal((await snapshot()).identityPre,1);
  const route='/v1/receivers/me/workspaces/'+WORKSPACE,base=proof('queued');const forged=[
   {headers:{...base,authorization:bearer('wrong')}},
   {headers:{...base,'x-control-delete':'0'.repeat(64)}},
   {headers:base,route:route+'?forged=1'},
   {headers:{...base,'x-confirm-workspace':RETAINED}},
   {headers:base,body:'nonempty'},
  ];
  for(const attempt of forged){const response=await request(ready.receiverPort,{method:'DELETE',route,...attempt});assert.equal(response.status,503,'Forged dependency must be refused by staged admission');}
  let safe=await snapshot();assert.equal(safe.targetStoreReads,0);assert.equal(safe.queuedStoreReads,0,'Forged dependencies must never enter original store continuation');
  control=await connectInspector({port:ready.inspectorPort,pid:child.pid,role:'control',source:source['control-server.cjs'],servicePort:ready.controlPort});const controlInitial=await control.install();assert.equal(controlInitial.ready,false);assert(controlInitial.accountLocks>=1);deleting.destroy();await delay(30);assert.equal((await control.status()).ready,false,'Natural client disconnect cannot release admitted Control work');
  await command('release-stripe');await until(()=>events.includes('identity-receiver-deleter'));assert.equal((await snapshot()).identityDependency,1);
  let active=await receiver.status();assert.equal(active.authenticatingDependencies,1);assert.equal(active.ready,false);await receiver.disconnect();receiver=await connectInspector(receiverOptions);const resumed=await receiver.status();assert.equal(resumed.sameGateVerified,true);assert.equal(resumed.installationCount,1);assert.equal(resumed.authenticatingDependencies,1,'Detach and reattach must retain the same authentication work');
  await command('release-auth');await until(()=>events.includes('dependency-store-entered'));const baseline=(await snapshot()).identityQueued;
  const pipeline=rawDelete(ready.receiverPort,proof('queued')),aborted=rawDelete(ready.receiverPort,proof('queued'));sockets.push(pipeline.socket,aborted.socket);
  const manual=[];for(let n=0;n<125;n++){const call=request(ready.receiverPort,{method:'DELETE',route,headers:proof('queued')});manual.push(call);pendingHTTP.push(call);}
  await until(async()=>{const state=await receiver.status();return state.activeContinuations===128&&state.activeDependencyWork===128;});
  await until(async()=>{const value=await snapshot();return value.dependencyStoreEntered===128;});
  aborted.socket.destroy();await delay(30);active=await receiver.status();assert.equal(active.activeContinuations,128,'Natural dependency disconnect cannot release original async work');assert.equal(active.ready,false);
  const queued=[];for(let n=0;n<127;n++){const call=request(ready.receiverPort,{method:'DELETE',route,headers:proof('queued')});queued.push(call);pendingHTTP.push(call);}
  const queuedDisconnected=rawDelete(ready.receiverPort,proof('queued'));sockets.push(queuedDisconnected.socket);
  await until(async()=>{const state=await receiver.status();return state.queuedDependencies===128&&state.bodyChecks===0;});
  queuedDisconnected.socket.destroy();await delay(30);assert.equal((await receiver.status()).queuedDependencies,128,'A disconnected pre-seal queued request must retain its completed body check and queue ownership');
  const beforeSeal=await snapshot();assert.equal(beforeSeal.identityDependency,1,'Accepted Control dependency must authenticate exactly once');assert.equal(beforeSeal.identityQueued-baseline,127);
  const overflow=await request(ready.receiverPort,{method:'DELETE',route,headers:proof('queued')});assert.equal(overflow.status,503);assert.deepEqual(JSON.parse(overflow.body),{error:'busy_retry'},'The next dependency beyond 128 waiting jobs must receive the original busy response');assert.equal((await snapshot()).identityQueued,beforeSeal.identityQueued,'Overflow must not authenticate or enter storage');
  const sealed=await receiver.sealReceiver();assert.equal(sealed.stage,'sealed');assert.equal(sealed.ready,false);assert.equal(sealed.queuedDependencies,128);assert.equal(sealed.activeContinuations,128);assert.equal(sealed.installationCount,1);pipeline.write();await delay(30);assert.equal((await snapshot()).identityQueued,beforeSeal.identityQueued,'Final seal must refuse a new pipeline before authentication');assert.equal((await receiver.status()).ready,false);
  await command('release-store');const replies=await Promise.all(manual);assert(replies.every(reply=>[200,409].includes(reply.status)),'Only original deletion outcomes may complete admitted dependencies');const queuedReplies=await Promise.all(queued);assert(queuedReplies.every(reply=>[200,409].includes(reply.status)),'Every connected pre-seal queued dependency must reach its original deletion outcome after seal');pipeline.socket.destroy();
  let receiverFinal,controlFinal;await until(async()=>{receiverFinal=await receiver.status();controlFinal=await control.status();return receiverFinal.ready&&controlFinal.ready;});
  safe=await snapshot();assert.equal(safe.identityDependency,1);assert.equal(safe.identityQueued,beforeSeal.identityQueued+128,'All 128 queued dependencies, including the disconnected one, must authenticate exactly once after capacity returns');assert(safe.controlProjectDeleted&&safe.receiverProjectDeleted&&safe.queuedProjectDeleted);assert(safe.writerLockPresent);assert.equal(safe.stripeCancel,1);assert.equal(receiverFinal.requests,0);assert.equal(receiverFinal.activeContinuations,0);assert.equal(receiverFinal.queuedDependencies,0);assert.equal(receiverFinal.installationCount,1);assert.equal(receiverFinal.sameGateVerified,true);assert.equal(receiverFinal.pendingRejected,0);assert(receiverFinal.rejected>=4,'Path, confirmation, body and post-seal pipeline refusals remain counted');
  await receiver.disconnect();receiver=await connectInspector(receiverOptions);const closedResume=await receiver.status();assert(closedResume.ready&&closedResume.closed&&closedResume.sameGateVerified);assert.equal(closedResume.installationCount,1,'Closed server must resume its original gate');
  await control.releaseFixtureHold();await receiver.releaseFixtureHold();await control.disconnect();control=null;const close=await receiver.close();receiver=null;assert(close.ownedInspectorCloseAcknowledged&&close.clientDisconnected);const preservation=await command('finish');await until(()=>child.exitCode!==null);assert.equal(child.exitCode,0);finished=true;assert(stderrBytes>0,'Actual external inspector transport must execute');
  console.log(JSON.stringify({localDisposableOnly:true,node:process.version,platform:process.platform,controlCommit:CONTROL_COMMIT,receiverCommit:RECEIVER_COMMIT,historicalSourceHashes:HASHES,sourceBytesUnmodified:true,actualOwnedHTTPAndExternalInspector:true,fakeIssuerStripeAndLedgersOnly:true,sourceAndNonceRejectedBeforeConnection:true,unreviewedMarkerRefusedWithOriginalListenerUntouched:true,changedOperationNonceRefusedWithoutGateReset:true,legacyAndDuplicateInstallRefused:true,preIdentityReceiverCompletedThroughAvailableControl:true,controlDeleteReachedReceiverAfterEarlyBarrier:true,actualHistoricalHMACAndDeleteContinuation:true,acceptedDependencyAuthenticatedOnce:true,forgedOwnerHMACPathConfirmationAndBodyDeniedBeforeStore:true,naturalDisconnectRetainedAsyncWork:true,finalSealPreserved128ActiveAnd128QueuedDependencies:true,disconnectedQueuedDependencyCompletedAfterSeal:true,waitingQueueOverflowBusyRetryWithoutAuthentication:true,finalSealRefusedNewPipelineBeforeIdentity:true,sameGateSurvivedInspectorDetachAndReattach:true,sameGateResumedAfterSealedServerClosed:true,installationCount:1,writerLockRetainedThroughActualDrain:true,...preservation,actualSigtermMainEntrypointTested:false,liveOperations:0},null,2));
 }finally{
  if(!finished&&child.connected){await command('cleanup').catch(()=>{});for(const socket of sockets)socket.destroy();await Promise.allSettled(pendingHTTP);try{if(receiver){let status=await receiver.status();if(status.stage==='dependency-open')await receiver.sealReceiver();await until(async()=>{status=await receiver.status();return status.ready;});await receiver.releaseFixtureHold();}if(control){await until(async()=>(await control.status()).ready);await control.releaseFixtureHold();}}catch{} }
  if(control)await control.disconnect().catch(()=>{});if(receiver)await receiver.disconnect().catch(()=>{});for(const socket of sockets)socket.destroy();if(!finished&&child.connected)await command('cleanup-finish').catch(()=>{});for(const call of calls.values())clearTimeout(call.timer);
 }
}
if(process.argv.includes('--owned-child'))ownedChild().catch(()=>{if(process.connected)process.send({event:'owned-child-failed'});process.exitCode=1;});
else parent().catch(error=>{console.error(error.stack);process.exitCode=1;});
