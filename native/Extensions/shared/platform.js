'use strict';
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GDPlatform=api;})(typeof globalThis==='object'?globalThis:this,()=>{
 const SYSTEMS=new Set(['macos','windows','linux','android','ios']);
 function detect(nav={}){
  const ua=String(nav.userAgent||''),p=String(nav.userAgentData?.platform||nav.platform||'').toLowerCase();
  let platform='unknown',deviceType='desktop';
  // iPadOS can report a desktop Mac user agent. Android also includes Linux.
  if(/iphone|ipad|ipod/i.test(ua)||/mac/.test(p)&&Number(nav.maxTouchPoints)>1){platform='ios';deviceType=/ipad/i.test(ua)||!/iphone|ipod/i.test(ua)?'tablet':'phone';}
  else if(p==='android'||/android/i.test(ua)){platform='android';deviceType=nav.userAgentData?.mobile===false||!/mobile/i.test(ua)?'tablet':'phone';}
  else if(/win/.test(p)||/windows/i.test(ua))platform='windows';
  else if(/mac/.test(p)||/macintosh|mac os x/i.test(ua))platform='macos';
  else if(/cros/i.test(ua))platform='unknown';
  else if(/linux/.test(p)||/linux|x11/i.test(ua))platform='linux';
  return {platform,deviceType,source:nav.userAgentData?'client-hints':'user-agent',architecture:'unknown'};
 }
 function effective(browser,native){
  // A trusted local native host wins over spoofable browser metadata.
  return native&&SYSTEMS.has(native.platform)?{...browser,...native,source:'native-companion'}:browser;
 }
 function target(item){
  if(SYSTEMS.has(item?.applicationPlatform))return item.applicationPlatform;
  const name=String(item?.name||'').toLowerCase();
  if(/\.(exe|msi|msix|appx|msixbundle|appxbundle)$/.test(name))return 'windows';
  if(/\.(appimage|deb|rpm)$/.test(name))return 'linux';
  if(/\.(apk|aab)$/.test(name))return 'android';
  if(/\.ipa$/.test(name))return 'ios';
  if(item?.kind==='app'||/\.app$/.test(name))return 'macos';
  return null;
 }
 function canPlay(item,device){
  if(!item||item.virtualFolder||!SYSTEMS.has(device?.platform)||!device.nativeAppControl)return false;
  if(/\.(msi|msix|appx|msixbundle|appxbundle|deb|rpm|dmg|pkg|apk|ipa|aab)$/i.test(item.name||''))return false;
  const os=target(item);
  if(os)return os===device.platform;
  return ['windows','linux'].includes(device.platform)&&(item.kind==='folder'||device.platform==='linux'&&!/\.[^/]+$/.test(item.name||''));
 }
 function label(device){return ({windows:'Windows',macos:'macOS',linux:'Linux',ios:device.deviceType==='tablet'?'iPad · iPadOS':'iPhone · iOS',android:'Android',unknown:'Unknown OS'})[device.platform]||'Unknown OS';}
 return {detect,effective,target,canPlay,label};
});
