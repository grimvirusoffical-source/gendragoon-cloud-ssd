'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {BidiClient,connectBidi,registerFirefoxHost,withFirefoxLaunchEnvironment,installedExtensionOrigin,discoverExtensionOrigin,FIREFOX_ID}=require('./firefox-native.cjs');
class Socket extends EventTarget{constructor(){super();this.sent=[];}send(value){this.sent.push(JSON.parse(value));}close(){this.closed=true;}reply(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}}
test('BiDi correlates concurrent responses, rejects protocol errors and fails outstanding requests on close',async()=>{
 const socket=new Socket(),client=new BidiClient(socket),a=client.command('first'),b=client.command('second');socket.reply({type:'success',id:2,result:{second:true}});socket.reply({type:'success',id:1,result:{first:true}});assert.deepEqual(await a,{first:true});assert.deepEqual(await b,{second:true});
 const c=client.command('denied');socket.reply({type:'error',id:3,error:'invalid argument',message:'fixture'});await assert.rejects(c,/invalid argument/);
 const pending=client.command('outstanding');socket.dispatchEvent(new Event('close'));await assert.rejects(pending,/closed/);assert.equal(client.pending.size,0);
});
test('BiDi evaluation serializes primitive and undefined results and rejects browser exceptions',async()=>{
 const socket=new Socket(),client=new BidiClient(socket),value=client.evaluate('context','document.title');assert.match(socket.sent[0].params.expression,/JSON.stringify/);assert.equal(socket.sent[0].params.target.context,'context');assert.equal(socket.sent[0].params.awaitPromise,true);
 socket.reply({type:'success',id:1,result:{type:'success',result:{type:'string',value:JSON.stringify({value:'GenDragoon'})}}});assert.equal(await value,'GenDragoon');
 const undefinedResult=client.evaluate('context','document.querySelector("button").click()');socket.reply({type:'success',id:2,result:{type:'success',result:{type:'string',value:'{}'}}});assert.equal(await undefinedResult,undefined);
 const failed=client.evaluate('context','throw new Error()');socket.reply({type:'success',id:3,result:{type:'exception',exceptionDetails:{text:'Fixture actual page error'}}});await assert.rejects(failed,/actual page error/);client.close();
});
test('BiDi transport is loopback-only, bounded, and times out without fake success',async()=>{
 for(const url of ['ws://other.invalid:9222/session','wss://127.0.0.1:9222/session','ws://127.0.0.1:9222/other','ws://127.0.0.1:9222/session?secret=x','ws://user:credential@127.0.0.1:9222/session'])await assert.rejects(connectBidi(url));
 const socket=new Socket(),client=new BidiClient(socket,{timeout:10}),pending=client.command('missing');await assert.rejects(pending,/timed out/);
 const oversized=client.command('oversized');socket.dispatchEvent(new MessageEvent('message',{data:'x'.repeat(2*1024*1024+1)}));await assert.rejects(oversized,/exceeds/);assert.equal(socket.closed,true);
});
async function hostFixture(t){const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gd-firefox-registration-')));t.after(()=>fs.rm(temp,{recursive:true,force:true}));const home=path.join(temp,'home'),root=path.join(temp,'root'),binary=path.join(root,'host');await fs.mkdir(home,{mode:0o700});await fs.mkdir(root,{mode:0o700});await fs.writeFile(binary,'synthetic-only',{mode:0o700});return {temp,home,root,binary,options:{platform:'linux',environment:{HOME:home,RUNNER_TEMP:temp,GITHUB_ACTIONS:'true'}}};}
test('disposable Firefox manifest allows only the fixed package ID and removes only its own unchanged file',async t=>{
 const f=await hostFixture(t),registration=await registerFirefoxHost(f.root,f.binary,f.options),manifest=JSON.parse(await fs.readFile(registration.target,'utf8'));
 assert.equal(manifest.type,'stdio');assert.equal(manifest.path,f.binary);assert.deepEqual(manifest.allowed_extensions,[FIREFOX_ID]);assert.equal(manifest.allowed_origins,undefined);
 await registration.setAllowedExtensions(['unapproved-fixture@redxai.local']);assert.deepEqual(JSON.parse(await fs.readFile(registration.target,'utf8')).allowed_extensions,['unapproved-fixture@redxai.local']);await assert.rejects(registration.setAllowedExtensions(['*']));await registration.setAllowedExtensions([FIREFOX_ID]);
 await assert.rejects(registerFirefoxHost(f.root,f.binary,f.options),/EEXIST/);await registration.close();await assert.rejects(fs.lstat(registration.target),{code:'ENOENT'});assert.equal(await fs.readFile(f.binary,'utf8'),'synthetic-only');
});
test('Firefox registration refuses non-CI, outside root hosts, symlinks and changed manifests',async t=>{
 const f=await hostFixture(t);await assert.rejects(registerFirefoxHost(f.root,f.binary,{...f.options,environment:{...f.options.environment,GITHUB_ACTIONS:'false'}}));await assert.rejects(registerFirefoxHost(f.root,path.join(f.home,'other'),f.options));
 const outside=path.join(f.temp,'outside-host');await fs.writeFile(outside,'outside fixture host',{mode:0o700});await assert.rejects(registerFirefoxHost(f.root,f.root+'/../outside-host',f.options),/canonical/);await assert.rejects(registerFirefoxHost(f.root,outside,f.options),/inside/);
 await fs.symlink(f.temp,path.join(f.root,'linked-parent'));await assert.rejects(registerFirefoxHost(f.root,path.join(f.root,'linked-parent/outside-host'),f.options),/linked host parent/);
 await fs.symlink(f.root,path.join(f.home,'.mozilla'));await assert.rejects(registerFirefoxHost(f.root,f.binary,f.options));await fs.unlink(path.join(f.home,'.mozilla'));
 const registration=await registerFirefoxHost(f.root,f.binary,f.options);await fs.writeFile(registration.target,'changed');await assert.rejects(registration.close(),/changed/);assert.equal(await fs.readFile(registration.target,'utf8'),'changed');
});
test('failed exclusive manifest setup removes its own partial inode and preserves independently changed content',async t=>{
 const f=await hostFixture(t),target=path.join(f.home,'.mozilla/native-messaging-hosts/com.redxai.gendragoon.json');
 await assert.rejects(registerFirefoxHost(f.root,f.binary,{...f.options,writeManifest:async(handle,data)=>{await handle.writeFile(data.slice(0,25));throw new Error('Synthetic partial write failure');}}),/partial write failure/);await assert.rejects(fs.lstat(target),{code:'ENOENT'});
 const successful=await registerFirefoxHost(f.root,f.binary,f.options);await successful.close();
 await assert.rejects(registerFirefoxHost(f.root,f.binary,{...f.options,writeManifest:async handle=>{await handle.writeFile('independently changed');throw new Error('Synthetic changed content');}}),/changed content/);assert.equal(await fs.readFile(target,'utf8'),'independently changed');
});
test('only the isolated Firefox launch receives automation authority and both parent settings restore on success or throw',async()=>{
 for(const fails of [false,true]){const environment={HOME:'/unchanged/synthetic-home',XDG_STATE_HOME:'/original/state',MOZ_REMOTE_ALLOW_SYSTEM_ACCESS:'original'},before={...environment};const launching=withFirefoxLaunchEnvironment('/private/fixture/state',async()=>{assert.equal(environment.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS,'1');assert.equal(environment.XDG_STATE_HOME,'/private/fixture/state');assert.equal(environment.HOME,before.HOME);await new Promise(setImmediate);if(fails)throw new Error('Synthetic launch failure');return 'launched';},environment);if(fails)await assert.rejects(launching,/launch failure/);else assert.equal(await launching,'launched');assert.deepEqual(environment,before);}
 const absent={HOME:'/unchanged/synthetic-home'};await assert.rejects(withFirefoxLaunchEnvironment('/fixture/state',async()=>{throw new Error('Launch failed before return');},absent));assert.deepEqual(absent,{HOME:'/unchanged/synthetic-home'});
});
test('registered Firefox page origin requires the exact active temporary RDP descriptor and canonical manifest URL',()=>{
 const origin='moz-extension://58f6682e-47a9-4a72-8587-0c805f002a74/',addon={id:FIREFOX_ID,debuggable:true,temporarilyInstalled:true,isWebExtension:true,isSystem:false,manifestURL:origin+'manifest.json'};assert.equal(installedExtensionOrigin({addons:[addon]}),origin);
 for(const change of [{id:'other@example.test'},{debuggable:false},{temporarilyInstalled:false},{isWebExtension:false},{isSystem:true},{manifestURL:'https://other.invalid/manifest.json'},{manifestURL:origin+'dashboard.html'},{manifestURL:origin+'manifest.json?query'},{manifestURL:undefined}])assert.throws(()=>installedExtensionOrigin({addons:[{...addon,...change}]}));
 assert.throws(()=>installedExtensionOrigin({addons:[addon,addon]}));
 try{installedExtensionOrigin({addons:[{...addon,manifestURL:'https://private.invalid/secret'}]});assert.fail('Invalid descriptor must fail');}catch(error){assert.match(error.message,/response keys=.*addons/);assert.match(error.message,/manifestURL/);assert.doesNotMatch(error.message,/private|secret|https:/);}
});
test('origin discovery uses only the pinned web-ext Firefox runner existing RDP connection and times out',async()=>{
 const addon={id:FIREFOX_ID,debuggable:true,temporarilyInstalled:true,isWebExtension:true,isSystem:false,manifestURL:'moz-extension://58f6682e-47a9-4a72-8587-0c805f002a74/manifest.json'},calls=[];
 const runner={extensionRunners:[{getName:()=> 'Firefox Desktop',remoteFirefox:{client:{request:async command=>{calls.push(command);return {addons:[addon]};}}}}]};assert.equal(await discoverExtensionOrigin(runner),addon.manifestURL.slice(0,-13));assert.deepEqual(calls,['listAddons']);
 await assert.rejects(discoverExtensionOrigin({extensionRunners:[] }));runner.extensionRunners[0].remoteFirefox.client.request=()=>new Promise(()=>{});await assert.rejects(discoverExtensionOrigin(runner,{timeout:10}),/discovery timed out/);
});
