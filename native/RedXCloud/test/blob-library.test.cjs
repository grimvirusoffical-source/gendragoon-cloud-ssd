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

 // New MachineNote chunks use the real visual barcode profile. Preserve the
 // compact cases above as backwards-compatibility coverage, then prove a
 // pixel-encoded carrier passes the actual HTTP validator and decrypts.
 const visualOriginal=crypto.randomBytes(64*1024),visualId=crypto.randomBytes(16).toString('hex');
 const visualPlain=path.join(td,'visual-original.bin'),compactSmall=path.join(td,'visual-compact-fixture.png');
 const visualPNG=path.join(td,'visual-carrier.png'),visualDownloaded=path.join(td,'visual-downloaded.png'),visualRestored=path.join(td,'visual-restored.bin');
 await fs.writeFile(visualPlain,visualOriginal);
 const codecEnvironment={...process.env,PYTHONPATH:path.join(root,'Red-SecretsXAI'),RSX_LIB:path.join(s.base,'tools/rsx-build',process.platform==='darwin'?'librsx.dylib':'librsx.so')};
 async function python(args,input){
  await new Promise((ok,bad)=>{
   const p=spawn(path.join(s.base,'tools/venv/bin/python'),args,{stdio:['pipe','pipe','pipe'],env:codecEnvironment});
   let err='';p.stderr.on('data',x=>err+=x);p.on('error',bad);p.on('close',c=>c===0?ok():bad(new Error('visual carrier fixture '+c+' '+err.slice(0,200))));p.stdin.end(input);
  });
 }
 await python([codec],JSON.stringify({operation:'seal',source:visualPlain,output:compactSmall,password:'fixture password 123456789',
  keymap,receiver:receiver.id,workspace:wkId,object_id:visualId}));
 await python(['-c',[
  'from pathlib import Path',
  'import sys',
  'from redsecretsxai import encode_image, decode_image, decode_storage_image',
  'blob=decode_storage_image(Path(sys.argv[1]).read_bytes())',
  'png=encode_image(blob,module=3,bits=3,noise=0,verify=True,chaff=True,skeleton=True,border=True,deterministic=True)',
  'assert decode_image(png)==blob',
  'Path(sys.argv[2]).write_bytes(png)',
 ].join('\n'),compactSmall,visualPNG]);
 const visualCarrier=await fs.readFile(visualPNG);
 assert.ok(visualCarrier.length<8*1024*1024);
 assert.ok(visualCarrier.readUInt32BE(16)*visualCarrier.readUInt32BE(20)<=4_000_000);
 const chunkTypes=[];for(let offset=8;offset<visualCarrier.length;){const length=visualCarrier.readUInt32BE(offset);chunkTypes.push(visualCarrier.toString('ascii',offset+4,offset+8));offset+=length+12;}
 assert.ok(!chunkTypes.includes('rxAI'),'visual carrier must not carry its ciphertext in the compact rxAI chunk');
 const visualRoute='/v1/receivers/me/workspaces/'+wkId+'/blobs/'+visualId;
 r=await call(a.access_token,'PUT',visualRoute,visualCarrier,{'content-type':'image/png','content-length':String(visualCarrier.length),'x-content-sha256':digest(visualCarrier)});
 assert.equal(r.status,201);assert.equal(r.json.status,'ready');
 const visualResponse=await call(a.access_token,'GET',visualRoute);
 assert.equal(visualResponse.status,200);assert.equal(digest(visualResponse.raw),digest(visualCarrier));
 await fs.writeFile(visualDownloaded,visualResponse.raw);
 await python([codec],JSON.stringify({operation:'restore',source:visualDownloaded,output:visualRestored,password:'fixture password 123456789',
  keymap,receiver:receiver.id,workspace:wkId,object_id:visualId}));
 assert.deepEqual(await fs.readFile(visualRestored),visualOriginal);
 assert.equal((await call(b.access_token,'GET',visualRoute)).status,404);

 // Explicit scalable-blob deletion frees exactly its reserved carrier bytes.
 const beforeDelete=(await call(a.access_token,'GET','/v1/receivers/me')).json.usedBytes;
 const deleted=await call(a.access_token,'DELETE',route);
 assert.equal(deleted.status,200);assert.equal(deleted.json.freedBytes,carrier.length);
 const afterDelete=(await call(a.access_token,'GET','/v1/receivers/me')).json.usedBytes;
 assert.equal(afterDelete,beforeDelete-carrier.length);
 assert.equal((await call(a.access_token,'GET',route)).status,404);
 assert.equal((await call(a.access_token,'DELETE',route)).status,404);
 assert.equal((await call(a.access_token,'GET','/v1/receivers/me')).json.usedBytes,afterDelete);

 // Deleting a workspace removes both storage generations and its library
 // index, with exactly one durable quota release across retries.
 const deletedWorkspace=await call(a.access_token,'DELETE','/v1/receivers/me/workspaces/'+wkId,
  undefined,{'x-confirm-workspace':wkId});
 assert.equal(deletedWorkspace.status,200);assert.equal(deletedWorkspace.json.freedBytes,afterDelete);
 const empty=(await call(a.access_token,'GET','/v1/receivers/me')).json;
 assert.equal(empty.usedBytes,0);assert.equal(empty.workspaces.length,0);assert.equal(empty.libraryItems,0);
 assert.equal((await call(a.access_token,'GET',mroute)).status,404);
 const retry=await call(a.access_token,'DELETE','/v1/receivers/me/workspaces/'+wkId,
  undefined,{'x-confirm-workspace':wkId});
 assert.equal(retry.status,200);assert.equal(retry.json.freedBytes,0);
});
