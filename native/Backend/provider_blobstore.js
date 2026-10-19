"use strict";
// Object storage behind /provider/v1. Two implementations of one small interface:
//   head(name)                         -> {size, generation, sha256} | null
//   get(name)                          -> {data, size, generation, sha256} | null
//   put(name, data, {ifGenerationMatch, sha256}) -> {generation}; throws code "precondition_failed"
//   delete(name, {ifGenerationMatch})  -> true if an object was deleted, false if absent or precondition lost
//   list(prefix, {cursor, limit})      -> {items:[{name,size,generation}], next}
// ifGenerationMatch follows GCS: 0 means "must not exist"; a generation string means "must be that generation".
// The memory store is the test fake. The GCS store has NOT been run against a real bucket or the Storage emulator yet.
const crypto=require("node:crypto");

function preconditionFailed(){return Object.assign(new Error("precondition_failed"),{code:"precondition_failed"});}

function memoryBlobStore(){
 const objects=new Map();let counter=0;const ops=[];
 function check(name,ifGenerationMatch){
  if(ifGenerationMatch===undefined||ifGenerationMatch===null)return;
  const cur=objects.get(name);
  if(String(ifGenerationMatch)==="0"){if(cur)throw preconditionFailed();return;}
  if(!cur||cur.generation!==String(ifGenerationMatch))throw preconditionFailed();
 }
 return {
  objects,ops,
  // Tests set failNext(op) to simulate a storage failure on the next call of that op.
  failures:new Map(),
  failNext(op,error=new Error("storage unavailable")){this.failures.set(op,error);},
  _fail(op){const e=this.failures.get(op);if(e){this.failures.delete(op);throw e;}},
  async head(name){this._fail("head");const o=objects.get(name);return o?{size:o.data.length,generation:o.generation,sha256:o.sha256}:null;},
  async get(name){this._fail("get");const o=objects.get(name);return o?{data:Buffer.from(o.data),size:o.data.length,generation:o.generation,sha256:o.sha256}:null;},
  async put(name,data,{ifGenerationMatch,sha256}={}){
   this._fail("put");check(name,ifGenerationMatch);
   const generation=String(++counter);
   objects.set(name,{data:Buffer.from(data),generation,sha256:sha256||crypto.createHash("sha256").update(data).digest("hex")});
   ops.push(["put",name]);return {generation};
  },
  async delete(name,{ifGenerationMatch}={}){
   this._fail("delete");
   if(!objects.has(name))return false;
   try{check(name,ifGenerationMatch);}catch(_){return false;}
   objects.delete(name);ops.push(["delete",name]);return true;
  },
  async list(prefix,{cursor="",limit=1000}={}){
   this._fail("list");
   const names=[...objects.keys()].filter(n=>n.startsWith(prefix)&&n>cursor).sort();
   const page=names.slice(0,limit);
   return {items:page.map(n=>({name:n,size:objects.get(n).data.length,generation:objects.get(n).generation})),next:names.length>limit?page.at(-1):null};
  },
 };
}

function gcsBlobStore(bucket){
 const isCode=(e,c)=>e?.code===c||e?.response?.status===c||e?.statusCode===c;
 return {
  async head(name){
   try{const [m]=await bucket.file(name).getMetadata();return {size:Number(m.size),generation:String(m.generation),sha256:m.metadata?.sha256||null};}
   catch(e){if(isCode(e,404))return null;throw e;}
  },
  async get(name){
   try{
    const file=bucket.file(name);const [m]=await file.getMetadata();
    const [data]=await file.download({validation:"crc32c",generation:m.generation});
    return {data,size:data.length,generation:String(m.generation),sha256:m.metadata?.sha256||null};
   }catch(e){if(isCode(e,404))return null;throw e;}
  },
  async put(name,data,{ifGenerationMatch,sha256}={}){
   const opts={resumable:false,validation:"crc32c",contentType:"application/octet-stream",metadata:{metadata:{sha256}}};
   if(ifGenerationMatch!==undefined&&ifGenerationMatch!==null)opts.preconditionOpts={ifGenerationMatch:Number(ifGenerationMatch)};
   const file=bucket.file(name);
   try{await file.save(data,opts);}catch(e){if(isCode(e,412))throw preconditionFailed();throw e;}
   const [m]=await file.getMetadata();return {generation:String(m.generation)};
  },
  async delete(name,{ifGenerationMatch}={}){
   const opts=ifGenerationMatch?{ifGenerationMatch:Number(ifGenerationMatch)}:{};
   try{await bucket.file(name).delete(opts);return true;}
   catch(e){if(isCode(e,404)||isCode(e,412))return false;throw e;}
  },
  async list(prefix,{cursor="",limit=1000}={}){
   const [files,,resp]=await bucket.getFiles({prefix,startOffset:cursor?cursor+"\u0000":undefined,maxResults:limit,autoPaginate:false});
   return {items:files.map(f=>({name:f.name,size:Number(f.metadata?.size||0),generation:f.metadata?.generation!=null?String(f.metadata.generation):null})),next:resp?.nextPageToken&&files.length?files.at(-1).name:null};
  },
 };
}
module.exports={memoryBlobStore,gcsBlobStore,preconditionFailed};
