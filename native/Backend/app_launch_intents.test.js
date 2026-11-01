'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {makeLaunchIntent}=require('./app_launch_intents');
const {fixture}=require('./test_helpers/transfer_fixture');
const key='abcdefab-1234-1234-1234-abcdefabcdef',requestId='f'.repeat(32);

test('launch signals cannot fake execution or select a mismatched OS',()=>{
 const value=makeLaunchIntent({name:'App.ipa',generation:'one'},{key,platform:'ios',requestId},1000);
 assert.equal(value.status,'requested');assert.equal(value.executionConfirmed,false);assert.equal(value.expiresMs,121000);
 assert.throws(()=>makeLaunchIntent({name:'App.apk'},{key,platform:'ios',requestId}),{status:409});
 assert.throws(()=>makeLaunchIntent({name:'App.ipa'},{key,platform:'ios',requestId,path:'/not/allowed'}),{status:400});
 assert.throws(()=>makeLaunchIntent(null,{key,platform:'ios',requestId}),{status:404});
});
test('iOS launch route authenticates ownership, stores a bounded signal and is idempotent',async t=>{
 const f=fixture();t.after(()=>f.close());
 f.docs.set(f.wsPath+'/files/'+key,{name:'CloudGame.ipa',kind:'file',generation:'revision-1'});
 const options={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,platform:'ios',requestId})};
 let response=await f.call('/app-launch-intents',options);assert.equal(response.status,202,await response.clone().text());
 let value=await response.json();assert.equal(value.id,requestId);assert.equal(value.status,'requested');assert.equal(value.executionConfirmed,false);
 response=await f.call('/app-launch-intents',options);assert.equal(response.status,202);
 assert.equal((await response.json()).createdMs,value.createdMs);
 response=await f.call('/app-launch-intents',{...options,headers:{...options.headers,Authorization:'Bearer other'}});assert.equal(response.status,404);
 response=await f.call('/app-launch-intents',{...options,body:JSON.stringify({key,platform:'android',requestId})});assert.equal(response.status,409);
 response=await f.call('/app-launch-intents',{...options,headers:{...options.headers,Authorization:'Bearer gdsk_read'}});assert.equal(response.status,403);
 assert.equal([...f.docs.keys()].filter(x=>x.includes('/appLaunchIntents/')).length,1);
});
