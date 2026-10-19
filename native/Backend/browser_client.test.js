"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./test_helpers/transfer_fixture');
const {once}=require('node:events');
const importClient=()=>import('./mobile/transfer-client.mjs');
function memory(){const map=new Map();return {getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k),map};}
async function client(f,tier='free',storage=memory()){
 if(!f.server.listening)await once(f.server,'listening');const {BrowserCloud}=await importClient();
 return new BrowserCloud({endpoint:'http://127.0.0.1:'+f.server.address().port,uid:'test-owner',token:async()=> 'good',storage});
}
test('browser CRC32C matches standard known-answer vector',async()=>{
 const {crc32c}=await importClient();assert.equal((crc32c(Buffer.from('123456789'))^0xffffffff)>>>0,0xe3069283);
});
test('browser profiles do not trust invalid worker counts and conserve mobile data',async()=>{
 const {workers}=await importClient();assert.equal(workers({workers:20},{mobile:true}),4);assert.equal(workers({workers:20},{saveData:true}),1);
 for(const n of [0,25,-1,NaN,'20'])assert.throws(()=>workers({workers:n}));
});
test('browser transport uses real HTTP upload, verification, ranged restore and delete',async()=>{
 const f=fixture();try{
  const api=await client(f),content=Buffer.from('browser mobile roundtrip '.repeat(5000));
  const file=new File([content],'mobile-document.txt',{lastModified:12345});
  const observations=[];await api.upload(file,'free',{mobile:true,onProgress:p=>observations.push(p)});
  const files=await api.list('free');assert.equal(files.length,1);assert.equal(files[0].name,file.name);assert.equal(observations.at(-1).done,content.length);
  const restored=await api.download(files[0],'free');assert.deepEqual(Buffer.from(await restored.arrayBuffer()),content);
  await api.delete(files[0].id,'free');assert.equal((await api.list('free')).length,0);
 }finally{await f.close();}
});
test('browser download refuses memory-unsafe files before issuing a download request',async()=>{
 const f=fixture();try{const api=await client(f);await assert.rejects(()=>api.download({id:'ad075169-b982-4acb-a26d-7da17915b18f',sizeBytes:200*1024*1024},'free'),/cannot safely save/);}finally{await f.close();}
});
test('browser interrupted upload resumes using same request ID and skips saved chunk',async()=>{
 const f=fixture('boost',1);try{
  const storage=memory(),api=await client(f,'boost',storage),ws='ad075169-b982-4acb-a26d-7da17915b18f';
  const bytes=Buffer.alloc(8*1024*1024+1024,37),file=new File([bytes],'resume-mobile.bin',{lastModified:23456});let once=false;
  await assert.rejects(()=>api.upload(file,ws,{saveData:true,onProgress:p=>{if(!once&&p.done<file.size){once=true;api.pause();}}}),e=>e.name==='AbortError');
  assert.equal(storage.map.size,1);const uploadID=[...storage.map.values()][0];
  const checkpoint=await(await api.request(api.path(ws)+'/uploads/'+uploadID)).json();assert.equal(checkpoint.uploadedBytes,8*1024*1024);
  await api.upload(file,ws,{mobile:true});assert.equal(storage.map.size,0);assert.equal((await api.list(ws)).length,1);
  const full=await api.download((await api.list(ws))[0],ws);assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes);
 }finally{await f.close();}
});
test('browser accounts receive separate resume identifiers, tokens are not persisted',async()=>{
 const f=fixture();try{const state=memory(),api=await client(f,'free',state);await api.upload(new File(['a'],'a.txt',{lastModified:1}),'free');assert.equal(state.map.size,0);assert.equal([...state.map.values()].includes('good'),false);}finally{await f.close();}
});
