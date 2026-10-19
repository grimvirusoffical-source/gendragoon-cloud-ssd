"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),express=require("express");
const crypto=require("node:crypto"),{Writable,Readable}=require("node:stream");
const {registerPaidStorage}=require("./paid_storage");
const hash=x=>crypto.createHash("sha256").update("gd-v1:"+x).digest("hex");
const uid="upload-integration-A",owner=hash(uid),wid="bd075169-b982-4acb-a26d-7da17915b18f";
function fixture(){
 const fs=new Map(),uploads=new Map(),objects=new Map();
 const workspace={kind:"paid",accountHash:owner,storageTier:"100GB",
  storageMode:"standard",storageActive:true,provisioned:true,
  performanceActive:false,usedBytes:0,reservedBytes:0};
 const bucket={
  store:new Map(),
  file(key){
   return {
    createWriteStream(){
     const parts=[];
     return new Writable({write(chunk,_enc,callback){parts.push(Buffer.from(chunk));callback()},
      final(callback){bucket.store.set(key,Buffer.concat(parts));callback()}});
    },
    async getMetadata(){
     if(!bucket.store.has(key))throw Error("Missing object");
     return [{size:bucket.store.get(key).length}];
    },
    createReadStream(){return Readable.from([bucket.store.get(key)])},
    async delete(){bucket.store.delete(key)}
   }
  },
  async combine(keys,target){bucket.store.set(target,Buffer.concat(keys.map(k=>bucket.store.get(k))))},
  async deleteFiles({prefix}){for(const k of bucket.store.keys())if(k.startsWith(prefix))bucket.store.delete(k)}
 };
 function collection(store){
  return {
   doc(id){
    return {
     id,
     get:async()=>{const snapshot=store.get(id);return {exists:store.has(id),data:()=>snapshot}},
     async create(d){if(store.has(id))throw Error("EXISTS");store.set(id,d)},
     async update(change){const old=store.get(id);if(!old)throw Error("Missing record");
       const next={...old};
       for(const [k,v]of Object.entries(change)){
        next[k]=(v && typeof v==="object" && "increment" in v)?
          (old[k]||0)+v.increment:v;
       }
       Object.assign(old,next);store.set(id,old);
     },
     async delete(){store.delete(id)}
    }
   },
   orderBy:()=>({limit:()=>({get:async()=>({docs:[...store].map(([id,data])=>({id,data:()=>data}))})})}),
   where:(key,_op,value)=>({limit:()=>({get:async()=>({docs:[...store]
    .filter(([,d])=>d[key]===value)
    .map(([id,data])=>({...collection(store).doc(id),data:()=>data}))})})})
  }
 }
 const workspaces=collection(new Map([[wid,workspace]]));
 const ref=workspaces.doc(wid);
 ref.collection=name=>collection(name==="uploads"?uploads:fs);
 const emptyDoc=()=>({get:async()=>({exists:false,data:()=>undefined})});
 const db={collection:name=>{
  if(name==="tenants")return {doc:()=>({collection:()=>({doc:emptyDoc})})};
  assert.equal(name,"gd_accounts");
  return {doc:userHash=>({collection:collectionName=>{
   assert.equal(collectionName,"workspaces");
   return {
    doc:id=>id===wid&&userHash===owner?ref:collection(new Map()).doc(id),
    limit(){return this;},
    get:async()=>userHash===owner?{docs:[{id:wid,data:()=>({...workspace})}]}:{docs:[]}
   };
  }})};
 },runTransaction:async handler=>{
  const tx={get:r=>r.get(),create:(r,d)=>r.create(d),update:(r,d)=>r.update(d),delete:r=>r.delete()};
  return handler(tx);
 }};
 const app=express();
 registerPaidStorage({app,db,bucket,accountKey:hash,FieldValue:{
  increment:n=>({increment:n}),serverTimestamp:()=>new Date()
 },apiKeys:{verify:async()=>null},getAuth:()=>({}),
 firebaseAuth:(req,res,next)=>{
  if(req.headers.authorization!=="Bearer mock-auth")return res.status(401).end();
  req.user={uid};next();
 }});
 const server=app.listen(0,"127.0.0.1");
 return {server,ready:new Promise(ok=>server.once("listening",ok)),
  workspace,store:bucket.store,files:fs,uploads};
}
test("paid account upload/verify/list/download/delete integrity roundtrip",async()=>{
 const f=fixture();await f.ready;
 const endpoint="http://127.0.0.1:"+f.server.address().port+
    "/v2/workspaces/"+wid+"/cloud";
 const token="Bearer mock-auth";
 async function call(path,init={}){
  return fetch(endpoint+path,{...init,headers:{Authorization:token,...init.headers}});
 }
 try{
  const content=crypto.randomBytes(250_000),name="large-beat-demo.wav";
  const create=await call("/uploads",{method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({name,sizeBytes:content.length})});
  assert.equal(create.status,201,await create.clone().text());
  const session=await create.json();
  assert.equal(session.totalChunks,1);
  assert.equal(f.workspace.reservedBytes,250_000);
  const piece=await call("/uploads/"+session.uploadId+"/chunks/0",{
   method:"PUT",headers:{"Content-Type":"application/octet-stream"},body:content});
  assert.equal(piece.status,200,await piece.text());
  const final=await call("/uploads/"+session.uploadId+"/finalize",{method:"POST"});
  assert.equal(final.status,200,await final.text());
  assert.equal(f.workspace.usedBytes,250_000);
  assert.equal(f.workspace.reservedBytes,0);
  const listed=await call("/files"),listing=await listed.json();
  assert.equal(listed.status,200);
  assert.equal(listing.files.length,1);
  assert.equal(listing.files[0].name,name);
  assert.equal(listing.quotaBytes,100_000_000_000);
  const response=await call("/files/"+session.uploadId+"/download");
  assert.equal(response.status,200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),content);
  const del=await call("/files/"+session.uploadId,{method:"DELETE"});
  assert.equal(del.status,200);
  assert.equal(f.workspace.usedBytes,0);
  const listedAgain=await call("/files");
  assert.equal((await listedAgain.json()).files.length,0);
 }finally{await new Promise(r=>f.server.close(r))}
});
