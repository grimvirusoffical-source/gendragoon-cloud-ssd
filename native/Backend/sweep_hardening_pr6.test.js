"use strict";
// G1-G4 hardening for the support sweep (PR #6): index file covers every sweep query, query failures are
// logged without data and do not stop later phases, bad deletion jobs are skipped, cleanup is state-checked.
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {memoryFirestore}=require("./test_firestore");
const {createAccountDeletion}=require("./account_delete");
const NOW=1_800_000_000_000,H=3600e3;
const ROOT=path.resolve(__dirname,"../..");

function failingDb(rows,failKey,code="FAILED_PRECONDITION"){
 const db=memoryFirestore(rows);
 const wrap=(q,keys)=>new Proxy(q,{get(t,p){
  if(p==="where")return(k,op,v)=>wrap(t.where(k,op,v),[...keys,k]);
  if(p==="orderBy"||p==="limit")return(...a)=>wrap(t[p](...a),keys);
  if(p==="get"&&keys.includes(failKey))return async()=>{throw Object.assign(Error("needs index SECRETROW projects/x/indexes?create=1"),{code});};
  return t[p];
 }});
 const collection=db.collection;
 db.collection=(name,...rest)=>wrap(collection(name,...rest),[]);
 return db;
}
function capture(){const lines=[];const e=console.error,w=console.warn;
 console.error=(...a)=>lines.push(a.join(" "));console.warn=(...a)=>lines.push(a.join(" "));
 return {lines,restore(){console.error=e;console.warn=w;}};}
function svcFor(db){return createAccountDeletion({db,stripe:{},bucket:{},auth:{},hash:x=>x,now:()=>NOW,notifier:async()=>{},env:{}});}
const seed=()=>[
 ["deletion_jobs/nm",{jobId:"nm",status:"failed",accountHash:"h",workspaceNames:{w:"SECRETROW"},namesExpireAt:new Date(NOW-1000)}],
 ["supportRequests/old",{jobId:"old",createdAt:new Date(NOW-40*24*H).toISOString(),count:1,notify:{state:"sent",attempts:0,nextAttemptAt:null},expireAt:new Date(NOW-1000)}],
];

for(const [failKey,name] of [["notify.nextAttemptAt","due"],["notify.staleDueAt","stale"],["namesExpireAt","names"],["expireAt","expire"]]){
 test("G4 failing "+name+" query logs support_sweep_query_failed with name+code only and the other phases still run",async()=>{
  const db=failingDb(seed(),failKey);const cap=capture();
  try{await svcFor(db).sweepSupportNotifications();}finally{cap.restore();}
  const hits=cap.lines.filter(l=>l.startsWith("support_sweep_query_failed"));
  assert.deepEqual(hits,["support_sweep_query_failed "+name+" FAILED_PRECONDITION"]);
  assert.equal(cap.lines.some(l=>/SECRETROW|indexes\?create/.test(l)),false,"no record data or error message logged");
  if(name!=="names")assert.equal(db.rows.get("deletion_jobs/nm").workspaceNames,undefined,"names phase still ran");
  if(name!=="expire")assert.equal(db.rows.has("supportRequests/old"),false,"expire phase still ran");
 });
}

test("G3 deletion job without accountHash does not throw during name clearing; later jobs still cleared",async()=>{
 const db=memoryFirestore([
  ["deletion_jobs/a",{jobId:"a",status:"failed",workspaceNames:{w:"x"},namesExpireAt:new Date(NOW-3000)}],
  ["deletion_jobs/b",{jobId:"b",status:"failed",accountHash:"hb",workspaceNames:{w:"y"},namesExpireAt:new Date(NOW-2000)}],
 ]);
 await svcFor(db).sweepSupportNotifications();
 assert.equal(db.rows.get("deletion_jobs/a").workspaceNames,undefined);
 assert.equal(db.rows.get("deletion_jobs/b").workspaceNames,undefined);
});

