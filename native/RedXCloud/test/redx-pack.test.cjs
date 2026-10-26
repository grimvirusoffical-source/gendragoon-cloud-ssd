'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {request}=require('./stack.cjs');
const net=require('node:net');
const {IntegrationMetadata}=require('../integrations.cjs');
const {RedXState}=require('../redx-state.cjs');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
async function startPackStack(){
 const base=process.env.REDX_INTEGRATION_ROOT,dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gendragoon-byo-pack-')));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const redxURL='http://127.0.0.1:'+port,p=spawn(path.join(base,'tools/redxd'),['run','--data-dir',path.join(dir,'redx'),'--listen','127.0.0.1:'+port,'--bootstrap','console','--no-open'],{env:{...process.env,REDX_ENGINE_DURABILITY:'sync'},stdio:['ignore','pipe','pipe']});
 const logs=new Map([[p,'']]);const capture=b=>logs.set(p,(logs.get(p)+b).slice(-200000));p.stdout.on('data',capture);p.stderr.on('data',capture);
 async function close(){if(p.exitCode===null){p.kill('SIGTERM');await Promise.race([new Promise(r=>p.once('close',r)),new Promise(r=>setTimeout(r,5000))]);if(p.exitCode===null)p.kill('SIGKILL');}await fs.rm(dir,{recursive:true,force:true});}
 try{
  let ready=false;for(let i=0;i<100;i++){if(p.exitCode!==null||p.signalCode)break;try{if((await fetch(redxURL+'/healthz',{signal:AbortSignal.timeout(500)})).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ready){const diagnostic=logs.get(p).split('\n').filter(line=>/error|failed|panic|listen|bind/i.test(line)).join('\n').replace(/rx_live_[A-Za-z0-9]+/g,'[redacted]').slice(-1500);throw Error('Fixture RedX startup failed exit='+p.exitCode+' signal='+p.signalCode+' '+diagnostic);}
  const admin=(logs.get(p).match(/rx_live_[A-Za-z0-9]+/)||[])[0];if(!admin)throw Error('Fixture key unavailable');
  const db=await request(redxURL+'/v1/dbs','POST',{name:'gendragoon_receivers'},admin);assert([200,201].includes(db.status));const minted=await request(redxURL+'/v1/keys','POST',{db:'gendragoon_receivers',scope:'write'},admin,{'X-RedX-Confirm':'createKey'});assert(minted.body.key);
  return {base,dir,redxURL,receiverKey:minted.body.key,processes:[p],logs,close};
 }catch(e){await close();throw e;}
}
test('real RedX pack files, separate integration CAS, revoked/prefix isolation and genuine encrypted app restore',{skip:!process.env.REDX_INTEGRATION_ROOT,timeout:180000},async t=>{
 const s=await startPackStack();t.after(()=>s.close());
 const redx=s.processes[0],admin=(s.logs.get(redx).match(/rx_live_[A-Za-z0-9]+/)||[])[0];assert(admin);
 const database='gendragoon_byo_fixture',pack='gendragoon';
 assert.equal((await request(s.redxURL+'/v1/dbs','POST',{name:database},admin)).status,201);
 async function mint(prefix,scope='write'){const r=await request(s.redxURL+'/v1/keys','POST',{db:database,scope,prefix},admin,{'X-RedX-Confirm':'createKey'});assert.equal(r.status,201);return r.body;}
 const full=await mint(''),read=await mint('', 'read'),restricted=await mint(pack+'.red-xai-pack:private');
 const resources=path.join(__dirname,'../../Resources'),helper=path.join(resources,'gendragoon_redx_pack.py');
 const python=process.env.GENDRAGOON_TEST_PYTHON||'/Library/Frameworks/Python.framework/Versions/3.13/bin/python3';
 const common={origin:s.redxURL,database,pack,key:full.key,development:true};
 async function cli(action,value={}){
  return new Promise((resolve,reject)=>{
   const archiveAction=['upload-source','restore-source'].includes(action);
   const runner=`import sys; sys.path.insert(0,${JSON.stringify(resources)}); import gendragoon_redx_pack as helper; import traceback,json; original=helper.run\ndef observed(*args):\n try: return original(*args)\n except Exception as error:\n  print(json.dumps({'exceptionType':type(error).__name__,'frames':[f.name+':'+str(f.lineno) for f in traceback.extract_tb(error.__traceback__)]}),file=sys.stderr)\n  raise\nhelper.run=observed\nraise SystemExit(helper.main())`;
   const args=archiveAction?['-B','-c',runner,action]:['-B',helper,action];
   const runtime=process.env.GENDRAGOON_TEST_RUNTIME||'/Applications/GenDragoon Cloud SSD.app/Contents/Resources';
   const child=spawn(python,args,{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONPATH:[runtime,path.join(s.base,'Red-SecretsXAI')].join(path.delimiter),RSX_LIB:path.join(s.base,'tools/rsx-build',process.platform==='darwin'?'librsx.dylib':'librsx.so')}});
   let output='',stderr='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>stderr=(stderr+b).slice(-4096));child.on('error',reject);
   child.on('close',code=>{try{const v=JSON.parse(output);assert(!output.includes(full.key));assert(!stderr.includes(full.key));resolve({code,...v,...(!v.ok&&archiveAction?{diagnostic:stderr}:{})});}catch{reject(Error('Pack helper returned no safe JSON result; inspect fixture locally'));}});
   child.stdin.end(JSON.stringify({...common,...value}));
  });
 }
 const emptyProbe=await cli('probe');assert.equal(emptyProbe.authorized,true);assert.equal(emptyProbe.packExists,false);
 assert.equal((await cli('probe',{key:admin})).error,'scoped_database_key_required');
 const connectDatabase='gd_connect_fixture';
 const begin=await cli('connect-begin',{database:connectDatabase}),parameters=Object.fromEntries(new URLSearchParams(new URL(begin.url).hash.split('?')[1]));
 const started=await request(s.redxURL+'/v1/connect/start','POST',{...parameters,v:1},admin);assert.equal(started.status,201);
 const approved=await request(s.redxURL+'/v1/connect/approve','POST',{request_id:started.body.request_id,workspace:connectDatabase,scope:'write'},admin,{'X-RedX-Confirm':'connectApprove'});assert.equal(approved.status,200,JSON.stringify(approved.body));
 const exchanged=await cli('connect-exchange',{database:connectDatabase,code:approved.body.code,state:begin.state,pkceVerifier:begin.pkceVerifier});assert.equal(exchanged.ok,true);assert.equal(exchanged.database,connectDatabase);assert.equal(exchanged.scope,'write');
 assert.equal((await cli('connect-exchange',{database:connectDatabase,code:approved.body.code,state:begin.state,pkceVerifier:begin.pkceVerifier})).ok,false);
 assert.equal((await cli('revoke',{database:connectDatabase,key:exchanged.key})).revoked,true);
 assert.equal((await cli('probe',{database:connectDatabase,key:exchanged.key})).error,'key_invalid');
 const fixture=path.join(s.dir,'source.bin'),original=crypto.randomBytes(2*1024*1024+71);await fs.writeFile(fixture,original);
 const put=await cli('put',{path:'private/sub/source.bin',source:fixture});assert.equal(put.ok,true);assert.equal(put.file.sha256,hash(original));
 const listing=await cli('list',{path:'private/sub'});assert.equal(listing.entries[0].name,'source.bin');
 const folder=await cli('mkdir',{path:'private/empty'});assert.equal(folder.ok,true);assert.deepEqual((await cli('list',{path:'private/empty'})).entries,[]);
 const restored=path.join(s.dir,'received.bin');assert.equal((await cli('get',{path:'private/sub/source.bin',destination:restored})).ok,true);assert.equal(hash(await fs.readFile(restored)),hash(original));
 assert.equal((await cli('get',{path:'private/sub/source.bin',destination:restored})).error,'destination_unsafe');
 assert.equal((await cli('put',{path:'private/no.bin',source:fixture,key:read.key})).error,'access_denied');
 assert.equal((await cli('list',{path:'private',key:restricted.key})).ok,true);assert.equal((await cli('list',{path:'',key:restricted.key})).error,'access_denied');
 assert.equal((await cli('put',{path:'../escape',source:fixture})).error,'path_invalid');
 assert.equal((await cli('list',{origin:'http://127.0.0.1:'+new URL(s.redxURL).port+'/other'})).error,'origin_invalid');
 const physical=path.join(s.dir,'redx/dbs',database,pack+'.red-xai-pack');assert((await fs.stat(physical)).isDirectory());assert((await fs.readdir(path.join(physical,'chunks'))).length>0);assert((await fs.readdir(path.join(physical,'manifests'))).length>0);
 const store=new RedXState({url:s.redxURL,key:s.receiverKey,db:'gendragoon_receivers',dev:true}),metadata=new IntegrationMetadata(store),owner=hash('fixture');
 await metadata.update(owner,v=>{v.byo.one={kind:'redx-db-byo',hostingFeeCents:0};});
 await Promise.all(Array.from({length:5},(_,i)=>metadata.update(owner,v=>{v.keys['key'+i]={digest:hash('not-a-real-key-'+i)};})));
 assert.equal(Object.keys((await metadata.account(owner)).keys).length,5);assert.equal((await metadata.account(owner)).byo.one.hostingFeeCents,0);assert.equal(await store.get(owner),null);
 if(process.platform==='darwin'){
  const app=path.join(s.dir,'Fixture.app');await fs.mkdir(path.join(app,'Contents/MacOS'),{recursive:true});await fs.writeFile(path.join(app,'Contents/Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.gendragoon.byo</string></dict></plist>');await fs.writeFile(path.join(app,'Contents/MacOS/fixture'),'#!/bin/sh\nexit 0\n',{mode:0o755});await fs.symlink('MacOS/fixture',path.join(app,'Contents/fixture-link'));
  const accountId=hash('fixture-account-'+crypto.randomBytes(16).toString('hex')),context=await cli('context',{accountId});assert.equal(context.ok,true);
  const cryptoConfig={accountId,storageSecret:crypto.randomBytes(32).toString('base64url'),keymapPath:context.keymapPath};t.after(()=>fs.rm(context.keymapPath,{force:true}));
  const uploaded=await cli('upload-source',{...cryptoConfig,source:app,path:'Applications',offload:false});assert.equal(uploaded.ok,true,JSON.stringify(uploaded));assert.equal(uploaded.encrypted,true);assert.equal(uploaded.offloaded,false);assert((await fs.stat(app)).isDirectory());
  const entries=await cli('archives',cryptoConfig);assert.equal(entries.entries.length,1);assert.equal(entries.entries[0].name,'Fixture.app');assert.equal(entries.entries[0].logicalParent,'Applications');
  const blobs=await cli('list',{path:'GenDragoon/'+context.workspaceId+'/blobs/'+uploaded.entry.transportId});assert(blobs.entries.length>=3);
  const png=await request(s.redxURL+`/v1/db/${database}/pack/${pack}/file/`+blobs.entries[0].path,'GET',undefined,full.key);assert.equal(png.status,200);assert.equal(png.bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert(!png.bytes.includes(Buffer.from('rxAI')));assert(!png.bytes.includes(Buffer.from('#!/bin/sh')));
  const output=path.join(s.dir,'restore-app');await fs.mkdir(output);const restore=await cli('restore-source',{...cryptoConfig,path:uploaded.path,destination:output});assert.equal(restore.ok,true,JSON.stringify(restore));assert.equal(restore.encrypted,true);assert.equal(await fs.readlink(path.join(output,'Fixture.app/Contents/fixture-link')),'MacOS/fixture');assert.equal((await fs.stat(path.join(output,'Fixture.app/Contents/MacOS/fixture'))).mode&0o111,0o111);
  assert.equal((await cli('restore-source',{...cryptoConfig,path:uploaded.path,destination:output})).error,'destination_unsafe');
  assert.equal((await cli('archives',{...cryptoConfig,accountId:hash('other-account')})).entries.length,0);
 }
 // Deletion removes only file index; physical chunks remain until host-admin GC.
 assert.equal((await cli('delete',{path:'private/sub/source.bin'})).chunksRetainedUntilHostGC,true);
 assert.equal((await cli('get',{path:'private/sub/source.bin',destination:path.join(s.dir,'deleted.bin')})).error,'not_found');
 assert.equal((await request(s.redxURL+'/v1/keys/'+read.id,'DELETE',undefined,admin,{'X-RedX-Confirm':'revokeKey'})).status,200);
 assert.equal((await cli('list',{path:'private',key:read.key})).error,'key_invalid');
});
