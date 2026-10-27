'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const p=require('../shared/platform.js');
test('OS and device detection covers Windows, Linux, Mac, Android, iPhone and desktop-mode iPad',()=>{
 const fixtures=[
  [{platform:'Win32',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'},'windows','desktop'],
  [{platform:'Linux x86_64',userAgent:'Mozilla/5.0 (X11; Linux x86_64)'},'linux','desktop'],
  [{platform:'MacIntel',userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X)',maxTouchPoints:0},'macos','desktop'],
  [{platform:'Linux armv8l',userAgent:'Mozilla/5.0 (Linux; Android 16) Mobile Safari'},'android','phone'],
  [{userAgentData:{platform:'Android',mobile:false},userAgent:'Mozilla/5.0 (Linux; Android 16)'},'android','tablet'],
  [{platform:'iPhone',userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',maxTouchPoints:5},'ios','phone'],
  [{platform:'MacIntel',userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X)',maxTouchPoints:5},'ios','tablet'],
  [{platform:'Linux x86_64',userAgent:'Mozilla/5.0 (X11; CrOS x86_64)'},'unknown','desktop'],
 ];
 for(const [nav,os,type] of fixtures){const result=p.detect(nav);assert.equal(result.platform,os);assert.equal(result.deviceType,type);}
});
test('browser metadata is a hint; native capabilities control executable eligibility',()=>{
 const device=p.effective(p.detect({platform:'Win32'}),{platform:'linux',nativeAppControl:true});
 assert.equal(device.platform,'linux');assert.equal(device.source,'native-companion');
 assert.equal(p.canPlay({name:'Windows.exe',kind:'file'},device),false);
 assert.equal(p.canPlay({name:'linux.AppImage',kind:'file'},device),true);
 assert.equal(p.canPlay({name:'linux.deb',kind:'file'},device),false);
 assert.equal(p.canPlay({name:'Mac.app',kind:'app'},device),false);
 assert.equal(p.canPlay({name:'phone.apk',kind:'file'},{platform:'android',nativeAppControl:true}),false);
 assert.equal(p.canPlay({name:'game.exe',kind:'file'},{platform:'windows'}),false);
 assert.equal(p.canPlay({name:'game.exe',kind:'file'},{platform:'windows',nativeAppControl:true}),true);
 assert.equal(p.canPlay({name:'Bundle',kind:'folder'},{platform:'windows',nativeAppControl:true}),true);
});
