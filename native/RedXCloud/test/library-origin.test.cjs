'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const policy=require('../library-origin.cjs'),tree=require('../library-tree.cjs');
const {createCloud}=require('../server.cjs'),{digest}=require('../redx-state.cjs');
const origin={schema:1,platform:'macos',architecture:'arm64',deviceId:'d'.repeat(32)};
test('catalog validates strict private origin schema and artifact hints without changing archive kind',()=>{
 assert.deepEqual(policy.validateOrigin(origin),origin);assert.equal(policy.validateOrigin(null),null);
 for(const bad of [{...origin,hostname:'private'},{...origin,schema:true},{...origin,platform:'darwin'},{...origin,architecture:[]},{...origin,deviceId:'../other'}])
  assert.throws(()=>policy.validateOrigin(bad),e=>e.code==='library_origin_invalid');
 for(const [name,target] of [['Tool.exe','windows'],['tool.msixbundle','windows'],['tool.appxbundle','windows'],['Tool.AppImage','linux'],['pkg.deb','linux'],['pkg.rpm','linux'],['app.apk','android'],['app.ipa','ios']])
  assert.equal(policy.applicationPlatform(name,'file'),target);
 assert.equal(policy.applicationPlatform('App.app','app'),'macos');assert.equal(policy.applicationPlatform('report.pdf','file'),null);
 assert.equal(policy.applicationPlatform('Folder','folder','windows'),null);
 assert.throws(()=>policy.applicationPlatform('Tool.exe','file','macos'),e=>e.code==='library_application_platform_conflict');
});
test('same encrypted manifest cannot change origin; omission and tree clones preserve its metadata',()=>{
 const item={key:'a'.repeat(18),workspace:'b'.repeat(32),name:'App.app',kind:'app',manifestId:'c'.repeat(32),archiveBytes:8,archiveSha256:'e'.repeat(64),origin,applicationPlatform:'macos'};
 assert.deepEqual(policy.metadata(item,item),{origin,applicationPlatform:'macos'});
 const omitted={...item};delete omitted.origin;delete omitted.applicationPlatform;
 assert.deepEqual(policy.metadata(omitted,item),{origin,applicationPlatform:'macos'});
 assert.deepEqual(policy.metadata({...item,origin:{...origin,deviceId:'e'.repeat(32)}},item),{origin,applicationPlatform:'macos'});
 const legacy={...item};delete legacy.origin;delete legacy.applicationPlatform;
 assert.deepEqual(policy.metadata(item,legacy),{origin:null,applicationPlatform:'macos'});
 assert.throws(()=>policy.metadata({...item,archiveBytes:99},item),e=>e.code==='library_item_conflict');
 const state={library:{[item.key]:structuredClone(item)}};
 const result=tree.apply(state,item.workspace,{operation:'copy',keys:[item.key],expectedRevision:0});
 const copy=state.library[result.changedKeys[0]];assert.deepEqual(copy.origin,origin);assert.equal(copy.applicationPlatform,'macos');assert.equal(copy.manifestId,item.manifestId);assert.equal(copy.archiveKey,item.key);
});

