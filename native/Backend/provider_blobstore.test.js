"use strict";
// BlobStore contract, run against the memory fake and, when available, the real @google-cloud/storage client talking
// to fake-gcs-server (https://github.com/fsouza/fake-gcs-server). Set GD_FAKE_GCS_BIN to the binary, or
// STORAGE_EMULATOR_HOST to an already running emulator (http://host:port). No real Google Cloud project is used.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const net=require("node:net"),{spawn}=require("node:child_process");
const express=require("express");
const {memoryBlobStore,gcsBlobStore}=require("./provider_blobstore");
const {registerProviderV1}=require("./provider_v1");
const {memoryFirestore}=require("./test_firestore");
const sha=b=>crypto.createHash("sha256").update(b).digest("hex");

async function freePort(){return new Promise(r=>{const s=net.createServer().listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>r(p));});});}
async function startEmulator(t){
 if(process.env.STORAGE_EMULATOR_HOST)return process.env.STORAGE_EMULATOR_HOST.replace(/\/$/,"");
 const bin=process.env.GD_FAKE_GCS_BIN;if(!bin)return null;
 const port=await freePort();
 const child=spawn(bin,["-backend","memory","-scheme","http","-host","127.0.0.1","-port",String(port),"-public-host","127.0.0.1:"+port,"-log-level","error"],{stdio:"ignore"});
 t.after(()=>child.kill());
 const url="http://127.0.0.1:"+port;
 for(let i=0;i<100;i++){try{const r=await fetch(url+"/storage/v1/b");if(r.ok)return url;}catch(_){}await new Promise(r=>setTimeout(r,50));}
 throw Error("fake-gcs-server did not start");
}
async function gcsStore(t){
 const url=await startEmulator(t);if(!url)return null;
 const {Storage}=require("@google-cloud/storage");
 const storage=new Storage({apiEndpoint:url,projectId:"demo-gendragoon",useAuthWithCustomEndpoint:false});
 const name="gd-provider-test-"+crypto.randomBytes(4).toString("hex");
 await storage.createBucket(name);
 return gcsBlobStore(storage.bucket(name));
}

async function contract(store,{deletePreconditions=true}={}){
 const name="customer/"+"a".repeat(64)+"/provider/x/b/one";
 assert.equal(await store.head(name),null);
 assert.equal(await store.get(name),null);
 const p1=await store.put(name,Buffer.from("hello"),{ifGenerationMatch:"0",sha256:sha("hello")});
 assert.ok(p1.generation);
 const h=await store.head(name);
 assert.equal(h.size,5);assert.equal(h.sha256,sha("hello"));assert.equal(h.generation,p1.generation);
 await assert.rejects(store.put(name,Buffer.from("again"),{ifGenerationMatch:"0"}),e=>e.code==="precondition_failed");
 await assert.rejects(store.put(name,Buffer.from("again"),{ifGenerationMatch:"999999"}),e=>e.code==="precondition_failed");
 const p2=await store.put(name,Buffer.from("world!"),{ifGenerationMatch:p1.generation,sha256:sha("world!")});
 assert.notEqual(p2.generation,p1.generation);
 const g=await store.get(name);assert.equal(g.data.toString(),"world!");assert.equal(g.generation,p2.generation);
 if(deletePreconditions)assert.equal(await store.delete(name,{ifGenerationMatch:p1.generation}),false,"stale generation does not delete");
 assert.equal(await store.delete(name,{ifGenerationMatch:p2.generation}),true);
 assert.equal(await store.delete(name),false,"absent");
 const base="customer/"+"b".repeat(64)+"/provider/y/b/";
 const ids=[];for(let i=0;i<7;i++){const id=sha("c"+i);ids.push(id);await store.put(base+id,Buffer.from("c"+i),{sha256:sha("c"+i)});}
 ids.sort();
 let page=await store.list(base,{limit:3});assert.deepEqual(page.items.map(i=>i.name.slice(base.length)),ids.slice(0,3));
 assert.equal(page.items[0].size,2);
 const seen=[...page.items];
 while(page.next){page=await store.list(base,{cursor:page.next,limit:3});seen.push(...page.items);}
 assert.deepEqual(seen.map(i=>i.name.slice(base.length)),ids);
 assert.deepEqual((await store.list("customer/"+"c".repeat(64)+"/",{limit:10})).items,[]);
}

