'use strict';
// Disposable historical Receiver proof. Never contacts a live service, sends
// a signal, changes host networking or reads account credentials/user data.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),syncFS=require('node:fs');
const path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const net=require('node:net'),inspector=require('node:inspector'),Module=require('node:module');
const {execFileSync}=require('node:child_process'),{setTimeout:delay}=require('node:timers/promises');
const {AdmissionGate}=require('./adapter/server-admission-gates-36.cjs');
assert.equal(process.version,'v20.20.2','Require the exact live Node runtime');
const REPO=path.resolve(__dirname,'../../..'),COMMIT='98eb1020d0a16340675a38cb99a8b5667b73b4d6';
const HASHES={
 'server.cjs':'9ae4ac7e6590adefa21980069048501c4c2e4de10e0e0eabc24c662de50ef5a6',
 'redx-state.cjs':'6c1fa216357077bf6d9e4b1cb811a1e6c27271f25eb523b823d20f12bbce98d4',
 'library-tree.cjs':'90fa3b8f2b6eb2d2b9cf9e13f3ce0832a7ba4965c70a8cf6c1c8a7f1e3ba0507',
};
const bytes={};
for(const [name,sha] of Object.entries(HASHES)){
 bytes[name]=execFileSync('git',['-C',REPO,'show',COMMIT+':native/RedXCloud/'+name],{encoding:'utf8',maxBuffer:1024*1024});
 assert.equal(crypto.createHash('sha256').update(bytes[name]).digest('hex'),sha,'Historical source drift');
}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};}
async function waitUntil(predicate,timeout=10000){const deadline=Date.now()+timeout;while(!await predicate()){assert(Date.now()<deadline,'Disposable fixture condition timed out');await delay(15);}}
function owner(subject){return crypto.createHash('sha256').update(JSON.stringify(['red-xai-receiver/v1','https://receiver-fixture.invalid',subject])).digest('hex');}
async function exists(file){try{await fs.lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function raw(port,subject,method='GET',route='/v1/receivers/me',body=null){
 const socket=net.createConnection({host:'127.0.0.1',port});socket.on('error',()=>{});socket.on('data',()=>{});
 socket.once('connect',()=>{
  const headers=[method+' '+route+' HTTP/1.1','Host: 127.0.0.1:'+port,'Authorization: Bearer rxca_'+subject.padEnd(43,'x'),'Connection: keep-alive'];
  if(body)headers.push('Content-Type: image/png','Content-Length: '+body.length,'X-Content-Sha256: '+crypto.createHash('sha256').update(body).digest('hex'));
  socket.write(headers.join('\r\n')+'\r\n\r\n');if(body)socket.write(body);
 });return socket;
}
async function main(){
 const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gd-receiver35-proof-')));await fs.chmod(temporary,0o700);
 const root=path.join(temporary,'storage'),release=path.join(temporary,'release-decoders'),marker=path.join(temporary,'decoders');
 await fs.mkdir(marker,{mode:0o700});
 // A real owned Node child holds the decoder slot. It is a deterministic
 // stand-in, not the production PNG codec; no cryptography claim is made.
 const decoderScript=`'use strict';const fs=require('node:fs'),path=require('node:path');const base=__dirname,input=process.argv[2];if(!input.startsWith(path.join(base,'storage')+path.sep))process.exit(9);const id=path.basename(input).split('.')[1];fs.writeFileSync(path.join(base,'decoders',id+'.started'),JSON.stringify({pid:process.pid}));const timer=setInterval(()=>{if(!fs.existsSync(path.join(base,'release-decoders')))return;clearInterval(timer);fs.readFileSync(input);fs.writeFileSync(path.join(base,'decoders',id+'.finished'),'finished');process.stdout.write(JSON.stringify({format:'redsecretsxai-png-v1'}));},15);`;
 await fs.writeFile(path.join(temporary,'png-carrier.py'),decoderScript,{mode:0o600});
 const loaded={};
 for(const name of ['redx-state.cjs','library-tree.cjs','server.cjs']){
  const filename=path.join(temporary,name),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.join(REPO,'native/RedXCloud'));
  m.require=function(request){
   if(request==='./redx-state.cjs')return loaded['redx-state.cjs'];
   if(request==='./library-tree.cjs')return loaded['library-tree.cjs'];
   if(request==='../Backend/accounts/oidc')return {createOidcVerifier(){throw Error('The disposable fixture permits site-session auth only');}};
   return Module.prototype.require.call(this,request);
  };m._compile(bytes[name],filename);loaded[name]=m.exports;
 }
 const note='a'.repeat(32),states=new Map(),holds=new Map([['held',deferred()],['pipeline',deferred()]]),entered=new Set(),identitySeen=new Set(),lateIdentity=deferred();
 let storeWrites=0;
 for(const subject of ['held','pipeline','payload','late'])states.set(owner(subject),{schema:2,id:owner(subject),owner:owner(subject),revision:0,quota:1024*1024,used:0,objects:{},reservations:{},deletions:{},library:{},workspaces:{[note]:{id:note,name:'Disposable fixture',usedBytes:0}}});
 const store={
  async get(id){for(const subject of ['held','pipeline'])if(id===owner(subject)&&!entered.has(subject)){entered.add(subject);await holds.get(subject).promise;}assert(states.has(id));return structuredClone(states.get(id));},
  async change(id,update){assert(states.has(id));const next=structuredClone(states.get(id));update(next);next.revision++;states.set(id,next);storeWrites++;return structuredClone(next);},
  async ensure(){throw Error('No account creation is permitted by this fixture');},
 };
 const cloud=await loaded['server.cjs'].createCloud({root,issuer:'https://receiver-fixture.invalid',authProvider:'redx-site-session',store,python:process.execPath,decoderConcurrency:1,fetchImpl:async(url,options)=>{
  assert.equal(url,'https://receiver-fixture.invalid/redxai-connect/userinfo');assert.equal(options.redirect,'error');
  const subject=options.headers.authorization.slice(12).replace(/x+$/,'');identitySeen.add(subject);if(subject==='late')await lateIdentity.promise;
  return new Response(JSON.stringify({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',sub:subject,email:'fixture@example.test',email_verified:true}),{status:200});
 }});
 const port=Number(new URL(await cloud.listen(0)).port),lock=path.join(root,'.writer-lock');
 const session=new inspector.Session();session.connect();
 const post=(method,params)=>new Promise((resolve,reject)=>session.post(method,params,(error,result)=>error?reject(error):resolve(result)));
 const gate=new AdmissionGate(post,{role:'receiver',source:bytes['server.cjs'],port,pid:process.pid});
 const sockets=[];let released=false,finished=false;
 try{
  await gate.locate(); // Captured scopes must stay live as counters later change.
  sockets.push(raw(port,'held'));await waitUntil(()=>entered.has('held'));sockets[0].destroy();
  sockets.push(raw(port,'late'));await waitUntil(()=>identitySeen.has('late'));sockets[1].destroy();
  const payload=Buffer.from('Disposable generated carrier bytes; no user file or key.'),ids=['b'.repeat(32),'c'.repeat(32)];
  for(const id of ids)sockets.push(raw(port,'payload','PUT','/v1/receivers/me/workspaces/'+note+'/blobs/'+id,payload));
  await waitUntil(async()=>{const values=await fs.readdir(marker);return values.some(n=>n.endsWith('.started'));});
  sockets.push(raw(port,'pipeline'));await waitUntil(()=>entered.has('pipeline'));
  let initial=await gate.install();
  await waitUntil(async()=>{initial=await gate.status();return initial.decoderWaiters===1;});
  assert(initial.requests>=5,JSON.stringify(initial));assert.equal(initial.decoders,1);assert.equal(initial.decoderWaiters,1);assert(initial.busy>0&&initial.workspaceOperations>0&&initial.transfers>0);assert.equal(initial.ready,false);
  assert(await exists(lock),'Underlying HTTP close must retain the original writer lock');
  await assert.rejects(gate.releaseFixtureHold(),'The fixture hold cannot be released while admitted work remains');
  const pipeline=sockets.at(-1);
  pipeline.write('GET /v1/receivers/me HTTP/1.1\r\nHost: 127.0.0.1:'+port+'\r\nAuthorization: Bearer rxca_'+('forbidden'.padEnd(43,'x'))+'\r\nConnection: keep-alive\r\n\r\n');
  for(const socket of sockets.slice(2,-1))socket.destroy();
  await delay(60);assert(!identitySeen.has('forbidden'),'Post-fence pipelined request reached the original handler');
  lateIdentity.resolve();holds.get('pipeline').resolve();
  await fs.writeFile(release,'release only the two generated decoder fixtures',{mode:0o600});released=true;
  await waitUntil(async()=>{const state=await gate.status();return state.decoders===0&&state.decoderWaiters===0&&state.busy===0&&state.workspaceOperations===0&&state.transfers===0;});
  const waiting=await gate.status();assert.equal(waiting.requests,1,'Disconnected fake-store callback must remain counted');assert.equal(waiting.ready,false);assert(await exists(lock));
  for(const id of ids){assert(await exists(path.join(marker,id+'.finished')),'Each real queued decoder child must finish normally');const file=path.join(root,owner('payload'),note,id+'.png');assert.deepEqual(await fs.readFile(file),payload);}
  const committedState=structuredClone(states.get(owner('payload')));assert.equal(committedState.used,payload.length*2);assert.deepEqual(committedState.reservations,{});
  holds.get('held').resolve();pipeline.destroy();
  let final;await waitUntil(async()=>{final=await gate.status();return final.ready;});
  assert.equal(final.requests,0);assert.equal(final.closed,true);assert(final.rejected>=1);assert.equal(final.pendingRejected,0);assert(await exists(lock),'Counter drainage itself must not remove the writer lock');
  const snapshotWrites=storeWrites,snapshotLedger=JSON.stringify([...states]),snapshotFiles=new Map();
  for(const id of ids)for(const extension of ['.png','.json']){
   const file=path.join(root,owner('payload'),note,id+extension);snapshotFiles.set(file,await fs.readFile(file));
  }
  await gate.releaseFixtureHold();await cloud.close();finished=true;
  assert(!await exists(lock),'Only the original graceful close removes its writer lock');assert.equal(storeWrites,snapshotWrites,'Closing must not change the retained ledger');assert.deepEqual(states.get(owner('payload')),committedState);assert.equal(JSON.stringify([...states]),snapshotLedger);
  for(const [file,body] of snapshotFiles)assert.deepEqual(await fs.readFile(file),body,'Graceful close changed a retained PNG or sidecar');
  console.log(JSON.stringify({localDisposableOnly:true,node:process.version,platform:process.platform,sourceCommit:COMMIT,sourceHashes:HASHES,sourceBytesUnmodified:true,fakeStoreAndIdentity:true,fakeCodecRealChildProcesses:true,actualLibraryAdmissionGate:true,scopeCapturedBeforeRequests:true,disconnectedPreIdentityAndStoreCallbacksCounted:true,queuedDecoderWaiterBlockedReadiness:true,postFencePipelineRefusedBeforeIdentity:true,twoGeneratedUploadsCompletedWithoutCancellation:true,decoderChildSignalsSent:0,writerLockRetainedThroughActualCounterDrain:true,originalGracefulCloseRemovedOnlyOwnLock:true,retainedLedgerAndPayloadsUnchangedByClose:true,actualSigtermMainEntrypointTested:false,liveOperations:0,final},null,2));
 }finally{
  lateIdentity.resolve();for(const hold of holds.values())hold.resolve();if(!released)await fs.writeFile(release,'release fixture cleanup',{mode:0o600});for(const socket of sockets)socket.destroy();
  if(!finished){try{await waitUntil(async()=>{const s=await gate.status();return s.ready;});await gate.releaseFixtureHold();await cloud.close();finished=true;}catch{}}
  session.disconnect();if(finished)await fs.rm(temporary,{recursive:true});
 }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