test('authenticated catalog roundtrip isolates accounts, keeps generation provenance and rejects retargeted hints',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'origin-catalog-'));
 const issuer='https://red-xai.com',workspace='1'.repeat(32),key='2'.repeat(18),first='3'.repeat(32),second='4'.repeat(32),legacyId='5'.repeat(32),legacyKey='6'.repeat(18);
 const records=new Map();const store={
  async get(id){return records.has(id)?structuredClone(records.get(id)):null;},
  async ensure(id,quota){if(!records.has(id))records.set(id,{id,owner:id,revision:0,quota,used:0,workspaces:{},objects:{},library:{}});return this.get(id);},
  async change(id,fn){const value=await this.get(id);fn(value);value.revision++;records.set(id,value);return structuredClone(value);}
 };
 const cloud=await createCloud({issuer,root,store,authProvider:'redx-site-session',entitlementURL:'https://api.red-xai.com/gendragoon/v2/receiver-entitlements',fetchImpl:async(url,opts)=>
  url.endsWith('/userinfo')?Response.json({protocol:'redx-site-session-v1',client_id:'gendragoon',scope:'gendragoon.receiver',sub:opts.headers.authorization.slice(-1),email_verified:true}):Response.json({schema:1,projectLimit:10,workspaces:[{id:workspace,projectId:workspace,name:'Note',active:true,readOnly:false,quotaBytes:1000,workers:1}]})});
 const api=await cloud.listen();t.after(async()=>{await cloud.close();await fs.rm(root,{recursive:true,force:true});});
 async function call(route,method='GET',body,who='A'){
  const response=await fetch(api+'/v1/receivers/me'+route,{method,headers:{authorization:'Bearer rxca_'+who.repeat(43),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 }
 await call('','PUT');await call('','PUT',undefined,'B');
 const owner=digest(JSON.stringify(['red-xai-receiver/v1',issuer,'A']));
 const dir=path.join(root,owner,workspace);await fs.mkdir(dir,{recursive:true,mode:0o700});
 for(const id of [first,second,legacyId]){
  const bytes=Buffer.from('89504e470d0a1a0a','hex');await fs.writeFile(path.join(dir,id+'.png'),bytes,{mode:0o600});
  await fs.writeFile(path.join(dir,id+'.json'),JSON.stringify({schema:1,id,workspace,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}),{mode:0o600});
 }
 const body={name:'Tool.exe',kind:'file',workspace,manifestId:first,archiveBytes:10,archiveSha256:'f'.repeat(64),origin,applicationPlatform:'windows'};
 let result=await call('/library/'+key,'PUT',body);assert.equal(result.status,200);assert.deepEqual(result.body.origin,origin);assert.equal(result.body.kind,'file');assert.equal(result.body.applicationPlatform,'windows');
 result=await call('/library/'+key,'PUT',{...body,origin:{...origin,platform:'windows'}});assert.equal(result.status,200);assert.deepEqual(result.body.origin,origin);
 result=await call('/library/'+key,'PUT',{...body,applicationPlatform:'macos'});assert.equal(result.status,400);
 const omitted={...body};delete omitted.origin;delete omitted.applicationPlatform;
 result=await call('/library/'+key,'PUT',omitted);assert.equal(result.status,200);assert.deepEqual(result.body.origin,origin);
 const nextOrigin={...origin,platform:'windows',architecture:'x86_64',deviceId:'9'.repeat(32)};
 result=await call('/library/'+key,'PUT',{...body,manifestId:second,origin:nextOrigin});assert.equal(result.status,200);assert.deepEqual(result.body.origin,nextOrigin);assert.deepEqual(result.body.previous.at(-1).origin,origin);
 const legacy={...body,key:legacyKey,name:'Legacy.exe',manifestId:legacyId,generation:1};delete legacy.origin;delete legacy.applicationPlatform;
 await store.change(owner,s=>{s.library[legacyKey]=legacy;});
 result=await call('/library/'+legacyKey,'PUT',{...legacy,origin:nextOrigin,applicationPlatform:'windows'});assert.equal(result.status,200);assert.equal(result.body.origin,null);assert.equal(result.body.applicationPlatform,'windows');
 assert.equal((await call('/library',undefined,undefined,'B')).body.items.length,0);
 const own=(await call('/workspaces/'+workspace+'/library')).body;assert.deepEqual(own.items.find(i=>i.key===key).origin,nextOrigin);
 result=await call('/library/operations','POST',{workspace,operation:'copy',keys:[key],expectedRevision:own.revision});assert.equal(result.status,200);
 const copied=result.body.items.find(i=>i.key===result.body.changedKeys[0]);assert.deepEqual(copied.origin,nextOrigin);assert.equal(copied.applicationPlatform,'windows');assert.equal(copied.archiveKey,key);assert.equal(copied.manifestId,second);
});
