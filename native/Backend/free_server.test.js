"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
process.env.CUSTOMER_BUCKET="gendragoon-test-placeholder";
process.env.STORAGE_PROJECT_ID="gendragood-ssd";
const {app,QUOTA,CHUNK,safeName,validID}=require("./free_server");
const {TransferGovernor}=require("./free_performance");
test("free storage quota is 2 decimal GB and chunks are bounded to 8 MiB",()=>{
 assert.equal(QUOTA,2_000_000_000);assert.equal(CHUNK,8*1024*1024);
});
test("user-facing filenames cannot contain path traversal",()=>{
 assert.equal(safeName("  Project.txt "), "Project.txt");
 for(const name of ["../private","a/b","\\secrets",".","..","",String.fromCharCode(0), "x".repeat(151)])assert.throws(()=>safeName(name));
});
test("IDs must be opaque 36-char UUID-shaped values",()=>{
 assert.equal(validID("a1b2c3d4-1111-4111-8111-a1b2c3d4e5f6"),true);
 for(const name of ["..","free","", "/tmp/file", "111"] )assert.equal(validID(name),false);
});
test("anonymous clients cannot list files, create workspace or upload bytes",async()=>{
 const server=await new Promise(resolve=>{
   const s=app.listen(0,"127.0.0.1",()=>resolve(s));
 });
 const base="http://127.0.0.1:"+server.address().port;
 try{
  const health=await fetch(base+"/health");assert.equal(health.status,200);
  for(const url of ["/v1/me","/v1/files"]){
   const r=await fetch(base+url);assert.equal(r.status,401,url);
  }
  const init=await fetch(base+"/v1/uploads",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  assert.equal(init.status,401);
  const create=await fetch(base+"/v1/free",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  assert.equal(create.status,401);
  const chunk=await fetch(base+"/v1/uploads/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/chunks/0",
      {method:"PUT",body:Buffer.from("unauthorized")});
  assert.equal(chunk.status,401);
 }finally{await new Promise(resolve=>server.close(resolve))}
});
test("free transfer queue never runs more than one active operation",async()=>{
 const gov=new TransferGovernor();let active=0,max=0;
 await Promise.all(Array.from({length:13},()=>gov.run("tenant-1",{kind:"free",provisioned:true},async()=>{
  active++;max=Math.max(active,max);await new Promise(r=>setTimeout(r,3));active--;
 })));
 assert.equal(max,1);
});
test("unprovisioned customer transfers are always denied",async()=>{
 const gov=new TransferGovernor();
 await assert.rejects(()=>gov.run("test",{kind:"free",provisioned:false},async()=>{}));
 await assert.rejects(()=>gov.run("test",{kind:"paid",provisioned:true},async()=>{}));
});
