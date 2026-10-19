"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {Storage}=require("@google-cloud/storage");
const cfg=JSON.parse(fs.readFileSync(path.join(__dirname,"customer-storage.json"),"utf8"));
if(cfg.bucket==="gen-dragoon-ssd")throw Error("Never use personal bucket");
const bucket=new Storage({projectId:cfg.project}).bucket(cfg.bucket);
(async()=>{
 const prefix="internal-service-test/"+crypto.randomUUID();
 const a=bucket.file(prefix+"/a"),b=bucket.file(prefix+"/b"),c=bucket.file(prefix+"/combined");
 try{
  await a.save(Buffer.from("Hello "),{resumable:false});
  await b.save(Buffer.from("GenDragoon"),{resumable:false});
  await bucket.combine([a.name,b.name],c.name);
  const [data]=await c.download();
  if(data.toString()!=="Hello GenDragoon")throw Error("Cloud object composition mismatch");
  console.log("PRIVATE_CUSTOMER_BUCKET_COMPOSE_TEST_PASSED");
 }finally{
  for(const f of [a,b,c]){try{await f.delete({ignoreNotFound:true})}catch(e){}}
 }
})().catch(e=>{console.log("COMPOSE_TEST_FAILED",e.code||e.name,String(e.message).slice(0,180));process.exitCode=1;});