test("BlobStore contract: memory fake",async()=>{await contract(memoryBlobStore());});
test("BlobStore contract: gcsBlobStore via @google-cloud/storage + fake-gcs-server",async t=>{
 const store=await gcsStore(t);if(!store)return t.skip("set GD_FAKE_GCS_BIN or STORAGE_EMULATOR_HOST");
 // fake-gcs-server (checked with 1.5x, Oct 2026) ignores ifGenerationMatch on DELETE; real GCS honours it
 // (objects.delete preconditions). Probe so the test states which behaviour it checked.
 const probe="probe/"+crypto.randomBytes(4).toString("hex");const pg=await store.put(probe,Buffer.from("p"));
 const honoured=!(await store.delete(probe,{ifGenerationMatch:String(BigInt(pg.generation)+1n)}));
 if(!honoured)t.diagnostic("emulator ignores DELETE preconditions; stale-generation delete not checked here (real GCS: verify in staging)");
 await contract(store,{deletePreconditions:honoured});
});
test("/provider/v1 end to end on gcsBlobStore: checksum, quota, manifest CAS race",async t=>{
 const store=await gcsStore(t);if(!store)return t.skip("set GD_FAKE_GCS_BIN or STORAGE_EMULATOR_HOST");
 const app=express(),db=memoryFirestore();
 registerProviderV1({app,db,blobs:store,accountKey:u=>sha("gd-v1:"+u),firebaseAuth:(q,_s,n)=>{q.user={uid:"u1"};n();},
  resolveWorkspace:async()=>({quotaBytes:100})});
 const server=await new Promise(r=>{const s=app.listen(0,"127.0.0.1",()=>r(s));});t.after(()=>server.close());
 const base="http://127.0.0.1:"+server.address().port+"/provider/v1";
 const post=(p,b)=>fetch(base+p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)});
 const {grant}=await (await post("/connect/grants",{workspaceId:"free"})).json();
 const {apiKey}=await (await post("/connect/redeem",{grant})).json();
 const call=(p,o={})=>fetch(base+p,{...o,headers:{authorization:"Bearer "+apiKey,...(o.headers||{})}});
 const d=Buffer.alloc(60,7);
 assert.equal((await call("/blobs/"+sha(d),{method:"PUT",body:d})).status,201);
 assert.equal((await call("/blobs/"+sha("x"),{method:"PUT",body:d})).status,422);
 assert.equal((await call("/blobs/"+sha(Buffer.alloc(50,1)),{method:"PUT",body:Buffer.alloc(50,1)})).status,507);
 const got=await call("/blobs/"+sha(d));assert.equal(got.status,200);assert.ok(Buffer.from(await got.arrayBuffer()).equals(d));
 const key="ef".repeat(32);
 const first=await call("/manifests/"+key,{method:"PUT",body:"m1",headers:{"if-none-match":"*"}});assert.equal(first.status,201);
 const etag=first.headers.get("etag");
 const racers=await Promise.all(Array.from({length:6},(_,i)=>call("/manifests/"+key,{method:"PUT",body:"r"+i,headers:{"if-match":etag}})));
 assert.equal(racers.filter(r=>r.status===200).length,1);
 assert.ok(racers.every(r=>r.status===200||r.status===412));
 const u=await (await call("/usage")).json();assert.equal(u.usedBytes,62);assert.equal(u.objectCount,2);
 assert.equal((await call("/blobs/"+sha(d),{method:"DELETE"})).status,204);
 assert.equal((await (await call("/usage")).json()).usedBytes,2);
});
