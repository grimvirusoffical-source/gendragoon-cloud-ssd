'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {startStack,request} = require('./stack.cjs');
const {createCloud} = require('../server.cjs');
const {digest} = require('../redx-state.cjs');
const id = () => crypto.randomBytes(16).toString('hex');

test('Real RedX + Red-XAI Accounts + Red-SecretsXAI PNG Receiver roundtrip', {timeout:180000, skip:!process.env.REDX_INTEGRATION_ROOT}, async t => {
 const s=await startStack();let cloud;t.after(async()=>{if(cloud)await cloud.close();await s.close();});
 const options={issuer:s.issuer,dev:true,redxURL:s.redxURL,redxKey:s.receiverKey,redxDB:'gendragoon_receivers',root:path.join(s.dir,'receivers'),python:path.join(s.base,'tools/venv/bin/python')};
 cloud=await createCloud(options);
 let endpoint=await cloud.listen();
 const a=await s.account('A'),b=await s.account('B');
 let ra,rb;
 await t.test('real verified identities create separate Receivers and idempotent root',async()=>{
  ra=(await request(endpoint+'/v1/receivers/me','PUT',undefined,a.access_token)).body;
  rb=(await request(endpoint+'/v1/receivers/me','PUT',undefined,b.access_token)).body;
  assert.match(ra.id,/^[a-f0-9]{64}$/);assert.notEqual(ra.id,rb.id);
  assert.equal((await request(endpoint+'/v1/receivers/me','PUT',undefined,a.access_token)).body.id,ra.id);
 });
 await t.test('missing, forged and ID tokens are refused',async()=>{
  for(const token of [undefined,'invalid',a.id_token])assert.equal((await request(endpoint+'/v1/receivers/me','GET',undefined,token)).status,401);
 });
 const workspace=id(),object=id();
 await t.test('workspace creation is idempotent, does not accept client quotas',async()=>{
  const create=()=>request(endpoint+'/v1/receivers/me/workspaces','POST',{name:'My private workspace',quota:999999999},a.access_token,{'idempotency-key':workspace});
  assert.equal((await create()).status,200);assert.equal((await create()).status,200);
  const state=(await request(endpoint+'/v1/receivers/me','GET',undefined,a.access_token)).body;
  assert.equal(state.workspaces.length,1);assert.equal(state.quotaBytes,64*1024*1024);
 });
 const objectURL=()=>endpoint+'/v1/receivers/me/workspaces/'+workspace+'/objects/'+object;
 const original=Buffer.from('Red-XAI PNG integration: '+crypto.randomBytes(24).toString('hex'));
 const input=path.join(s.dir,'private-notes.txt'),png=path.join(s.dir,'sealed.png'),download=path.join(s.dir,'download.png');
 await fs.writeFile(input,original,{mode:0o600});
 const password=crypto.randomBytes(24).toString('hex'),keymap=path.join(s.dir,'client-keymap/session.kxai');
 function codec(operation,source,output,extra={}) {
  return new Promise(resolve=>{
   const child=spawn(options.python,[path.join(__dirname,'../client-codec.py')],{env:{...process.env,RSX_LIB:path.join(s.base,'tools/rsx-build/librsx.dylib'),OPENBLAS_NUM_THREADS:'1'},stdio:['pipe','pipe','pipe']});
   let out='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',()=>{});
   child.once('close',code=>resolve({code,out}));child.stdin.end(JSON.stringify({operation,source,output,password,keymap,receiver:ra.id,workspace,object_id:object,...extra}));
  });
 }
 let image;
 await t.test('actual C++ encryption and Python red-X image encoder produce a valid PNG',async()=>{
  assert.equal((await codec('seal',input,png)).code,0);
  image=await fs.readFile(png);assert.equal(image.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.ok(!image.includes(original));
 });
 const headers=()=>({'content-type':'image/png','x-content-sha256':digest(image)});
 await t.test('PNG upload passes the real carrier decoder and consumes encoded bytes once',async()=>{
  const one=await request(objectURL(),'PUT',image,a.access_token,headers());assert.equal(one.status,201,JSON.stringify(one.body));
  const again=await request(objectURL(),'PUT',image,a.access_token,headers());assert.equal(again.status,200);
  const state=(await request(endpoint+'/v1/receivers/me','GET',undefined,a.access_token)).body;assert.equal(state.usedBytes,image.length);
 });
 await t.test('other account cannot download or write into the first workspace',async()=>{
  assert.equal((await request(objectURL(),'GET',undefined,b.access_token)).status,404);
  assert.equal((await request(objectURL(),'PUT',image,b.access_token,headers())).status,404);
 });
 await t.test('download decrypts byte-for-byte, with filename inside encryption',async()=>{
  const result=await request(objectURL(),'GET',undefined,a.access_token);assert.equal(result.status,200);assert.deepEqual(result.bytes,image);
  await fs.writeFile(download,result.bytes);
  const output=path.join(s.dir,'restored.txt');assert.equal((await codec('restore',download,output)).code,0);assert.deepEqual(await fs.readFile(output),original);
 });
 await t.test('wrong password and wrong object context produce no plaintext file',async()=>{
  for(const extra of [{password:'wrong'},{object_id:id()}]){
   const output=path.join(s.dir,'must-not-exist-'+id());assert.notEqual((await codec('restore',download,output,extra)).code,0);await assert.rejects(fs.stat(output));
  }
 });
 await t.test('fake PNG and wrong upload hashes fail without losing quota',async()=>{
  for(const [body,hash] of [[Buffer.from('not a PNG'),digest('not a PNG')],[image,'f'.repeat(64)]]){
   const url=endpoint+'/v1/receivers/me/workspaces/'+workspace+'/objects/'+id();
   assert.equal((await request(url,'PUT',body,a.access_token,{'content-type':'image/png','x-content-sha256':hash})).status,422);
  }
  assert.equal((await request(endpoint+'/v1/receivers/me','GET',undefined,a.access_token)).body.usedBytes,image.length);
 });
 await t.test('metadata and PNG survive cloud service restart using the same RedX data',async()=>{
  await cloud.close();cloud=await createCloud(options);endpoint=await cloud.listen();
  assert.deepEqual((await request(objectURL(),'GET',undefined,a.access_token)).bytes,image);
 });
 await t.test('on-disk corruption fails closed',async()=>{
  const disk=path.join(options.root,ra.id,object+'.png');const damaged=Buffer.from(image);damaged[damaged.length-10]^=1;await fs.writeFile(disk,damaged);
  assert.equal((await request(objectURL(),'GET',undefined,a.access_token)).status,503);
 });
});
