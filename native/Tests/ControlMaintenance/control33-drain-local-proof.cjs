'use strict';
// LOCAL DISPOSABLE PROOF ONLY. No remote target, signal, debugger listener,
// service manager, environment read, credential read or application-data access.
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const http=require('node:http'),net=require('node:net'),inspector=require('node:inspector'),Module=require('node:module');
const {setTimeout:delay}=require('node:timers/promises');
assert.equal(process.version,'v20.20.2','exact live Node version is required');
const REPO=path.resolve(__dirname,'../../..');
const HISTORICAL_COMMIT='f01e25b63ea87b2d0d0892bfd910683e2d94ff84';
const SOURCE=require('node:child_process').execFileSync('git',['-C',REPO,'show',HISTORICAL_COMMIT+':native/RedXCloud/control-server.cjs'],{encoding:'utf8',maxBuffer:1024*1024});
const SOURCE_HASH='176ebea80c72bb6ae73017d58829fdde50489164a1a26319fb49699424e391d2';
assert.equal(crypto.createHash('sha256').update(SOURCE).digest('hex'),SOURCE_HASH);
const serialExpected=SOURCE.match(/ async function serial\(owner,fn\)\{[^\n]+\}/)[0].trim();
const handlerStart=SOURCE.indexOf('async(req,res)=>{'),handlerEnd=SOURCE.indexOf('\n });\n server.requestTimeout=',handlerStart);
assert(handlerStart>0&&handlerEnd>handlerStart);
const handlerExpected=SOURCE.slice(handlerStart,handlerEnd+3);
const identifyStart=SOURCE.indexOf('async function identify(req){'),identifyEnd=SOURCE.indexOf('\n }\n async function seed(',identifyStart);
assert(identifyStart>0&&identifyEnd>identifyStart);
const identifyExpected=SOURCE.slice(identifyStart,identifyEnd+3);
const secureFetchExpected=SOURCE.match(/ const secureFetch=([^\n]+);/)[1];
const fixtureFilename=path.join(REPO,'native/RedXCloud/control33-disposable.cjs');
const historicalDependencyHashes={
 'control-state.cjs':'92f187276d2c026e90fb7749abad07e1409196bce3b6ad5b26f9856c7dea133f',
 'redx-state.cjs':'6c1fa216357077bf6d9e4b1cb811a1e6c27271f25eb523b823d20f12bbce98d4'
};
const historicalModules={};
for(const name of ['redx-state.cjs','control-state.cjs']){
 const bytes=require('node:child_process').execFileSync('git',['-C',REPO,'show',HISTORICAL_COMMIT+':native/RedXCloud/'+name],{encoding:'utf8',maxBuffer:1024*1024});
 assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),historicalDependencyHashes[name],'historical dependency differs from verified live bytes');
 const filename=path.join(REPO,'native/RedXCloud/disposable-'+name),dependency=new Module(filename,module);
 dependency.filename=filename;dependency.paths=Module._nodeModulePaths(path.dirname(filename));
 dependency.require=function(request){if(request==='./redx-state.cjs')return historicalModules['redx-state.cjs'];return Module.prototype.require.call(this,request);};
 dependency._compile(bytes,filename);historicalModules[name]=dependency.exports;
}
const m=new Module(fixtureFilename,module);m.filename=fixtureFilename;m.paths=Module._nodeModulePaths(path.dirname(fixtureFilename));
m.require=function(request){if(request==='./control-state.cjs')return historicalModules['control-state.cjs'];if(request==='./redx-state.cjs')return historicalModules['redx-state.cjs'];return Module.prototype.require.call(this,request);};
m._compile(SOURCE,fixtureFilename);
const {createControl}=m.exports;
const {STORAGE,PERFORMANCE}=require(path.join(REPO,'native/Backend/catalog.js'));
const CATALOG=require(path.join(REPO,'native/Backend/stripe_live_catalog.json'));
const stripePrices=new Map();
for(const term of ['month','year']){
 const factor=term==='year'?10:1;
 for(const [tier,entry] of Object.entries(STORAGE))stripePrices.set(CATALOG.priceIds['storage|standard|'+tier+'|'+term],{active:true,livemode:true,currency:'usd',unit_amount:entry.standard*factor,recurring:{interval:term,interval_count:1}});
 for(const [tier,entry] of Object.entries(PERFORMANCE))stripePrices.set(CATALOG.priceIds['performance|'+tier+'|'+term],{active:true,livemode:true,currency:'usd',unit_amount:entry.cents*factor,recurring:{interval:term,interval_count:1}});
}
stripePrices.set(CATALOG.priceIds['one_time|remove_ads'],{active:true,livemode:true,currency:'usd',unit_amount:499});
let stripeReads=0;
const stripe=new Proxy({prices:{async retrieve(id){assert(stripePrices.has(id));stripeReads++;return structuredClone(stripePrices.get(id));}}},{get(target,key){assert(key==='prices','Stripe mutation or unreviewed method attempted');return target[key];}});

