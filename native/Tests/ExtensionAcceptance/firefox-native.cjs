'use strict';
// Account-free Linux CI only. web-ext installs the unmodified package; Mozilla's
// documented WebDriver BiDi endpoint drives its real extension DOM/native API.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const net=require('node:net');
const FIREFOX_ID='gendragoon@redxai.local',NEGATIVE_ID='unapproved-fixture@redxai.local',UUID='58f6682e-47a9-4a72-8587-0c805f002a74';
const HOST_NAME='com.redxai.gendragoon',MAX_RESPONSE=2*1024*1024;
const FILE_LABEL='<img src=x onerror=alert(1)> café 😀.txt';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class BidiClient{
 constructor(socket,{timeout=15000}={}){this.socket=socket;this.timeout=timeout;this.sequence=0;this.pending=new Map();this.events=[];this.trace=[];this.closed=false;
  socket.addEventListener('message',event=>this.receive(event.data));
  socket.addEventListener('close',()=>this.fail(new Error('Firefox BiDi connection closed')));
  socket.addEventListener('error',()=>this.fail(new Error('Firefox BiDi transport failed')));
 }
 receive(data){try{if(typeof data!=='string'||Buffer.byteLength(data)>MAX_RESPONSE)throw new Error('Firefox BiDi response exceeds fixture bound');const packet=JSON.parse(data);
   if(packet.type==='event'){if(this.events.length>=1000)this.events.shift();this.events.push(packet);return;}
   const pending=this.pending.get(packet.id);if(!pending)return;this.pending.delete(packet.id);clearTimeout(pending.timer);const trace=this.trace.find(entry=>entry.id===packet.id);if(trace){trace.status=packet.type;trace.elapsedMs=Date.now()-pending.started;if(packet.type==='error')trace.error=packet.error;}
   if(packet.type==='error')pending.reject(new Error(packet.error+': '+String(packet.message||'').slice(0,400)));else if(packet.type==='success')pending.resolve(packet.result);else pending.reject(new Error('Malformed Firefox BiDi response'));
  }catch(error){this.fail(error);this.socket.close();}
 }
 fail(error){this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
 command(method,params={}){if(this.closed)return Promise.reject(new Error('Firefox BiDi session unavailable'));if(this.pending.size>=32)return Promise.reject(new Error('Firefox BiDi fixture request limit'));
  const id=++this.sequence,started=Date.now(),trace={id,method,status:'sent'};this.trace.push(trace);if(this.trace.length>100)this.trace.shift();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);trace.status='timeout';trace.elapsedMs=Date.now()-started;reject(new Error('Firefox BiDi command timed out: '+method));},this.timeout);this.pending.set(id,{resolve,reject,timer,started});try{this.socket.send(JSON.stringify({id,method,params}));}catch(error){clearTimeout(timer);this.pending.delete(id);trace.status='transport-error';reject(error);}});
 }
 async evaluate(context,expression){const response=await this.command('script.evaluate',{expression:'(async()=>JSON.stringify({value:await ('+expression+')}))()',target:{context},awaitPromise:true});
  if(response.type!=='success'||response.result?.type!=='string')throw new Error('Firefox extension evaluation failed: '+String(response.exceptionDetails?.text||response.type).slice(0,400));return JSON.parse(response.result.value).value;
 }
 async wait(context,expression,label,timeout=15000){const until=Date.now()+timeout;while(Date.now()<until){if(await this.evaluate(context,expression))return;await delay(100);}throw new Error('Firefox dashboard timeout: '+label);}
 close(){this.fail(new Error('Firefox BiDi fixture closed'));this.socket.close();}
}
async function connectBidi(url,{WebSocketImpl=globalThis.WebSocket,timeout=15000}={}){
 const parsed=new URL(url);assert.equal(parsed.protocol,'ws:');assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.username,'');assert.equal(parsed.password,'');assert.equal(parsed.pathname,'/session');assert.equal(parsed.search,'');assert.equal(parsed.hash,'');assert.ok(parsed.port);
 const until=Date.now()+timeout;let last;
 while(Date.now()<until){try{const socket=new WebSocketImpl(url);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.close();reject(new Error('Firefox BiDi handshake timed out'));},1000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Firefox BiDi not ready'));},{once:true});});return new BidiClient(socket);}catch(error){last=error;await delay(100);}}
 throw last||new Error('Firefox BiDi connection timed out');
}
async function freePort(){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function withFirefoxLaunchEnvironment(stateHome,launch,environment=process.env){
 const changes={XDG_STATE_HOME:stateHome,MOZ_REMOTE_ALLOW_SYSTEM_ACCESS:'1'},prior=Object.fromEntries(Object.keys(changes).map(key=>[key,{present:Object.hasOwn(environment,key),value:environment[key]}]));
 try{Object.assign(environment,changes);return await launch();}
 finally{for(const [key,value]of Object.entries(prior)){if(value.present)environment[key]=value.value;else delete environment[key];}}
}
async function ownedDirectory(directory,{create=false,created=[]}={}){let stat;try{stat=await fs.lstat(directory);}catch(error){if(error.code!=='ENOENT'||!create)throw error;await fs.mkdir(directory,{mode:0o700});created.push(directory);stat=await fs.lstat(directory);}assert.ok(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===process.getuid()&&(stat.mode&0o022)===0,'Firefox fixture registration requires owned non-writable directories');}
async function registerFirefoxHost(root,binary,{environment=process.env,platform=process.platform,writeManifest=(handle,data)=>handle.writeFile(data)}={}){
 assert.equal(platform,'linux');assert.equal(environment.GITHUB_ACTIONS,'true');
 const runner=await fs.realpath(environment.RUNNER_TEMP);assert.ok(root.startsWith(runner+path.sep));
 assert.equal(await fs.realpath(root),root);assert.equal(path.resolve(binary),binary,'Require a canonical fixture host path');assert.equal(await fs.realpath(binary),binary,'Do not traverse a linked host parent');const relative=path.relative(root,binary);assert.ok(relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative),'Register only a host inside the private fixture root');const host=await fs.lstat(binary);assert.ok(host.isFile()&&!host.isSymbolicLink()&&host.uid===process.getuid()&&(host.mode&0o077)===0,'Register only the private owned fixture host');
 const home=path.resolve(environment.HOME||'');assert.ok(path.isAbsolute(environment.HOME||'')&&home!=='/');assert.equal(await fs.realpath(home),home,'Never follow a different Firefox home');await ownedDirectory(home);
 const created=[],directory=path.join(home,'.mozilla/native-messaging-hosts');let target,data,handle,createdStat;
 try{await ownedDirectory(path.join(home,'.mozilla'),{create:true,created});await ownedDirectory(directory,{create:true,created});target=path.join(directory,HOST_NAME+'.json');
  data=JSON.stringify({name:HOST_NAME,description:'Disposable GenDragoon Firefox acceptance fixture',path:binary,type:'stdio',allowed_extensions:[FIREFOX_ID]});
  handle=await fs.open(target,'wx',0o600);createdStat=await handle.stat();await writeManifest(handle,data);await handle.close();handle=null;const stat=await fs.lstat(target);
  let expected=data;
  async function unchanged(){const current=await fs.lstat(target);assert.ok(current.isFile()&&!current.isSymbolicLink()&&current.uid===process.getuid()&&current.ino===stat.ino,'Do not change/remove a replaced Firefox host manifest');assert.equal(await fs.readFile(target,'utf8'),expected,'Do not change/remove a changed Firefox host manifest');}
  return {target,data,async setAllowedExtensions(allowed){assert.ok(Array.isArray(allowed)&&allowed.length===1&&[FIREFOX_ID,NEGATIVE_ID].includes(allowed[0]));await unchanged();const next=JSON.stringify({...JSON.parse(data),allowed_extensions:allowed});await fs.writeFile(target,next,{flag:'r+'});await fs.truncate(target,Buffer.byteLength(next));expected=next;},async close(){await unchanged();await fs.unlink(target);for(const dir of [...created].reverse())try{await fs.rmdir(dir);}catch(error){if(error.code!=='ENOTEMPTY'&&error.code!=='ENOENT')throw error;}}};
 }catch(error){if(handle)try{await handle.close();}catch{}
  // A partial write can fail before a cleanup object is returned. Remove only
  // this invocation's owned inode containing an exact prefix of its own data.
  // EEXIST, replaced files and independently changed content remain untouched.
  if(createdStat&&target)try{const current=await fs.lstat(target);if(current.isFile()&&!current.isSymbolicLink()&&current.uid===process.getuid()&&current.nlink===1&&current.ino===createdStat.ino&&current.dev===createdStat.dev){const contents=await fs.readFile(target),expected=Buffer.from(data);if(contents.length<=expected.length&&contents.equals(expected.subarray(0,contents.length))){const last=await fs.lstat(target);if(last.ino===createdStat.ino&&last.dev===createdStat.dev&&last.nlink===1)await fs.unlink(target);}}}catch{}
  for(const dir of [...created].reverse())try{await fs.rmdir(dir);}catch{}throw error;}
}
async function firefoxNativeTest({root,directory,archive,firefoxBinary,webExt,webExtVersion,python,helpers}){
 const {startCompanion,stopChild,atomicJSON,events,report,checksum}=helpers;
 assert.equal(process.platform,'linux');assert.equal(process.env.GITHUB_ACTIONS,'true');const runnerRoot=await fs.realpath(process.env.RUNNER_TEMP);assert.ok(root.startsWith(runnerRoot+path.sep));
 const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'));assert.equal(manifest.browser_specific_settings?.gecko?.id,FIREFOX_ID);
 const child=await startCompanion(root,FIREFOX_ID,python),binary=path.join(root,'state/gendragoon/NativeMessaging/gendragoon-native-host');
 let registration,runner,bidi,context,result;
 try{
  registration=await registerFirefoxHost(root,binary);
  const profile=path.join(root,'firefox-profile');await fs.mkdir(profile,{mode:0o700});const port=await freePort();
  // Firefox157 requires explicit test-driver authority for moz-extension pages.
  // This reaches only the new CI process and is restored even if launch fails.
  // https://github.com/mozilla-firefox/firefox/blob/main/remote/components/RemoteAgent.sys.mjs
  runner=await withFirefoxLaunchEnvironment(path.join(root,'state'),()=>webExt.cmd.run({sourceDir:directory,firefox:firefoxBinary,firefoxProfile:profile,keepProfileChanges:true,noReload:true,noInput:true,startUrl:['about:blank'],
   pref:{'extensions.webextensions.uuids':JSON.stringify({[FIREFOX_ID]:UUID})},args:['-headless','--remote-debugging-port',String(port)]},{shouldExitProgram:false}));
  const reload=await runner.reloadAllExtensions();for(const result of reload||[])assert.ok(!result.reloadError,'The actual temporary Firefox extension must reload');
  bidi=await connectBidi('ws://127.0.0.1:'+port+'/session');const session=await bidi.command('session.new',{capabilities:{alwaysMatch:{acceptInsecureCerts:false}}});assert.equal(session.capabilities.browserName,'firefox');
  await bidi.command('session.subscribe',{events:['log.entryAdded']});
  // This brand-new web-ext process already owns its explicit about:blank tab.
  // Reusing it avoids coupling native messaging to browser window creation.
  const tree=await bidi.command('browsingContext.getTree',{}),blank=tree.contexts.filter(entry=>entry.url==='about:blank');assert.equal(blank.length,1,'Select only the expected new disposable Firefox tab');context=blank[0].context;
  await bidi.command('browsingContext.navigate',{context,url:'moz-extension://'+UUID+'/dashboard.html',wait:'complete'});
  assert.equal(await bidi.evaluate(context,'browser.runtime.id'),FIREFOX_ID,'The actual loaded ID must match the native manifest and host config exactly');
  await bidi.wait(context,"document.querySelector('#status').textContent.includes('Approve this disposable CI fixture client first.')",'denied fixture consent');
  assert.equal(await bidi.evaluate(context,"document.querySelectorAll('#files li').length"),0);
  await atomicJSON(path.join(root,'consent.json'),{approved:true});await bidi.evaluate(context,"document.querySelector('#refresh').click()");
  await bidi.wait(context,"document.querySelector('#status').textContent.includes('Connected as Disposable CI fixture.')",'approved fixture metadata');
  assert.equal(await bidi.evaluate(context,"document.querySelectorAll('#notes option').length"),2);
  assert.equal(await bidi.evaluate(context,"document.querySelector('#files li').textContent"),FILE_LABEL+' · 17 archive bytes');assert.equal(await bidi.evaluate(context,"document.querySelectorAll('#files img').length"),0);
  assert.equal(await bidi.evaluate(context,"document.querySelector('#upload-file').disabled"),false);
  await bidi.evaluate(context,"(()=>{const el=document.querySelector('#notes');el.value='"+'b'.repeat(32)+"';el.dispatchEvent(new Event('change'));})()");await bidi.wait(context,"document.querySelector('#note-detail').textContent.includes('Read only')",'read-only MachineNote');
  assert.equal(await bidi.evaluate(context,"document.querySelector('#upload-file').disabled&&document.querySelector('#upload-folder').disabled"),true);
  await bidi.evaluate(context,"(()=>{const el=document.querySelector('#notes');el.value='"+'a'.repeat(32)+"';el.dispatchEvent(new Event('change'));})()");await bidi.wait(context,"document.querySelector('#note-detail').textContent==='Ready for uploads.'",'writable MachineNote');
  await bidi.evaluate(context,"document.querySelector('#upload-file').click()");await bidi.wait(context,"document.querySelector('#status').textContent==='Selection cancelled.'",'cancelled synthetic picker');
  for(const [method,params]of [['request',{path:'/v1/integrations/keys',method:'GET'}],['uploadSelection',{workspaceId:'a'.repeat(32),selectedPaths:['/not-an-upload']}]] ){
   assert.equal(await bidi.evaluate(context,'(async()=>{try{await GDCompanion.call('+JSON.stringify(method)+','+JSON.stringify(params)+');return null;}catch(error){return error.code;}})()'),'route_denied');
  }
  // Navigate the real packaged Teams page; its bridge creates its own native
  // connection and must render the current policy/profile from private IPC.
  const teams=context;
  await bidi.command('browsingContext.navigate',{context:teams,url:'moz-extension://'+UUID+'/teams/index.html?workspaceId='+'a'.repeat(32)+'&workspaceName=Fixture',wait:'complete'});
  await bidi.wait(teams,"document.querySelector('#username').value==='FixtureUser'&&document.querySelectorAll('#community-rules li').length>0",'packaged Teams profile and community policy');
  assert.equal(await bidi.evaluate(teams,'document.title'),'GenDragoon Teams');assert.equal(await bidi.evaluate(teams,"document.querySelector('h1').textContent"),'Build together.');
  assert.equal(await bidi.evaluate(teams,"document.querySelector('#join-team').disabled&&document.querySelector('#send-message').disabled"),true,'Participation stays disabled without current fixture rules acceptance');
  await bidi.command('browsingContext.navigate',{context,url:'moz-extension://'+UUID+'/dashboard.html',wait:'complete'});await bidi.wait(context,"document.querySelector('#status').textContent.includes('Connected as Disposable CI fixture.')",'return to the packaged dashboard');
  const screenshot=await bidi.command('browsingContext.captureScreenshot',{context,origin:'document'});await fs.writeFile(path.join(root,'reports/firefox-dashboard.png'),Buffer.from(screenshot.data,'base64'),{mode:0o600});
  await atomicJSON(path.join(root,'consent.json'),{approved:false});
  assert.equal(await bidi.evaluate(context,"(async()=>{try{await GDCompanion.call('status');return null;}catch(error){return error.code;}})()"),'approval_required','Revoked consent must deny the already open native connection');
  const beforeManifestDenial=await events(root);await registration.setAllowedExtensions([NEGATIVE_ID]);
  await bidi.command('browsingContext.reload',{context,wait:'complete'});await bidi.wait(context,"document.querySelector('#status').classList.contains('error')",'Firefox native manifest rejects a different extension ID');
  assert.equal(await bidi.evaluate(context,"document.querySelectorAll('#files li').length"),0);assert.equal((await events(root)).length,beforeManifestDenial.length,'Browser manifest ID rejection must never reach native IPC dispatch');
  await registration.setAllowedExtensions([FIREFOX_ID]);await atomicJSON(path.join(root,'consent.json'),{approved:true});
  await bidi.command('browsingContext.reload',{context,wait:'complete'});await bidi.wait(context,"document.querySelector('#status').textContent.includes('Connected as Disposable CI fixture.')",'restored exact Firefox native manifest');
  const before=await events(root),configPath=path.join(root,'state/gendragoon/NativeMessaging/config.json'),config=JSON.parse(await fs.readFile(configPath,'utf8'));
  config.allowedOrigins=config.allowedOrigins.filter(origin=>origin!==FIREFOX_ID);await atomicJSON(configPath,config);
  await bidi.command('browsingContext.reload',{context,wait:'complete'});await bidi.wait(context,"document.querySelector('#status').classList.contains('error')",'exact Firefox ID removal denies fresh host');
  assert.equal(await bidi.evaluate(context,"document.querySelectorAll('#files li').length"),0);const trace=await events(root);assert.equal(trace.length,before.length,'Denied startup caller must not reach IPC dispatch');
  assert.ok(trace.some(event=>event.clientKind==='browser'&&event.clientId===FIREFOX_ID&&event.method==='status'));
  assert.ok(trace.some(event=>event.method==='selectUpload'));assert.ok(trace.some(event=>event.path==='/v1/receivers/me/dev-community'));
  assert.ok(!trace.some(event=>event.method==='uploadSelection'||event.path==='/v1/integrations/keys'));
  const errors=bidi.events.filter(event=>event.method==='log.entryAdded'&&event.params?.level==='error'&&event.params?.type==='javascript');assert.deepEqual(errors,[],'Unexpected extension JavaScript errors');
  result={passed:true,webExtVersion,nodeVersion:process.version,browserVersion:session.capabilities.browserVersion,firefoxExecutableSHA256:checksum(await fs.readFile(firefoxBinary)),extensionVersion:manifest.version,extensionId:FIREFOX_ID,
   extensionArchiveSHA256:checksum(await fs.readFile(archive)),nativeHostSHA256:checksum(await fs.readFile(binary)),runnerImage:process.env.ImageVersion||null,
   realFirefoxTemporaryLoadAndReload:true,lintErrors:0,nativeMessagingTested:true,actualNativeMessaging:true,actualProductionPrivateIPC:true,
   approvalDeniedThenFixtureApproved:true,fixtureApprovalRevokedOnExistingConnection:true,exactFirefoxIDRemovalDeniesNewConnection:true,browserManifestRejectsDifferentExtensionID:true,
   readOnlyControls:true,metadataRenderedAsText:true,disallowedRoutesRejected:true,teamsPageLoaded:true,teamsCommunityPolicyRendered:true,
   syntheticAccountFreeDispatch:true,realNativeConsentUITested:false,liveAccountOrUploadTest:false,signedStoreInstallationTested:false,normalUserApprovalTested:false,otherOperatingSystemsTested:false,
   installationMethod:'Pinned Mozilla web-ext temporary add-on, controlled by Firefox WebDriver BiDi in new disposable CI profile',
   nativeHostRegistration:'Exact allowed_extensions ID in disposable Actions VM user path; no existing manifest overwritten; exact created file removed after test',
   protocol:'Mozilla WebDriver BiDi over IPv4 loopback; Node built-in WebSocket; no new test dependencies',privilegedExtensionAutomation:true,
   firefoxAutomationEnvironment:'MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1',firefoxAutomationAuthoritySource:'https://github.com/mozilla-firefox/firefox/blob/main/remote/components/RemoteAgent.sys.mjs'};
 }catch(error){await report(root,'firefox-native-failure',{passed:false,stage:'native messaging/IPC acceptance',message:String(error.message).slice(0,500),bidiCommands:bidi?.trace||[],eventTypes:(bidi?.events||[]).slice(-20).map(event=>({method:event.method,type:event.params?.type,level:event.params?.level}))});throw error;}
 finally{
  try{if(bidi){try{await bidi.command('session.end');}catch{}bidi.close();}}
  finally{try{if(runner)await runner.exit();}finally{try{await stopChild(child);}finally{if(registration)await registration.close();}}}
 }
 await report(root,'firefox',{...result,createdHostManifestRemoved:true});
}
module.exports={BidiClient,connectBidi,registerFirefoxHost,firefoxNativeTest,withFirefoxLaunchEnvironment,FIREFOX_ID};
