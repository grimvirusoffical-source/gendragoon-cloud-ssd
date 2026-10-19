'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture}=require('./test_helpers/transfer_fixture');
for(const tier of ['free','standard','lite','boost','turbo','ultra','max']){
 test(`stress ${tier}: 40 concurrent uploads, retries, finalization, restore and deletion`,async()=>{
  const f=fixture(tier,2);const count=40,size=32768;const bytes=crypto.randomBytes(size);
  async function retry(action){for(let attempt=0;attempt<5;attempt++){const r=await action();if(r.status!==429)return r;assert.equal(r.headers.get('retry-after'),'2');await r.text();await new Promise(done=>setTimeout(done,2000));}throw Error('Backpressure did not recover');}
  try{
   const jobs=await Promise.all(Array.from({length:count},(_,i)=>f.create(`stress-${i}.bin`,size)));
   assert.equal(f.docs.get(f.wsPath).reservedBytes,count*size);
   const puts=await Promise.all(jobs.map(j=>retry(()=>f.chunk(j.uploadId,0,bytes))));
   for(const r of puts)assert.equal(r.status,200,await r.text());
   const retries=await Promise.all(jobs.map(j=>retry(()=>f.chunk(j.uploadId,0,bytes))));
   for(const r of retries)assert.equal(r.status,200,await r.text());
   const finalize=await Promise.all(jobs.map(j=>f.call(`/uploads/${j.uploadId}/finalize`,{method:'POST'})));
   for(const r of finalize)assert.equal(r.status,200,await r.text());
   assert.equal(f.docs.get(f.wsPath).reservedBytes,0);
   assert.equal(f.docs.get(f.wsPath).usedBytes,count*size);
   await Promise.all(jobs.map(async j=>{
    const full=await f.call(`/files/${j.uploadId}/download`);assert.equal(full.status,200);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes);
    const range=await f.call(`/files/${j.uploadId}/download`,{headers:{Range:'bytes=4096-8191'}});
    assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),bytes.subarray(4096,8192));
   }));
   const deletes=await Promise.all(jobs.map(j=>f.call(`/files/${j.uploadId}`,{method:'DELETE'})));
   for(const r of deletes)assert.ok([200,204].includes(r.status),await r.text());
   assert.equal(f.docs.get(f.wsPath).usedBytes,0);
   assert.equal(f.docs.get(f.wsPath).reservedBytes,0);
  }finally{await f.close();}
 });
}
