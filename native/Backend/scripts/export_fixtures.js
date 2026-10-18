"use strict";
// Generates fixtures/key-envelope/*.json from the real key-envelope handlers.
const crypto=require("node:crypto");
const fs=require("node:fs");
const path=require("node:path");
const express=require("express");
const {memoryFirestore}=require("../test_firestore");
const {registerKeyEnvelope}=require("../key_envelope");

const outDir=path.resolve(process.argv[2]||path.join(__dirname,"../../../fixtures"));
const ownerUid="owner";
const hash=uid=>crypto.createHash("sha256").update("fixture:"+uid).digest("hex");
const owner=hash(ownerUid);
const workspace="11111111-1111-4111-8111-000000000001";
const wrapped=Buffer.alloc(48,7).toString("base64");
const argon={memory:19*1024*1024,iterations:2,parallelism:1};
function envelope(version,extra={}){return {version,wrappedKey:wrapped,kdf:"argon2id",kdfParams:argon,...extra};}

function sortValue(value){
 if(Array.isArray(value))return value.map(sortValue);
 if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sortValue(value[key])]));
 return value;
}
function writeCase(area,name,record){
 const dir=path.join(outDir,area);
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,name+".json"),JSON.stringify(sortValue(record),null,2)+"\n");
}
function redact(headers){
 return Object.fromEntries(Object.entries(headers).map(([key,value])=>[key.toLowerCase(),key.toLowerCase()==="authorization"?"<redacted>":value]));
}
async function capture(base,method,requestPath,{body,headers}={}){
 const sent={authorization:"Bearer owner",...headers};
 if(method!=="GET"&&method!=="HEAD")sent["content-type"]="application/json";
 const response=await fetch(base+requestPath,{method,headers:sent,body:body===undefined?undefined:JSON.stringify(body)});
 const text=await response.text();
 let parsed=null;
 if(text){try{parsed=JSON.parse(text);}catch(_){parsed=text;}}
 return {request:{method,path:requestPath,headers:redact(sent),body:body===undefined?null:body},response:{status:response.status,body:parsed}};
}
async function listen(){
 const db=memoryFirestore([["gd_accounts/"+owner+"/workspaces/"+workspace,{kind:"paid",accountHash:owner}]]);
 const app=express();
 app.use(express.json({limit:"16kb"}));
 registerKeyEnvelope({app,db,hash,firebaseAuth:(req,res,next)=>{
  if((req.headers.authorization||"")!=="Bearer owner")return res.status(401).json({error:"invalid_token"});
  req.user={uid:ownerUid};
  next();
 }});
 const server=app.listen(0,"127.0.0.1");
 await new Promise(resolve=>server.once("listening",resolve));
 return {base:"http://127.0.0.1:"+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}
async function main(){
 const url="/v2/workspaces/"+workspace+"/key-envelope";
 const app=await listen();
 try{
  const missing=await capture(app.base,"GET",url);
  if(missing.response.status!==404)throw Error("GET missing "+JSON.stringify(missing.response));
  writeCase("key-envelope","get-missing",missing);
  const created=await capture(app.base,"PUT",url,{headers:{"if-none-match":"*"},body:envelope(1)});
  if(created.response.status!==201||created.response.body?.version!==1)throw Error("create "+JSON.stringify(created.response));
  writeCase("key-envelope","create",created);
  const conflict=await capture(app.base,"PUT",url,{headers:{"if-none-match":"*"},body:envelope(1)});
  if(conflict.response.status!==409||conflict.response.body?.error!=="envelope_exists")throw Error("409 "+JSON.stringify(conflict.response));
  writeCase("key-envelope","conflict",conflict);
  const updated=await capture(app.base,"PUT",url,{headers:{"if-match":'"1"'},body:envelope(2)});
  if(updated.response.status!==200||updated.response.body?.version!==2)throw Error("update "+JSON.stringify(updated.response));
  writeCase("key-envelope","update",updated);
  const stale=await capture(app.base,"PUT",url,{headers:{"if-match":'"1"'},body:envelope(2)});
  if(stale.response.status!==412||stale.response.body?.error!=="version_mismatch")throw Error("412 "+JSON.stringify(stale.response));
  writeCase("key-envelope","version-mismatch",stale);
  const huge=Buffer.alloc(5000,3).toString("base64");
  const oversized=await capture(app.base,"PUT",url,{headers:{"if-match":'"2"'},body:envelope(3,{wrappedKey:huge})});
  if(oversized.response.status!==413||oversized.response.body?.error!=="payload_too_large")throw Error("413 "+JSON.stringify(oversized.response));
  writeCase("key-envelope","payload-too-large",oversized);
  const bad=await capture(app.base,"PUT",url,{headers:{"if-match":'"2"'},body:{version:3,wrappedKey:wrapped,kdf:"argon2id",kdfParams:{memory:64*1024*1024*1024,iterations:1,parallelism:1}}});
  if(bad.response.status!==422||bad.response.body?.error!=="kdf_params_invalid")throw Error("422 "+JSON.stringify(bad.response));
  writeCase("key-envelope","kdf-params-invalid",bad);
  const current=await capture(app.base,"GET",url);
  if(current.response.status!==200||current.response.body?.version!==2)throw Error("GET "+JSON.stringify(current.response));
  writeCase("key-envelope","get",current);
 }finally{await app.close();}
}
main().catch(error=>{console.error(error);process.exit(1);});
