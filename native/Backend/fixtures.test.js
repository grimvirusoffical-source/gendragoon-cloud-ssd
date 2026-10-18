"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {spawnSync}=require("node:child_process");

const committed=path.resolve(__dirname,"../../fixtures");
const contractDoc=path.join(__dirname,"docs/API-workspace-policy.md");

function documentedRoutes(markdown){
 const section=markdown.split("## Request fields")[1]?.split(/\n## /)[0]||"";
 const routes=[];
 for(const line of section.split("\n")){
  const match=line.match(/^\| `([A-Z]+) ([^`]+)` \| ([^|]+) \|/);
  if(!match)continue;
  const cell=match[3].trim();
  const fields=cell==="none"?[]:cell.replace(/[{}`]/g,"").split(",").map(part=>part.trim()).filter(Boolean).sort();
  const pattern=new RegExp("^"+match[2].replace(/[.+?^${}()|[\]\\]/g,"\\$&").replace(/:[A-Za-z]+/g,"[^/]+")+"$");
  routes.push({method:match[1],fields,pattern});
 }
 assert.ok(routes.length>=10,"Request fields table is missing routes");
 return routes.sort((a,b)=>b.pattern.source.length-a.pattern.source.length);
}
function bodyKeys(body){
 if(body==null)return [];
 assert.equal(Array.isArray(body),false,"request body must be an object");
 assert.equal(typeof body,"object");
 return Object.keys(body).sort();
}
 function assertPriceInvariant(rel,body){
 if(!body||typeof body!=="object")return;
 const items=[...(Array.isArray(body.workspaces)?body.workspaces:[]),...(Array.isArray(body.projects)?body.projects:[])];
 if(body.project&&typeof body.project==="object")items.push(body.project);
 for(const item of items){
  if(typeof item.monthlyPriceCents!=="number")continue;
  assert.equal(item.monthlyPriceCents===0,item.isFree===true||item.grandfathered===true,rel+" "+(item.id||"item"));
 }
 if(typeof body.monthlyPriceCents==="number"&&typeof body.isFree==="boolean"){
  const grandfathered=body.grandfathered===true||body.project?.grandfathered===true;
  assert.equal(body.monthlyPriceCents===0,body.isFree===true||grandfathered,rel+" response");
 }
}
function assertDocumentedBody(rel,fixture,routes){
 const route=routes.find(item=>item.method===fixture.request?.method&&item.pattern.test(fixture.request?.path||""));
 assert.ok(route,rel+" has no documented route for "+fixture.request?.method+" "+fixture.request?.path);
 const keys=bodyKeys(fixture.request.body);
 if(rel==="byo/verify-missing-url.json"){
  assert.deepEqual(keys,[],rel+" must omit presignedUrl");
  assert.equal(fixture.response.status,400);
  assert.deepEqual(fixture.response.body,{error:"presigned_url_required"});
  return;
 }
 assert.deepEqual(keys,route.fields,rel+" request body does not match the documented fields");
 if(rel.startsWith("byo/verify-"))assert.deepEqual(fixture.request.body&&Object.keys(fixture.request.body),["presignedUrl"]);
}

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
 const routes=documentedRoutes(fs.readFileSync(contractDoc,"utf8"));
 assert.deepEqual(saved.map(file=>path.relative(committed,file)),fresh.map(file=>path.relative(tmp,file)),"fixture paths differ; run npm run fixtures");
 for(let i=0;i<fresh.length;i++){
  const generated=JSON.parse(fs.readFileSync(fresh[i],"utf8"));
  const stored=JSON.parse(fs.readFileSync(saved[i],"utf8"));
  const rel=path.relative(committed,saved[i]);
  assert.deepEqual(stored,generated,rel+" is stale; run npm run fixtures");
  assert.deepEqual(keysNamedCode(generated.response?.body),[],rel+" puts an error code in `code`");
  assertPriceInvariant(rel,generated.response?.body);
  const headers=JSON.stringify(generated.request?.headers||{});
  assert.equal(headers.includes("Bearer "),false,"request token was not redacted");
  assertDocumentedBody(rel,generated,routes);
 }
});

test("byo/verify-missing-url is 400 when presignedUrl is omitted",()=>{
 const fixture=JSON.parse(fs.readFileSync(path.join(committed,"byo/verify-missing-url.json"),"utf8"));
 assert.equal(fixture.request.method,"POST");
 assert.match(fixture.request.path,/\/byo\/verify$/);
 assert.deepEqual(fixture.request.body,{});
 assert.equal(fixture.response.status,400);
 assert.deepEqual(fixture.response.body,{error:"presigned_url_required"});
 const others=walk(path.join(committed,"byo")).filter(file=>path.basename(file).startsWith("verify-")&&!file.endsWith("verify-missing-url.json"));
 assert.ok(others.length>=5);
 for(const file of others){
  const body=JSON.parse(fs.readFileSync(file,"utf8")).request.body;
  assert.deepEqual(Object.keys(body),["presignedUrl"],path.basename(file));
  assert.equal(typeof body.presignedUrl,"string");
 }
});
