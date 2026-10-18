"use strict";
// G4 (PR #6): every Firestore query in account_delete.js that needs an index has one in the
// committed firestore.indexes.json, and every support-sweep query failure is logged as
// `support_sweep_query_failed <phase> <code>` with no data while the later phases still run.
// Independent of the sweep_hardening_pr6.test.js checks: own parser, own index rules, and a
// runtime recorder that cross-checks the static list against the queries the sweep really sends.
// No network, emulator, secrets or user data.
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {memoryFirestore}=require("./test_firestore");
const {createAccountDeletion}=require("./account_delete");
const ROOT=path.resolve(__dirname,"../..");
const SOURCE=path.join(__dirname,"account_delete.js");
const NOW=1_800_000_000_000,H=3600e3;

// The documented sweep queries (docs/API-account.md, "sweepSupportNotifications"; README.md
// release checklist). A new index-needing query in account_delete.js must be added here, to the
// docs, and to firestore.indexes.json, or the inventory test fails.
const SWEEP_QUERIES=[
 {phase:"due",collection:"supportRequests",filters:[["notify.state","in"],["notify.nextAttemptAt","<="]],orderBy:[["notify.nextAttemptAt","asc"]]},
 {phase:"stale",collection:"supportRequests",filters:[["notify.state","in"],["notify.staleDueAt","<="]],orderBy:[["notify.staleDueAt","asc"]]},
 {phase:"names",collection:"deletion_jobs",filters:[["namesExpireAt","<="]],orderBy:[["namesExpireAt","asc"]]},
 {phase:"expire",collection:"supportRequests",filters:[["expireAt","<="]],orderBy:[["expireAt","asc"]]},
];

