"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
process.env.CUSTOMER_BUCKET="gendragoon-test-placeholder";
process.env.STORAGE_PROJECT_ID="gendragood-ssd";
const {app,QUOTA,CHUNK,safeName,validID,trustProxyHops}=require("./free_server");
const express=require("express");
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

test("req.ip is the client address Cloud Run appended, not one the client forged",async()=>{
 assert.equal(app.get("trust proxy"),1);
 assert.equal(trustProxyHops({}),1);assert.equal(trustProxyHops({TRUST_PROXY_HOPS:"0"}),0);assert.equal(trustProxyHops({TRUST_PROXY_HOPS:"2"}),2);
 for(const bad of ["true","-1","4","1.5"," 1"])assert.throws(()=>trustProxyHops({TRUST_PROXY_HOPS:bad}),/TRUST_PROXY_HOPS/);
 const ipOf=async(hops,xff)=>{
  const a=express();a.set("trust proxy",hops);a.get("/ip",(req,res)=>res.json({ip:req.ip}));
  const s=await new Promise(r=>{const x=a.listen(0,"127.0.0.1",()=>r(x));});
  try{return (await (await fetch("http://127.0.0.1:"+s.address().port+"/ip",{headers:xff?{"X-Forwarded-For":xff}:{}})).json()).ip;}
  finally{s.close();}
 };
 // Cloud Run appends the peer address: "<whatever the client sent>, <client>".
 assert.equal(await ipOf(app.get("trust proxy"),"203.0.113.7"),"203.0.113.7");
 assert.equal(await ipOf(app.get("trust proxy"),"198.51.100.1, 10.0.0.9, 203.0.113.7"),"203.0.113.7");
 assert.equal(await ipOf(0,"203.0.113.7"),"127.0.0.1");
 assert.equal(await ipOf(true,"198.51.100.1, 203.0.113.7"),"198.51.100.1"); // why "trust everything" is wrong
});
