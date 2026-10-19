"use strict";
// Fixed-window limiter in memory, per Cloud Run instance. Keys are hashed so raw addresses are not kept.
const crypto=require("node:crypto");
function createLimiter({limit,windowMs,now=()=>Date.now(),maxKeys=50_000}){
 const hits=new Map();
 return function allow(key){
  const k=crypto.createHash("sha256").update(String(key)).digest("base64url").slice(0,22);
  const t=now();
  let entry=hits.get(k);
  if(!entry||entry.reset<=t){
   if(hits.size>=maxKeys)for(const [key2,e] of hits)if(e.reset<=t)hits.delete(key2);
   if(hits.size>=maxKeys)hits.clear();
   entry={count:0,reset:t+windowMs};hits.set(k,entry);
  }
  entry.count+=1;
  return entry.count<=limit?{ok:true}:{ok:false,retryAfterS:Math.ceil((entry.reset-t)/1000)};
 };
}
module.exports={createLimiter};
