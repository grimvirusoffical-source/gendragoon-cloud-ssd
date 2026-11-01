'use strict';
// A launcher signal is not evidence of execution. Runners must confirm separately.
const PLATFORMS=new Set(['windows','linux','macos','android','ios']);
function invalid(message,status=400){return Object.assign(new Error(message),{status});}
function appPlatform(item){
 const name=String(item?.originalName||item?.name||'').toLowerCase();
 if(/\.ipa$/.test(name))return 'ios';
 if(/\.(apk|aab)$/.test(name))return 'android';
 if(/\.app$/.test(name)||item?.kind==='app')return 'macos';
 if(/\.exe$/.test(name))return 'windows';
 if(/\.appimage$/.test(name))return 'linux';
 return PLATFORMS.has(item?.applicationPlatform)?item.applicationPlatform:null;
}
function makeLaunchIntent(item,body,now=Date.now()){
 if(!body||Array.isArray(body)||Object.keys(body).some(k=>!['key','platform','requestId'].includes(k))
    ||typeof body.key!=='string'||!/^(?:[a-f0-9]{18}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(body.key)
    ||!PLATFORMS.has(body.platform)||!/^[a-f0-9]{32}$/.test(body.requestId||''))throw invalid('Invalid application launch signal');
 if(!item||item.virtualFolder)throw invalid('Application not found',404);
 const target=appPlatform(item);
 if(!target||target!==body.platform)throw invalid('Application requires a matching operating system',409);
 if(!Number.isSafeInteger(now)||now<0)throw invalid('Invalid launch time');
 return {schema:1,id:body.requestId,key:body.key,platform:target,status:'requested',executionConfirmed:false,
   createdMs:now,expiresMs:now+120000,generation:item.generation??null,
   message:'Launch signal received. Waiting for a compatible execution service; this does not confirm that the app is running.'};
}
module.exports={appPlatform,makeLaunchIntent};
