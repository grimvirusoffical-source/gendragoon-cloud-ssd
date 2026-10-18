"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {spawnSync}=require("node:child_process");

const committed=path.resolve(__dirname,"../../fixtures");

function walk(dir){
 if(!fs.existsSync(dir))return [];
 const out=[];
 for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const child=path.join(dir,entry.name);
  if(entry.isDirectory())out.push(...walk(child));
  else if(entry.name.endsWith(".json"))out.push(child);
 }
 return out.sort();
}
function keysNamedCode(value,found=[]){
 if(Array.isArray(value))value.forEach(item=>keysNamedCode(item,found));
 else if(value&&typeof value==="object")for(const [key,item] of Object.entries(value)){
  if(key==="code")found.push(value);
  keysNamedCode(item,found);
 }
 return found;
}

test("committed API fixtures match a fresh generation from the handlers",{timeout:30_000},()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"gd-fixtures-"));
 const run=spawnSync(process.execPath,[path.join(__dirname,"scripts/export_fixtures.js"),tmp],{encoding:"utf8"});
 assert.equal(run.status,0,(run.stderr||"")+(run.stdout||""));
 const fresh=walk(tmp),saved=walk(committed);
 assert.deepEqual(saved.map(file=>path.relative(committed,file)),fresh.map(file=>path.relative(tmp,file)),"fixture paths differ; run npm run fixtures");
 for(let i=0;i<fresh.length;i++){
  const generated=JSON.parse(fs.readFileSync(fresh[i],"utf8"));
  const stored=JSON.parse(fs.readFileSync(saved[i],"utf8"));
  assert.deepEqual(stored,generated,path.relative(committed,saved[i])+" is stale; run npm run fixtures");
  assert.deepEqual(keysNamedCode(generated.response?.body),[],path.relative(tmp,fresh[i])+" puts an error code in `code`");
  const headers=JSON.stringify(generated.request?.headers||{});
  assert.equal(headers.includes("Bearer "),false,"request token was not redacted");
 }
});