// ---------- static scan: balanced-paren parse of every db.collection(...) chain ----------
function readCall(src,open){
 // src[open]==="(" ; returns {args:[raw...], end:index after ")"}
 let depth=0,i=open,start=open+1,args=[],quote=null;
 for(;i<src.length;i++){
  const c=src[i];
  if(quote){if(c==="\\"){i++;continue;}if(c===quote)quote=null;continue;}
  if(c==='"'||c==="'"||c==="`"){quote=c;continue;}
  if(c==="("||c==="["||c==="{")depth++;
  else if(c===")"||c==="]"||c==="}"){depth--;if(depth===0){args.push(src.slice(start,i));return {args:args.map(a=>a.trim()).filter((a,k,all)=>a!==""||all.length>1),end:i+1};}}
  else if(c===","&&depth===1){args.push(src.slice(start,i));start=i+1;}
 }
 throw Error("unbalanced call at "+open);
}
const literal=raw=>{const m=/^(["'])([^"'\\]*)\1$/.exec(raw||"");return m?m[2]:null;};
const lineOf=(src,at)=>src.slice(0,at).split("\n").length;
function scanQueries(src){
 const found=[],unparsed=[];
 const re=/\bdb\s*\.\s*collection\s*\(/g;
 let m;
 while((m=re.exec(src))){
  const head=readCall(src,m.index+m[0].length-1);
  const chain=[];let at=head.end;
  for(;;){
   const call=/^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(src.slice(at,at+200));
   if(!call)break;
   const parsed=readCall(src,at+call[0].length-1);
   chain.push({method:call[1],args:parsed.args});at=parsed.end;
  }
  const shaping=chain.filter(c=>c.method==="where"||c.method==="orderBy");
  if(!shaping.length)continue;
  const line=lineOf(src,m.index),coll=literal(head.args[0]);
  const problem=
   coll===null?"collection name is not a string literal":
   chain.slice(0,chain.indexOf(shaping[0])).some(c=>c.method==="doc"||c.method==="collection")?"query on a subcollection":
   shaping.some(c=>literal(c.args[0])===null)?"field path is not a string literal":
   shaping.some(c=>c.method==="where"&&literal(c.args[1])===null)?"where operator is not a string literal":
   shaping.some(c=>c.method==="orderBy"&&c.args.length>1&&literal(c.args[1])===null)?"orderBy direction is not a string literal":null;
  if(problem){unparsed.push("account_delete.js:"+line+": "+problem);continue;}
  found.push({line,collection:coll,
   filters:shaping.filter(c=>c.method==="where").map(c=>[literal(c.args[0]),literal(c.args[1])]),
   orderBy:shaping.filter(c=>c.method==="orderBy").map(c=>[literal(c.args[0]),(literal(c.args[1])||"asc").toLowerCase()])});
 }
 return {found,unparsed};
}

// ---------- index rules (Firestore semantics, written independently of the code under test) ----------
const EQUALITY=new Set(["==","in"]),RANGE=new Set(["<","<=",">",">=","!=","not-in"]),ARRAY=new Set(["array-contains","array-contains-any"]);
const DIR={asc:"ASCENDING",desc:"DESCENDING"};
function requiredIndex(q){
 for(const [f,op] of q.filters)if(ARRAY.has(op))return {unsupported:f+" "+op+" needs an arrayConfig index; extend this test"};
 const eq=[...new Set(q.filters.filter(([,op])=>EQUALITY.has(op)).map(([f])=>f))];
 const ordered=q.orderBy.map(([f,d])=>[f,DIR[d]]);
 for(const [f,op] of q.filters)if(RANGE.has(op)&&!ordered.some(([o])=>o===f))ordered.push([f,"ASCENDING"]);
 const eqOnly=eq.filter(f=>!ordered.some(([o])=>o===f));
 const fields=new Set([...eqOnly,...ordered.map(([f])=>f)]);
 if(!ordered.length)return {automatic:true};               // equality-only: served by automatic single-field indexes / merge
 if(fields.size===1)return {single:{collectionGroup:q.collection,fieldPath:ordered[0][0],order:ordered[0][1]}};
 return {composite:{collectionGroup:q.collection,equality:eqOnly,ordered}};
}
function compositeMatches(index,want){
 if(index.collectionGroup!==want.collectionGroup||(index.queryScope||"COLLECTION")!=="COLLECTION")return false;
 const fields=(index.fields||[]).filter(f=>f.fieldPath!=="__name__");
 if(fields.length!==want.equality.length+want.ordered.length)return false;
 const head=fields.slice(0,want.equality.length),tail=fields.slice(want.equality.length);
 // Equality fields may appear in any order and direction; ordered fields must match exactly.
 if(head.map(f=>f.fieldPath).sort().join()!==[...want.equality].sort().join())return false;
 if(head.some(f=>f.order!=="ASCENDING"&&f.order!=="DESCENDING"))return false;
 return tail.every((f,k)=>f.fieldPath===want.ordered[k][0]&&f.order===want.ordered[k][1]);
}
function singleMatches(override,want){
 return override.collectionGroup===want.collectionGroup&&override.fieldPath===want.fieldPath&&
  (override.indexes||[]).some(i=>i.order===want.order&&(i.queryScope||"COLLECTION")==="COLLECTION");
}
function loadIndexes(){
 const firebasePath=path.join(ROOT,"firebase.json");
 assert.ok(fs.existsSync(firebasePath),"firebase.json is committed at the repo root");
 const rel=JSON.parse(fs.readFileSync(firebasePath,"utf8"))?.firestore?.indexes;
 assert.equal(typeof rel,"string","firebase.json firestore.indexes names the index file");
 const file=path.resolve(ROOT,rel);
 assert.ok(fs.existsSync(file),rel+" exists");
 return {file,json:JSON.parse(fs.readFileSync(file,"utf8"))};
}
function coverageProblems(queries,idx){
 const problems=[];
 for(const q of queries){
  const need=requiredIndex(q),where="account_delete.js:"+q.line+" "+q.collection;
  if(need.unsupported)problems.push(where+": "+need.unsupported);
  else if(need.single){
   if(!(idx.fieldOverrides||[]).some(o=>singleMatches(o,need.single)))
    problems.push(where+": no fieldOverrides entry "+need.single.fieldPath+" "+need.single.order+" COLLECTION");
  }else if(need.composite){
   if(!(idx.indexes||[]).some(i=>compositeMatches(i,need.composite)))
    problems.push(where+": no composite index "+[...need.composite.equality.map(f=>f+" (eq)"),...need.composite.ordered.map(([f,d])=>f+" "+d)].join(" + "));
  }
 }
 return problems;
}
function deployProblems(idx){
 const problems=[];
 for(const i of idx.indexes||[]){
  const fields=(i.fields||[]).filter(f=>f.fieldPath!=="__name__");
  if(fields.length<2)problems.push(i.collectionGroup+": a 1-field composite is rejected by firestore deploy; use fieldOverrides");
 }
 const keys=(idx.indexes||[]).map(i=>i.collectionGroup+"|"+(i.queryScope||"COLLECTION")+"|"+(i.fields||[]).map(f=>f.fieldPath+":"+f.order).join());
 if(new Set(keys).size!==keys.length)problems.push("duplicate composite index");
 for(const o of idx.fieldOverrides||[])if(o.collectionGroup==="deletion_jobs"&&o.ttl===true)problems.push("TTL policy on deletion_jobs."+o.fieldPath+" (docs forbid it)");
 return problems;
}
const shape=q=>q.collection+" | "+q.filters.map(f=>f.join(" ")).join(", ")+" | "+q.orderBy.map(o=>o.join(" ")).join(", ");
const needsIndex=q=>!requiredIndex(q).automatic;

test("G4 static scan: every where/orderBy chain in account_delete.js parses, and the index-needing ones are exactly the 4 documented sweep queries",()=>{
 const {found,unparsed}=scanQueries(fs.readFileSync(SOURCE,"utf8"));
 assert.deepEqual(unparsed,[],"queries this test cannot read; make them literal or extend the parser");
 assert.deepEqual(found.filter(needsIndex).map(shape).sort(),SWEEP_QUERIES.map(shape).sort());
});

test("G4 firestore.indexes.json (via firebase.json) has a matching index for every index-needing query, and is deployable",()=>{
 const {json}=loadIndexes();
 const {found}=scanQueries(fs.readFileSync(SOURCE,"utf8"));
 assert.ok(found.filter(needsIndex).length>=SWEEP_QUERIES.length);
 assert.deepEqual(coverageProblems(found,json),[]);
 assert.deepEqual(coverageProblems(SWEEP_QUERIES.map(q=>({...q,line:"doc:"+q.phase})),json),[]);
 assert.deepEqual(deployProblems(json),[]);
});

test("G4 index rules self-check: a missing composite, a swapped field order, a DESC-only override and a missing expireAt override are all reported",()=>{
 const {json}=loadIndexes();
 const queries=SWEEP_QUERIES.map(q=>({...q,line:q.phase}));
 const clone=()=>JSON.parse(JSON.stringify(json));
 const noDue=clone();noDue.indexes=noDue.indexes.filter(i=>!i.fields.some(f=>f.fieldPath==="notify.nextAttemptAt"));
 assert.match(coverageProblems(queries,noDue).join("\n"),/due supportRequests: no composite index notify\.state \(eq\) \+ notify\.nextAttemptAt ASCENDING/);
 const swapped=clone();for(const i of swapped.indexes)i.fields.reverse();
 assert.equal(coverageProblems(queries,swapped).length,2);
 const desc=clone();for(const o of desc.fieldOverrides)o.indexes=o.indexes.filter(i=>i.order!=="ASCENDING");
 assert.equal(coverageProblems(queries,desc).length,2);
 const noExpire=clone();noExpire.fieldOverrides=noExpire.fieldOverrides.filter(o=>!(o.collectionGroup==="supportRequests"&&o.fieldPath==="expireAt"));
 assert.match(coverageProblems(queries,noExpire).join("\n"),/expire supportRequests: no fieldOverrides entry expireAt ASCENDING/);
 const ttlJobs=clone();ttlJobs.fieldOverrides.find(o=>o.collectionGroup==="deletion_jobs").ttl=true;
 assert.match(deployProblems(ttlJobs).join(),/TTL policy on deletion_jobs/);
});

// ---------- runtime: record what the sweep really sends; fail chosen phases ----------
// Closer to real Firestore than memoryFirestore alone: query snapshots are frozen at read time,
// and doc() rejects a missing or empty id ("Path must be a non-empty string").
function recordingDb(rows,{fail={},code=9,afterGet={}}={}){
 const db=memoryFirestore(rows),sent=[];
 const wrap=(q,spec)=>new Proxy(q,{get(t,p){
  if(p==="where")return(f,op,v)=>wrap(t.where(f,op,v),{...spec,filters:[...spec.filters,[f,op]]});
  if(p==="orderBy")return(f,d="asc")=>wrap(t.orderBy(f,d),{...spec,orderBy:[...spec.orderBy,[f,String(d).toLowerCase()]]});
  if(p==="limit")return n=>wrap(t.limit(n),spec);
  if(p==="get"&&(spec.filters.length||spec.orderBy.length))return async()=>{
   sent.push(spec);
   const phase=SWEEP_QUERIES.find(s=>shape(s)===shape(spec))?.phase;
   if(phase&&fail[phase])throw Object.assign(Error("9 FAILED_PRECONDITION: The query requires an index. https://console.firebase.google.com/project/demo/firestore/indexes?create_composite=MORGANLEAK person@example.com"),
    fail[phase]==="nocode"?{}:{code});
   const snap=await t.get();
   const docs=snap.docs.map(d=>{const frozen=d.data();return {...d,data:()=>structuredClone(frozen)};});
   if(phase&&afterGet[phase])await afterGet[phase](db);
   return {...snap,docs};
  };
  if(p==="doc")return id=>{if(typeof id!=="string"||id==="")throw Error("Path must be a non-empty string");return t.doc(id);};
  const v=t[p];return typeof v==="function"?v.bind(t):v;
 }});
 const base=db.collection;
 db.collection=(name,...rest)=>{const c=base(name,...rest);return wrap(c,{collection:name,filters:[],orderBy:[]});};
 return {db,sent};
}
const seed=()=>[
 ["supportRequests/due",{jobId:"due",accountHash:"ha",createdAt:new Date(NOW-30*H).toISOString(),count:1,
  notify:{state:"failed",attempts:5,nextAttemptAt:new Date(NOW-1000).toISOString()}}],
 ["supportRequests/stale",{jobId:"stale",accountHash:"hs",createdAt:new Date(NOW-2*H).toISOString(),count:1,
  notify:{state:"pending",attempts:1,nextAttemptAt:new Date(NOW+99*H).toISOString(),staleDueAt:new Date(NOW-1000).toISOString()}}],
 ["deletion_jobs/names",{jobId:"names",status:"failed",accountHash:"hn",workspaceNames:{w:"MORGANLEAK"},namesExpireAt:new Date(NOW-1000)}],
 ["supportRequests/old",{jobId:"old",createdAt:new Date(NOW-40*24*H).toISOString(),count:1,notify:{state:"sent",attempts:0},expireAt:new Date(NOW-1000)}],
];
const ran={
 due:db=>db.rows.get("supportRequests/due").notify.nextAttemptAt>new Date(NOW).toISOString(),
 stale:db=>typeof db.rows.get("supportRequests/stale").notify.staleAlertedAt==="string",
 names:db=>db.rows.get("deletion_jobs/names").workspaceNames===undefined,
 expire:db=>!db.rows.has("supportRequests/old"),
};
async function sweep(rows,opts={}){
 const {db,sent}=recordingDb(rows,opts);
 const lines=[],saved={error:console.error,warn:console.warn,log:console.log,info:console.info};
 for(const k of Object.keys(saved))console[k]=(...a)=>lines.push(a.map(String).join(" "));
 try{await createAccountDeletion({db,stripe:{},bucket:{},auth:{},hash:x=>x,now:()=>NOW,notifier:async()=>{},env:{}}).sweepSupportNotifications();}
 finally{Object.assign(console,saved);}
 return {db,sent,lines};
}

test("G4 runtime: the sweep sends exactly the 4 documented queries, matching the static scan",async()=>{
 const {sent,db}=await sweep(seed());
 assert.deepEqual(sent.map(shape),SWEEP_QUERIES.map(shape),"phase order due, stale, names, expire");
 for(const [phase,check] of Object.entries(ran))assert.ok(check(db),phase+" phase ran");
 const {found}=scanQueries(fs.readFileSync(SOURCE,"utf8"));
 for(const s of sent)assert.ok(found.some(f=>shape(f)===shape(s)),"static scan saw "+shape(s));
});

for(const phase of SWEEP_QUERIES.map(q=>q.phase)){
 test("G4 a failing "+phase+" query logs `support_sweep_query_failed "+phase+" 9` once, with no data, and every other phase still runs",async()=>{
  const {db,lines}=await sweep(seed(),{fail:{[phase]:true}});
  assert.deepEqual(lines.filter(l=>l.includes("support_sweep_query_failed")),["support_sweep_query_failed "+phase+" 9"]);
  assert.equal(lines.some(l=>/MORGANLEAK|example\.com|console\.firebase|indexes\?|FAILED_PRECONDITION/.test(l)),false,lines.join("\n"));
  for(const [other,check] of Object.entries(ran))if(other!==phase)assert.ok(check(db),other+" phase still ran after "+phase+" failed");
 });
}

test("G4 all four queries failing: four lines in phase order, string or missing codes are safe, sweep resolves",async()=>{
 const {lines}=await sweep(seed(),{fail:{due:true,stale:true,names:"nocode",expire:true},code:"FAILED_PRECONDITION"});
 assert.deepEqual(lines.filter(l=>l.startsWith("support_sweep_query_failed")),
  ["support_sweep_query_failed due FAILED_PRECONDITION","support_sweep_query_failed stale FAILED_PRECONDITION",
   "support_sweep_query_failed names unknown","support_sweep_query_failed expire FAILED_PRECONDITION"]);
 for(const l of lines.filter(l=>l.includes("support_sweep_query_failed")))assert.match(l,/^support_sweep_query_failed (due|stale|names|expire) [A-Za-z0-9_.-]{1,40}$/);
});

// ---------- G2 / G3 gaps the in-memory fake hides ----------
test("G2 cleanup re-reads inside the transaction: a request that turned pending again after the query is kept",async()=>{
 const {db,lines}=await sweep(seed(),{afterGet:{expire:async db=>{
  db.rows.set("supportRequests/old",{jobId:"old",createdAt:new Date(NOW).toISOString(),count:1,
   notify:{state:"pending",attempts:0,nextAttemptAt:new Date(NOW+60e3).toISOString()}});
 }}});
 assert.equal(db.rows.get("supportRequests/old")?.notify?.state,"pending","fresh pending request survives a stale cleanup read");
 assert.equal(lines.some(l=>l.startsWith("support_expire_failed")),false);
});

test("G2 cleanup re-checks expireAt inside the transaction: a sent request whose expireAt moved out is kept",async()=>{
 const {db}=await sweep(seed(),{afterGet:{expire:async db=>{
  const row=db.rows.get("supportRequests/old");db.rows.set("supportRequests/old",{...row,expireAt:new Date(NOW+30*24*H)});
 }}});
 assert.ok(db.rows.has("supportRequests/old"),"expireAt in the future at delete time");
});

test("G3 a deletion job with no accountHash is skipped without touching account_deletions (real Firestore rejects doc(undefined))",async()=>{
 const rows=[...seed(),
  ["deletion_jobs/nohash",{jobId:"nohash",status:"failed",workspaceNames:{w:"x"},namesExpireAt:new Date(NOW-3000)}],
  ["deletion_jobs/empty",{jobId:"empty",status:"failed",accountHash:"",workspaceNames:{w:"y"},namesExpireAt:new Date(NOW-2500)}]];
 const {db,lines}=await sweep(rows);
 for(const id of ["nohash","empty","names"])assert.equal(db.rows.get("deletion_jobs/"+id).workspaceNames,undefined,id+" names cleared");
 assert.equal(lines.some(l=>l.startsWith("support_names_clear_failed")),false,lines.join("\n"));
 assert.equal([...db.rows.keys()].some(k=>/^account_deletions\/(undefined)?$/.test(k)),false);
});
