"use strict";
// Disposable Firestore contract fixture: transactions are serializable, writes
// commit together, and reads after the first write are rejected like Firestore.
// No credentials, sockets, cloud APIs, or production records are used.
function memoryFirestore(initial=[]){
 const rows=new Map(initial.map(([key,value])=>[key,structuredClone(value)]));
 let tail=Promise.resolve();
 function fieldAt(row,key){
  if(row==null)return undefined;
  if(!key.includes("."))return row[key];
  let cur=row;
  for(const part of key.split(".")){
   if(cur==null||typeof cur!=="object")return undefined;
   cur=cur[part];
  }
  return cur;
 }
 function isIso(value){return typeof value==="string"&&/^\d{4}-\d{2}-\d{2}T/.test(value);}
 function compareValues(left,right){
  if(left instanceof Date||right instanceof Date||isIso(left)||isIso(right)){
   const stamp=value=>value instanceof Date?value.getTime():typeof value==="number"?value:Date.parse(value);
   const a=stamp(left),b=stamp(right);
   return (Number.isFinite(a)?a:0)-(Number.isFinite(b)?b:0);
  }
  return ((left||0)-(right||0));
 }
 function matches(row,filter){
  const value=fieldAt(row,filter.key);
  if(filter.op==="==")return value===filter.value;
  if(filter.op==="in")return Array.isArray(filter.value)&&filter.value.includes(value);
  if(value===undefined||value===null)return false;
  const cmp=compareValues(value,filter.value);
  if(filter.op==="<=")return cmp<=0;
  if(filter.op==="<")return cmp<0;
  if(filter.op===">=")return cmp>=0;
  if(filter.op===">")return cmp>0;
  return false;
 }
 function snap(path){return {exists:rows.has(path),id:path.split("/").at(-1),ref:doc(path),data:()=>structuredClone(rows.get(path))};}
 function doc(path){return {path,id:path.split("/").at(-1),get:async()=>snap(path),collection:name=>collection(path+"/"+name),
   create:async value=>{if(rows.has(path))throw Object.assign(Error("exists"),{code:6});rows.set(path,structuredClone(value));},
   set:async(value,options)=>{rows.set(path,structuredClone(options?.merge?{...rows.get(path),...value}:value));},
   update:async value=>{if(!rows.has(path))throw Error("missing");rows.set(path,{...rows.get(path),...structuredClone(value)});},
   delete:async()=>rows.delete(path)};}
 function collection(path,filters=[],maximum=Infinity,sort=null){
   const query={path,doc:id=>doc(path+"/"+id),limit:n=>collection(path,filters,n,sort),
     where:(key,op,value)=>collection(path,[...filters,{key,op,value}],maximum,sort),
     orderBy:(key,direction="asc")=>collection(path,filters,maximum,{key,direction}),
     get:async()=>{
       let matchesRows=[...rows.keys()].filter(key=>key.startsWith(path+"/")&&!key.slice(path.length+1).includes("/"))
         .filter(key=>filters.every(filter=>matches(rows.get(key),filter)));
       if(sort)matchesRows.sort((a,b)=>compareValues(fieldAt(rows.get(a),sort.key),fieldAt(rows.get(b),sort.key))*(sort.direction==="desc"?-1:1));
       const docs=matchesRows.slice(0,maximum).map(snap);return {docs,empty:docs.length===0,size:docs.length};
     }};return query;
 }
 const db={collection,doc,rows,transactionCount:0,runTransaction(fn){
   const run=tail.then(async()=>{
     db.transactionCount++;const writes=[];
     const tx={get:async ref=>{if(writes.length)throw Error("Firestore reads must precede writes");return ref.get();},
       set:(ref,value,options)=>writes.push(()=>ref.set(value,options)),update:(ref,value)=>writes.push(()=>ref.update(value)),
       create:(ref,value)=>writes.push(()=>ref.create(value)),delete:ref=>writes.push(()=>ref.delete())};
     const result=await fn(tx);for(const apply of writes)await apply();return result;
   });tail=run.catch(()=>{});return run;
 },batch(){const writes=[];return {update:(ref,v)=>writes.push(()=>ref.update(v)),set:(ref,v,o)=>writes.push(()=>ref.set(v,o)),commit:async()=>{for(const apply of writes)await apply();}};}};
 return db;
}
module.exports={memoryFirestore};
