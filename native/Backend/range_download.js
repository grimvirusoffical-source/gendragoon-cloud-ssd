"use strict";
const {pipeline}=require("node:stream/promises");
function parseRange(value,size){
 if(value===undefined)return null;
 if(typeof value!=="string"||value.length>100||!Number.isSafeInteger(size)||size<1)
  throw Object.assign(Error("Invalid range"),{status:416});
 const m=/^bytes=(\d*)-(\d*)$/.exec(value.trim());
 if(!m||(!m[1]&&!m[2]))throw Object.assign(Error("Invalid range"),{status:416});
 let start,end;
 if(!m[1]){const suffix=Number(m[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)throw Object.assign(Error("Invalid suffix"),{status:416});start=Math.max(0,size-suffix);end=size-1;}
 else{start=Number(m[1]);end=m[2]?Number(m[2]):size-1;}
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)
  throw Object.assign(Error("Unsatisfiable range"),{status:416});
 return {start,end:Math.min(end,size-1)};
}
async function sendObject(req,res,{file,record,id,run=fn=>fn()}){
 const size=record.sizeBytes;
 const etag='"gd-'+id+'-'+(record.generation||size)+'"';
 res.set({"Accept-Ranges":"bytes","ETag":etag,"Content-Type":"application/octet-stream",
  "Content-Disposition":"attachment; filename*=UTF-8''"+encodeURIComponent(record.name),
  "Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"});
 if(req.headers["if-match"]&&req.headers["if-match"]!=="*"&&req.headers["if-match"]!==etag)return res.status(412).end();
 let range;
 try{range=parseRange(req.headers["if-range"]&&req.headers["if-range"]!==etag?undefined:req.headers.range,size);}
 catch(_){res.set("Content-Range","bytes */"+size);return res.status(416).end();}
 if(range)res.status(206).set("Content-Range",`bytes ${range.start}-${range.end}/${size}`);
 res.set("Content-Length",String(range?range.end-range.start+1:size));
 if(req.method==="HEAD")return res.end();
 await run(async()=>{
  if(req.aborted||res.destroyed)throw Error("Client disconnected");
  // Ranged GCS reads cannot validate the whole object's CRC. Full reads still do.
  const opts=range?{start:range.start,end:range.end,validation:false}:{};
  await pipeline(file.createReadStream(opts),res);
 });
}
module.exports={parseRange,sendObject};
