"use strict";
// Disposable Firestore contract fixture: transactions are serializable, writes
// commit together, and reads after the first write are rejected like Firestore.
// No credentials, sockets, cloud APIs, or production records are used.
function memoryFirestore(initial=[]){
 const rows=new Map(initial.map(([key,value])=>[key,structuredClone(value)]));
 require("./workspace_policy").registerWorkspaceIndex({rows});
 let tail=Promise.resolve();
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
       let matches=[...rows.keys()].filter(key=>key.startsWith(path+"/")&&!key.slice(path.length+1).includes("/"))
         .filter(key=>filters.every(f=>f.op==="=="?rows.get(key)[f.key]===f.value:f.op==="in"?f.value.includes(rows.get(key)[f.key]):false));
       if(sort)matches.sort((a,b)=>((rows.get(a)[sort.key]||0)-(rows.get(b)[sort.key]||0))*(sort.direction==="desc"?-1:1));
       const docs=matches.slice(0,maximum).map(snap);return {docs,empty:docs.length===0,size:docs.length};
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