function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};}
async function listen(server){await new Promise((a,b)=>{server.once('error',b);server.listen(0,'127.0.0.1',a)});return server.address().port;}
async function waitUntil(fn,timeout=3000){const t=Date.now()+timeout;while(!fn()){if(Date.now()>t)throw Error('fixture condition timed out');await delay(10)}}
function rawRequest(port,token='fixture'){
 const socket=net.createConnection({host:'127.0.0.1',port});socket.on('error',()=>{});socket.on('data',()=>{});
 socket.once('connect',()=>socket.write('GET /v2/account HTTP/1.1\r\nHost: 127.0.0.1:'+port+'\r\nAuthorization: Bearer rxca_'+token.padEnd(43,'x')+'\r\nConnection: keep-alive\r\n\r\n'));
 return socket;
}
const session=new inspector.Session();session.connect();
function post(method,params={}){return new Promise((resolve,reject)=>session.post(method,params,(e,r)=>e?reject(e):resolve(r)))}
async function call(objectId,functionDeclaration,args=[],byValue=false,awaitPromise=false){
 const result=await post('Runtime.callFunctionOn',{objectId,functionDeclaration,arguments:args,returnByValue:byValue,awaitPromise,silent:true});
 if(result.exceptionDetails)throw Error('in-memory inspector operation failed');return result.result;
}
async function lexical(functionId,wanted){
 const props=await post('Runtime.getProperties',{objectId:functionId,ownProperties:false,generatePreview:false});
 const scopes=props.internalProperties?.find(x=>x.name==='[[Scopes]]')?.value?.objectId;assert(scopes,'V8 scope reference unavailable');
 const list=await post('Runtime.getProperties',{objectId:scopes,ownProperties:true,generatePreview:false});
 const matches=[];
 for(const entry of list.result.filter(x=>/^\d+$/.test(x.name)&&x.value?.objectId)){
  const values=await post('Runtime.getProperties',{objectId:entry.value.objectId,ownProperties:true,generatePreview:false});
  // Do not log, serialize or return complete scopes. Keep only named references.
  for(const value of values.result)if(value.name===wanted&&value.value?.objectId)matches.push(value.value);
 }
 assert.equal(matches.length,1,'ambiguous or missing lexical reference: '+wanted);return matches[0];
}
async function locate(port){
 const evaluated=await post('Runtime.evaluate',{expression:`process._getActiveHandles().filter(h=>h?.constructor?.name==='Server'&&h.listening&&h.address()?.port===${port})`,silent:true});
 assert(!evaluated.exceptionDetails);
 const count=await call(evaluated.result.objectId,'function(){return this.length}',[],true);assert.equal(count.value,1);
 const server=await call(evaluated.result.objectId,'function(){return this[0]}');
 const listeners=await call(server.objectId,"function(){return this.listeners('request').length}",[],true);assert.equal(listeners.value,1);
 const handler=await call(server.objectId,"function(){return this.listeners('request')[0]}");
 const text=await call(handler.objectId,'function(){return this.toString()}',[],true);assert.equal(text.value,handlerExpected,'old handler source mismatch');
 const identify=await lexical(handler.objectId,'identify');
 const identifyText=await call(identify.objectId,'function(){return this.toString()}',[],true);assert.equal(identifyText.value,identifyExpected,'old identity source mismatch');
 const secureFetch=await lexical(identify.objectId,'secureFetch');
 const fetchText=await call(secureFetch.objectId,'function(){return this.toString()}',[],true);assert.equal(fetchText.value,secureFetchExpected,'old secureFetch source mismatch');
 const serial=await lexical(handler.objectId,'serial');
 const serialText=await call(serial.objectId,'function(){return this.toString()}',[],true);assert.equal(serialText.value,serialExpected,'old serial source mismatch');
 const locks=await lexical(serial.objectId,'accountLocks');
 const shape=await call(locks.objectId,'function(){return this instanceof Map}',[],true);assert.equal(shape.value,true);
 return {server,handler,locks};
}
async function gate(port){
 const {server,handler,locks}=await locate(port);
 const result=await call(server.objectId,`function(original,locks){return new Promise((resolve,reject)=>setImmediate(()=>{try{
  if(!this.listening||this.listeners('request').length!==1||this.listeners('request')[0]!==original||!(locks instanceof Map))throw Error('provenance changed');
  const state={closed:false,barrier:false,pending:0,rejected:0,workRefusals:0,ready:false,installedFromSetImmediate:true};
  if(locks.get!==Map.prototype.get||locks.delete!==Map.prototype.delete)throw Error('unreviewed map accessors');
  const originalGet=locks.get,originalDelete=locks.delete;
  if(Object.hasOwn(locks,'set')||locks.set!==Map.prototype.set)throw Error('unreviewed map mutator');
  const denyWork=function(){state.workRefusals++;throw new Error('private maintenance admission closed');};
  Object.defineProperty(locks,'set',{value:denyWork,writable:false,configurable:false,enumerable:false});
  // Holds the OLD process until its normal, separately approved unit stop.
  const hold=setInterval(()=>{},1000);
  const wrapper=(req,res)=>{state.pending++;state.rejected++;let done=false;const finish=()=>{if(!done){done=true;state.pending--;}};res.once('finish',finish);res.once('close',finish);res.shouldKeepAlive=false;res.writeHead(503,{'content-type':'application/json','connection':'close','retry-after':'60'});res.end('{"error":"maintenance"}');};
  // Synchronous replacement before close: no intervening event-loop admission.
  this.removeListener('request',original);this.on('request',wrapper);
  this.close(()=>{state.closed=true;});
  // Telemetry only: the native timeout is not a completion proof. Readiness
  // relies on the exact original map's synchronous work-admission fence.
  setTimeout(()=>setImmediate(()=>{state.barrier=true;}),8250);
  const ready=()=>{const descriptor=Object.getOwnPropertyDescriptor(locks,'set');const fenced=descriptor?.value===denyWork&&descriptor.writable===false&&descriptor.configurable===false&&locks.get===originalGet&&locks.delete===originalDelete;state.ready=state.closed&&fenced&&locks.size===0&&state.pending===0;return {installedFromSetImmediate:state.installedFromSetImmediate,ownSetNonWritableNonConfigurable:descriptor.writable===false&&descriptor.configurable===false,getDeleteUnchanged:locks.get===originalGet&&locks.delete===originalDelete,closed:state.closed,identityBarrier:state.barrier,workAdmissionFenced:fenced,workRefusals:state.workRefusals,accountLocks:locks.size,pendingRejected:state.pending,rejected:state.rejected,ready:state.ready};};
  // Test-only release removes only its interval. The admission fence remains
  // immutable until this disposable process ends; it cannot be restored.
  resolve({status:ready,release(){if(!ready().ready)throw Error('still draining');clearInterval(hold);}});
 }catch(error){reject(error);}}));}`, [{objectId:handler.objectId},{objectId:locks.objectId}],false,true);
 return {
  status:async()=> (await call(result.objectId,'function(){return this.status()}',[],true)).value,
  release:async()=>call(result.objectId,'function(){this.release();return true}',[],true),
  // A retained pre-close accepted socket can still emit a request event. This
  // exact old server is used in the pipeline test, never a replaced mock server.
 };
}
async function preIdentityOnly(){
 const seen=deferred();let releaseIdentity,entered=0;
 const issuer=http.createServer((req,res)=>{releaseIdentity=()=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',sub:'late-fixture',email:'fixture@example.test',email_verified:true}));};seen.resolve();});
 const issuerPort=await listen(issuer);
 const control=await createControl({issuer:'https://fixture.invalid',store:{async get(){entered++;throw Error('unadmitted work reached store');}},receiverStore:{get:async()=>({workspaces:{}})},fetchImpl:(url,options)=>{assert.equal(url,'https://fixture.invalid/redxai-connect/userinfo');assert(options.signal instanceof AbortSignal);return fetch('http://127.0.0.1:'+issuerPort+'/userinfo',options);}});
 const port=Number(new URL(await control.listen(0)).port),socket=rawRequest(port,'lateidentity');await seen.promise;socket.destroy();
 const unrelated=new Map(),prototypeSet=Map.prototype.set;unrelated.set('before',1);
 const boundary=await gate(port);await delay(30);let status=await boundary.status();assert.equal(status.closed,true);assert.equal(status.accountLocks,0);assert.equal(status.workAdmissionFenced,true);assert.equal(status.ready,true);
 releaseIdentity();for(let n=0;n<100;n++){status=await boundary.status();if(status.workRefusals===1)break;await delay(20)}assert.equal(status.workRefusals,1);assert.equal(entered,0,'late identity must fail at original serial map.set before fn');
 unrelated.set('after',2);assert.equal(Map.prototype.set,prototypeSet);assert.deepEqual([...unrelated],[['before',1],['after',2]]);assert.equal(Object.hasOwn(unrelated,'set'),false);
 await boundary.release();issuer.closeAllConnections();await new Promise(r=>issuer.close(r));return {readyWithNoPriorAdmittedWork:true,lateIdentityDeniedBeforeOriginalSerialFunction:true,unrelatedMapsUntouched:true};
}
async function test(){
 const zeroMapPreIdentity=await preIdentityOnly();
 const events=[];const stalls=new Map();let completeAbortBody;
 const identity=http.createServer((req,res)=>{
  const name=(req.headers.authorization||'').slice(12).replace(/x+$/,'');events.push('identity:'+name);
  if(name==='abortbody'){
   res.writeHead(200,{'content-type':'application/json'});res.write('{');completeAbortBody=()=>res.end(JSON.stringify({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',sub:'late-after-abort',email:'fixture@example.test',email_verified:true}).slice(1));res.on('close',()=>events.push('abortedbody'));return;
  }
  const send=()=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',sub:['inserial','queued'].includes(name)?'same-owner':name,email:'fixture@example.test',email_verified:true}));};
  if(name==='preidentity'){stalls.set(name,send);return;}send();
 });
 const identityPort=await listen(identity);
 const serialHold=deferred();let serialEntered=0,serialFinished=0;
 const store={async get(){serialEntered++;events.push('store-enter');await serialHold.promise;serialFinished++;events.push('store-finish');return {policyVersion:3,ownerBenefits:false,projects:{}};}};
 const control=await createControl({issuer:'https://fixture.invalid',stripe,store,receiverStore:{get:async()=>({workspaces:{}})},fetchImpl:(url,options)=>{assert.equal(url,'https://fixture.invalid/redxai-connect/userinfo');assert.equal(options.redirect,'error');assert(options.signal instanceof AbortSignal);const tag=options.headers.authorization.slice(12).replace(/x+$/,'');options.signal.addEventListener('abort',()=>events.push('signal-aborted:'+tag),{once:true});return fetch('http://127.0.0.1:'+identityPort+'/userinfo',options).then(response=>{events.push('fetch-headers:'+tag);const nativeText=response.text.bind(response);Object.defineProperty(response,'text',{value(){events.push('body-start:'+tag);const result=nativeText();result.then(()=>events.push('body-fulfilled:'+tag),()=>events.push('body-rejected:'+tag));return result;}});return response;},error=>{events.push('fetch-rejected:'+tag);throw error;})}});
 const port=Number(new URL(await control.listen(0)).port);
 const inside=rawRequest(port,'inserial');await waitUntil(()=>serialEntered===1);inside.destroy();
 const queued=rawRequest(port,'queued');await waitUntil(()=>events.includes('body-fulfilled:queued'));await delay(20);assert.equal(serialEntered,1,'same-owner request must be queued before fence');queued.destroy();
 const pre=rawRequest(port,'preidentity');await waitUntil(()=>stalls.has('preidentity'));pre.destroy();
 const body=rawRequest(port,'abortbody');await waitUntil(()=>events.includes('identity:abortbody'));body.destroy();
 // Keep a legitimate pre-existing active socket so post-gate pipelined requests
 // exercise the wrapper instead of merely observing connect refusal.
 const pipeline=net.createConnection({host:'127.0.0.1',port});pipeline.on('error',()=>{});let pipelineReply='';pipeline.on('data',b=>{pipelineReply+=b.toString()});
 await new Promise(r=>pipeline.once('connect',r));
 pipeline.write('GET /v2/account HTTP/1.1\r\nHost: 127.0.0.1:'+port+'\r\nAuthorization: Bearer rxca_'+('pipeline'.padEnd(43,'x'))+'\r\nConnection: keep-alive\r\n\r\n');
 await waitUntil(()=>serialEntered===2);
 const boundary=await gate(port);const initial=await boundary.status();assert.equal(initial.ready,false);assert(initial.accountLocks>=1);
 pipeline.write('GET /v2/account HTTP/1.1\r\nHost: 127.0.0.1:'+port+'\r\nAuthorization: Bearer rxca_'+('forbidden'.padEnd(43,'x'))+'\r\nConnection: keep-alive\r\n\r\n');
 await delay(150);
 assert(!events.includes('identity:forbidden'),'post-gate pipelined request reached identity');
 stalls.get('preidentity')();await waitUntil(()=>events.includes('body-fulfilled:preidentity'));await delay(20);let refused=await boundary.status();assert.equal(refused.workRefusals,1);assert.equal(serialEntered,2,'late identity must not enter fn after map.set fence');
 await delay(8400);const late=await boundary.status();assert.equal(late.ready,false,'in-serial disconnected operation must block after timer barrier');assert(late.accountLocks>=1);
 serialHold.resolve();await waitUntil(()=>serialFinished>=6);pipeline.destroy();
 let final;
 for(let n=0;n<100;n++){final=await boundary.status();if(final.ready)break;await delay(25)}
 assert.equal(final.ready,true);assert.equal(final.identityBarrier,true);assert.equal(final.accountLocks,0);assert.equal(final.pendingRejected,0);assert(final.rejected>=1);
 const bodyRejectedBeforeReady=events.includes('body-rejected:abortbody');
 assert(events.includes('signal-aborted:abortbody'),'original native identity abort signal must fire before late-body completion');
 const beforeLate=serialEntered;
 if(!bodyRejectedBeforeReady){
  completeAbortBody();await waitUntil(()=>events.includes('body-fulfilled:abortbody')||events.includes('body-rejected:abortbody'));await delay(50);
 }
 assert.equal(serialEntered,beforeLate,'even a native body completing after original abort must not enter fn');
 const verifiedFinal=await boundary.status();assert.equal(verifiedFinal.ready,true);assert.equal(verifiedFinal.workAdmissionFenced,true);assert(verifiedFinal.workRefusals>=1);
 assert.equal(serialEntered,6,'all three previously admitted handlers, including queued same-owner tail, must complete exactly twice through fake read store');
 await boundary.release();identity.closeAllConnections();await new Promise(r=>identity.close(r));session.disconnect();
 console.log(JSON.stringify({localDisposableOnly:true,sourceSha256:SOURCE_HASH,node:process.version,platform:process.platform,historicalCommit:HISTORICAL_COMMIT,historicalDependencyHashes,fakeStoresOnly:true,sourceBytesUnmodified:true,actualInspectorLexicalScopeAccess:true,handlerSerialIdentityAndFetchSourcesVerified:true,fakeStripeReadOnlyCatalogChecks:stripeReads,stripeWrites:0,zeroMapPreIdentity,disconnectedPreIdentityDeniedAtActualSerialAdmission:true,disconnectedSerialNeverReadyBeforeCompletion:true,postGatePipelinedRequestRejectedBeforeIdentity:true,originalAbortSignalObserved:true,nativeFetchBodyRejectedByOriginalTimeout:bodyRejectedBeforeReady,nativeBodyFinishedAfterOriginalAbort:!bodyRejectedBeforeReady&&events.includes('body-fulfilled:abortbody'),lateBodyNeverEnteredOriginalFn:true,existingSameOwnerQueuedTailDrained:true,unrelatedMapPrototypeUntouched:true,final:verifiedFinal,liveOperations:0},null,2));
}
test().catch(error=>{console.error(error.stack);session.disconnect();process.exit(1);});
