'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const http=require('node:http'),net=require('node:net'),path=require('node:path');
const {EventEmitter,once}=require('node:events'),{fork}=require('node:child_process');
const {createControlLifecycle,runControlCLI}=require('../control-lifecycle.cjs');
const {createControl}=require('../control-server.cjs');
const {initialJob}=require('../account-deletion.cjs');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Disposable lifecycle checkpoint timed out')),5000))]);}finally{clearTimeout(timer);}}
async function turn(){await new Promise(resolve=>setImmediate(resolve));}
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port;}
function request(port){return new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port,path:'/',agent:false},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,text}));});req.on('error',reject);});}
async function refused(port){await assert.rejects(request(port),{code:'ECONNREFUSED'});}

test('close refuses later keepalive admissions before draining the admitted handler and its worker',async()=>{
 const entered=deferred(),release=deferred(),worker=deferred(),draining=deferred();let calls=0,drains=0,done=false;
 const server=http.createServer(),lifecycle=createControlLifecycle(server,{drain:async()=>{drains++;draining.resolve();await worker.promise;}});
 server.on('request',lifecycle.admit(async(_req,res)=>{calls++;entered.resolve();await release.promise;res.end('first');}));
 const port=await listen(server),socket=net.connect(port,'127.0.0.1');let received='';socket.on('data',x=>received+=x);await once(socket,'connect');
 socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');await bounded(entered.promise);
 const closing=lifecycle.close();assert.equal(lifecycle.close(),closing);closing.then(()=>done=true);
 socket.write('GET /later HTTP/1.1\r\nHost: localhost\r\n\r\n');
 await refused(port);await turn();assert.equal(drains,0);assert.equal(done,false);
 const ended=once(socket,'close');release.resolve();await bounded(draining.promise);await bounded(ended);
 assert.equal(calls,1);assert.match(received,/503 Service Unavailable/);assert.match(received,/service_closing/);assert.equal(done,false);
 worker.resolve();await bounded(closing);assert.equal(drains,1);assert.equal(done,true);
});

test('a disconnected request and rejected handler cannot bypass background drain',async()=>{
 const entered=deferred(),release=deferred(),worker=deferred(),draining=deferred();let drained=false;
 const server=http.createServer(),lifecycle=createControlLifecycle(server,{drain:async()=>{draining.resolve();await worker.promise;}});
 server.on('request',lifecycle.admit(async()=>{entered.resolve();await release.promise;throw Error('private detail');}));
 const port=await listen(server),req=http.get({host:'127.0.0.1',port,agent:false});req.on('error',()=>{});await bounded(entered.promise);req.destroy();
 const closing=lifecycle.close().then(()=>drained=true);await turn();assert.equal(drained,false);
 release.resolve();await bounded(draining.promise);assert.equal(drained,false);worker.resolve();await bounded(closing);assert.equal(drained,true);
});

