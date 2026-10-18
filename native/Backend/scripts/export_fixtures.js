"use strict";
// Generates fixtures/storage-urls/*.json from the real storage-url handler.
const crypto=require("node:crypto");
const fs=require("node:fs");
const path=require("node:path");
const express=require("express");
const {memoryFirestore}=require("../test_firestore");
const {registerStorageUrls}=require("../storage_urls");

const NOW=1_700_000_000_000;
const outDir=path.resolve(process.argv[2]||path.join(__dirname,"../../../fixtures"));
const ownerUid="owner";
const hash=uid=>crypto.createHash("sha256").update("fixture:"+uid).digest("hex");
const owner=hash(ownerUid);
const workspace="11111111-1111-4111-8111-000000000001";
const objectId="0123456789abcdef0123456789abcdef";
const bucketName="gendragoon-managed-test";

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
function bucket(){
 return {name:bucketName,file(name){return {
  async getSignedUrl(){
   return ["https://storage.googleapis.com/"+bucketName+"/"+name+"?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Expires=900"];
  },
  async getMetadata(){return [{generation:"42"}];},
 };}};
}
async function listen(locked=false){
 const db=memoryFirestore([["gd_accounts/"+owner+"/workspaces/"+workspace,{kind:"paid",accountHash:owner,locked,provisioned:true}]]);
 const app=express();
 app.use(express.json({limit:"16kb"}));
 registerStorageUrls({app,db,bucket:bucket(),hash,now:()=>NOW,firebaseAuth:(req,res,next)=>{
  if((req.headers.authorization||"")!=="Bearer owner")return res.status(401).json({error:"invalid_token"});
  req.user={uid:ownerUid};
  next();
 }});
 const server=app.listen(0,"127.0.0.1");
 await new Promise(resolve=>server.once("listening",resolve));
 return {base:"http://127.0.0.1:"+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}
async function main(){
 const url="/v2/workspaces/"+workspace+"/storage-urls";
 const app=await listen(false);
 try{
  const put=await capture(app.base,"POST",url,{body:{op:"put",objects:[objectId]}});
  if(put.response.status!==200||put.response.body?.urls?.[0]?.method!=="PUT")throw Error("put "+JSON.stringify(put.response));
  writeCase("storage-urls","put",put);
  const get=await capture(app.base,"POST",url,{body:{op:"get",objects:[objectId]}});
  if(get.response.status!==200||get.response.body?.urls?.[0]?.method!=="GET")throw Error("get "+JSON.stringify(get.response));
  writeCase("storage-urls","get",get);
  const removed=await capture(app.base,"POST",url,{body:{op:"delete",objects:[objectId]}});
  if(removed.response.status!==200||removed.response.body?.mode!=="delete"||removed.response.body?.urls?.[0]?.method!=="DELETE")
   throw Error("delete "+JSON.stringify(removed.response));
  writeCase("storage-urls","delete",removed);
  const missing=await capture(app.base,"POST",url,{body:{op:"put",objects:["manifest"]}});
  if(missing.response.status!==400||missing.response.body?.error!=="manifest_generation_required")throw Error("manifest generation "+JSON.stringify(missing.response));
  writeCase("storage-urls","manifest-generation-required",missing);
  const manifestPut=await capture(app.base,"POST",url,{body:{op:"put",objects:["manifest"],ifGeneration:0}});
  if(manifestPut.response.status!==200||!manifestPut.response.body?.urls?.[0]?.url.includes("/manifest?"))
   throw Error("manifest put "+JSON.stringify(manifestPut.response));
  writeCase("storage-urls","manifest-put",manifestPut);
  const manifestGet=await capture(app.base,"POST",url,{body:{op:"get",objects:["manifest"]}});
  if(manifestGet.response.status!==200||manifestGet.response.body?.urls?.[0]?.generation!=="42")
   throw Error("manifest get "+JSON.stringify(manifestGet.response));
  writeCase("storage-urls","manifest-get",manifestGet);
  const manifestDelete=await capture(app.base,"POST",url,{body:{op:"delete",objects:["manifest"]}});
  if(manifestDelete.response.status!==200||manifestDelete.response.body?.urls?.[0]?.method!=="DELETE")
   throw Error("manifest delete "+JSON.stringify(manifestDelete.response));
  writeCase("storage-urls","manifest-delete",manifestDelete);
  const badOp=await capture(app.base,"POST",url,{body:{op:"resumable",objects:[objectId]}});
  if(badOp.response.status!==400||badOp.response.body?.error!=="invalid_op")throw Error("invalid op "+JSON.stringify(badOp.response));
  writeCase("storage-urls","invalid-op",badOp);
  const badId=await capture(app.base,"POST",url,{body:{op:"get",objects:["notes.txt"]}});
  if(badId.response.status!==400||badId.response.body?.error!=="invalid_object_id")throw Error("invalid id "+JSON.stringify(badId.response));
  writeCase("storage-urls","invalid-object-id",badId);
 }finally{await app.close();}
 const locked=await listen(true);
 try{
  const refused=await capture(locked.base,"POST",url,{body:{op:"put",objects:[objectId]}});
  if(refused.response.status!==423||refused.response.body?.error!=="workspace_lock")throw Error("locked "+JSON.stringify(refused.response));
  writeCase("storage-urls","locked",refused);
  const refusedDelete=await capture(locked.base,"POST",url,{body:{op:"delete",objects:["manifest"]}});
  if(refusedDelete.response.status!==423||refusedDelete.response.body?.error!=="workspace_lock")throw Error("locked delete "+JSON.stringify(refusedDelete.response));
  writeCase("storage-urls","locked-delete",refusedDelete);
 }finally{await locked.close();}
}
main().catch(error=>{console.error(error);process.exit(1);});
