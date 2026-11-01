'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {createCloud}=require('../server.cjs');

const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const issuer='https://red-xai.com';
class Store {
 constructor(){this.data=new Map();}
 async ensure(key, quota){if(!this.data.has(key))this.data.set(key,{schema:1,owner:key,id:key,revision:0,quota,used:0,workspaces:{},objects:{},library:{}});return this.get(key);}
 async get(key){return this.data.has(key)?structuredClone(this.data.get(key)):null;}
 async change(key,fn){const state=await this.get(key);fn(state);state.revision++;this.data.set(key,state);return structuredClone(state);}
}
function receiverId(subject){return hash(JSON.stringify(['red-xai-receiver/v1',issuer,subject]));}

test('Receiver accepts verified opt-in 1 MiB PNG and rejects forged carriers without changing encrypted validator',{timeout:40000},async t=>{
 const tmp=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'gd-fast-receiver-'));
 const store=new Store();
 const cloud=await createCloud({issuer,authProvider:'redx-site-session',store,root:path.join(tmp,'receiver'),
  quota:24*1024*1024,python:process.env.GENDRAGOON_TEST_PYTHON||'python3',
  fetchImpl:async(url,opts)=>{
   assert.equal(url,issuer+'/redxai-connect/userinfo');
   const who=(opts.headers.authorization||'').slice('Bearer rxca_'.length, 'Bearer rxca_'.length+1);
   return Response.json({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',
                        sub:who==='B'?'bob':'alice',email_verified:true,email:who+'@example.test'});
  }});
 const api=await cloud.listen();
 t.after(async()=>{await cloud.close();await fs.rm(tmp,{recursive:true,force:true});});
 const token=who=>'Bearer rxca_'+who.repeat(43);
 async function call(who,method,route,body,headers={}){
  const response=await fetch(api+route,{method,headers:{authorization:token(who),...headers},...(body!==undefined?{body}:{})});
  const bytes=Buffer.from(await response.arrayBuffer());
  let json;try{json=JSON.parse(bytes.toString());}catch{}
  return{status:response.status,bytes,json,headers:response.headers};
 }
 const receiverResponse=await call('A','PUT','/v1/receivers/me');
 assert.equal(receiverResponse.status,200);
 assert.ok(receiverResponse.json.supportedStorageFormats.includes('gendragoon-plaintext-png-v1'));
 assert.equal((await call('B','PUT','/v1/receivers/me')).status,200);
 const workspace='d'.repeat(32),id='a'.repeat(32);
 const created=await call('A','POST','/v1/receivers/me/workspaces',JSON.stringify({name:'Plain test note'}),
  {'content-type':'application/json','idempotency-key':workspace});
 assert.equal(created.status,200,JSON.stringify(created.json));
 const png=path.join(tmp,'fast.png');
 const source=path.join(__dirname,'../../Resources/gendragoon_fast_png.py');
 const mirror=path.join(__dirname,'../gendragoon_fast_png.py');
 assert.equal(hash(await fs.readFile(source)),hash(await fs.readFile(mirror)),'Server decoder and client format must match exactly');
 const code=['from pathlib import Path','import sys,os,gendragoon_fast_png as c',
  'Path(sys.argv[1]).write_bytes(c.encode(os.urandom(1024*1024),sys.argv[2]))'].join('\n');
 execFileSync(process.env.GENDRAGOON_TEST_PYTHON||'python3',['-c',code,png,id],{
  env:{...process.env,PYTHONPATH:path.join(__dirname,'..')},timeout:10000});
 const carrier=await fs.readFile(png);
 assert.ok(carrier.length>1024*1024&&carrier.length<2*1024*1024);
 const route='/v1/receivers/me/workspaces/'+workspace+'/blobs/'+id;
 const headers={'content-type':'image/png','content-length':String(carrier.length),'x-content-sha256':hash(carrier)};
 let result=await call('A','PUT',route,carrier,headers);
 assert.equal(result.status,201,JSON.stringify(result.json));
 assert.equal(result.json.status,'ready');
 result=await call('A','GET',route);
 assert.equal(result.status,200);
 assert.deepEqual(result.bytes,carrier);
 assert.equal(result.headers.get('x-content-sha256'),hash(carrier));
 assert.equal((await call('B','GET',route)).status,404);
 const sidecar=JSON.parse(await fs.readFile(path.join(tmp,'receiver',receiverId('alice'),workspace,id+'.json')));
 assert.equal(sidecar.encoding,'gendragoon-plaintext-png-v1');
 const reused=await call('A','PUT',route,carrier,headers);
 assert.equal(reused.status,200);assert.equal(reused.json.reused,true);
 const bad=Buffer.from(carrier);bad[bad.length-20]^=1;
 const wrongOid='b'.repeat(32);
 for(const [payload,object] of [[bad,'c'.repeat(32)],[carrier,wrongOid]]){
  const response=await call('A','PUT','/v1/receivers/me/workspaces/'+workspace+'/blobs/'+object,
   payload,{'content-type':'image/png','content-length':String(payload.length),'x-content-sha256':hash(payload)});
  assert.equal(response.status,422,JSON.stringify(response.json));
 }
 const state=(await call('A','GET','/v1/receivers/me')).json;
 assert.equal(state.usedBytes,carrier.length,'Failed carrier reservations must not consume quota');
});
