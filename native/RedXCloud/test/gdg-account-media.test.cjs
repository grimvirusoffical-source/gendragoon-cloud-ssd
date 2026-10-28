'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {digest}=require('../redx-state.cjs');
const {GDGAccountState,initial,workspaceRecords,FILE}=require('../gdg-account-state.cjs');
const signed=require('../gdg-signed-policy.cjs');
const {GDGMediaContainer,prefix,objectPath}=require('../gdg-media-container.cjs');
const issuer='https://red-xai.com';
const identity=sub=>({issuer,subject:sub,owner:digest(JSON.stringify(['red-xai-receiver/v1',issuer,sub]))});
const alice=identity('fixture-alice'),bob=identity('fixture-bob'),wid='a'.repeat(32),second='b'.repeat(32);
function png(label='fixture'){return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from(label)]);}
function qr(){const value=png();return {format:'redsecretsxai-visual-v3',objectId:'c'.repeat(32),png:value.toString('base64'),sha256:digest(value)};}
function signedState(){const s=initial(alice);s.GDGWS=workspaceRecords({workspaces:{[wid]:{name:'A / user label'},[second]:{name:'B'}}},alice.owner);return s;}
function request(id='d'.repeat(32),fingerprint='e'.repeat(64)){return {id,name:'Fixture laptop',platform:'macos',deviceFingerprint:fingerprint};}

test('registration uses GDGSigned and Unsign removes image, identifier and all receipt metadata',()=>{
 const state=signedState();signed.add(alice,wid,state,request(),qr(),100);
 assert.ok(state.GDGSigned['d'.repeat(32)]);
 const image=signed.image(alice,wid,state,'d'.repeat(32));assert.equal(image.sha256,qr().sha256);assert.equal(image.png,undefined);
 const view=signed.list(alice,wid,state);assert.equal(view.devices.length,1);
 assert.ok(!JSON.stringify(view).includes('deviceFingerprint'));assert.ok(!JSON.stringify(view).includes(qr().png));
 assert.throws(()=>signed.image(alice,second,state,'d'.repeat(32)),{code:'not_found'});
 assert.throws(()=>signed.list({...alice,apiKey:true},wid,state),{code:'account_session_required'});
 signed.remove(alice,wid,state,'d'.repeat(32));assert.deepEqual(state.GDGSigned,{});
 assert.throws(()=>signed.image(alice,wid,state,'d'.repeat(32)),{code:'not_found'});
 assert.equal(signed.remove(alice,wid,state,'d'.repeat(32)).qrDeleted,true);
 assert.equal(Object.keys(state.GDGWS).length,2,'Unsign never deletes workspaces');
});
test('device registration rejects malformed/duplicate identities and corrupt image bytes',()=>{
 const s=signedState();signed.add(alice,wid,s,request(),qr(),100);
 assert.throws(()=>signed.add(alice,wid,s,request('f'.repeat(32)),qr(),100),{code:'device_already_signed'});
 assert.throws(()=>signed.add(alice,wid,s,request('a'.repeat(32),'raw-serial'),qr(),100),{code:'device_request_invalid'});
 assert.throws(()=>signed.validateImage({...qr(),png:png('changed').toString('base64')}),{code:'device_receipt_invalid'});
 assert.throws(()=>signed.validateImage({...qr(),credential:'not-allowed'}),{code:'device_receipt_invalid'});
 assert.throws(()=>signed.list({...alice,subject:bob.subject},wid,s),{code:'account_identity_mismatch'});
});
test('GDGWS contains owned names but storage paths are immutable IDs, excluding deleted workspaces',()=>{
 const source={workspaces:{[wid]:{name:'../../Other User',active:true},[second]:{name:'Deleted'}},deletedWorkspaces:{[second]:{}}};
 const records=workspaceRecords(source,alice.owner);
 assert.deepEqual(Object.keys(records),[wid]);assert.equal(records[wid].name,'../../Other User');
 assert.equal(records[wid].mediaPrefix,prefix(alice.owner,wid));assert.ok(!records[wid].mediaPrefix.includes('Other User'));
 assert.notEqual(prefix(alice.owner,wid),prefix(bob.owner,wid));
 for(const bad of ['..','a/b','a'.repeat(31),'%2e%2e'])assert.throws(()=>prefix(alice.owner,bad));
 assert.ok(objectPath(alice.owner,wid,'d'.repeat(32)).endsWith('/dd/'+'d'.repeat(32)+'.png'));
});