test('actual Control close waits for a deletion worker scheduled by an already admitted authenticated request',async()=>{
 const auth=deferred(),entered=deferred(),worker=deferred(),workerEntered=deferred();
 const row={workspaces:{},accountDeletion:initialJob({id:'a'.repeat(32),keyHash:'b'.repeat(64),requestedAtMs:1})};
 const receiverStore={async get(){return structuredClone(row);},async change(_owner,fn){fn(row);return structuredClone(row);}};
 const control=await createControl({issuer:'https://red-xai.com',store:{},receiverStore,
  fetchImpl:async()=>{entered.resolve();await auth.promise;return Response.json({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',sub:'disposable-subject',email:'fixture@example.test',email_verified:true});},
  accountDeletionReceiver:async(_identity,action)=>{if(action==='metadata'){workerEntered.resolve();await worker.promise;return {done:true};}if(action==='finish'){row.accountDeletion.status='completed';row.accountDeletion.phase='complete';}return {};}});
 const root=await control.listen();
 const response=fetch(root+'/v2/account/deletion',{headers:{authorization:'Bearer rxca_'+'A'.repeat(43)}}).then(async r=>({status:r.status,body:await r.json()}));
 await bounded(entered.promise);let closed=false;const closing=control.close().then(()=>closed=true);
 await refused(Number(new URL(root).port));auth.resolve();assert.equal((await bounded(response)).status,200);
 await bounded(workerEntered.promise);await turn();assert.equal(closed,false);worker.resolve();await bounded(closing);
 assert.equal(row.accountDeletion.status,'completed');await assert.rejects(control.listen(),error=>error.code==='service_closing');
});

test('close before listen is idempotent and drains once',async()=>{
 let drains=0;const server=http.createServer(),lifecycle=createControlLifecycle(server,{drain:async()=>{drains++;}});
 const closing=lifecycle.close();assert.equal(lifecycle.close(),closing);await closing;assert.equal(drains,1);assert.equal(lifecycle.closing,true);
});

test('failed close retains the CLI with one fixed diagnostic and repeated signals never force exit',async t=>{
 const p=new EventEmitter();let text='',retained=0,closes=0;p.stderr={write:x=>text+=x};
 t.mock.method(global,'setInterval',()=>{retained++;return {};});
 const runner=runControlCLI(async()=>({listen:async()=>{},close:async()=>{closes++;throw Error('private credential/path detail');}}),{processImpl:p});
 await runner.startup;p.emit('SIGTERM');await runner.stop();p.emit('SIGINT');await runner.stop();
 assert.equal(closes,1);assert.equal(retained,1);assert.equal(text,'control_shutdown_failed\n');assert.equal(p.exitCode,undefined);
});
test('listen failure uses the shared close promise and a failed drain retains startup work',async t=>{
 const p=new EventEmitter();let text='',retained=0,closes=0;p.stderr={write:x=>text+=x};
 t.mock.method(global,'setInterval',()=>{retained++;return {};});
 const runner=runControlCLI(async()=>({listen:async()=>{throw Error('private listen detail');},close:async()=>{closes++;throw Error('private worker detail');}}),{processImpl:p});
 await runner.startup;p.emit('SIGTERM');p.emit('SIGINT');await runner.stop();
 assert.equal(closes,1);assert.equal(retained,1);assert.equal(text,'control_startup_failed\ncontrol_shutdown_failed\n');assert.equal(p.exitCode,undefined);
});

function childFixture(mode){
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const child=fork(path.join(__dirname,'fixtures/control-lifecycle-child.cjs'),[mode],{env,silent:true});
 const messages=[],waiters=[];let stderr='',stdout='';child.stderr.on('data',x=>stderr+=x);child.stdout.on('data',x=>stdout+=x);
 child.on('message',message=>{messages.push(message);for(const item of [...waiters])if(item.event===message.event){waiters.splice(waiters.indexOf(item),1);item.resolve(message);}});
 const next=event=>{const existing=messages.find(m=>m.event===event);if(existing)return Promise.resolve(existing);return bounded(new Promise(resolve=>waiters.push({event,resolve})));};
 const exited=new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));
 return {child,next,exited,get stderr(){return stderr;},get stdout(){return stdout;}};
}
for(const mode of ['normal','rejected-handler'])test(`actual process repeated SIGTERM/SIGINT drains HTTP and worker before normal exit (${mode})`,{skip:process.platform==='win32'},async t=>{
 const f=childFixture(mode),ready=await f.next('ready'),response=request(ready.port);await f.next('entered');
 t.after(async()=>{if(f.child.connected)for(const name of ['create','handler','worker'])f.child.send(name);await bounded(f.exited);});
 f.child.kill('SIGTERM');f.child.kill('SIGINT');await f.next('closing');await refused(ready.port);assert.equal(f.child.exitCode,null);
 f.child.send('handler');await bounded(response);await f.next('draining');assert.equal(f.child.exitCode,null);
 f.child.send('worker');const drained=await f.next('drained');assert.equal(drained.drains,1);
 assert.deepEqual(await bounded(f.exited),{code:0,signal:null});assert.equal(f.stderr,'');assert.equal(f.stdout,'');
});
test('actual process signal during startup never opens HTTP admissions and still drains normally',{skip:process.platform==='win32'},async t=>{
 const f=childFixture('startup');await f.next('creating');
 t.after(async()=>{if(f.child.connected)for(const name of ['create','handler','worker'])f.child.send(name);await bounded(f.exited);});
 f.child.kill('SIGTERM');f.child.kill('SIGINT');await f.next('signal');f.child.send('create');
 assert.equal((await f.next('drained')).drains,1);assert.deepEqual(await bounded(f.exited),{code:0,signal:null});assert.equal(f.stderr,'');assert.equal(f.stdout,'');
});
test('actual EADDRINUSE startup failure waits for its deferred worker before normal exit1',{skip:process.platform==='win32'},async t=>{
 const f=childFixture('listen-failure');
 t.after(async()=>{if(f.child.connected)f.child.send('worker');await bounded(f.exited);});
 await f.next('draining');assert.equal(f.child.exitCode,null);
 f.child.kill('SIGTERM');f.child.kill('SIGINT');await f.next('signal');assert.equal(f.child.exitCode,null);
 f.child.send('worker');assert.equal((await f.next('drained')).drains,1);
 assert.deepEqual(await bounded(f.exited),{code:1,signal:null});assert.equal(f.stderr,'control_startup_failed\n');assert.equal(f.stdout,'');
});