test("G3 a name-clear that throws for one record is logged and skipped; the sweep keeps going",async()=>{
 const db=memoryFirestore([
  ["deletion_jobs/a",{jobId:"a",status:"failed",accountHash:"ha",workspaceNames:{w:"x"},namesExpireAt:new Date(NOW-3000)}],
  ["deletion_jobs/b",{jobId:"b",status:"failed",accountHash:"hb",workspaceNames:{w:"y"},namesExpireAt:new Date(NOW-2000)}],
  ["supportRequests/old",{jobId:"old",createdAt:new Date(NOW-40*24*H).toISOString(),count:1,notify:{state:"sent",attempts:0,nextAttemptAt:null},expireAt:new Date(NOW-1000)}],
 ]);
 const orig=db.runTransaction.bind(db);let first=true;
 db.runTransaction=fn=>{if(first){first=false;return Promise.reject(Error("boom"));}return orig(fn);};
 const cap=capture();
 try{await svcFor(db).sweepSupportNotifications();}finally{cap.restore();}
 assert.ok(cap.lines.includes("support_names_clear_failed a"));
 assert.equal(db.rows.get("deletion_jobs/b").workspaceNames,undefined);
 assert.equal(db.rows.has("supportRequests/old"),false);
});

test("G2 cleanup keeps pending and retrying-failed records even past expireAt; deletes sent and terminal ones",async()=>{
 const past=new Date(NOW-1000);
 const db=memoryFirestore([
  ["supportRequests/p",{jobId:"p",notify:{state:"pending",attempts:1,nextAttemptAt:new Date(NOW+99*H).toISOString()},expireAt:past}],
  ["supportRequests/f",{jobId:"f",notify:{state:"failed",attempts:2,nextAttemptAt:new Date(NOW+99*H).toISOString()},expireAt:past}],
  ["supportRequests/s",{jobId:"s",notify:{state:"sent",attempts:0,nextAttemptAt:null},expireAt:past}],
  ["supportRequests/t",{jobId:"t",notify:{state:"failed",attempts:5,nextAttemptAt:new Date(NOW+99*H).toISOString()},expireAt:past}],
  ["supportRequests/m",{jobId:"m",notify:{state:"failed",attempts:0,jobMissing:true},expireAt:past}],
  ["supportRequests/future",{jobId:"future",notify:{state:"sent",attempts:0,nextAttemptAt:null},expireAt:new Date(NOW+H)}],
 ]);
 await svcFor(db).sweepSupportNotifications();
 for(const k of ["p","f","future"])assert.ok(db.rows.has("supportRequests/"+k),k+" kept");
 for(const k of ["s","t","m"])assert.equal(db.rows.has("supportRequests/"+k),false,k+" deleted");
});

test("G4 firestore.indexes.json is wired in firebase.json and covers every sweep query in account_delete.js",()=>{
 const fb=JSON.parse(fs.readFileSync(path.join(ROOT,"firebase.json"),"utf8"));
 assert.ok(fs.existsSync(path.join(ROOT,fb.firestore.indexes)));
 assert.ok(fs.existsSync(path.join(ROOT,fb.firestore.rules)));
 const idx=JSON.parse(fs.readFileSync(path.join(ROOT,fb.firestore.indexes),"utf8"));
 const src=fs.readFileSync(path.join(__dirname,"account_delete.js"),"utf8");
 const re=/db\.collection\("([^"]+)"\)([^;{}]*?)\.orderBy\("([^"]+)"\)/g;
 const queries=[...src.matchAll(re)].map(m=>({coll:m[1],eq:[...m[2].matchAll(/\.where\("([^"]+)","(==|in)"/g)].map(x=>x[1]),
  range:[...m[2].matchAll(/\.where\("([^"]+)","(<=|<|>=|>)"/g)].map(x=>x[1]),order:m[3]}));
 assert.ok(queries.length>=4,"found "+queries.length+" sweep queries");
 for(const q of queries){
  if(q.eq.length===0){
   const o=idx.fieldOverrides.find(f=>f.collectionGroup===q.coll&&f.fieldPath===q.order);
   assert.ok(o&&o.indexes.some(i=>i.order==="ASCENDING"),q.coll+"."+q.order+" single-field");
   assert.notEqual(q.coll==="deletion_jobs"&&o.ttl===true,true,"no TTL on deletion_jobs");
   continue;
  }
  const want=[...q.eq,q.order];
  assert.ok(idx.indexes.some(i=>i.collectionGroup===q.coll&&i.queryScope==="COLLECTION"&&
   i.fields.map(f=>f.fieldPath+":"+f.order).join()===want.map(f=>f+":ASCENDING").join()),q.coll+" "+want.join("+"));
 }
});