test('user DB adapter writes only GDG extension records, preserves identity and retries CAS conflicts',async()=>{
 const rows=new Map(),calls=[];let conflict=false;
 const fetch=async(url,options)=>{
  calls.push({url,method:options.method});assert.ok(url.startsWith('http://127.0.0.1:7790/v1/db/redx_accounts/'));
  if(options.method==='GET'){
   const decoded=decodeURIComponent(url);if(decoded.includes(':GDGSigned['))return new Response('',{status:404});const id=Number(decoded.match(/ID=(\d+)/)[1]);
   const row=rows.get(id);return row?Response.json({value:JSON.stringify(JSON.stringify(row))}):new Response('',{status:404});
  }
  const {q,params:p}=JSON.parse(options.body);assert.ok(q.includes(FILE));assert.ok(!q.includes('acct-account'));
  if(q.includes('{Add[]}')){if(rows.has(p.id))return new Response('',{status:409});rows.set(p.id,JSON.parse(p.state));return Response.json({ok:true});}
  if(conflict){conflict=false;return new Response('',{status:409});}
  const old=rows.get(p.id);if(!old||old.revision!==p.previous||old.owner!==p.owner||old.subject!==p.subject)return new Response('',{status:409});
  rows.set(p.id,JSON.parse(p.state));return Response.json({ok:true});
 };
 const db=new GDGAccountState({url:'http://127.0.0.1:7790',key:'fixture-not-live',fetchImpl:fetch});
 await db.ensure(alice);await db.ensure(bob);conflict=true;
 await db.syncWorkspaces(alice,{revision:5,workspaces:{[wid]:{name:'Alice'}}});
 let a=await db.get(alice),b=await db.get(bob);assert.equal(a.GDGWS[wid].name,'Alice');assert.deepEqual(b.GDGWS,{});
 await db.change(alice,s=>signed.add(alice,wid,s,request(),qr(),100));
 await db.syncWorkspaces(alice,{revision:6,workspaces:{}});a=await db.get(alice);assert.deepEqual(a.GDGSigned,{});
 await db.syncWorkspaces(alice,{revision:4,workspaces:{[wid]:{name:'Stale'}}});assert.deepEqual((await db.get(alice)).GDGWS,{});
 assert.ok(calls.length>5);assert.throws(()=>new GDGAccountState({url:'http://untrusted.example',key:'fixture'}));
});

test('RedX media master container validates ownership prefixes and detects corrupt remote chunks',async()=>{
 const files=new Map();const service=async(url,options)=>{
  const key=new URL(url).pathname;assert.ok(key.startsWith('/v1/db/gendragoon_media/pack/red-xai-db/file/accounts/'));
  if(options.method==='GET')return files.has(key)?new Response(files.get(key)):new Response('',{status:404});
  if(options.method==='DELETE'){files.delete(key);return Response.json({ok:true});}
  assert.equal(options.headers['x-redx-sha256'],digest(options.body));files.set(key,Buffer.from(options.body));return Response.json({ok:true});
 };
 const media=new GDGMediaContainer({url:'http://127.0.0.1:7790',key:'fixture-not-live',fetchImpl:service});
 await media.ensureWorkspace(alice.owner,wid,'display name');
 const id='d'.repeat(32),bytes=png('encrypted-fixture-envelope');
 const record={schema:1,id,workspace:wid,bytes:bytes.length,sha256:digest(bytes),encoding:'redsecretsxai-png-v1'};
 await media.put(alice.owner,wid,id,bytes,record);assert.deepEqual((await media.get(alice.owner,wid,id)).bytes,bytes);
 assert.equal(await media.get(bob.owner,wid,id),null);
 const payload=[...files.keys()].find(k=>k.endsWith(id+'.png'));files.set(payload,png('tampered'));
 await assert.rejects(media.get(alice.owner,wid,id),{code:'stored_object_corrupt'});
 await media.remove(alice.owner,wid,id);assert.equal(await media.get(alice.owner,wid,id),null);
 assert.equal(files.size,1,'deleting one object preserves the workspace marker');
});
