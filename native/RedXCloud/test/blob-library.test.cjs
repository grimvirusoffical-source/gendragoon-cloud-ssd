'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');

const digest=b=>crypto.createHash('sha256').update(b).digest('hex');

test('scalable compact-PNG blobs and library index use real RedX + account isolation',{timeout:180000,skip:!process.env.REDX_INTEGRATION_ROOT},async t=>{
 const root=process.env.REDX_INTEGRATION_ROOT;
 const previousPythonPath=process.env.PYTHONPATH;
 process.env.PYTHONPATH=path.join(root,'Red-SecretsXAI')+(previousPythonPath?path.delimiter+previousPythonPath:'');
 t.after(()=>{if(previousPythonPath===undefined)delete process.env.PYTHONPATH;else process.env.PYTHONPATH=previousPythonPath;});
 const {startStack}=require(path.join(root,'gendragoon-cloud-ssd/native/RedXCloud/test/stack.cjs'));
 const {createCloud}=require(path.join(root,'gendragoon-cloud-ssd/native/RedXCloud/server.cjs'));
 const s=await startStack();
 const storage=path.join(s.dir,'blob-library-receivers');
 const cloud=await createCloud({issuer:s.issuer,dev:true,redxURL:s.redxURL,redxKey:s.receiverKey,
  redxDB:'gendragoon_receivers',root:storage,quota:128*1024*1024,python:path.join(s.base,'tools/venv/bin/python')});
 t.after(async()=>{await cloud.close();await s.close();});
 const api=await cloud.listen();
 const a=await s.account('blob-a'),b=await s.account('blob-b');
 async function call(token,method,route,body,headers={}){
  const r=await fetch(api+route,{method,body,headers:{authorization:'Bearer '+token,...headers}});
  const raw=Buffer.from(await r.arrayBuffer());
  let json=null;try{json=JSON.parse(raw.toString('utf8'));}catch{}
  return{status:r.status,headers:r.headers,raw,json};
 }
 const receiver=(await call(a.access_token,'PUT','/v1/receivers/me')).json;
 assert.equal((await call(b.access_token,'PUT','/v1/receivers/me')).status,200);
 const wkId=crypto.randomBytes(16).toString('hex');
 const wk=(await call(a.access_token,'POST','/v1/receivers/me/workspaces',
  JSON.stringify({name:'Applications'}),{'content-type':'application/json','idempotency-key':wkId})).json;
 assert.equal(wk.id,wkId);

 // Use the genuine codec to make a payload well above the old 64 KiB preview bound.
 const td=path.join(s.dir,'blob-codec');await fs.mkdir(td,{mode:0o700});
 const plain=path.join(td,'plain.bin'),png=path.join(td,'carrier.png'),keymap=path.join(td,'keymap');
 const original=crypto.randomBytes(2*1024*1024+12345);await fs.writeFile(plain,original);
 const objectId=crypto.randomBytes(16).toString('hex');
 const codec=path.join(root,'gendragoon-cloud-ssd/native/RedXCloud/client-codec.py');
 const input=JSON.stringify({operation:'seal',source:plain,output:png,password:'fixture password 123456789',
  keymap,receiver:receiver.id,workspace:wkId,object_id:objectId});
 const {spawn}=require('node:child_process');
 await new Promise((ok,bad)=>{
  const p=spawn(path.join(s.base,'tools/venv/bin/python'),[codec],{stdio:['pipe','pipe','pipe'],
   env:{...process.env,PYTHONPATH:path.join(root,'Red-SecretsXAI'),RSX_LIB:path.join(s.base,'tools/rsx-build',process.platform==='darwin'?'librsx.dylib':'librsx.so')}});
  let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);
  p.on('error',bad);p.on('close',c=>c===0?ok():bad(new Error('codec '+c+' '+err.slice(0,200))));
  p.stdin.end(input);
 });
 const carrier=await fs.readFile(png);assert.ok(carrier.length>2*1024*1024);assert.ok(carrier.length<3*1024*1024);
 const route='/v1/receivers/me/workspaces/'+wkId+'/blobs/'+objectId;
 let r=await call(a.access_token,'PUT',route,carrier,{'content-type':'image/png','content-length':String(carrier.length),'x-content-sha256':digest(carrier)});
 assert.equal(r.status,201);assert.equal(r.json.status,'ready');

 // Immutable idempotent retry reuses, does not double-count quota.
 r=await call(a.access_token,'PUT',route,carrier,{'content-type':'image/png','content-length':String(carrier.length),'x-content-sha256':digest(carrier)});
 assert.equal(r.status,200);assert.equal(r.json.reused,true);
 const state=(await call(a.access_token,'GET','/v1/receivers/me')).json;
 assert.equal(state.usedBytes,carrier.length);

 r=await call(a.access_token,'GET',route);
 assert.equal(r.status,200);assert.equal(digest(r.raw),digest(carrier));assert.equal(r.headers.get('content-type'),'image/png');

 // Different account cannot discover this workspace/blob.
 assert.equal((await call(b.access_token,'GET',route)).status,404);

 // A compact encrypted manifest is itself a blob, then becomes the library head.
 const manifestId=crypto.randomBytes(16).toString('hex');
 const manifestPlain=path.join(td,'manifest.json'),manifestPNG=path.join(td,'manifest.png');
 const archiveSha=digest(original);
 await fs.writeFile(manifestPlain,JSON.stringify({schema:'gendragoon.library-manifest/v1',name:'Fixture.app',kind:'app',
  archiveBytes:original.length,archiveSha256:archiveSha,chunks:[{id:objectId,bytes:original.length}]}));
 const manifestInput=JSON.stringify({operation:'seal',source:manifestPlain,output:manifestPNG,password:'fixture password 123456789',
  keymap,receiver:receiver.id,workspace:wkId,object_id:manifestId});
 await new Promise((ok,bad)=>{
  const p=spawn(path.join(s.base,'tools/venv/bin/python'),[codec],{stdio:['pipe','pipe','pipe'],
   env:{...process.env,PYTHONPATH:path.join(root,'Red-SecretsXAI'),RSX_LIB:path.join(s.base,'tools/rsx-build',process.platform==='darwin'?'librsx.dylib':'librsx.so')}});
  let err='';p.stderr.on('data',x=>err+=x);p.on('error',bad);p.on('close',c=>c===0?ok():bad(new Error('manifest codec '+c+' '+err.slice(0,200))));
  p.stdin.end(manifestInput);
 });
 const mpng=await fs.readFile(manifestPNG);
 const mroute='/v1/receivers/me/workspaces/'+wkId+'/blobs/'+manifestId;
 assert.equal((await call(a.access_token,'PUT',mroute,mpng,{'content-type':'image/png','content-length':String(mpng.length),'x-content-sha256':digest(mpng)})).status,201);
 const key=digest('Fixture.app').slice(0,18);
 const item={name:'Fixture.app',kind:'app',workspace:wkId,manifestId,archiveBytes:original.length,archiveSha256:archiveSha};
 r=await call(a.access_token,'PUT','/v1/receivers/me/library/'+key,JSON.stringify(item),{'content-type':'application/json'});
 assert.equal(r.status,200);assert.equal(r.json.generation,1);assert.equal(r.json.manifestId,manifestId);
 r=await call(a.access_token,'GET','/v1/receivers/me/library');
 assert.equal(r.status,200);assert.equal(r.json.items.length,1);assert.equal(r.json.items[0].name,'Fixture.app');
 assert.equal((await call(b.access_token,'GET','/v1/receivers/me/library')).json.items.length,0);

 // Legacy small-object endpoint still works for compatibility.
 const legacyId=crypto.randomBytes(16).toString('hex');
 const legacyRoute='/v1/receivers/me/workspaces/'+wkId+'/objects/'+legacyId;
 const smallPNG=mpng;
 assert.ok(smallPNG.length<8*1024*1024);
 assert.equal((await call(a.access_token,'PUT',legacyRoute,smallPNG,{'content-type':'image/png','content-length':String(smallPNG.length),'x-content-sha256':digest(smallPNG)})).status,201);
 assert.equal((await call(a.access_token,'GET',legacyRoute)).status,200);

 // Explicit scalable-blob deletion frees exactly its reserved carrier bytes.
 const beforeDelete=(await call(a.access_token,'GET','/v1/receivers/me')).json.usedBytes;
 const deleted=await call(a.access_token,'DELETE',route);
 assert.equal(deleted.status,200);assert.equal(deleted.json.freedBytes,carrier.length);
 const afterDelete=(await call(a.access_token,'GET','/v1/receivers/me')).json.usedBytes;
 assert.equal(afterDelete,beforeDelete-carrier.length);
 assert.equal((await call(a.access_token,'GET',route)).status,404);
 assert.equal((await call(a.access_token,'DELETE',route)).status,404);
 assert.equal((await call(a.access_token,'GET','/v1/receivers/me')).json.usedBytes,afterDelete);
});
